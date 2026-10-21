/**
 * Git Worktree & Diff Inspector Frontend.
 * Displays worktrees registered in the current conversation's trajectory metadata
 * via `worktree_*` MCP tools (and inherited across client-side session forks).
 */
(() => {
  const POLL_INTERVAL_MS = 4000;
  const $ = (id) => document.getElementById(id);

  const state = {
    conversationId: '',
    isForkedSession: false,
    parentConversationId: '',
    focusedPath: '',
    lastFocusedStep: -1,
    worktrees: [],
    selectedPath: '',
    diffMode: 'all', // 'all' | 'branch' | 'dirty' | 'staged'
    selectedCommit: '',
    diffData: null,
    collapsedFiles: new Set(),
    fileFilter: '',
    live: true,
    loadingDiff: false,
  };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const sidecarToken = urlParams.get('token') || '';

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #18181b)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncThemeScheme();
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      const vars = event.data.payload?.cssVariables || {};
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
      syncThemeScheme();
    }
  });
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function resolveConversationId() {
    return urlParams.get('conversationId') || window.sidecar?.conversationId || '';
  }

  async function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v));
      }
    }
    const url = qs.toString() ? `${path}?${qs.toString()}` : path;
    const headers = {};
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function renderHeaderMeta() {
    $('count-tracked').textContent = String(state.worktrees.length);
    const forkBadge = $('fork-badge');
    if (forkBadge) {
      if (state.isForkedSession) {
        const parentShort = state.parentConversationId
          ? state.parentConversationId.slice(0, 8)
          : 'parent';
        forkBadge.textContent = `fork:${parentShort}`;
        forkBadge.title = state.parentConversationId
          ? `Forked from conversation ${state.parentConversationId}`
          : 'Forked session';
        forkBadge.classList.remove('hidden');
      } else {
        forkBadge.classList.add('hidden');
      }
    }
  }

  function renderWorktreeList() {
    renderHeaderMeta();
    const listEl = $('worktree-list');
    const items = state.worktrees;

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div>No worktrees registered in this chat session yet.</div>
          <div class="empty-hint">
            When the agent starts working in a worktree, it calls
            <code>worktree_register</code> or <code>worktree_focus</code>
            to attach it to this conversation's metadata.
          </div>
        </div>`;
      return;
    }

    listEl.innerHTML = items
      .map((wt) => {
        const isSelected = wt.path === state.selectedPath;
        const badges = [];
        if (wt.isFocused) {
          badges.push('<span class="status-pill focused" title="Focused worktree in this session">Focused</span>');
        }
        if (wt.inheritedFromFork) {
          badges.push('<span class="status-pill inherited" title="Inherited from parent conversation before session fork">Inherited</span>');
        }
        if (!wt.existsOnDisk) {
          badges.push('<span class="status-pill missing" title="Directory does not currently exist on disk">Missing</span>');
        } else {
          if (wt.counts.ahead > 0) {
            badges.push(`<span class="status-pill ahead" title="${wt.counts.ahead} commit(s) ahead of ${esc(wt.baseRef)}">+${wt.counts.ahead} commit${wt.counts.ahead > 1 ? 's' : ''}</span>`);
          }
          if (wt.counts.totalDirty > 0) {
            const parts = [];
            if (wt.counts.staged > 0) parts.push(`${wt.counts.staged} staged`);
            if (wt.counts.unstaged > 0) parts.push(`${wt.counts.unstaged} mod`);
            if (wt.counts.untracked > 0) parts.push(`${wt.counts.untracked} new`);
            badges.push(`<span class="status-pill dirty">${esc(parts.join(', '))}</span>`);
          } else {
            badges.push('<span class="status-pill clean">Clean</span>');
          }
        }

        const labelRow = wt.label
          ? `<div class="wt-label-row" title="${esc(wt.label)}">${esc(wt.label)}</div>`
          : '';

        return `
          <div class="wt-card${isSelected ? ' selected' : ''}" data-wt-path="${esc(wt.path)}">
            <div class="wt-row-top">
              <div class="wt-title-wrap">
                <span class="repo-pill">${esc(wt.repoName)}</span>
                <span class="wt-name" title="${esc(wt.path)}">${esc(wt.displayName)}</span>
              </div>
              <div class="wt-badges">${badges.join('')}</div>
            </div>
            ${labelRow}
            <div class="wt-row-bottom">
              <div class="wt-branch-commit">
                <span class="branch-pill" title="Branch: ${esc(wt.branch)}">${esc(wt.branch)}</span>
                <span class="commit-subj" title="${esc(wt.headSha)} ${esc(wt.headSubject)}">${wt.headSha ? `${esc(wt.headSha)} · ` : ''}${esc(wt.headSubject)}</span>
              </div>
              <span class="wt-time">${esc(wt.headRelTime)}</span>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderDetail() {
    const detailEl = $('detail-section');
    const wt = state.worktrees.find((w) => w.path === state.selectedPath);
    if (!wt) {
      detailEl.classList.add('hidden');
      return;
    }
    detailEl.classList.remove('hidden');

    $('detail-repo').textContent = wt.repoName;
    $('detail-name').textContent = wt.displayName;
    $('detail-branch').textContent = wt.branch;
    $('detail-focused')?.classList.toggle('hidden', !wt.isFocused);

    const metaParts = [
      `<span>Path: <code>${esc(wt.path)}</code></span>`,
      `<span>Base: <code>${esc(wt.baseRef)}</code></span>`,
    ];
    if (wt.label) {
      metaParts.push(`<span>Task: ${esc(wt.label)}</span>`);
    }
    if (wt.inheritedFromFork) {
      metaParts.push('<span>Origin: Inherited from parent session fork</span>');
    }
    $('detail-submeta').innerHTML = metaParts.join('');

    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.diffMode);
    });

    const commitsBox = $('commits-box');
    const commits = state.diffData?.commits || [];
    if (commits.length > 0 && (state.diffMode === 'all' || state.diffMode === 'branch')) {
      commitsBox.classList.remove('hidden');
      const headerRow = `
        <div class="commits-header">
          <span>Stacked Commits (${commits.length} ahead of <code>${esc(wt.baseRef)}</code>) — click to filter</span>
          ${state.selectedCommit ? '<button type="button" class="ghost-btn sm" data-clear-commit="1">Show Full Stack</button>' : ''}
        </div>`;
      const rows = commits
        .map(
          (c) => `
          <div class="commit-row${state.selectedCommit === c.sha ? ' active' : ''}" data-commit-sha="${esc(c.sha)}" title="Click to inspect only commit ${esc(c.sha)}">
            <span class="commit-sha">${esc(c.sha)}</span>
            <span class="commit-msg">${esc(c.subject)}</span>
            <span class="commit-time">${esc(c.relTime)}</span>
          </div>`
        )
        .join('');
      commitsBox.innerHTML = headerRow + rows;
    } else {
      commitsBox.classList.add('hidden');
      commitsBox.innerHTML = '';
    }

    renderDiffFiles(wt);
  }

  function renderDiffFiles(wt) {
    const container = $('diff-container');
    const summaryEl = $('diff-summary-stats');

    if (!wt.existsOnDisk) {
      container.innerHTML = `<div class="empty-state">Worktree path <code>${esc(wt.path)}</code> does not currently exist on disk.</div>`;
      summaryEl.textContent = '';
      return;
    }

    if (state.loadingDiff && !state.diffData) {
      container.innerHTML = '<div class="empty-state">Loading diff…</div>';
      summaryEl.textContent = '';
      return;
    }

    const allFiles = state.diffData?.files || [];
    const filter = state.fileFilter.trim().toLowerCase();
    const files = filter
      ? allFiles.filter((f) => f.path.toLowerCase().includes(filter))
      : allFiles;

    summaryEl.innerHTML = `${files.length} file${files.length === 1 ? '' : 's'} · <span class="stat-add">+${state.diffData?.totalAdditions || 0}</span> <span class="stat-del">-${state.diffData?.totalDeletions || 0}</span>`;

    if (files.length === 0) {
      container.innerHTML = `<div class="empty-state">No changes in <strong>${esc(state.diffMode)}</strong> view.</div>`;
      return;
    }

    container.innerHTML = files
      .map((f) => {
        const collapsed = state.collapsedFiles.has(f.path);
        const fullFilePath = `${wt.path}/${f.path}`;
        const statusLabel = f.status === 'U' ? '?' : f.status;
        const pathLabel = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
        const stateBadges = [];
        if (state.diffMode === 'dirty' && f.dirtyState) {
          if (f.dirtyState.staged) {
            stateBadges.push('<span class="status-pill ahead">staged</span>');
          }
          if (f.dirtyState.unstaged) {
            stateBadges.push('<span class="status-pill dirty">unstaged</span>');
          }
          if (f.dirtyState.untracked) {
            stateBadges.push('<span class="status-pill focused">untracked</span>');
          }
        }

        let bodyHtml = '';
        if (!collapsed) {
          if (f.isBinary) {
            bodyHtml = '<div class="file-hunks"><div class="empty-state">Binary or large file not shown</div></div>';
          } else if (f.hunks.length === 0) {
            bodyHtml = '<div class="file-hunks"><div class="empty-state">Empty file or mode-only change</div></div>';
          } else {
            const hunksHtml = f.hunks
              .map((h) => {
                const rowsHtml = h.lines
                  .map((ln) => {
                    const cls =
                      ln.type === 'add'
                        ? 'line-add'
                        : ln.type === 'del'
                        ? 'line-del'
                        : 'line-ctx';
                    const prefix = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';
                    return `<tr class="diff-line ${cls}">
                      <td class="line-num">${ln.oldNo ?? ''}</td>
                      <td class="line-num">${ln.newNo ?? ''}</td>
                      <td class="line-prefix">${prefix}</td>
                      <td class="line-code">${esc(ln.text)}</td>
                    </tr>`;
                  })
                  .join('');
                return `
                  <div class="hunk-block">
                    <div class="hunk-header">${esc(h.header)}</div>
                    <table class="diff-table"><tbody>${rowsHtml}</tbody></table>
                  </div>`;
              })
              .join('');
            bodyHtml = `<div class="file-hunks">${hunksHtml}</div>`;
          }
        }

        return `
          <div class="file-card" data-file-path="${esc(f.path)}">
            <div class="file-card-header" data-toggle-file="${esc(f.path)}">
              <div class="file-card-left">
                <span>${collapsed ? '&#9656;' : '&#9662;'}</span>
                <span class="file-status st-${esc(f.status)}">${esc(statusLabel)}</span>
                <span class="file-path" title="${esc(pathLabel)}">${esc(pathLabel)}</span>
              </div>
              <div class="file-card-right">
                ${stateBadges.join('')}
                <span class="stat-add">+${f.additions}</span>
                <span class="stat-del">-${f.deletions}</span>
                <button type="button" class="ghost-btn sm" data-open-file="${esc(fullFilePath)}" title="Open in File Viewer">Open</button>
              </div>
            </div>
            ${bodyHtml}
          </div>`;
      })
      .join('');
  }

  async function loadDiffForSelected() {
    if (!state.selectedPath) {
      state.diffData = null;
      renderDetail();
      return;
    }
    const wt = state.worktrees.find((w) => w.path === state.selectedPath);
    if (!wt || !wt.existsOnDisk) {
      state.diffData = null;
      renderDetail();
      return;
    }

    state.loadingDiff = true;
    renderDetail();
    try {
      const data = await apiGet('/api/diff', {
        path: wt.path,
        mode: state.diffMode,
        baseRef: wt.baseRef,
        commit: state.selectedCommit,
      });
      if (state.selectedPath === wt.path) {
        state.diffData = data;
      }
    } catch (err) {
      showToast(`Diff error: ${err.message}`);
    } finally {
      state.loadingDiff = false;
      renderDetail();
    }
  }

  function ensureSelection(newFocusedPath, newFocusedStep) {
    const visible = state.worktrees;
    if (visible.length === 0) {
      state.selectedPath = '';
      state.diffData = null;
      renderDetail();
      return;
    }

    // If the agent issued a newer focus/register action in the trajectory, follow it
    if (
      newFocusedPath &&
      typeof newFocusedStep === 'number' &&
      newFocusedStep > state.lastFocusedStep &&
      visible.some((w) => w.path === newFocusedPath)
    ) {
      state.lastFocusedStep = newFocusedStep;
      if (state.selectedPath !== newFocusedPath) {
        state.selectedPath = newFocusedPath;
        state.selectedCommit = '';
        state.collapsedFiles.clear();
      }
    } else if (!visible.some((w) => w.path === state.selectedPath)) {
      state.selectedPath = state.focusedPath || visible[0].path;
      state.selectedCommit = '';
      state.collapsedFiles.clear();
    }

    renderWorktreeList();
    loadDiffForSelected();
  }

  async function refreshAll() {
    try {
      const data = await apiGet('/api/worktrees', {
        conversationId: state.conversationId,
      });
      state.worktrees = data.worktrees || [];
      state.focusedPath = data.focusedPath || '';
      state.isForkedSession = Boolean(data.isForkedSession);
      state.parentConversationId = data.parentConversationId || '';

      renderWorktreeList();
      ensureSelection(data.focusedPath || '', Number(data.focusedStep ?? -1));
    } catch (err) {
      $('worktree-list').innerHTML = `<div class="empty-state">Error loading session worktrees: ${esc(err.message)}</div>`;
    }
  }

  function openInNativeFileViewer(absPath) {
    const fileUri = absPath.startsWith('file://') ? absPath : `file://${absPath}`;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'toggle-aux-pane', payload: { tabType: 'fileView', uri: fileUri } },
        '*'
      );
      showToast(`Opened ${absPath.split('/').pop()}`);
    } else {
      navigator.clipboard?.writeText(absPath);
      showToast(`Copied path: ${absPath}`);
    }
  }

  document.addEventListener('click', async (e) => {
    const wtCard = e.target.closest('[data-wt-path]');
    if (wtCard) {
      const nextPath = wtCard.dataset.wtPath;
      if (state.selectedPath !== nextPath) {
        state.selectedPath = nextPath;
        state.selectedCommit = '';
        state.collapsedFiles.clear();
        renderWorktreeList();
        await loadDiffForSelected();
      }
      return;
    }

    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      state.diffMode = modeBtn.dataset.mode;
      state.selectedCommit = '';
      await loadDiffForSelected();
      return;
    }

    const clearCommitBtn = e.target.closest('[data-clear-commit]');
    if (clearCommitBtn) {
      state.selectedCommit = '';
      await loadDiffForSelected();
      return;
    }

    const commitRow = e.target.closest('[data-commit-sha]');
    if (commitRow) {
      const sha = commitRow.dataset.commitSha;
      state.selectedCommit = state.selectedCommit === sha ? '' : sha;
      await loadDiffForSelected();
      return;
    }

    const openFileBtn = e.target.closest('[data-open-file]');
    if (openFileBtn) {
      e.stopPropagation();
      openInNativeFileViewer(openFileBtn.dataset.openFile);
      return;
    }

    const toggleFileHdr = e.target.closest('[data-toggle-file]');
    if (toggleFileHdr) {
      const fp = toggleFileHdr.dataset.toggleFile;
      if (state.collapsedFiles.has(fp)) state.collapsedFiles.delete(fp);
      else state.collapsedFiles.add(fp);
      const wt = state.worktrees.find((w) => w.path === state.selectedPath);
      if (wt) renderDiffFiles(wt);
      return;
    }
  });

  $('btn-refresh')?.addEventListener('click', () => {
    showToast('Refreshing session worktrees…');
    refreshAll();
  });

  $('chk-live')?.addEventListener('change', (e) => {
    state.live = e.target.checked;
  });

  $('file-filter')?.addEventListener('input', (e) => {
    state.fileFilter = e.target.value || '';
    const wt = state.worktrees.find((w) => w.path === state.selectedPath);
    if (wt) renderDiffFiles(wt);
  });

  $('btn-expand-all')?.addEventListener('click', () => {
    state.collapsedFiles.clear();
    const wt = state.worktrees.find((w) => w.path === state.selectedPath);
    if (wt) renderDiffFiles(wt);
  });

  $('btn-collapse-all')?.addEventListener('click', () => {
    for (const f of state.diffData?.files || []) {
      state.collapsedFiles.add(f.path);
    }
    const wt = state.worktrees.find((w) => w.path === state.selectedPath);
    if (wt) renderDiffFiles(wt);
  });

  $('btn-copy-wt-path')?.addEventListener('click', async () => {
    if (!state.selectedPath) return;
    try {
      await navigator.clipboard.writeText(state.selectedPath);
      showToast('Copied worktree path');
    } catch {
      showToast(state.selectedPath);
    }
  });

  async function init() {
    state.conversationId = resolveConversationId();
    if (state.conversationId) {
      const badge = $('conv-badge');
      badge.textContent = `conv:${state.conversationId.slice(0, 8)}`;
      badge.classList.remove('hidden');
    }

    await refreshAll();

    setInterval(() => {
      if (state.live && !document.hidden) {
        refreshAll();
      }
    }, POLL_INTERVAL_MS);
  }

  init();
})();
