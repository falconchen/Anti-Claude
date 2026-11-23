import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {
  makeBytesField,
  makeStringField,
  makeVarintField,
  moveConversationToProject,
  parseProtoFields,
  patchCascadeSummaryProject,
  patchTrajectoryMetadataProject,
  validateWireFormat
} from '../core/move-to-project.mjs';

const CONV_ID = '11111111-2222-5333-8444-555555555551';
const PROJ_ID = '0db61ffb-79fc-5b25-99d3-850bea2cbda5';
const WS_URI = 'file:///Users/falcon/projects/js/cf-photos';

test('patchTrajectoryMetadataProject and patchCascadeSummaryProject preserve unknown fields and rebuild empty blobs', () => {
  // 1. Rebuild from empty (0-byte corrupted blob)
  const rebuilt = patchTrajectoryMetadataProject(Buffer.alloc(0), {
    conversationId: CONV_ID,
    projectId: PROJ_ID,
    workspaceUris: [WS_URI]
  });
  assert.equal(validateWireFormat(rebuilt), true);
  const rebuiltFields = parseProtoFields(rebuilt);
  assert.equal(rebuiltFields.find((f) => f.fieldNumber === 6)?.payload?.toString('utf8'), CONV_ID);
  assert.equal(rebuiltFields.find((f) => f.fieldNumber === 7)?.payload?.toString('utf8'), WS_URI);
  assert.equal(rebuiltFields.find((f) => f.fieldNumber === 18)?.payload?.toString('utf8'), PROJ_ID);
  assert.ok(rebuiltFields.some((f) => f.fieldNumber === 1));

  // 2. Losslessly patch existing raw_summary while keeping title (field 1 / 15) and unknown field 77
  const origRaw = Buffer.concat([
    makeStringField(1, '漏洞审查 (fork)'),
    makeVarintField(2, 18n),
    makeBytesField(15, makeStringField(1, '漏洞审查 (fork)')),
    makeStringField(77, 'keep-unknown-intact')
  ]);
  const { patchedSummary } = patchCascadeSummaryProject(origRaw, {
    conversationId: CONV_ID,
    projectId: PROJ_ID,
    workspaceUris: [WS_URI]
  });
  assert.equal(validateWireFormat(patchedSummary), true);
  const topFields = parseProtoFields(patchedSummary);
  assert.equal(topFields.find((f) => f.fieldNumber === 1)?.payload?.toString('utf8'), '漏洞审查 (fork)');
  assert.equal(topFields.find((f) => f.fieldNumber === 77)?.payload?.toString('utf8'), 'keep-unknown-intact');
  const f17 = topFields.find((f) => f.fieldNumber === 17);
  assert.ok(f17?.payload);
  assert.equal(parseProtoFields(f17.payload).find((f) => f.fieldNumber === 18)?.payload?.toString('utf8'), PROJ_ID);
});

test('moveConversationToProject updates summaries DB, FTS5, proto cache, repairs 0-byte conv.db and cleans dirty trajectory_meta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-move-proj-'));
  const agyDir = path.join(root, 'antigravity');
  const convDir = path.join(agyDir, 'conversations');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(projectsDir, `${PROJ_ID}.json`),
      JSON.stringify({
        id: PROJ_ID,
        name: 'cf-photos',
        projectResources: { resources: [{ gitFolder: { folderUri: WS_URI } }] }
      }),
      'utf8'
    );

    const origRaw = Buffer.concat([
      makeStringField(1, '漏洞审查 (fork)'),
      makeVarintField(2, 10n),
      makeBytesField(15, makeStringField(1, '漏洞审查 (fork)'))
    ]);

    const sdb = new DatabaseSync(path.join(agyDir, 'conversation_summaries.db'), { readBigInts: true });
    sdb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        preview text NOT NULL DEFAULT '',
        step_count integer NOT NULL DEFAULT 0,
        last_modified_time text NOT NULL DEFAULT '',
        workspace_uris text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT '',
        project_id text NOT NULL DEFAULT '',
        parent_conversation_id text NOT NULL DEFAULT '',
        killed integer NOT NULL DEFAULT 0,
        raw_summary blob
      );
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED, chunk_index UNINDEXED, chunk_first_step UNINDEXED, chunk_last_step UNINDEXED,
        last_modified_time UNINDEXED, step_count UNINDEXED, last_step_created_at UNINDEXED, archived UNINDEXED,
        user_step_byte_offsets UNINDEXED, agent_step_byte_offsets UNINDEXED,
        title, workspace, project, user_body, agent_body
      );
    `);
    sdb
      .prepare(
        'INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, workspace_uris, project_id, raw_summary) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(CONV_ID, '漏洞审查 (fork)', '漏洞审查 (fork)', 10, '', 'outside-of-project', origRaw);
    sdb
      .prepare(
        'INSERT INTO conversations_fts (conversation_id, chunk_index, chunk_first_step, chunk_last_step, last_modified_time, step_count, last_step_created_at, archived, user_step_byte_offsets, agent_step_byte_offsets, title, workspace, project, user_body, agent_body) VALUES (?, -1, 0, 0, 1795410728249838000, 10, 1795410728249838000, 0, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(CONV_ID, Buffer.alloc(0), Buffer.alloc(0), '漏洞审查 (fork)', '', '', '', '');
    sdb.close();

    // Corrupted conv.db with 0-byte trajectory_metadata_blob + dirty trajectory_meta row
    const cdb = new DatabaseSync(path.join(convDir, `${CONV_ID}.db`));
    cdb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('traj-real', CONV_ID, 4, 1);
    cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('traj-dirty', CONV_ID, 0, 0);
    cdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.alloc(0));
    cdb.close();

    // Cache file containing the summary entry
    const cachePath = path.join(agyDir, 'agyhub_summaries_proto.pb');
    const cacheEntry = Buffer.concat([makeStringField(1, CONV_ID), makeBytesField(2, origRaw)]);
    fs.writeFileSync(cachePath, makeBytesField(1, cacheEntry));

    const res = moveConversationToProject(
      { conversationId: CONV_ID, projectId: PROJ_ID },
      { antigravityDir: agyDir, projectsDir }
    );
    assert.equal(res.ok, true);
    assert.equal(res.projectId, PROJ_ID);
    assert.equal(res.projectName, 'cf-photos');
    assert.deepEqual(res.workspaceUris, [WS_URI]);
    assert.equal(res.convDbPatched, true);
    assert.equal(res.cleanedDirtyMeta, 1);
    assert.equal(res.ftsUpdated, true);
    assert.equal(res.protoCacheUpdated, true);

    // Verify summaries DB + FTS5
    const checkSdb = new DatabaseSync(path.join(agyDir, 'conversation_summaries.db'), { readOnly: true, readBigInts: true });
    const row = checkSdb.prepare('SELECT project_id, workspace_uris, title, raw_summary FROM conversation_summaries WHERE conversation_id = ?').get(CONV_ID);
    assert.equal(row.project_id, PROJ_ID);
    assert.equal(row.workspace_uris, JSON.stringify([WS_URI]));
    assert.equal(row.title, '漏洞审查 (fork)');
    const fts = checkSdb.prepare('SELECT project, workspace, title FROM conversations_fts WHERE conversation_id = ? AND chunk_index = -1').get(CONV_ID);
    assert.equal(fts.project, 'cf-photos');
    assert.equal(fts.workspace, 'cf-photos');
    assert.equal(fts.title, '漏洞审查 (fork)');
    checkSdb.close();

    // Verify conv.db repaired & dirty row removed
    const checkCdb = new DatabaseSync(path.join(convDir, `${CONV_ID}.db`), { readOnly: true });
    const blob = checkCdb.prepare('SELECT data FROM trajectory_metadata_blob WHERE id = ?').get('main');
    assert.ok(blob.data.length > 20);
    assert.equal(parseProtoFields(Buffer.from(blob.data)).find((f) => f.fieldNumber === 18)?.payload?.toString('utf8'), PROJ_ID);
    const metaRows = checkCdb.prepare('SELECT trajectory_id FROM trajectory_meta').all();
    assert.deepEqual(metaRows.map((r) => r.trajectory_id), ['traj-real']);
    checkCdb.close();

    // Verify reserved project IDs are rejected
    const bad = moveConversationToProject(
      { conversationId: CONV_ID, projectId: 'outside-of-project' },
      { antigravityDir: agyDir, projectsDir }
    );
    assert.equal(bad.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const clientSource = fs.readFileSync(new URL('../core/move-to-project-client.js', import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

test('renderer move-to-project lists built projects, detects out-of-project chats, and calls daemon + writeSummary + Redux batch', async () => {
  const writeSummaryCalls = [];
  const dispatched = [];
  const daemonCalls = [];

  const summaries = {
    [CONV_ID]: {
      summary: '漏洞审查 (fork)',
      workspaces: [],
      trajectoryMetadata: { projectId: '', workspaceUris: [], workspaces: [] }
    }
  };
  const store = {
    getState: () => ({
      sidebarProjects: {
        projects: [
          { id: 'outside-of-project', name: 'Outside of Project', folderUris: [] },
          { id: 'default-cli-project', name: 'CLI Project', folderUris: [] },
          { id: PROJ_ID, name: 'cf-photos', folderUris: [WS_URI] }
        ]
      },
      trajectorySummaries: {
        summaries,
        indexes: { outsideOfProject: [CONV_ID] }
      }
    }),
    dispatch: (action) => dispatched.push(action)
  };
  const actions = {
    updateConversationAnnotations: async () => {},
    writeSummary: async (req) => writeSummaryCalls.push(req)
  };
  const childEl = {
    __reactFiber$test: {
      memoizedProps: { sidebarStore: store, sidebarActions: actions },
      return: null
    }
  };
  const sidebarEl = { firstElementChild: childEl, querySelector: () => null };
  const w = {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    document: {
      documentElement: { getAttribute: () => 'zh' },
      body: null,
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) => (sel === '[data-testid="conversation-list-sidebar"]' ? sidebarEl : null),
      querySelectorAll: () => [],
      getElementById: () => null
    },
    __agProjectCall: async (action, payload) => {
      daemonCalls.push([action, payload]);
      return { ok: true, conversationId: CONV_ID, projectId: PROJ_ID, projectName: 'cf-photos', workspaceUris: [WS_URI] };
    },
    ctx: { modules: {}, config: {}, onCleanup() {} }
  };
  w.window = w;
  vm.runInNewContext(clientSource, w);

  try {
    const api = w.__agMoveToProject;
    assert.deepEqual(plain(api.listProjects()), [{ id: PROJ_ID, name: 'cf-photos', folderUris: [WS_URI] }]);
    assert.equal(api.isOutOfProject(CONV_ID), true);

    const res = plain(await api.move(CONV_ID, PROJ_ID));
    assert.equal(res.ok, true);
    assert.equal(res.liveSynced, true);
    assert.deepEqual(plain(daemonCalls), [['moveConversationToProject', { conversationId: CONV_ID, projectId: PROJ_ID }]]);
    assert.equal(writeSummaryCalls.length, 1);
    assert.equal(writeSummaryCalls[0].cascadeId, CONV_ID);
    assert.equal(writeSummaryCalls[0].summary.trajectoryMetadata.projectId, PROJ_ID);
    assert.deepEqual(plain(writeSummaryCalls[0].summary.trajectoryMetadata.workspaceUris), [WS_URI]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, 'trajectorySummaries/applyStreamBatch');
    assert.equal(dispatched[0].payload.updates[0][0], CONV_ID);
  } finally {
    w.__agMoveToProject?.dispose();
  }
});
