import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  DecisionStore,
  formatDecisionRevisitPrompt,
  isSafeProjectWorkspace,
  matchAnswerToOptions,
  normalizeOptionItem,
  parseAnswerContent,
  parseTranscriptDecisions
} from '../core/decisions.mjs';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-decisions-test-'));
  const agyDir = path.join(root, '.gemini', 'antigravity');
  const brainDir = path.join(agyDir, 'brain');
  const projectsDir = path.join(root, '.gemini', 'config', 'projects');
  const workspaceDir = path.join(root, 'projects', 'Demo App');
  const dbPath = path.join(agyDir, 'anti-claude', 'decisions.db');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const sumDbPath = path.join(agyDir, 'conversation_summaries.db');
  const sdb = new DatabaseSync(sumDbPath);
  sdb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      workspace_uris TEXT NOT NULL DEFAULT "[]",
      last_modified_time TEXT NOT NULL DEFAULT ""
    );
  `);
  sdb.close();

  return { root, agyDir, brainDir, projectsDir, workspaceDir, dbPath, sumDbPath };
}

function writeTranscript(brainDir, cid, steps, fullSteps = null) {
  const logsDir = path.join(brainDir, cid, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const tPath = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(tPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  if (fullSteps) {
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      fullSteps.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );
  }
  return tPath;
}

test('option normalization & answer matching cover strings, dicts, multi-select commas, custom, skipped, pending', () => {
  const o1 = normalizeOptionItem('(Recommended) 严格隔离：仅查看自己名下（PIC）', 0);
  assert.equal(o1.recommended, true);
  assert.equal(o1.cleanLabel, '严格隔离：仅查看自己名下（PIC）');

  const o2 = normalizeOptionItem({ label: 'Option + Space', description: 'Classic iTerm2 hotkey' }, 1);
  assert.equal(o2.recommended, false);
  assert.equal(o2.label, 'Option + Space');
  assert.equal(o2.description, 'Classic iTerm2 hotkey');

  /* Multi-select with commas inside option labels */
  const multiOpts = [
    normalizeOptionItem('(Recommended) 方案 A，包含前端、后端与 SQLite', 0),
    normalizeOptionItem('方案 B，仅纯 Markdown 归档', 1),
    normalizeOptionItem('方案 C：独立工具', 2)
  ];
  const mRes = matchAnswerToOptions(
    '(Recommended) 方案 A，包含前端、后端与 SQLite, 方案 C：独立工具',
    multiOpts,
    true
  );
  assert.equal(mRes.answerKind, 'multi');
  assert.deepEqual(mRes.selectedIndices, [0, 2]);

  const skipRes = matchAnswerToOptions('User Skipped', multiOpts, false);
  assert.equal(skipRes.answerKind, 'skipped');

  const customRes = matchAnswerToOptions('先在1和3都加', multiOpts, false);
  assert.equal(customRes.answerKind, 'custom');
  assert.equal(customRes.currentChoice, '先在1和3都加');

  const pendRes = matchAnswerToOptions('', multiOpts, false);
  assert.equal(pendRes.answerKind, 'pending');

  const parsedAns = parseAnswerContent(
    'Created At: 2026-11-24T10:00:00+08:00\nCompleted At: 2026-11-24T10:01:00+08:00\nA1: 第一题答案\n第二行补充\nA2: User Skipped'
  );
  assert.equal(parsedAns.completedAt, '2026-11-24T10:01:00+08:00');
  assert.equal(parsedAns.answers.get(1), '第一题答案\n第二行补充');
  assert.equal(parsedAns.answers.get(2), 'User Skipped');
});

test('parseTranscriptDecisions recovers truncated tool_calls & content from transcript_full.jsonl', () => {
  const env = makeTempEnv();
  const cid = '11111111-1111-4111-8111-111111111111';
  const fullQuestions = JSON.stringify([
    {
      question: 'Sales 与 Editorial 的数据可见范围如何设定？',
      is_multi_select: false,
      options: ['(Recommended) 严格隔离', '默认筛本人', '全量可见可编']
    },
    {
      question: '登录页快捷 PIN 码如何处理？',
      is_multi_select: false,
      options: [
        { label: '(Recommended) 彻底移除 PIN 码', description: '统一白名单邮箱+密码' },
        { label: '保留现场 iPad 快捷 PIN 码', description: '仅 OnSite_Staff 可用' }
      ]
    }
  ]);

  const compactSteps = [
    {
      step_index: 10,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T15:00:00Z',
      truncated_fields: ['tool_calls'],
      tool_calls: [{ name: 'ask_question', args: { questions: '[truncated]' } }]
    },
    {
      step_index: 11,
      type: 'GENERIC',
      created_at: '2026-11-24T15:01:00Z',
      truncated_fields: ['content'],
      content: 'Created At: 2026-11-24T23:00:00+08:00\nA1: [truncated]'
    }
  ];

  const fullSteps = [
    {
      step_index: 10,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T15:00:00Z',
      tool_calls: [{ name: 'ask_question', args: { questions: fullQuestions } }]
    },
    {
      step_index: 11,
      type: 'GENERIC',
      created_at: '2026-11-24T15:01:00Z',
      content:
        'Created At: 2026-11-24T23:00:00+08:00\nCompleted At: 2026-11-24T23:01:12+08:00\nA1: 默认筛本人\nA2: 彻底移除 PIN 码'
    }
  ];

  const tPath = writeTranscript(env.brainDir, cid, compactSteps, fullSteps);
  const parsed = parseTranscriptDecisions(tPath, { conversationId: cid });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, `${cid}:10:0`);
  assert.equal(parsed[0].answerKind, 'preset');
  assert.equal(parsed[0].currentChoice, '默认筛本人');
  assert.equal(parsed[1].options[0].description, '统一白名单邮箱+密码');
  assert.equal(parsed[1].answerKind, 'preset');
  assert.equal(parsed[1].answeredAt, '2026-11-24T23:01:12+08:00');

  fs.rmSync(env.root, { recursive: true, force: true });
});

test('DecisionStore end-to-end: backfill, idempotency, live title tracking, revisions, CJK search, and dual-track MD sync', () => {
  const env = makeTempEnv();
  const projectId = 'proj-demo-001';
  const cid = '22222222-2222-4222-8222-222222222222';
  const wsUri = pathToFileURL(env.workspaceDir).href;

  fs.writeFileSync(
    path.join(env.projectsDir, `${projectId}.json`),
    JSON.stringify({
      id: projectId,
      name: 'Anniversary RSVP',
      projectResources: { resources: [{ folderUri: wsUri }] }
    }),
    'utf8'
  );

  const sdb = new DatabaseSync(env.sumDbPath);
  sdb
    .prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, project_id, workspace_uris, last_modified_time) VALUES (?, ?, ?, ?, ?)'
    )
    .run(cid, '初始对话标题', projectId, JSON.stringify([wsUri]), '2026-11-24T15:20:00Z');
  sdb.close();

  /* Step 1: Pending ask_question (no answer step yet) */
  const qPayload = JSON.stringify([
    {
      question: 'Sales 与 Editorial 的数据可见范围如何设定？',
      is_multi_select: false,
      options: ['(Recommended) 严格隔离：仅查看自己名下宾客', '默认筛本人：可看全量仅改本人', '全量可见可编']
    }
  ]);
  const callStep = {
    step_index: 5,
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-24T15:10:00Z',
    tool_calls: [{ name: 'ask_question', args: { questions: qPayload } }]
  };
  writeTranscript(env.brainDir, cid, [callStep]);

  const store = new DecisionStore({
    dbPath: env.dbPath,
    antigravityDir: env.agyDir,
    projectsDir: env.projectsDir,
    homeDir: env.root,
    syncMarkdown: true
  });

  const sync1 = store.syncFromTranscripts();
  assert.equal(sync1.ok, true);
  assert.equal(sync1.upsertedDecisions, 1);

  const list1 = store.listDecisions();
  assert.equal(list1.total, 1);
  assert.equal(list1.items[0].reviewStatus, 'pending');
  assert.equal(list1.items[0].currentTitle, '初始对话标题');
  assert.equal(list1.items[0].projectName, 'Anniversary RSVP');

  /* Step 2: User submits answer -> transcript updates -> pending promotes to decided */
  const ansStep = {
    step_index: 6,
    type: 'GENERIC',
    created_at: '2026-11-24T15:11:00Z',
    content: 'Created At: 2026-11-24T23:11:00+08:00\nCompleted At: 2026-11-24T23:12:00+08:00\nA1: (Recommended) 严格隔离：仅查看自己名下宾客'
  };
  writeTranscript(env.brainDir, cid, [callStep, ansStep]);

  const sync2 = store.syncFromTranscripts();
  assert.equal(sync2.updatedFiles, 1);

  const detail = store.getDecisionDetail({ decisionId: `${cid}:5:0` });
  assert.equal(detail.ok, true);
  assert.equal(detail.decision.reviewStatus, 'decided');
  assert.equal(detail.decision.answerKind, 'preset');

  /* Step 3: User marks as uncertain + adds note, then revises to option 2 */
  const metaRes = store.updateDecisionMeta({
    id: `${cid}:5:0`,
    reviewStatus: 'uncertain',
    userNote: '先按严格隔离试跑一周，若业务部反馈跨组跟进不便再切方案2'
  });
  assert.equal(metaRes.ok, true);
  assert.equal(metaRes.decision.reviewStatus, 'uncertain');

  const revRes = store.addDecisionRevision({
    id: `${cid}:5:0`,
    toOptionIndex: 1,
    reason: '业务部需要跨组协同核对 VIP 宾客名单'
  });
  assert.equal(revRes.ok, true);
  assert.equal(revRes.decision.reviewStatus, 'changed');
  assert.equal(revRes.decision.currentChoice, '默认筛本人：可看全量仅改本人');
  assert.equal(revRes.revisions.length, 1);
  assert.equal(revRes.revisions[0].fromChoice, '(Recommended) 严格隔离：仅查看自己名下宾客');

  /* Step 4: Force re-scan must NEVER wipe user_note, changed status, or revisions */
  store.syncFromTranscripts({ force: true });
  const afterForce = store.getDecisionDetail({ decisionId: `${cid}:5:0` });
  assert.equal(afterForce.decision.reviewStatus, 'changed');
  assert.equal(afterForce.decision.currentChoice, '默认筛本人：可看全量仅改本人');
  assert.match(afterForce.decision.userNote, /试跑一周/);
  assert.equal(afterForce.revisions.length, 1);

  /* Step 5: Live title rename reflects immediately; deletion falls back to snapshot */
  const sdb2 = new DatabaseSync(env.sumDbPath);
  sdb2.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?').run('权限体系重构评审', cid);
  sdb2.close();

  const listRenamed = store.listDecisions({ search: '权限' });
  assert.equal(listRenamed.total, 1);
  assert.equal(listRenamed.items[0].currentTitle, '权限体系重构评审');

  /* Verify dual-track project Markdown was synced cleanly */
  const mdPath = path.join(env.workspaceDir, '.anti-claude', 'decisions.md');
  assert.equal(fs.existsSync(mdPath), true);
  const mdText = fs.readFileSync(mdPath, 'utf8');
  assert.match(mdText, /Anniversary RSVP/);
  assert.match(mdText, /默认筛本人：可看全量仅改本人/);
  assert.match(mdText, /业务部需要跨组协同核对 VIP 宾客名单/);
  assert.match(mdText, new RegExp(cid));

  /* Verify revisit prompt contains full comparison context */
  const promptText = formatDecisionRevisitPrompt(afterForce.decision, afterForce.revisions, afterForce.siblings);
  assert.match(promptText, /全量可见可编/);
  assert.match(promptText, /变更历史/);

  /* Verify title snapshot fallback if conversation row is deleted */
  const sdb3 = new DatabaseSync(env.sumDbPath);
  sdb3.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(cid);
  sdb3.close();
  const listDeleted = store.listDecisions();
  assert.equal(listDeleted.items[0].currentTitle, '初始对话标题');

  /* Verify unsafe workspace guard */
  assert.equal(isSafeProjectWorkspace('/', { homeDir: env.root, antigravityDir: env.agyDir }), false);
  assert.equal(isSafeProjectWorkspace(env.root, { homeDir: env.root, antigravityDir: env.agyDir }), false);
  assert.equal(isSafeProjectWorkspace(env.agyDir, { homeDir: env.root, antigravityDir: env.agyDir }), false);
  assert.equal(isSafeProjectWorkspace(env.workspaceDir, { homeDir: env.root, antigravityDir: env.agyDir }), true);

  store.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});
