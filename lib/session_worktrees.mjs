/**
 * @fileoverview Per-chat session worktree metadata resolver.
 *
 * Derives the active and focused Git worktrees for a conversation purely
 * from the conversation's Trajectory steps (`CORTEX_STEP_TYPE_MCP_TOOL` calls to
 * `worktree_*`) via the Language Server RPC API.
 *
 * Because client-side session forking (`ForkCascade` / `BranchCascade`)
 * branches the conversation trajectory up to `forkIndex`, any worktrees
 * registered or focused prior to the fork point are automatically inherited by
 * the forked session without relying on any filesystem markers or state files.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const HOME = homedir();
const WORKTREE_TOOL_RE =
  /(?:^|_)(worktree_(?:register|focus|unregister|list|add|remove))$/;

let cachedLsConn = null;

/**
 * Normalizes a worktree path (`file://`, `~/`, relative, trailing slashes).
 * Does not require the path to exist on disk so metadata remains independent
 * of filesystem state.
 */
export function normalizeWorktreePath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      trimmed = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, '');
    }
  } else if (trimmed === '~') {
    trimmed = HOME;
  } else if (trimmed.startsWith('~/')) {
    trimmed = join(HOME, trimmed.slice(2));
  }
  const resolved = resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/**
 * Discovers the running Language Server address and CSRF token from
 * process environment or `/proc/<pid>/environ`.
 */
export function resolveLanguageServerConnection() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (envAddr && envCsrf) {
    return { address: envAddr, csrfToken: envCsrf };
  }
  if (cachedLsConn?.address && cachedLsConn?.csrfToken) {
    return cachedLsConn;
  }

  try {
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      try {
        const raw = readFileSync(`/proc/${pid}/environ`, 'utf-8');
        if (!raw.includes('ANTIGRAVITY_LS_ADDRESS=')) continue;
        let address = '';
        let csrfToken = '';
        for (const entry of raw.split('\0')) {
          if (entry.startsWith('ANTIGRAVITY_LS_ADDRESS=')) {
            address = entry.slice('ANTIGRAVITY_LS_ADDRESS='.length).trim();
          } else if (entry.startsWith('ANTIGRAVITY_CSRF_TOKEN=')) {
            csrfToken = entry.slice('ANTIGRAVITY_CSRF_TOKEN='.length).trim();
          }
        }
        if (address && csrfToken) {
          cachedLsConn = { address, csrfToken };
          return cachedLsConn;
        }
      } catch {
        // Ignore unreadable proc entries
      }
    }
  } catch {
    // Ignore /proc scan errors
  }

  return { address: envAddr, csrfToken: envCsrf };
}

/**
 * Calls a method on `exa.language_server_pb.LanguageServerService`.
 */
export async function callLanguageServerRpc(method, payload = {}, timeoutMs = 4000) {
  const { address, csrfToken } = resolveLanguageServerConnection();
  if (!address) {
    return { ok: false, status: 0, data: null, error: 'Language Server address not found' };
  }
  let baseUrl = address;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;

  const headers = { 'Content-Type': 'application/json' };
  if (csrfToken) {
    headers['x-codeium-csrf-token'] = csrfToken;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    // Clear cached connection on network failure in case Language Server restarted
    cachedLsConn = null;
    return { ok: false, status: 0, data: null, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches all trajectory steps and fork lineage metadata for `conversationId`.
 */
export async function fetchConversationTrajectory(conversationId) {
  if (!conversationId) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }
  const res = await callLanguageServerRpc('GetCascadeTrajectory', {
    cascadeId: conversationId,
  });
  if (!res.ok || !res.data?.trajectory) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }

  const trajectory = res.data.trajectory;
  const steps = Array.isArray(trajectory.steps) ? [...trajectory.steps] : [];
  const totalSteps = Number(
    res.data.numTotalSteps ?? res.data.num_total_steps ?? trajectory.numTotalSteps ?? steps.length
  );

  while (steps.length < totalSteps) {
    const pageRes = await callLanguageServerRpc('GetCascadeTrajectorySteps', {
      cascadeId: conversationId,
      stepOffset: steps.length,
    });
    const pageSteps = pageRes.data?.steps;
    if (!pageRes.ok || !Array.isArray(pageSteps) || pageSteps.length === 0) {
      break;
    }
    steps.push(...pageSteps);
  }

  return {
    ok: true,
    steps,
    parentReferences: Array.isArray(trajectory.parentReferences)
      ? trajectory.parentReferences
      : [],
    metadata: trajectory.metadata || {},
  };
}

/**
 * Extracts normalized `worktree_*` action from a trajectory step, or null.
 */
function extractWorktreeStepAction(step) {
  if (!step) return null;
  const status = step.status || '';
  if (
    status === 'CORTEX_STEP_STATUS_ERROR' ||
    status === 'CORTEX_STEP_STATUS_FAILED' ||
    status === 'CORTEX_STEP_STATUS_CANCELED'
  ) {
    return null;
  }

  if (
    step.type === 'CORTEX_STEP_TYPE_MCP_TOOL' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const mcpTool = step.mcpTool || step.mcp_tool;
    const toolCall =
      mcpTool?.toolCall ||
      mcpTool?.tool_call ||
      step.metadata?.toolCall ||
      step.metadata?.tool_call;
    const rawName = toolCall?.name || '';
    const match = WORKTREE_TOOL_RE.exec(rawName);
    if (match) {
      const canonicalTool = match[1];
      let args = {};
      const argsJson = toolCall?.argumentsJson ?? toolCall?.arguments_json ?? '';
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          return null;
        }
      } else if (argsJson && typeof argsJson === 'object') {
        args = argsJson;
      }

      return {
        toolCallId: toolCall?.id || '',
        toolName: canonicalTool,
        args,
        createdAt: step.metadata?.createdAt || '',
      };
    }
  }

  // Fallback for same-turn bootstrap or subagent CLI invocation:
  // `worktree_mcp.mjs --cli worktree_register '<json>'`
  if (
    step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const metaToolCall = step.metadata?.toolCall || step.metadata?.tool_call;
    const argsJson = metaToolCall?.argumentsJson ?? metaToolCall?.arguments_json ?? '';
    let cmdLine = '';
    if (typeof argsJson === 'string' && argsJson.includes('worktree_')) {
      try {
        const parsed = JSON.parse(argsJson);
        cmdLine = parsed.CommandLine || '';
      } catch {
        return null;
      }
    }
    if (!cmdLine) return null;
    const cliMatch =
      /--cli\s+(?:[a-z0-9_]*_)?(worktree_(?:register|focus|unregister|list))\s+'([^']+)'/.exec(
        cmdLine
      );
    if (!cliMatch) return null;
    try {
      const args = JSON.parse(cliMatch[2]);
      return {
        toolCallId: metaToolCall?.id || '',
        toolName: cliMatch[1],
        args,
        createdAt: step.metadata?.createdAt || '',
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Applies a single `worktree_*` action onto the session worktree state.
 */
export function applyWorktreeAction(state, action, stepIndex, isInheritedFromFork = false) {
  const { toolName, args, createdAt } = action;
  const rawPath = args.path || args.worktree_path || args.worktreePath || '';
  const wtPath = normalizeWorktreePath(rawPath);

  if (
    toolName === 'worktree_register' ||
    toolName === 'worktree_add'
  ) {
    if (!wtPath) return;
    const prev = state.entries.get(wtPath);
    const baseRef = String(args.base_ref ?? args.baseRef ?? prev?.baseRef ?? '').trim();
    const label = String(args.label ?? args.description ?? prev?.label ?? '').trim();
    const shouldFocus = args.focus !== false;

    state.entries.set(wtPath, {
      path: wtPath,
      baseRef,
      label,
      registeredStep: prev ? prev.registeredStep : stepIndex,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev?.updatedAt || '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    });

    if (shouldFocus || !state.focusedPath) {
      state.focusedPath = wtPath;
      state.focusedStep = stepIndex;
    }
    return;
  }

  if (toolName === 'worktree_focus') {
    if (!wtPath) return;
    const prev = state.entries.get(wtPath);
    const baseRef = String(args.base_ref ?? args.baseRef ?? prev?.baseRef ?? '').trim();
    const label = String(args.label ?? args.description ?? prev?.label ?? '').trim();

    state.entries.set(wtPath, {
      path: wtPath,
      baseRef,
      label,
      registeredStep: prev ? prev.registeredStep : stepIndex,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev?.updatedAt || '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    });
    state.focusedPath = wtPath;
    state.focusedStep = stepIndex;
    return;
  }

  if (
    toolName === 'worktree_unregister' ||
    toolName === 'worktree_remove'
  ) {
    if (!wtPath) return;
    state.entries.delete(wtPath);
    if (state.focusedPath === wtPath) {
      let nextFocus = '';
      let bestStep = -1;
      for (const item of state.entries.values()) {
        if (item.updatedStep >= bestStep) {
          bestStep = item.updatedStep;
          nextFocus = item.path;
        }
      }
      state.focusedPath = nextFocus;
      state.focusedStep = stepIndex;
    }
  }
}

/**
 * Folds all `worktree_*` MCP tool calls in a conversation's trajectory
 * to produce the current per-session worktree state.
 *
 * @param {string} conversationId
 * @param {?Object=} pendingAction Optional in-flight action being executed by the MCP server
 */
export async function getSessionWorktreeState(conversationId, pendingAction = null) {
  const traj = await fetchConversationTrajectory(conversationId);
  const steps = traj.steps || [];

  // Detect fork boundary step index if this conversation was forked in the client
  let forkBoundaryStep = -1;
  let parentConversationId = '';
  if (traj.parentReferences.length > 0) {
    const lastRef = traj.parentReferences[traj.parentReferences.length - 1];
    parentConversationId =
      lastRef.conversationId ||
      lastRef.conversation_id ||
      lastRef.cascadeId ||
      lastRef.cascade_id ||
      '';
    const refIdx = Number(lastRef.stepIndex ?? lastRef.step_index ?? -1);
    if (Number.isFinite(refIdx) && refIdx >= 0) {
      forkBoundaryStep = refIdx;
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const sysMsg = steps[i]?.systemMessage || steps[i]?.system_message;
    if (sysMsg?.eventType === 'FORK_NOTICE' || sysMsg?.event_type === 'FORK_NOTICE') {
      forkBoundaryStep = i;
    }
  }

  const state = {
    entries: new Map(),
    focusedPath: '',
    focusedStep: -1,
    seenToolCallIds: new Set(),
  };

  for (let i = 0; i < steps.length; i++) {
    const action = extractWorktreeStepAction(steps[i]);
    if (!action) continue;
    if (action.toolCallId) {
      state.seenToolCallIds.add(action.toolCallId);
    }
    const isInherited = forkBoundaryStep >= 0 && i <= forkBoundaryStep;
    applyWorktreeAction(state, action, i, isInherited);
  }

  // If called from inside the MCP tool handler before the step is flushed to
  // the trajectory reader, apply `pendingAction` idempotently.
  if (
    pendingAction &&
    (!pendingAction.toolCallId || !state.seenToolCallIds.has(pendingAction.toolCallId))
  ) {
    applyWorktreeAction(state, pendingAction, steps.length, false);
  }

  const worktrees = [...state.entries.values()].map((item) => ({
    ...item,
    isFocused: item.path === state.focusedPath,
    existsOnDisk: existsSync(item.path),
  }));

  worktrees.sort((a, b) => {
    if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
    if (b.updatedStep !== a.updatedStep) return b.updatedStep - a.updatedStep;
    return a.path.localeCompare(b.path);
  });

  return {
    conversationId,
    focusedPath: state.focusedPath,
    focusedStep: state.focusedStep,
    isForkedSession: forkBoundaryStep >= 0 || Boolean(parentConversationId),
    parentConversationId,
    forkBoundaryStep,
    worktrees,
  };
}
