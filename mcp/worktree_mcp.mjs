/**
 * @fileoverview Stdio MCP Server for `worktree-inspector`.
 *
 * Exposes `worktree_*` tools so the agent can report created, focused,
 * or unregistered Git worktrees for the active chat session.
 *
 * All session state is persisted natively inside the per-conversation
 * Trajectory (`CortexStepMcpTool` steps) rather than on the filesystem, so it
 * is automatically inherited when a chat session is forked in the client.
 */

import { createInterface } from 'node:readline';
import {
  getSessionWorktreeState,
  normalizeWorktreePath,
} from '../lib/session_worktrees.mjs';

const SERVER_INFO = {
  name: 'worktree',
  version: '0.3.0',
};

const TOOLS = [
  {
    name: 'worktree_register',
    description:
      'Register a created or existing Git worktree in the current chat session metadata (and focus it by default). Tracked purely in per-session trajectory metadata and inherited across client-side session forks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the Git worktree directory (absolute or ~/...).',
        },
        base_ref: {
          type: 'string',
          description:
            'Optional base Git ref/branch to compare against (e.g. "origin/main", "release/0.0.1"). Auto-detected if omitted.',
        },
        label: {
          type: 'string',
          description:
            'Optional short task label describing what this worktree is used for in this conversation.',
        },
        focus: {
          type: 'boolean',
          description:
            'Whether to make this worktree the currently focused worktree in the UI (defaults to true).',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'worktree_focus',
    description:
      'Set the active focused Git worktree for the current chat session (registers it in the session metadata if not already tracked).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the Git worktree directory to focus.',
        },
        base_ref: {
          type: 'string',
          description: 'Optional updated base Git ref/branch to compare against.',
        },
        label: {
          type: 'string',
          description: 'Optional updated short task label for this worktree.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'worktree_unregister',
    description:
      'Unregister a Git worktree from the current chat session metadata without modifying files on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the Git worktree directory to remove from session tracking.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'worktree_list',
    description:
      'List all Git worktrees currently tracked in the active chat session metadata, including the focused worktree and any worktrees inherited from a forked parent session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
];

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(params) {
  const rawToolName = params?.name || '';
  const args = params?.arguments || {};
  const meta = params?._meta || {};
  const conversationId =
    meta['antigravity.google/conversation_id'] ||
    args.conversation_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    '';

  const match = /(?:^|_)(worktree_(?:register|focus|unregister|list))$/.exec(
    rawToolName
  );
  const toolName = match ? match[1] : rawToolName;

  if (
    toolName === 'worktree_register' ||
    toolName === 'worktree_focus' ||
    toolName === 'worktree_unregister'
  ) {
    const wtPath = normalizeWorktreePath(args.path || '');
    if (!wtPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Missing required argument: `path`.' }],
      };
    }

    const pendingAction = {
      toolName,
      args: { ...args, path: wtPath },
      createdAt: new Date().toISOString(),
    };
    const state = await getSessionWorktreeState(conversationId, pendingAction);

    const actionVerb =
      toolName === 'worktree_unregister'
        ? 'Unregistered'
        : toolName === 'worktree_focus'
        ? 'Focused'
        : 'Registered';

    const payload = {
      ok: true,
      action: toolName,
      message: `${actionVerb} worktree ${wtPath} in session ${conversationId || '(active)'}`,
      conversationId,
      focusedPath: state.focusedPath,
      trackedCount: state.worktrees.length,
      worktrees: state.worktrees,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (toolName === 'worktree_list') {
    const state = await getSessionWorktreeState(conversationId, null);
    const payload = {
      ok: true,
      conversationId,
      isForkedSession: state.isForkedSession,
      parentConversationId: state.parentConversationId,
      focusedPath: state.focusedPath,
      trackedCount: state.worktrees.length,
      worktrees: state.worktrees,
    };
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${rawToolName}` }],
  };
}

if (process.argv[2] === '--cli') {
  const cliToolName = process.argv[3] || '';
  const cliArgsRaw = process.argv[4] || '{}';
  let cliArgs = {};
  try {
    cliArgs = JSON.parse(cliArgsRaw);
  } catch (err) {
    console.error(`Invalid JSON arguments: ${err.message}`);
    process.exit(1);
  }
  handleToolCall({
    name: cliToolName,
    arguments: cliArgs,
  }).then((res) => {
    const text = res.content?.[0]?.text || '';
    if (res.isError) {
      console.error(text);
      process.exit(1);
    }
    console.log(text);
    process.exit(0);
  });
} else {
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }

    // Notifications have no `id`
    if (msg.id === undefined || msg.id === null) {
      return;
    }

    try {
      switch (msg.method) {
        case 'initialize': {
          const clientProtocol = msg.params?.protocolVersion || '2024-11-05';
          sendResult(msg.id, {
            protocolVersion: clientProtocol,
            capabilities: {
              tools: {},
            },
            serverInfo: SERVER_INFO,
          });
          break;
        }
        case 'ping': {
          sendResult(msg.id, {});
          break;
        }
        case 'tools/list': {
          sendResult(msg.id, { tools: TOOLS });
          break;
        }
        case 'tools/call': {
          const result = await handleToolCall(msg.params || {});
          sendResult(msg.id, result);
          break;
        }
        default: {
          sendError(msg.id, -32601, `Method not found: ${msg.method}`);
          break;
        }
      }
    } catch (err) {
      sendError(msg.id, -32603, err?.message || String(err));
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
