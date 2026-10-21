/**
 * @fileoverview Git Worktree & Diff Inspector Sidecar Backend.
 *
 * Reads the active conversation's tracked and focused worktrees purely from
 * per-chat session trajectory metadata (`worktree_*` MCP tool steps via
 * `getSessionWorktreeState`), which is natively inherited across client-side
 * session forks without relying on filesystem markers or scanning.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  watchFile,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  getSessionWorktreeState,
  normalizeWorktreePath,
} from '../../lib/session_worktrees.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

async function runGit(cwd, args, maxBuffer = 16 * 1024 * 1024) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      stdout: err?.stdout || '',
      stderr: err?.stderr || err?.message || '',
    };
  }
}

/**
 * Formats a friendly short display name for a worktree path.
 */
function formatWorktreeDisplayName(wtPath, repoRoot, isMainWorktree) {
  if (isMainWorktree && repoRoot) {
    return `${basename(repoRoot)} (main checkout)`;
  }
  const treesDir = `${join(HOME, '.local', 'trees')}/`;
  if (wtPath.startsWith(treesDir)) {
    return wtPath.slice(treesDir.length);
  }
  if (wtPath.startsWith(`${HOME}/`)) {
    return `~/${wtPath.slice(HOME.length + 1)}`;
  }
  return wtPath;
}

/**
 * Resolves the default base branch for a worktree when `base_ref` was not
 * explicitly specified in the session metadata.
 */
async function resolveDefaultBaseRef(wtPath) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const res = await runGit(wtPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (res.ok && res.stdout.trim()) {
      return ref;
    }
  }
  return 'HEAD';
}

/**
 * Enriches a session-tracked worktree entry with live Git branch/commit/dirty
 * counts for the UI.
 */
async function inspectTrackedWorktree(metaEntry) {
  const wtPath = metaEntry.path;
  if (!existsSync(wtPath)) {
    return {
      path: wtPath,
      displayName: formatWorktreeDisplayName(wtPath, '', false),
      repoName: basename(wtPath),
      repoRoot: wtPath,
      existsOnDisk: false,
      isFocused: metaEntry.isFocused,
      inheritedFromFork: metaEntry.inheritedFromFork,
      label: metaEntry.label || '',
      registeredStep: metaEntry.registeredStep,
      updatedStep: metaEntry.updatedStep,
      branch: 'missing',
      detached: false,
      headSha: '',
      headSubject: 'Directory not found on disk',
      headRelTime: '',
      headTimestamp: 0,
      baseRef: metaEntry.baseRef || 'HEAD',
      aheadCount: 0,
      counts: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        totalDirty: 0,
        ahead: 0,
      },
    };
  }

  const [commonDirRes, topLevelRes, branchRes, statusRes, logRes] = await Promise.all([
    runGit(wtPath, ['rev-parse', '--git-common-dir']),
    runGit(wtPath, ['rev-parse', '--show-toplevel']),
    runGit(wtPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(wtPath, ['status', '--porcelain=v1', '-uall']),
    runGit(wtPath, ['log', '-1', '--format=%h%x09%s%x09%cr%x09%ct']),
  ]);

  let repoRoot = topLevelRes.ok && topLevelRes.stdout.trim() ? topLevelRes.stdout.trim() : wtPath;
  let isMainWorktree = false;
  if (commonDirRes.ok && commonDirRes.stdout.trim()) {
    const commonDir = resolve(wtPath, commonDirRes.stdout.trim());
    if (basename(commonDir) === '.git') {
      const mainRoot = dirname(commonDir);
      try {
        isMainWorktree = realpathSync(mainRoot) === realpathSync(wtPath);
      } catch {
        isMainWorktree = mainRoot === wtPath;
      }
      repoRoot = mainRoot;
    }
  }

  const baseRef = metaEntry.baseRef || (await resolveDefaultBaseRef(wtPath));
  const revRes =
    baseRef && baseRef !== 'HEAD'
      ? await runGit(wtPath, ['rev-list', '--count', `${baseRef}..HEAD`])
      : { ok: false, stdout: '0' };

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  if (statusRes.ok) {
    for (const line of statusRes.stdout.split('\n')) {
      if (line.length < 3) continue;
      const x = line[0];
      const y = line[1];
      if (x === '?' && y === '?') {
        untracked++;
      } else {
        if (x !== ' ' && x !== '?') staged++;
        if (y !== ' ' && y !== '?') unstaged++;
      }
    }
  }

  let headSha = '';
  let headSubject = '';
  let headRelTime = '';
  let headTimestamp = 0;
  if (logRes.ok && logRes.stdout.trim()) {
    const parts = logRes.stdout.trim().split('\t');
    headSha = parts[0] || '';
    headSubject = parts[1] || '';
    headRelTime = parts[2] || '';
    headTimestamp = Number(parts[3]) || 0;
  }

  const branchName = branchRes.ok && branchRes.stdout.trim() ? branchRes.stdout.trim() : '';
  const aheadCount = revRes.ok ? Number(revRes.stdout.trim()) || 0 : 0;
  const totalDirty = staged + unstaged + untracked;

  return {
    path: wtPath,
    displayName: formatWorktreeDisplayName(wtPath, repoRoot, isMainWorktree),
    repoName: basename(repoRoot),
    repoRoot,
    existsOnDisk: true,
    isMainWorktree,
    isFocused: metaEntry.isFocused,
    inheritedFromFork: metaEntry.inheritedFromFork,
    label: metaEntry.label || '',
    registeredStep: metaEntry.registeredStep,
    updatedStep: metaEntry.updatedStep,
    branch: branchName || 'detached HEAD',
    detached: !branchName,
    headSha,
    headSubject,
    headRelTime,
    headTimestamp,
    baseRef,
    aheadCount,
    counts: {
      staged,
      unstaged,
      untracked,
      totalDirty,
      ahead: aheadCount,
    },
  };
}

/**
 * Parses unified git diff output into structured file and hunk objects.
 */
function parseUnifiedDiff(rawDiff) {
  const files = [];
  if (!rawDiff || !rawDiff.trim()) return files;

  const lines = rawDiff.split('\n');
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const oldPath = m ? m[1] : '';
      const newPath = m ? m[2] : '';
      currentFile = {
        path: newPath || oldPath,
        oldPath: oldPath !== newPath ? oldPath : '',
        status: 'M',
        additions: 0,
        deletions: 0,
        isBinary: false,
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith('new file mode ')) {
      currentFile.status = 'A';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'D';
      continue;
    }
    if (line.startsWith('rename from ')) {
      currentFile.status = 'R';
      currentFile.oldPath = line.slice('rename from '.length).trim();
      continue;
    }
    if (line.startsWith('rename to ')) {
      currentFile.path = line.slice('rename to '.length).trim();
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentFile.isBinary = true;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('similarity index ')
    ) {
      continue;
    }

    if (line.startsWith('@@ ')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      oldLine = hm ? Number(hm[1]) : 1;
      newLine = hm ? Number(hm[3]) : 1;
      currentHunk = {
        header: line,
        context: hm && hm[5] ? hm[5].trim() : '',
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith('+')) {
        currentFile.additions++;
        currentHunk.lines.push({
          type: 'add',
          oldNo: null,
          newNo: newLine++,
          text: line.slice(1),
        });
      } else if (line.startsWith('-')) {
        currentFile.deletions++;
        currentHunk.lines.push({
          type: 'del',
          oldNo: oldLine++,
          newNo: null,
          text: line.slice(1),
        });
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'ctx',
          oldNo: oldLine++,
          newNo: newLine++,
          text: line.slice(1),
        });
      } else if (line.startsWith('\\ No newline at end of file')) {
        currentHunk.lines.push({
          type: 'meta',
          oldNo: null,
          newNo: null,
          text: line,
        });
      }
    }
  }

  return files;
}

/**
 * Builds synthetic unified diff entries for untracked files in a worktree.
 */
async function buildUntrackedFileDiffs(wtPath) {
  const res = await runGit(wtPath, ['ls-files', '--others', '--exclude-standard']);
  if (!res.ok || !res.stdout.trim()) return [];

  const relPaths = res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const relPath of relPaths.slice(0, 50)) {
    const absPath = join(wtPath, relPath);
    try {
      const st = statSync(absPath);
      if (!st.isFile()) continue;
      if (st.size > 256 * 1024) {
        out.push({
          path: relPath,
          oldPath: '',
          status: 'U',
          additions: 0,
          deletions: 0,
          isBinary: true,
          hunks: [],
        });
        continue;
      }
      const raw = readFileSync(absPath);
      if (raw.includes(0)) {
        out.push({
          path: relPath,
          oldPath: '',
          status: 'U',
          additions: 0,
          deletions: 0,
          isBinary: true,
          hunks: [],
        });
        continue;
      }
      const text = raw.toString('utf-8');
      const rawLines = text.split('\n');
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
      }
      const hunkLines = rawLines.map((lineText, idx) => ({
        type: 'add',
        oldNo: null,
        newNo: idx + 1,
        text: lineText,
      }));
      out.push({
        path: relPath,
        oldPath: '',
        status: 'U',
        additions: hunkLines.length,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            header: `@@ -0,0 +1,${hunkLines.length} @@ (untracked file)`,
            context: 'untracked file',
            lines: hunkLines,
          },
        ],
      });
    } catch {
      // Skip unreadable file
    }
  }
  return out;
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/fullscreen', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET'
  );
}

app.api(
  '/api/worktrees',
  async (data) => {
    const conversationId = data.conversationId || app.config.conversationId || '';
    const sessionState = await getSessionWorktreeState(conversationId);
    const worktrees = await Promise.all(
      sessionState.worktrees.map((entry) => inspectTrackedWorktree(entry))
    );

    return {
      conversationId,
      focusedPath: sessionState.focusedPath,
      focusedStep: sessionState.focusedStep,
      isForkedSession: sessionState.isForkedSession,
      parentConversationId: sessionState.parentConversationId,
      worktrees,
      timestamp: Date.now(),
    };
  },
  'GET'
);

app.api(
  '/api/diff',
  async (data) => {
    const wtPath = normalizeWorktreePath(data.path || '');
    const mode = data.mode || 'all';
    if (!wtPath || !existsSync(wtPath)) {
      return { error: 'Worktree path does not exist on disk', files: [], commits: [] };
    }

    const baseRef = data.baseRef || (await resolveDefaultBaseRef(wtPath));
    let mergeBase = '';
    if (baseRef && baseRef !== 'HEAD') {
      const mbRes = await runGit(wtPath, ['merge-base', 'HEAD', baseRef]);
      if (mbRes.ok && mbRes.stdout.trim()) {
        mergeBase = mbRes.stdout.trim();
      }
    }

    const commits = [];
    if (mergeBase) {
      const logRes = await runGit(wtPath, [
        'log',
        '--format=%h%x09%s%x09%an%x09%cr',
        '-n',
        '30',
        `${mergeBase}..HEAD`,
      ]);
      if (logRes.ok && logRes.stdout.trim()) {
        for (const line of logRes.stdout.trim().split('\n')) {
          const [sha, subject, author, relTime] = line.split('\t');
          if (sha) commits.push({ sha, subject, author, relTime });
        }
      }
    }

    let diffArgs = ['diff', '--no-ext-diff', '-U3'];
    let includeUntracked = false;
    const selectedCommit =
      typeof data.commit === 'string' && /^[0-9a-f]{6,40}$/i.test(data.commit.trim())
        ? data.commit.trim()
        : '';

    if (selectedCommit) {
      diffArgs = ['show', '--format=', '--no-ext-diff', '-U3', selectedCommit];
    } else if (mode === 'staged') {
      diffArgs.push('--cached');
    } else if (mode === 'unstaged') {
      includeUntracked = true;
    } else if (mode === 'dirty' || mode === 'working') {
      diffArgs.push('HEAD');
      includeUntracked = true;
    } else if (mode === 'branch') {
      diffArgs.push(mergeBase ? `${mergeBase}..HEAD` : 'HEAD~1..HEAD');
    } else {
      diffArgs.push(mergeBase || 'HEAD');
      includeUntracked = true;
    }

    const [diffRes, statusRes, untrackedFiles] = await Promise.all([
      runGit(wtPath, diffArgs),
      runGit(wtPath, ['status', '--porcelain=v1', '-uall']),
      includeUntracked ? buildUntrackedFileDiffs(wtPath) : Promise.resolve([]),
    ]);

    const statusMap = new Map();
    if (statusRes.ok) {
      for (const line of statusRes.stdout.split('\n')) {
        if (line.length < 3) continue;
        const x = line[0];
        const y = line[1];
        const rawPath = line.slice(3).trim();
        const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;
        statusMap.set(filePath, {
          staged: x !== ' ' && x !== '?',
          unstaged: y !== ' ' && y !== '?',
          untracked: x === '?' && y === '?',
        });
      }
    }

    const files = [...parseUnifiedDiff(diffRes.stdout), ...untrackedFiles].map((f) => ({
      ...f,
      dirtyState: statusMap.get(f.path) || {
        staged: false,
        unstaged: false,
        untracked: f.status === 'U',
      },
    }));

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const f of files) {
      totalAdditions += f.additions;
      totalDeletions += f.deletions;
    }

    return {
      path: wtPath,
      mode,
      baseRef,
      mergeBase: mergeBase ? mergeBase.slice(0, 9) : '',
      commits,
      files,
      totalAdditions,
      totalDeletions,
    };
  },
  'GET'
);

watchFile(join(__dirname, 'main.mjs'), { interval: 2000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    process.exit(0);
  }
}).unref();

app.run();
