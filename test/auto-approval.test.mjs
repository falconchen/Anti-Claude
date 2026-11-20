import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { AutoApprovalCoordinator, approvalKey, normalizeApprovalSettings } from '../core/auto-approval.mjs';

const candidate = (overrides = {}) => ({ cascadeId: 'background-chat', trajectoryId: 'trajectory', stepIndex: 7,
  kind: 'permission', action: 'command', target: 'git status', specSignature: '{"resource":"original"}', ...overrides });
const policy = (overrides = {}) => ({ enabled: true, settings: { delaySeconds: 3 }, ...overrides });
const snapshot = (...candidates) => ({ candidates, knownIds: ['background-chat'] });
function harness() {
  let now = 10000, journal = [];
  const engine = new AutoApprovalCoordinator({ now: () => now, persist: records => { journal = structuredClone(records); } });
  return { engine, advance: ms => { now += ms; }, journal: () => journal };
}

test('approval countdown cancels when removed and restarts when resource changes', () => {
  const h = harness(), c = candidate();
  assert.equal(h.engine.observe('window-a', snapshot(c), policy()).remaining, 3);
  h.advance(2000);
  assert.equal(h.engine.observe('window-a', snapshot(c), policy()).remaining, 1);
  const changed = candidate({ target: 'git diff' });
  assert.equal(h.engine.observe('window-a', snapshot(changed), policy()).remaining, 3);
  h.engine.observe('window-a', snapshot(), policy());
  h.advance(4000);
  assert.equal(h.engine.observe('window-a', snapshot(c), policy()).remaining, 3);
});

test('pause, scope changes and external executor conflict revoke a ready claim', () => {
  for (const nextPolicy of [policy({ enabled: false }), policy({ conflict: true }), policy({ settings: { delaySeconds: 0, scopes: { command: false } } })]) {
    const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
    const claim = h.engine.observe('a', snapshot(c), p).claim;
    assert.ok(claim);
    assert.equal(h.engine.commit('a', { token: claim.token, candidate: c }, nextPolicy).ok, false);
    assert.equal(h.journal().length, 0);
  }
});

test('duplicate windows, repeated notifications and a daemon restart cannot resubmit a request', () => {
  const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
  const claim = h.engine.observe('a', snapshot(c), p).claim;
  assert.equal(h.engine.observe('b', snapshot(c), p).claim, undefined);
  assert.equal(h.engine.commit('b', { token: claim.token, candidate: c }, p).ok, false);
  assert.equal(h.engine.commit('a', { token: claim.token, candidate: c }, p).permit, true);
  assert.equal(h.engine.commit('a', { token: claim.token, candidate: c }, p).ok, false);
  const restarted = new AutoApprovalCoordinator({ records: h.journal() });
  assert.equal(restarted.observe('new-window', snapshot(c), p).status, 'uncertain');
  assert.equal(restarted.observe('new-window', snapshot(c), p).claim, undefined);
  assert.ok(!JSON.stringify(h.journal()).includes('git status'), 'journal never stores command content');
});

test('RPC success is not confirmed until waiting state disappears; missing conversations do not confirm', () => {
  const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
  const claim = h.engine.observe('a', snapshot(c), p).claim;
  h.engine.commit('a', { token: claim.token, candidate: c }, p);
  h.engine.result('a', { key: claim.key, token: claim.token, succeeded: true });
  assert.equal(h.engine.observe('a', snapshot(c), p).status, 'verifying');
  assert.equal(h.engine.observe('a', { candidates: [], knownIds: [] }, p).status, 'verifying');
  assert.equal(h.engine.observe('a', { ...snapshot(), waiting: [c] }, p).status, 'verifying', 'a still-waiting request excluded by the renderer is not a success');
  assert.equal(h.engine.observe('a', { ...snapshot(), waiting: [], unknownWaitingIds: [c.cascadeId] }, p).status, 'verifying', 'unrecognized waiting state is not success');
  h.engine.observe('a', snapshot(), p);
  assert.equal(h.journal()[0].stage, 'confirmed');
});

test('failed submissions and missing replies are never retried; closed windows do not block other work forever', () => {
  for (const failed of [true, false]) {
    const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
    const claim = h.engine.observe('a', snapshot(c), p).claim;
    h.engine.commit('a', { token: claim.token, candidate: c }, p);
    if (failed) h.engine.result('a', { key: claim.key, token: claim.token, succeeded: false });
    h.advance(11000);
    assert.equal(h.engine.observe('b', snapshot(c), p).status, 'uncertain');
    assert.equal(h.engine.observe('b', snapshot(c), p).claim, undefined);
    const other = candidate({ stepIndex: 8 });
    assert.ok(h.engine.observe('b', snapshot(c, other), p).claim);
  }
});

test('preflight rejects changed specs and persistence errors; activity restarts the delay', () => {
  const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
  const claim = h.engine.observe('a', snapshot(c), p).claim;
  assert.equal(h.engine.commit('a', { token: claim.token, candidate: candidate({ specSignature: 'changed' }) }, p).ok, false);
  const failed = new AutoApprovalCoordinator({ persist: () => { throw new Error('disk full'); } });
  const ready = failed.observe('a', snapshot(c), p).claim;
  assert.equal(failed.commit('a', { token: ready.token, candidate: c }, p).error, 'journal_write_failed');
  const delayed = harness();
  delayed.engine.observe('a', snapshot(c), policy()); delayed.advance(2000);
  assert.equal(delayed.engine.observe('a', { ...snapshot(c), userActive: true }, policy()).status, 'interacting');
  assert.equal(delayed.engine.observe('a', snapshot(c), policy()).remaining, 3);
});

test('approval categories reject URLs, administrator elevation and questions regardless of scope', () => {
  const p = policy({ settings: { delaySeconds: 0 } });
  for (const invalid of [candidate({ action: 'read_url' }), candidate({ action: 'escalate_admin' }), candidate({ kind: 'askQuestion' }), candidate({ stepIndex: -1 })]) {
    assert.equal(harness().engine.observe('a', snapshot(invalid), p).claim, undefined);
  }
  for (const action of ['command', 'unsandboxed', 'mcp', 'read_file', 'write_file']) {
    assert.ok(harness().engine.observe('a', snapshot(candidate({ action })), p).claim);
  }
  assert.equal(normalizeApprovalSettings({ delaySeconds: 9000, scopes: { mcp: false } }).delaySeconds, 3600);
  assert.equal(normalizeApprovalSettings({ scopes: { mcp: false } }).scopes.mcp, false);
});

test('corrupt journals and truncated snapshots stop approval rather than losing deduplication state', () => {
  assert.throws(() => new AutoApprovalCoordinator({ records: [{}] }), /invalid_approval_journal/);
  const h = harness();
  assert.equal(h.engine.observe('a', { candidates: Array(257).fill(candidate()) }, policy()).error, 'invalid_snapshot');
});

test('an abandoned window claim expires and cannot be used after another window takes ownership', () => {
  const h = harness(), c = candidate(), p = policy({ settings: { delaySeconds: 0 } });
  const old = h.engine.observe('old-window', snapshot(c), p).claim;
  h.advance(6000);
  const fresh = h.engine.observe('new-window', snapshot(c), p).claim;
  assert.ok(fresh);
  assert.equal(h.engine.commit('old-window', { candidate: c, token: old.token }, p).ok, false);
  assert.equal(h.engine.commit('new-window', { candidate: c, token: fresh.token }, p).permit, true);
});

let JSDOM;
try { JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM; } catch {}
const skip = JSDOM ? false : 'jsdom not installed';
const clientSource = fs.readFileSync(new URL('../core/auto-approval-client.js', import.meta.url), 'utf8');
const customSource = fs.readFileSync(new URL('../user/custom.js', import.meta.url), 'utf8');

function mountClient({ enabled = true, service, bridge, state, html = '', lang = 'en' }) {
  const dom = new JSDOM(`<!doctype html><html data-ag-ux-lang="${lang}"><body>${html}<div class="bg-sidebar"><div class="sidebar-parent"><div data-testid="conversation-list-sidebar"><div></div></div></div></div></body></html>`, {
    runScripts: 'outside-only', url: 'https://127.0.0.1:12345/c/current-chat', pretendToBeVisual: true
  });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder;
  w.setInterval = () => 1; // Tests drive ticks explicitly, without wall-clock sleeps.
  w.clearInterval = () => {};
  const store = { getState: () => state, subscribe: () => () => {} };
  const el = w.document.querySelector('[data-testid="conversation-list-sidebar"]').firstElementChild;
  el.__reactFiber$test = { memoizedProps: { sidebarStore: store, value: service }, return: null };
  w.__agProjectCall = bridge;
  w.ctx = { modules: { autoApproval: enabled }, config: { autoApproval: { delaySeconds: 0 } }, onCleanup() {} };
  w.eval(clientSource);
  return { dom, w, api: w.__agAutoApproval, close: () => { w.__agAutoApproval?.dispose(); w.close(); } };
}

function nativeState(action = 'command', target = 'git status') {
  return { trajectorySummaries: { summaries: { 'background-chat': { waitingSteps: [{ stepIndex: 7, step: {
    status: 9, metadata: { sourceTrajectoryStepInfo: { trajectoryId: 'trajectory', stepIndex: 7 } },
    requestedInteraction: { interaction: { case: 'permission', value: { resource: { action, target } } } }
  } }] } } } };
}

function engineBridge(h, p, hooks = {}) {
  return async (action, payload) => {
    if (action === 'autoApprovalPoll') return h.engine.observe('renderer', payload, p);
    if (action === 'autoApprovalCommit') { hooks.beforeCommit?.(); return h.engine.commit('renderer', payload, p); }
    if (action === 'autoApprovalResult') return h.engine.result('renderer', payload);
    if (action === 'saveUiPrefs') { p.enabled = payload.modules.autoApproval; p.settings = payload.autoApproval; return { ok: true, autoApproval: payload.autoApproval }; }
    return { ok: false };
  };
}

test('renderer directly approves a background conversation once, without navigating or persisting a grant', { skip }, async () => {
  const h = harness(), p = policy({ settings: { delaySeconds: 0 } }), state = nativeState();
  const calls = [];
  const client = mountClient({ state, bridge: engineBridge(h, p), service: { handleCascadeUserInteraction: async (...args) => { calls.push(args); } } });
  try {
    const path = client.w.location.pathname;
    await client.api.tick(); await client.api.tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['background-chat', {
      trajectoryId: 'trajectory', stepIndex: 7, interaction: { case: 'permission', value: { allow: true, scope: 1 } }
    }]);
    assert.equal(client.w.location.pathname, path);
    assert.equal(client.api.getStatus().status, 'verifying');
    state.trajectorySummaries.summaries['background-chat'].waitingSteps = [];
    await client.api.tick();
    assert.equal(h.journal()[0].stage, 'confirmed');
  } finally { client.close(); }
});

test('renderer rechecks after permit and never submits a canceled or edited request', { skip }, async () => {
  for (const edit of [false, true]) {
    const h = harness(), p = policy({ settings: { delaySeconds: 0 } }), state = nativeState(); let calls = 0;
    const client = mountClient({ state, service: { handleCascadeUserInteraction: async () => { calls++; } }, bridge: engineBridge(h, p, { beforeCommit: () => {
      const summary = state.trajectorySummaries.summaries['background-chat'];
      if (edit) summary.waitingSteps[0].step.requestedInteraction.interaction.value.resource.target = 'changed';
      else summary.waitingSteps = [];
    } }) });
    try { await client.api.tick(); assert.equal(calls, 0); } finally { client.close(); }
  }
});

test('renderer pause revokes pending work; disposal and malformed steps do not submit', { skip }, async () => {
  const h = harness(), p = policy({ settings: { delaySeconds: 0 } }), state = nativeState(); let calls = 0;
  const client = mountClient({ state, service: { handleCascadeUserInteraction: async () => { calls++; } }, bridge: engineBridge(h, p) });
  try {
    await client.api.setEnabled(false); await client.api.tick(); assert.equal(calls, 0);
    state.trajectorySummaries.summaries['background-chat'].waitingSteps[0].step.metadata = {};
    await client.api.setEnabled(true); await client.api.tick(); assert.equal(calls, 0);
    client.api.dispose(); await client.api.tick(); assert.equal(calls, 0);
  } finally { client.close(); }
});

test('renderer does not retry a native RPC failure on the next state notification', { skip }, async () => {
  const h = harness(), p = policy({ settings: { delaySeconds: 0 } }), state = nativeState(); let calls = 0;
  const client = mountClient({ state, bridge: engineBridge(h, p), service: { handleCascadeUserInteraction: async () => {
    calls++; throw new Error('disconnected');
  } } });
  try {
    await client.api.tick(); await client.api.tick();
    assert.equal(calls, 1);
    assert.equal(client.api.getStatus().status, 'uncertain');
  } finally { client.close(); }
});

test('independent settings nav follows UI Enhancements and configures enable, delay, scopes and language', { skip }, async () => {
  const h = harness(), p = policy({ enabled: false }), state = nativeState();
  const client = mountClient({ enabled: false, state, service: {}, bridge: engineBridge(h, p), html: `<div data-split-root="true"><div><div data-testid="settings-sidebar"><div><div><button data-testid="settings-nav-item-General">General</button></div><div><button data-testid="settings-nav-item-Appearance">Appearance</button></div></div></div></div><div><div id="right"><div>Native</div></div></div></div>` });
  try {
    client.w.ctx.modules.autoApproval = false;
    client.w.requestAnimationFrame = () => 1;
    client.w.eval(customSource);
    const doc = client.w.document;
    const nav = doc.querySelector('#ag-auto-approval-nav');
    assert.equal(nav.previousElementSibling.id, 'ag-claude-ux-settings-nav');
    nav.querySelector('button').click();
    assert.equal(doc.getElementById('right').getAttribute('data-ag-auto-approval-open'), 'true');
    assert.equal(doc.getElementById('ag-auto-approval-panel').hidden, false);
    assert.equal(doc.querySelectorAll('[data-ag-approval-scope]').length, 4);
    const delay = doc.querySelector('[data-ag-approval-delay]'); delay.value = '5'; delay.dispatchEvent(new client.w.Event('change'));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(client.api.getSettings().delaySeconds, 5);
    const scope = doc.querySelector('[data-ag-approval-scope="writeFile"]'); scope.checked = false; scope.dispatchEvent(new client.w.Event('change'));
    await new Promise(r => setTimeout(r, 0));
    assert.equal(client.api.getSettings().scopes.writeFile, false);
    doc.querySelector('[data-ag-approval-enabled]').click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(client.api.getStatus().enabled, true);
    doc.querySelector('[data-testid="settings-nav-item-ClaudeUX"]').click();
    assert.equal(doc.getElementById('ag-auto-approval-panel').hidden, true);
    doc.documentElement.setAttribute('data-ag-ux-lang', 'zh');
    client.api.attachSettings(doc.querySelector('[data-testid="settings-sidebar"]'), doc.getElementById('right'), doc.getElementById('ag-claude-ux-settings-nav'), () => {});
    assert.equal(nav.querySelector('button').textContent, '自动审批');
    assert.equal(doc.querySelector('[data-ag-approval-enabled]').getAttribute('aria-label'), '启用自动审批');
    client.w.__agClaudeUxDispose();
    assert.equal(doc.getElementById('ag-auto-approval-nav'), null);
  } finally { client.close(); }
});
