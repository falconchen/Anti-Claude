import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {
  TitleSyncWatcher,
  checkConversationSafeForNativeSync,
  extractConversationIdFromFilename,
  parsePbtxtTitle,
  unescapePbtxtString
} from '../core/title-sync.mjs';
import { attachedTargets, dispatchTitleSyncBatch, rebuildBundleIfNeeded } from '../core/daemon.mjs';

const UUID_1 = '11111111-2222-3333-4444-555555555551';
const UUID_2 = '11111111-2222-3333-4444-555555555552';
const UUID_3 = '11111111-2222-3333-4444-555555555553';

test('pbtxt parser handles UTF-8, escaped quotes, octal UTF-8 bytes and rejects empty/oversized titles', () => {
  assert.equal(unescapePbtxtString('\\344\\270\\255\\346\\226\\207'), '中文');
  assert.equal(
    parsePbtxtTitle('title:"ivm1 限速加固与 \\"ACL\\" 拦截" last_user_view_time:{seconds:1795404793}'),
    'ivm1 限速加固与 "ACL" 拦截'
  );
  assert.equal(parsePbtxtTitle('title:"\\344\\270\\255\\346\\226\\207标题\\n换行"'), '中文标题 换行');
  assert.equal(parsePbtxtTitle('last_user_view_time:{seconds:123}'), null);
  assert.equal(parsePbtxtTitle('title:"   "'), null);
  assert.equal(parsePbtxtTitle(`title:"${'a'.repeat(201)}"`), null);

  assert.equal(extractConversationIdFromFilename(`${UUID_1.toUpperCase()}.pbtxt`), UUID_1);
  assert.equal(extractConversationIdFromFilename(`.${UUID_1}.pbtxt.tmp`), null);
  assert.equal(extractConversationIdFromFilename('not-a-uuid.pbtxt'), null);
});

test('TitleSyncWatcher aggregates bursts, suppresses self-echoes, allows subsequent changes and supports forget()', () => {
  let now = 10000;
  const files = new Map([
    [path.join('/fake/annotations', `${UUID_1}.pbtxt`), 'title:"标题一"'],
    [path.join('/fake/annotations', `${UUID_2}.pbtxt`), 'title:"标题二"']
  ]);
  const batches = [];
  let listener = null;
  let closed = false;

  const watcher = new TitleSyncWatcher({
    annotationsDir: '/fake/annotations',
    debounceMs: 0,
    dedupWindowMs: 3000,
    nowFn: () => now,
    existsFn: () => true,
    readFileFn: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    watchFn: (_dir, cb) => {
      listener = cb;
      return { on() {}, unref() {}, close() { closed = true; } };
    },
    onBatch: (batch) => batches.push(batch)
  });

  assert.equal(watcher.start(), true);
  assert.ok(listener);

  // Batch burst (manual pending fill before flush)
  watcher.debounceMs = 5000;
  listener('rename', `${UUID_1}.pbtxt`);
  listener('rename', `.${UUID_1}.pbtxt.tmp`); // ignored
  listener('rename', `${UUID_2}.pbtxt`);
  listener('change', `${UUID_1}.pbtxt`); // deduplicated within batch
  const first = watcher.flush();
  assert.deepEqual(first, [
    { id: UUID_1, title: '标题一' },
    { id: UUID_2, title: '标题二' }
  ]);
  assert.equal(batches.length, 1);

  // Self-echo within dedupWindowMs is suppressed
  now += 500;
  listener('change', `${UUID_1}.pbtxt`);
  assert.deepEqual(watcher.flush(), []);
  assert.equal(batches.length, 1);

  // Different title for same conversation dispatches immediately
  files.set(path.join('/fake/annotations', `${UUID_1}.pbtxt`), 'title:"标题一（修订）"');
  listener('rename', `${UUID_1}.pbtxt`);
  assert.deepEqual(watcher.flush(), [{ id: UUID_1, title: '标题一（修订）' }]);
  assert.equal(batches.length, 2);

  // forget() allows retrying the same title after a transient dispatch failure
  watcher.forget([UUID_2]);
  listener('change', `${UUID_2}.pbtxt`);
  assert.deepEqual(watcher.flush(), [{ id: UUID_2, title: '标题二' }]);
  assert.equal(batches.length, 3);

  watcher.stop();
  assert.equal(closed, true);
});

test('TitleSyncWatcher captures real atomic renameSync writes in a temp annotations directory', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-title-sync-'));
  try {
    let resolveBatch;
    const gotBatch = new Promise((resolve) => {
      resolveBatch = resolve;
    });
    const watcher = new TitleSyncWatcher({
      annotationsDir: tmpDir,
      debounceMs: 60,
      onBatch: (entries) => resolveBatch(entries)
    });
    assert.equal(watcher.start(), true);
    try {
      const tmp1 = path.join(tmpDir, `.${UUID_1}.pbtxt.tmp`);
      const dst1 = path.join(tmpDir, `${UUID_1}.pbtxt`);
      const tmp2 = path.join(tmpDir, `.${UUID_2}.pbtxt.tmp`);
      const dst2 = path.join(tmpDir, `${UUID_2}.pbtxt`);
      fs.writeFileSync(tmp1, 'title:"历史对话批量改名 A" last_user_view_time:{seconds:1}\n', 'utf8');
      fs.renameSync(tmp1, dst1);
      fs.writeFileSync(tmp2, 'title:"历史对话批量改名 B" last_user_view_time:{seconds:2}\n', 'utf8');
      fs.renameSync(tmp2, dst2);

      const batch = await Promise.race([
        gotBatch,
        new Promise((_, reject) => setTimeout(() => reject(new Error('fs_watch_timeout')), 3000))
      ]);
      const byId = new Map(batch.map((e) => [e.id, e.title]));
      assert.equal(byId.get(UUID_1), '历史对话批量改名 A');
      assert.equal(byId.get(UUID_2), '历史对话批量改名 B');
    } finally {
      watcher.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const clientSource = fs.readFileSync(new URL('../core/title-sync-client.js', import.meta.url), 'utf8');

function mountTitleSyncClient({ enabled = true, summaries = {}, updateFn }) {
  const store = { getState: () => ({ trajectorySummaries: { summaries } }) };
  const actionsCtx = { updateConversationAnnotations: updateFn };
  const childEl = {
    __reactFiber$test: {
      memoizedProps: { sidebarStore: store, sidebarActions: actionsCtx },
      return: null
    }
  };
  const sidebarEl = {
    firstElementChild: childEl,
    querySelector: () => null
  };
  const listeners = new Map();
  const w = {
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    },
    document: {
      querySelector: (sel) => (sel === '[data-testid="conversation-list-sidebar"]' ? sidebarEl : null),
      getElementById: () => null
    },
    ctx: { modules: { titleSync: enabled }, config: {}, onCleanup() {} }
  };
  w.window = w;
  vm.runInNewContext(clientSource, w);
  return {
    w,
    api: w.__agTitleSync,
    close: () => {
      w.__agTitleSync?.dispose();
    }
  };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('renderer syncBatch updates idle chats via native RPC, skips unchanged titles to prevent loops, and emits refresh event', async () => {
  const calls = [];
  const summaries = {
    [UUID_1]: { summary: 'Old Title 1', annotations: { title: 'Old Title 1' } },
    [UUID_2]: { summary: 'Already Synced', annotations: { title: 'Already Synced' } }
  };
  const client = mountTitleSyncClient({
    summaries,
    updateFn: async (id, patch, flag) => {
      calls.push([id, patch, flag]);
      summaries[id].annotations.title = patch.title;
    }
  });
  try {
    let emitted = null;
    client.w.addEventListener('ag-title-sync-updated', (ev) => {
      emitted = ev.detail;
    });

    const res = plain(
      await client.api.syncBatch(
        [
          { id: UUID_1, title: 'New Idle Title 1' },
          { id: UUID_2, title: 'Already Synced' },
          { id: UUID_3, title: 'Unknown Conversation' }
        ],
        { intervalMs: 0 }
      )
    );

    assert.equal(res.ok, true);
    assert.deepEqual(res.updated, [UUID_1]);
    assert.deepEqual(res.unchanged, [UUID_2]);
    assert.deepEqual(res.missing, [UUID_3]);
    assert.deepEqual(res.failed, []);
    assert.deepEqual(plain(calls), [[UUID_1, { title: 'New Idle Title 1' }, true]]);
    assert.deepEqual(plain(emitted), { ids: [UUID_1] });

    // Re-running with same batch must be a zero-RPC no-op (echo suppression)
    const echoRes = plain(await client.api.syncBatch([{ id: UUID_1, title: 'New Idle Title 1' }], { intervalMs: 0 }));
    assert.deepEqual(echoRes.updated, []);
    assert.deepEqual(echoRes.unchanged, [UUID_1]);
    assert.equal(calls.length, 1);
  } finally {
    client.close();
  }
});

test('renderer isolates per-item RPC errors and respects setEnabled(false) / dispose()', async () => {
  const calls = [];
  const summaries = {
    [UUID_1]: { summary: 'Old 1', annotations: { title: 'Old 1' } },
    [UUID_2]: { summary: 'Old 2', annotations: { title: 'Old 2' } }
  };
  const client = mountTitleSyncClient({
    summaries,
    updateFn: async (id, patch) => {
      calls.push(id);
      if (id === UUID_1) throw new Error('rpc_boom');
      summaries[id].annotations.title = patch.title;
    }
  });
  try {
    const res = plain(
      await client.api.syncBatch(
        [
          { id: UUID_1, title: 'Fail 1' },
          { id: UUID_2, title: 'Pass 2' }
        ],
        { intervalMs: 0 }
      )
    );
    assert.deepEqual(res.failed, [UUID_1]);
    assert.deepEqual(res.updated, [UUID_2]);
    assert.deepEqual(calls, [UUID_1, UUID_2]);

    client.api.setEnabled(false);
    const disabledRes = plain(await client.api.syncBatch([{ id: UUID_1, title: 'Blocked' }], { intervalMs: 0 }));
    assert.equal(disabledRes.skipped, 'disabled');
    assert.equal(calls.length, 2);

    client.api.dispose();
    assert.equal(client.w.__agTitleSync, undefined);
  } finally {
    client.close();
  }
});

test('daemon dispatchTitleSyncBatch targets a single host page and forgets failed/undelivered IDs', async () => {
  rebuildBundleIfNeeded();
  const prevEntries = Array.from(attachedTargets.entries());
  attachedTargets.clear();
  try {
    const forgotten = [];
    const fakeWatcher = { forget: (ids) => forgotten.push(...ids) };

    // No attached host target -> forgets batch IDs
    const noTargetRes = await dispatchTitleSyncBatch([{ id: UUID_1, title: 'Title A' }], fakeWatcher);
    assert.equal(noTargetRes.ok, false);
    assert.equal(noTargetRes.error, 'no_target');
    assert.deepEqual(forgotten, [UUID_1]);

    // Two windows attached -> only dispatches to the single active page target
    const sentTo = [];
    attachedTargets.set('page-1', {
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 7,
      watchedCascadeId: '',
      ws: { readyState: WebSocket.OPEN },
      send: async () => {
        sentTo.push('page-1');
        return { result: { result: { value: { ok: true, updated: [UUID_1], unchanged: [], missing: [], failed: [] } } } };
      }
    });
    attachedTargets.set('page-2', {
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 9,
      watchedCascadeId: UUID_1,
      ws: { readyState: WebSocket.OPEN },
      send: async (_method, params) => {
        sentTo.push(`page-2:ctx=${params.contextId}`);
        return { result: { result: { value: { ok: true, updated: [UUID_1], unchanged: [], missing: [], failed: [UUID_2] } } } };
      }
    });

    forgotten.length = 0;
    const okRes = await dispatchTitleSyncBatch(
      [
        { id: UUID_1, title: 'Title A' },
        { id: UUID_2, title: 'Title B' }
      ],
      fakeWatcher
    );
    assert.equal(okRes.ok, true);
    assert.deepEqual(sentTo, ['page-2:ctx=9']);
    assert.deepEqual(forgotten, [UUID_2]);
  } finally {
    attachedTargets.clear();
    for (const [k, v] of prevEntries) attachedTargets.set(k, v);
  }
});

test('safety guard allows healthy conv.db and blocks empty trajectory_metadata_blob or legacy .pb chats', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-title-sync-guard-'));
  const annDir = path.join(rootDir, 'annotations');
  const convDir = path.join(rootDir, 'conversations');
  fs.mkdirSync(annDir, { recursive: true });
  fs.mkdirSync(convDir, { recursive: true });

  const makeConvDb = (id, blobBuf) => {
    const db = new DatabaseSync(path.join(convDir, `${id}.db`));
    db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);');
    if (blobBuf !== null) {
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', blobBuf);
    }
    db.close();
  };

  try {
    // UUID_1: healthy conv.db with non-empty metadata blob
    makeConvDb(UUID_1, Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]));
    // UUID_2: corrupted imported conv.db with 0-byte trajectory_metadata_blob
    makeConvDb(UUID_2, Buffer.alloc(0));
    // UUID_3: legacy .pb format without conv.db
    fs.writeFileSync(path.join(convDir, `${UUID_3}.pb`), Buffer.from([0x01, 0x02]));

    assert.deepEqual(checkConversationSafeForNativeSync(UUID_1, convDir), { safe: true, reason: 'ok' });
    assert.deepEqual(checkConversationSafeForNativeSync(UUID_2, convDir), {
      safe: false,
      reason: 'empty_trajectory_metadata'
    });
    assert.deepEqual(checkConversationSafeForNativeSync(UUID_3, convDir), {
      safe: false,
      reason: 'legacy_pb_format'
    });

    // End-to-end through TitleSyncWatcher: only UUID_1 dispatches; UUID_2 & UUID_3 are skipped safely
    fs.writeFileSync(path.join(annDir, `${UUID_1}.pbtxt`), 'title:"健康会话新标题"', 'utf8');
    fs.writeFileSync(path.join(annDir, `${UUID_2}.pbtxt`), 'title:"损坏DB新标题"', 'utf8');
    fs.writeFileSync(path.join(annDir, `${UUID_3}.pbtxt`), 'title:"旧版PB新标题"', 'utf8');

    const batches = [];
    const skipped = [];
    const watcher = new TitleSyncWatcher({
      annotationsDir: annDir,
      conversationsDir: convDir,
      debounceMs: 5000,
      onBatch: (b) => batches.push(b),
      onSkippedUnsafe: (s) => skipped.push(...s)
    });
    watcher.handleFsEvent(`${UUID_1}.pbtxt`);
    watcher.handleFsEvent(`${UUID_2}.pbtxt`);
    watcher.handleFsEvent(`${UUID_3}.pbtxt`);

    const dispatched = watcher.flush();
    watcher.stop();

    assert.deepEqual(dispatched, [{ id: UUID_1, title: '健康会话新标题' }]);
    assert.equal(batches.length, 1);
    assert.deepEqual(skipped, [
      { id: UUID_2, reason: 'empty_trajectory_metadata' },
      { id: UUID_3, reason: 'legacy_pb_format' }
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
