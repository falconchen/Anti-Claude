#!/usr/bin/env node
/**
 * Anti-Claude — mcp/decisions-mcp.mjs
 * Zero-dependency MCP stdio server (JSON-RPC 2.0 over NDJSON) for querying and updating
 * archived Antigravity `ask_question` decisions & revision histories.
 */

import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DECISION_STATUSES, DecisionStore } from '../core/decisions.mjs';

const __filename = fileURLToPath(import.meta.url);

export const MCP_TOOLS = [
  {
    name: 'search_decisions',
    description:
      'Search and filter past ask_question decisions across Antigravity conversations. Returns full original options, initial/current choices, live conversation titles, conversation IDs, review status, notes, and revision histories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword search across question, options, choices, notes, project name, and conversation title.'
        },
        project_id: {
          type: 'string',
          description: 'Optional Antigravity project ID (or "__unassigned__" for outside-of-project conversations).'
        },
        project_name: {
          type: 'string',
          description: 'Optional case-insensitive project name filter.'
        },
        workspace_path: {
          type: 'string',
          description: 'Optional absolute local workspace directory path to filter decisions belonging to that project.'
        },
        conversation_id: {
          type: 'string',
          description: 'Optional exact conversation UUID.'
        },
        review_status: {
          type: 'string',
          enum: ['all', ...DECISION_STATUSES],
          description: 'Filter by review status: decided, uncertain, changed, skipped, pending, or all.'
        },
        limit: {
          type: 'integer',
          description: 'Max number of decisions to return (default 20, max 100).'
        }
      }
    }
  },
  {
    name: 'get_decision_detail',
    description:
      'Retrieve complete details for a specific decision (by decision_id) or all decisions in a conversation (by conversation_id), including all unselected alternatives, sibling questions from the same round, revision history, and a structured revisit prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: {
          type: 'string',
          description: 'Deterministic decision ID in format "<conversation_id>:<step_index>:<question_index>".'
        },
        conversation_id: {
          type: 'string',
          description: 'Conversation UUID to retrieve all decisions made in that conversation.'
        }
      }
    }
  },
  {
    name: 'update_decision',
    description:
      'Update a recorded decision status/note or record a new decision revision (from_choice -> to_choice with reason). Automatically persists to decisions.db and syncs <project>/.anti-claude/decisions.md.',
    inputSchema: {
      type: 'object',
      required: ['decision_id'],
      properties: {
        decision_id: {
          type: 'string',
          description: 'Target decision ID.'
        },
        review_status: {
          type: 'string',
          enum: DECISION_STATUSES,
          description: 'Optional new review status (e.g. "uncertain", "decided", "changed").'
        },
        user_note: {
          type: 'string',
          description: 'Optional review note or revisit condition.'
        },
        new_choice: {
          type: 'string',
          description: 'If changing the decision, the new chosen option label or custom decision text.'
        },
        new_option_index: {
          type: 'integer',
          description: 'Optional 0-based index into the original options array if switching to a previous alternative.'
        },
        reason: {
          type: 'string',
          description: 'Reason for changing the decision (recorded in revision history).'
        },
        changed_in_conversation_id: {
          type: 'string',
          description: 'Optional conversation UUID where this revision was decided.'
        }
      }
    }
  },
  {
    name: 'list_project_decisions_summary',
    description:
      'Return a compact summary of decisions for a project (counts by status, all uncertain and changed decisions, recent decisions, and local .anti-claude/decisions.md path).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional Antigravity project ID.' },
        project_name: { type: 'string', description: 'Optional project name substring.' },
        workspace_path: { type: 'string', description: 'Optional absolute workspace folder path.' }
      }
    }
  }
];

export function createMcpHandler(store) {
  const safeSync = () => {
    try {
      store.syncFromTranscripts();
    } catch {}
  };

  function handleToolCall(name, args = {}) {
    if (name === 'search_decisions') {
      safeSync();
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      return store.listDecisions({
        search: args.query || '',
        projectId: args.project_id || '',
        projectName: args.project_name || '',
        workspacePath: args.workspace_path || '',
        conversationId: args.conversation_id || '',
        status: args.review_status && args.review_status !== 'all' ? args.review_status : '',
        limit,
        offset: 0,
        includeRevisions: true
      });
    }

    if (name === 'get_decision_detail') {
      safeSync();
      return store.getDecisionDetail({
        decisionId: args.decision_id || '',
        conversationId: args.conversation_id || ''
      });
    }

    if (name === 'update_decision') {
      safeSync();
      const id = String(args.decision_id || '').trim();
      if (!id) return { ok: false, error: 'missing_decision_id' };

      const hasRevision =
        (typeof args.new_choice === 'string' && args.new_choice.trim().length > 0) ||
        (args.new_option_index !== undefined && args.new_option_index !== null);

      let result = null;
      if (hasRevision) {
        result = store.addDecisionRevision({
          id,
          toChoice: args.new_choice || '',
          toOptionIndex: args.new_option_index ?? null,
          reason: args.reason || '',
          changedInConversationId: args.changed_in_conversation_id || ''
        });
        if (!result.ok) return result;
      }

      if (args.review_status !== undefined || args.user_note !== undefined) {
        const metaRes = store.updateDecisionMeta({
          id,
          reviewStatus: hasRevision && args.review_status === undefined ? undefined : args.review_status,
          userNote: args.user_note
        });
        if (!metaRes.ok) return metaRes;
        result = metaRes;
      }

      return result || { ok: false, error: 'no_fields_to_update' };
    }

    if (name === 'list_project_decisions_summary') {
      safeSync();
      return store.getProjectSummary({
        projectId: args.project_id || '',
        projectName: args.project_name || '',
        workspacePath: args.workspace_path || ''
      });
    }

    return { ok: false, error: `unknown_tool:${name}` };
  }

  return function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const { id, method, params } = msg;

    /* Notifications have no id and expect no reply */
    if (id === undefined || id === null) {
      return null;
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'anti-claude-decisions',
            version: '1.0.0'
          }
        }
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS }
      };
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const toolArgs = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const out = handleToolCall(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            isError: out?.ok === false
          }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(err?.message || err) }) }],
            isError: true
          }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(method || '')}`
      }
    };
  };
}

function createStoreFromEnv() {
  const home = process.env.HOME || os.homedir();
  const antigravityDir = process.env.ANTI_CLAUDE_AGY_DIR || path.join(home, '.gemini', 'antigravity');
  const projectsDir = process.env.ANTI_CLAUDE_PROJECTS_DIR || path.join(home, '.gemini', 'config', 'projects');
  const dbPath =
    process.env.ANTI_CLAUDE_DECISIONS_DB || path.join(antigravityDir, 'anti-claude', 'decisions.db');
  const syncMarkdown = process.env.ANTI_CLAUDE_SYNC_MARKDOWN !== '0';
  return new DecisionStore({ dbPath, antigravityDir, projectsDir, homeDir: home, syncMarkdown });
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
  } catch {
    return false;
  }
}

if (isMain()) {
  const store = createStoreFromEnv();
  const handleMessage = createMcpHandler(store);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const writeResponse = (resp) => {
    if (!resp) return;
    process.stdout.write(`${JSON.stringify(resp)}\n`);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      });
      return;
    }
    const resp = handleMessage(msg);
    writeResponse(resp);
  });

  const cleanup = () => {
    try {
      store.close();
    } catch {}
  };
  rl.on('close', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}
