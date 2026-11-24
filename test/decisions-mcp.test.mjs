import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MCP_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'decisions-mcp.mjs');
const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

test('decisions-mcp stdio server handles initialize, tools/list, search, get, update, and summary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-decisions-mcp-test-'));
  const agyDir = path.join(root, '.gemini', 'antigravity');
  const brainDir = path.join(agyDir, 'brain');
  const projectsDir = path.join(root, '.gemini', 'config', 'projects');
  const workspaceDir = path.join(root, 'work', 'CheckoutService');
  const dbPath = path.join(agyDir, 'anti-claude', 'decisions.db');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const cid = '33333333-3333-4333-8333-333333333333';
  const pid = 'proj-checkout';
  const wsUri = pathToFileURL(workspaceDir).href;

  fs.writeFileSync(
    path.join(projectsDir, `${pid}.json`),
    JSON.stringify({ id: pid, name: 'CheckoutService', folderUris: [wsUri] }),
    'utf8'
  );

  const sdb = new DatabaseSync(path.join(agyDir, 'conversation_summaries.db'));
  sdb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      last_modified_time TEXT NOT NULL DEFAULT ""
    );
  `);
  sdb
    .prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, project_id, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?, ?)'
    )
    .run(cid, '支付缓存选型讨论', pid, JSON.stringify([wsUri]), '2026-11-24T16:00:00Z');
  sdb.close();

  const logsDir = path.join(brainDir, cid, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const qStr = JSON.stringify([
    {
      question: '幂等锁使用哪种存储方案？',
      is_multi_select: false,
      options: ['(Recommended) Redis SET NX EX', 'PostgreSQL 唯一索引约束', '本地内存锁']
    }
  ]);
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-24T15:50:00Z',
        tool_calls: [{ name: 'ask_question', args: { questions: qStr } }]
      }),
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        created_at: '2026-11-24T15:51:00Z',
        content: 'Created At: 2026-11-24T23:51:00+08:00\nA1: (Recommended) Redis SET NX EX'
      })
    ].join('\n') + '\n',
    'utf8'
  );

  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: Object.assign({}, process.env, {
      HOME: root,
      ANTI_CLAUDE_AGY_DIR: agyDir,
      ANTI_CLAUDE_PROJECTS_DIR: projectsDir,
      ANTI_CLAUDE_DECISIONS_DB: dbPath,
      ANTI_CLAUDE_SYNC_MARKDOWN: '1'
    }),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const rpc = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout for ${method}`)), 5000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const initRes = await rpc(1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initRes.result.serverInfo.name, 'anti-claude-decisions');

    /* Notification should not block or error */
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listToolsRes = await rpc(2, 'tools/list');
    const toolNames = listToolsRes.result.tools.map((t) => t.name);
    assert.deepEqual(toolNames, [
      'search_decisions',
      'get_decision_detail',
      'update_decision',
      'list_project_decisions_summary'
    ]);

    const searchRes = await rpc(3, 'tools/call', {
      name: 'search_decisions',
      arguments: { query: '幂等锁', workspace_path: workspaceDir }
    });
    assert.equal(searchRes.result.isError, false);
    const searchData = JSON.parse(searchRes.result.content[0].text);
    assert.equal(searchData.total, 1);
    const decId = searchData.items[0].id;
    assert.equal(decId, `${cid}:2:0`);

    const updateRes = await rpc(4, 'tools/call', {
      name: 'update_decision',
      arguments: {
        decision_id: decId,
        new_option_index: 1,
        reason: '避免引入额外 Redis 依赖，利用现有 PG 事务即可保证强一致',
        user_note: '压测 QPS < 2000 时完全够用'
      }
    });
    const updateData = JSON.parse(updateRes.result.content[0].text);
    assert.equal(updateData.ok, true);
    assert.equal(updateData.decision.reviewStatus, 'changed');
    assert.equal(updateData.decision.currentChoice, 'PostgreSQL 唯一索引约束');

    const detailRes = await rpc(5, 'tools/call', {
      name: 'get_decision_detail',
      arguments: { decision_id: decId }
    });
    const detailData = JSON.parse(detailRes.result.content[0].text);
    assert.equal(detailData.revisions.length, 1);
    assert.match(detailData.revisitPrompt, /PostgreSQL 唯一索引约束/);

    const sumRes = await rpc(6, 'tools/call', {
      name: 'list_project_decisions_summary',
      arguments: { workspace_path: workspaceDir }
    });
    const sumData = JSON.parse(sumRes.result.content[0].text);
    assert.equal(sumData.counts.changed, 1);
    assert.equal(sumData.changed.length, 1);
    assert.equal(fs.existsSync(path.join(workspaceDir, '.anti-claude', 'decisions.md')), true);
  } finally {
    child.stdin.end();
    rl.close();
    child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
