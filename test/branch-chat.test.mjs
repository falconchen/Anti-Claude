import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { makeStringField } from '../core/move-to-project.mjs';
import { listBranchedConversations } from '../core/daemon.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = fs.readFileSync(path.join(REPO, 'core', 'branch-chat-client.js'), 'utf8');

const SRC_CID = '11111111-2222-4333-8444-555555555501';
const NEW_CID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROJ_ID = '0db61ffb-79fc-5b25-99d3-850bea2cbda5';
const WS_URI = 'file:///Users/falcon/projects/Anti-Claude';

function makeStep(stepIndex, text = 'Done.') {
  return {
    metadata: { sourceTrajectoryStepInfo: { stepIndex } },
    step: { case: 'plannerResponse', value: { response: text } }
  };
}

/* Minimal zero-dependency DOM shim so all renderer branch-chat tests run without jsdom */
function createMiniDom({ url, lang = 'zh' }) {
  function splitSelectors(sel) {
    return String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function splitDescendant(s) {
    const out = [];
    let cur = '';
    let inBracket = 0;
    let inQuote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuote) {
        cur += ch;
        if (ch === inQuote) inQuote = '';
      } else if (ch === '"' || ch === "'") {
        cur += ch;
        inQuote = ch;
      } else if (ch === '[') {
        inBracket += 1;
        cur += ch;
      } else if (ch === ']') {
        inBracket = Math.max(0, inBracket - 1);
        cur += ch;
      } else if (/\s/.test(ch) && inBracket === 0) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function matchSimple(el, part) {
    if (!el || el.nodeType !== 1) return false;
    let s = part.trim();
    if (!s) return false;
    if (s.startsWith(':scope >')) s = s.slice(8).trim();
    const segs = splitDescendant(s);
    if (segs.length > 1) {
      if (!matchSimple(el, segs[segs.length - 1])) return false;
      let cur = el.parentElement;
      for (let i = segs.length - 2; i >= 0; i--) {
        let found = false;
        while (cur) {
          if (matchSimple(cur, segs[i])) {
            found = true;
            cur = cur.parentElement;
            break;
          }
          cur = cur.parentElement;
        }
        if (!found) return false;
      }
      return true;
    }

    const negMatches = [...s.matchAll(/:not\(([^)]+)\)/g)];
    for (const nm of negMatches) {
      if (matchSimple(el, nm[1])) return false;
      s = s.replace(nm[0], '');
    }

    const tagMatch = s.match(/^([a-z][a-z0-9-]*)/i);
    if (tagMatch) {
      if (el.tagName !== tagMatch[1].toUpperCase()) return false;
      s = s.slice(tagMatch[0].length);
    }

    const idMatch = s.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      if (el.id !== idMatch[1]) return false;
      s = s.replace(idMatch[0], '');
    }

    const attrRegex = /\[([^\]=^$*]+)(?:(\^?=)"([^"]*)")?\]/g;
    let am;
    while ((am = attrRegex.exec(s)) !== null) {
      const [, attr, op, val] = am;
      if (!el.hasAttribute(attr)) return false;
      const actual = el.getAttribute(attr);
      if (op === '=' && actual !== val) return false;
      if (op === '^=' && !String(actual || '').startsWith(val)) return false;
    }
    s = s.replace(attrRegex, '');

    const clsRegex = /\.([a-zA-Z0-9_-]+)/g;
    let cm;
    while ((cm = clsRegex.exec(s)) !== null) {
      const classes = String(el.className || '').split(/\s+/).filter(Boolean);
      if (!classes.includes(cm[1])) return false;
    }
    return true;
  }

  function matchesSelector(el, sel) {
    return splitSelectors(sel).some((p) => matchSimple(el, p));
  }

  class MiniElement {
    constructor(tagName) {
      this.nodeType = 1;
      this.tagName = String(tagName || 'div').toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.listeners = new Map();
      this._text = '';
      this._innerHTML = '';
      this.disabled = false;
    }
    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get firstElementChild() { return this.children[0] || null; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.documentElement || cur === doc.body) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v ?? '');
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
      this._innerHTML = String(html ?? '');
      this.children = [];
      this._text = '';
      /* Parse popover menu button & label span if present */
      const btnM = this._innerHTML.match(/<button[^>]*data-ag-branch-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/);
      if (btnM) {
        const b = new MiniElement('button');
        b.setAttribute('data-ag-branch-action', btnM[1]);
        b.setAttribute('role', 'menuitem');
        b.className = 'ag-branch-menu-item';
        const lblM = btnM[2].match(/<span[^>]*class="ag-branch-menu-label"[^>]*>([\s\S]*?)<\/span>/);
        if (lblM) {
          const sp = new MiniElement('span');
          sp.className = 'ag-branch-menu-label';
          sp.textContent = lblM[1];
          b.appendChild(sp);
        }
        this.appendChild(b);
      }
    }
    setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
    getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null; }
    hasAttribute(k) { return this.attrs.has(String(k)); }
    removeAttribute(k) { this.attrs.delete(String(k)); }
    appendChild(child) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      this.listeners.set(type, list.filter((f) => f !== fn));
    }
    dispatchEvent(ev) {
      const event = Object.assign({ type: '', target: this, bubbles: true, preventDefault() {}, stopPropagation() {} }, ev);
      if (!event.target) event.target = this;
      let cur = this;
      while (cur) {
        const fns = cur.listeners.get(event.type) || [];
        for (const fn of [...fns]) fn(event);
        if (!event.bubbles) break;
        cur = cur.parentElement;
      }
      return true;
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this, bubbles: true });
    }
    matches(sel) { return matchesSelector(this, sel); }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const isDirectScope = splitSelectors(sel).every((s) => s.startsWith(':scope >'));
      const walk = (node, depth) => {
        for (const ch of node.children) {
          if (matchesSelector(ch, sel)) out.push(ch);
          if (!isDirectScope || depth === 0) {
            if (!isDirectScope) walk(ch, depth + 1);
          }
        }
      };
      walk(this, 0);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    getBoundingClientRect() {
      return { left: 200, right: 228, top: 180, bottom: 208, width: 28, height: 28 };
    }
  }

  const docListeners = new Map();
  const docEl = new MiniElement('html');
  docEl.setAttribute('data-ag-ux-lang', lang);
  const body = new MiniElement('body');
  docEl.appendChild(body);
  const root = new MiniElement('div');
  root.id = 'root';
  const mainEl = new MiniElement('main');
  mainEl.id = 'app-main';
  root.appendChild(mainEl);
  body.appendChild(root);

  const doc = {
    documentElement: docEl,
    body,
    createElement: (tag) => new MiniElement(tag),
    getElementById: (id) => docEl.querySelector(`#${id}`),
    querySelector: (sel) => docEl.querySelector(sel),
    querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = docListeners.get(type);
      if (list) docListeners.set(type, list.filter((f) => f !== fn));
    },
    dispatchEvent: (ev) => {
      const fns = docListeners.get(ev.type) || [];
      for (const fn of [...fns]) fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev));
      return true;
    }
  };

  const parsedUrl = new URL(url);
  const winListeners = new Map();
  const rafQueue = [];
  const win = {
    document: doc,
    location: {
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      href: parsedUrl.href,
      assigned: [],
      assign(u) { this.assigned.push(u); }
    },
    innerWidth: 1200,
    innerHeight: 800,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    addEventListener: (type, fn) => {
      const list = winListeners.get(type) || [];
      list.push(fn);
      winListeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = winListeners.get(type);
      if (list) winListeners.set(type, list.filter((f) => f !== fn));
    },
    dispatchEvent: (ev) => {
      const fns = winListeners.get(ev.type) || [];
      for (const fn of [...fns]) fn(ev);
      return true;
    }
  };
  win.window = win;

  return {
    window: win,
    doc,
    mainEl,
    flushRaf: () => {
      while (rafQueue.length) rafQueue.shift()(0);
    }
  };
}

function createHarness({
  url = `http://127.0.0.1/c/${SRC_CID}?project=${PROJ_ID}`,
  lang = 'zh',
  modules = { branchChat: true },
  summaries = {
    [SRC_CID]: {
      summary: 'Original Chat',
      projectId: PROJ_ID,
      workspaces: [{ workspaceFolderAbsoluteUri: WS_URI }],
      trajectoryMetadata: { projectId: PROJ_ID, workspaceUris: [WS_URI] }
    }
  },
  forkConversation = async () => ({ newCascadeId: NEW_CID, newProjectId: PROJ_ID, forkedAtStepIndex: 5 }),
  daemonHandler = async () => ({ ok: true, projectId: PROJ_ID, workspaceUris: [WS_URI] })
} = {}) {
  const { window, doc, mainEl, flushRaf } = createMiniDom({ url, lang });

  const navCalls = [];
  const dispatched = [];
  const writeSummaryCalls = [];
  const daemonCalls = [];
  const forkCalls = [];
  const events = [];

  const router = {
    state: { location: { pathname: new URL(url).pathname, search: Object.fromEntries(new URL(url).searchParams) } },
    buildLocation: ({ to, params }) => ({ pathname: to.replace('$cascadeId', params?.cascadeId || '') }),
    navigate: (opts) => {
      const resolvedSearch = typeof opts.search === 'function' ? opts.search(router.state.location.search) : opts.search;
      navCalls.push({ ...opts, resolvedSearch });
    }
  };
  const store = {
    getState: () => ({ trajectorySummaries: { summaries } }),
    dispatch: (action) => dispatched.push(action)
  };
  const actions = {
    writeSummary: async (req) => writeSummaryCalls.push(req),
    updateConversationAnnotations: async () => {}
  };
  const service = {
    forkConversation: async (req) => {
      forkCalls.push(req);
      return forkConversation(req);
    }
  };

  mainEl.__reactFiber$test = {
    memoizedProps: { sidebarStore: store, sidebarActions: actions, sidebarRouter: router },
    dependencies: { firstContext: { memoizedValue: service, next: null } },
    return: null
  };

  window.addEventListener('ag-title-sync-updated', (e) => events.push(e.detail));
  window.__agProjectCall = async (action, payload) => {
    daemonCalls.push({ action, payload });
    return daemonHandler(action, payload);
  };

  const cleanups = [];
  window.ctx = { modules, onCleanup: (fn) => cleanups.push(fn) };
  vm.runInNewContext(CLIENT_SRC, window);

  const addToolbar = ({
    steps = [makeStep(2), makeStep(5)],
    alternateSteps = null,
    isLatest = false,
    nativeFork = false,
    sideQuestion = false,
    streamingHeading = false,
    cascadeId = SRC_CID
  } = {}) => {
    const turn = doc.createElement('div');
    turn.setAttribute('data-testid', 'agent-response');
    if (streamingHeading) {
      const h6 = doc.createElement('h6');
      h6.className = 'sr-only';
      h6.textContent = 'Agent working';
      turn.appendChild(h6);
    }
    const tb = doc.createElement('div');
    tb.setAttribute('data-testid', 'cascade-system-message-toolbar');
    const row = doc.createElement('div');
    const grp = doc.createElement('div');
    grp.className = 'flex shrink-0 items-center';

    const copyBtn = doc.createElement('button');
    copyBtn.setAttribute('aria-label', 'Copy');
    copyBtn.className = 'text-secondary-foreground hover:text-foreground';
    grp.appendChild(copyBtn);

    if (sideQuestion) {
      const sq = doc.createElement('button');
      sq.setAttribute('data-testid', 'side-question-insert-to-main');
      grp.appendChild(sq);
    }
    if (nativeFork) {
      const nf = doc.createElement('button');
      nf.setAttribute('aria-label', 'Fork Conversation');
      nf.setAttribute('data-tooltip-id', 'fork-native-1');
      grp.appendChild(nf);
    }

    const upBtn = doc.createElement('button');
    upBtn.setAttribute('aria-label', 'Good response');
    grp.appendChild(upBtn);

    const downBtn = doc.createElement('button');
    downBtn.setAttribute('aria-label', 'Bad response');
    grp.appendChild(downBtn);

    row.appendChild(grp);
    tb.appendChild(row);
    turn.appendChild(tb);
    mainEl.appendChild(turn);

    tb.__reactFiber$test = {
      memoizedProps: { steps, isLatest, cascadeId },
      alternate: alternateSteps ? { memoizedProps: { steps: alternateSteps, isLatest, cascadeId } } : null,
      return: mainEl.__reactFiber$test
    };
    return { turn, tb, grp };
  };

  return {
    window,
    doc,
    mainEl,
    summaries,
    navCalls,
    dispatched,
    writeSummaryCalls,
    daemonCalls,
    forkCalls,
    events,
    cleanups,
    flushRaf,
    addToolbar,
    close: () => window.__agBranchChat?.dispose()
  };
}

test('mounts "..." button on completed toolbars, opens ChatGPT-style pill popover, and branches in current workspace & same project', async () => {
  const h = createHarness();
  try {
    const { tb } = h.addToolbar({
      steps: [makeStep(1), makeStep(4)],
      alternateSteps: [makeStep(1), makeStep(4), makeStep(7, 'Fresher alternate reply')],
      isLatest: false
    });
    h.window.__agBranchChat.scanToolbars();

    const moreBtn = tb.querySelector('[data-ag-branch-more]');
    assert.ok(moreBtn, 'should inject "..." button');
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'false');

    moreBtn.click();
    const pop = h.doc.getElementById('ag-branch-popover');
    assert.ok(pop, 'should open popover menu');
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'true');
    assert.match(pop.textContent, /分支到新聊天/);

    const forkItem = pop.querySelector('[data-ag-branch-action="fork"]');
    assert.ok(forkItem, 'popover should contain fork action button');
    forkItem.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.doc.getElementById('ag-branch-popover'), null, 'popover should close after click');
    assert.equal(h.forkCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.forkCalls[0])), {
      sourceCascadeId: SRC_CID,
      forkAtStepIndex: 7,
      targetForkWorkspace: 1,
      sourceWorkspaceUris: [WS_URI]
    });
    assert.equal(h.daemonCalls.length, 0, 'no fallback move needed when backend already returns same projectId');
    assert.equal(h.navCalls.length, 1);
    assert.equal(h.navCalls[0].to, '/c/$cascadeId');
    assert.equal(h.navCalls[0].params.cascadeId, NEW_CID);
    assert.equal(h.navCalls[0].resolvedSearch.project, PROJ_ID);
  } finally {
    h.close();
  }
});

test('auto-yields per-toolbar when native Fork Conversation button is present, while still enhancing historical toolbars', () => {
  const h = createHarness();
  try {
    const historical = h.addToolbar({ steps: [makeStep(3)], isLatest: false, nativeFork: false });
    const latestWithNative = h.addToolbar({ steps: [makeStep(9)], isLatest: true, nativeFork: true });
    const sideQ = h.addToolbar({ steps: [makeStep(2)], isLatest: true, sideQuestion: true });
    const streaming = h.addToolbar({ steps: [makeStep(11)], isLatest: true, streamingHeading: true });

    h.window.__agBranchChat.scanToolbars();

    assert.ok(historical.tb.querySelector('[data-ag-branch-more]'), 'historical toolbar without native button gets "..."');
    assert.equal(latestWithNative.tb.querySelector('[data-ag-branch-more]'), null, 'toolbar with native fork button must auto-yield');
    assert.equal(sideQ.tb.querySelector('[data-ag-branch-more]'), null, 'side-question toolbar must be skipped');
    assert.equal(streaming.tb.querySelector('[data-ag-branch-more]'), null, 'actively streaming turn must be skipped');

    // Simulate Antigravity later rolling out native fork onto the historical toolbar as well
    const lateNative = h.doc.createElement('button');
    lateNative.setAttribute('aria-label', 'Fork Conversation');
    historical.grp.appendChild(lateNative);
    h.window.__agBranchChat.scanToolbars();
    assert.equal(historical.tb.querySelector('[data-ag-branch-more]'), null, 'previously injected button is removed when native fork appears');
  } finally {
    h.close();
  }
});

test('falls back to moveConversationToProject (with retry) when backend drops source projectId on fork', async () => {
  let daemonAttempts = 0;
  const h = createHarness({
    forkConversation: async () => {
      h.summaries[NEW_CID] = {
        summary: 'Original Chat (fork)',
        projectId: 'outside-of-project',
        workspaces: [],
        trajectoryMetadata: { projectId: 'outside-of-project', workspaceUris: [] }
      };
      return { newCascadeId: NEW_CID, newProjectId: 'outside-of-project', forkedAtStepIndex: 5 };
    },
    daemonHandler: async (action, payload) => {
      daemonAttempts += 1;
      if (daemonAttempts === 1) return { ok: false, error: 'conversation_not_found' };
      return { ok: true, conversationId: payload.conversationId, projectId: payload.projectId, workspaceUris: [WS_URI] };
    }
  });

  try {
    const { tb } = h.addToolbar({ steps: [makeStep(5)], isLatest: false });
    const res = await h.window.__agBranchChat.branchFromToolbar(tb);

    assert.equal(res.ok, true);
    assert.equal(res.fallbackMoved, true);
    assert.equal(res.projectId, PROJ_ID);
    assert.equal(daemonAttempts, 2, 'should retry once after conversation_not_found');
    assert.equal(h.daemonCalls[0].action, 'moveConversationToProject');
    assert.equal(h.daemonCalls[0].payload.conversationId, NEW_CID);
    assert.equal(h.daemonCalls[0].payload.projectId, PROJ_ID);
    assert.equal(h.writeSummaryCalls.length, 1);
    assert.equal(h.dispatched.length, 1);
    assert.equal(h.dispatched[0].type, 'trajectorySummaries/applyStreamBatch');
    assert.equal(h.navCalls.length, 1);
    assert.equal(h.navCalls[0].resolvedSearch.project, PROJ_ID);
  } finally {
    h.close();
  }
});

test('out-of-project conversation forks cleanly without project assignment or move RPC', async () => {
  const h = createHarness({
    url: `http://127.0.0.1/c/${SRC_CID}`,
    summaries: {
      [SRC_CID]: {
        summary: 'Standalone Chat',
        projectId: 'outside-of-project',
        workspaces: [],
        trajectoryMetadata: { projectId: 'outside-of-project', workspaceUris: [] }
      }
    },
    forkConversation: async () => ({ newCascadeId: NEW_CID, newProjectId: '', forkedAtStepIndex: 3 })
  });

  try {
    const { tb } = h.addToolbar({ steps: [makeStep(3)], isLatest: false });
    const res = await h.window.__agBranchChat.branchFromToolbar(tb);

    assert.equal(res.ok, true);
    assert.equal(res.fallbackMoved, false);
    assert.equal(res.projectId, '');
    assert.equal(h.daemonCalls.length, 0);
    assert.equal(h.forkCalls[0].targetForkWorkspace, 1);
    assert.equal('sourceWorkspaceUris' in h.forkCalls[0], false);
    assert.equal(h.navCalls[0].resolvedSearch.project, undefined);
  } finally {
    h.close();
  }
});

test('supports Escape dismissal, i18n language refresh, setEnabled(false) teardown, and re-entrancy guard', async () => {
  let resolveFork;
  const h = createHarness({
    lang: 'en',
    forkConversation: () => new Promise((resolve) => { resolveFork = resolve; })
  });

  try {
    const { tb } = h.addToolbar({ steps: [makeStep(6)], isLatest: false });
    h.window.__agBranchChat.scanToolbars();
    const moreBtn = tb.querySelector('[data-ag-branch-more]');
    assert.equal(moreBtn.getAttribute('aria-label'), 'More options');

    moreBtn.click();
    assert.match(h.doc.getElementById('ag-branch-popover').textContent, /Branch in new chat/);

    // Switch language live
    h.doc.documentElement.setAttribute('data-ag-ux-lang', 'zh');
    h.window.__agBranchChat.refreshLanguage();
    assert.equal(moreBtn.getAttribute('aria-label'), '更多操作');
    assert.match(h.doc.getElementById('ag-branch-popover').textContent, /分支到新聊天/);

    // Escape closes popover
    h.doc.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    assert.equal(h.doc.getElementById('ag-branch-popover'), null);

    // Re-entrancy guard prevents duplicate concurrent forks
    const p1 = h.window.__agBranchChat.branchFromToolbar(tb, moreBtn);
    const p2 = h.window.__agBranchChat.branchFromToolbar(tb, moreBtn);
    const r2 = await p2;
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'already_forking');
    assert.equal(h.forkCalls.length, 1);

    resolveFork({ newCascadeId: NEW_CID, newProjectId: PROJ_ID, forkedAtStepIndex: 6 });
    const r1 = await p1;
    assert.equal(r1.ok, true);

    // Disabling removes all injected buttons immediately
    h.window.__agBranchChat.setEnabled(false);
    assert.equal(h.doc.querySelectorAll('[data-ag-branch-more]').length, 0);

    // Re-enabling restores cleanly
    h.window.__agBranchChat.setEnabled(true);
    h.flushRaf();
    assert.equal(h.doc.querySelectorAll('[data-ag-branch-more]').length, 1);
  } finally {
    h.close();
  }
});

test('daemon listBranchedConversations identifies true forks (field #6 !== self) and ignores self-references', () => {
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-branch-list-'));
  const forkId = 'aaaaaaaa-1111-4222-8333-444444444441';
  const selfRefId = 'bbbbbbbb-1111-4222-8333-444444444442';
  const plainId = 'cccccccc-1111-4222-8333-444444444443';
  const sourceId = 'dddddddd-1111-4222-8333-444444444444';

  const makeConvDb = (cid, refCid) => {
    const db = new DatabaseSync(path.join(convDir, `${cid}.db`));
    db.exec('CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB)');
    if (refCid) {
      db.prepare('INSERT INTO parent_references (idx, data) VALUES (?, ?)').run(0, makeStringField(6, refCid));
    }
    db.close();
  };

  try {
    makeConvDb(forkId, sourceId);
    makeConvDb(selfRefId, selfRefId);
    makeConvDb(plainId, null);

    assert.deepEqual(listBranchedConversations(convDir), [forkId]);
    // Second call uses cache and returns identical result
    assert.deepEqual(listBranchedConversations(convDir), [forkId]);
  } finally {
    fs.rmSync(convDir, { recursive: true, force: true });
  }
});

test('decorates branched conversation titles in sidebar, recents, project detail, and titlebar, and clears on recycle/disable', async () => {
  const h = createHarness({
    url: `http://127.0.0.1/c/${NEW_CID}?project=${PROJ_ID}`,
    daemonHandler: async (action) => {
      if (action === 'listBranchedConversations') return { ok: true, ids: [NEW_CID] };
      return { ok: true };
    }
  });

  try {
    // 1. Native sidebar row (indented project row: text starts at left=28 inside row)
    const sbWrap = h.doc.createElement('div');
    sbWrap.setAttribute('data-testid', 'conversation-list-sidebar');
    sbWrap.getBoundingClientRect = () => ({ left: 0, right: 260, top: 0, bottom: 600, width: 260, height: 600 });
    const sbRow = h.doc.createElement('div');
    sbRow.setAttribute('data-testid', 'conversation-row-sidebar');
    sbRow.setAttribute('data-cascade-id', NEW_CID);
    sbRow.getBoundingClientRect = () => ({ left: 8, right: 252, top: 40, bottom: 72, width: 244, height: 32 });
    const link = h.doc.createElement('a');
    link.setAttribute('href', `/c/${NEW_CID}`);
    const titleSpan = h.doc.createElement('span');
    titleSpan.className = 'truncate';
    titleSpan.textContent = 'Implement Chat Branching Feature';
    titleSpan.getBoundingClientRect = () => ({ left: 36, right: 220, top: 46, bottom: 66, width: 184, height: 20 });
    link.appendChild(titleSpan);
    const subSpan = h.doc.createElement('span');
    subSpan.className = 'truncate';
    subSpan.textContent = 'Anti-Claude';
    sbRow.appendChild(link);
    sbRow.appendChild(subSpan);
    sbWrap.appendChild(sbRow);
    h.mainEl.appendChild(sbWrap);

    // 2. Recent 20 row (flat row inside 8px sidebar margin + 8px row padding = 16px gutter)
    const recentSec = h.doc.createElement('section');
    recentSec.id = 'ag-claude-recent-section';
    const recentRow = h.doc.createElement('div');
    recentRow.setAttribute('data-ag-recent-id', NEW_CID);
    recentRow.getBoundingClientRect = () => ({ left: 8, right: 252, top: 100, bottom: 132, width: 244, height: 32 });
    const recentTitle = h.doc.createElement('div');
    recentTitle.className = 'ag-recent-title';
    recentTitle.textContent = 'Implement Chat Branching Feature';
    recentTitle.getBoundingClientRect = () => ({ left: 16, right: 210, top: 106, bottom: 126, width: 194, height: 20 });
    recentRow.appendChild(recentTitle);
    recentSec.appendChild(recentRow);
    sbWrap.appendChild(recentSec);

    // 3. Projects detail row (36px shell padding + 6px row padding)
    const projView = h.doc.createElement('section');
    projView.id = 'ag-claude-projects-view';
    projView.getBoundingClientRect = () => ({ left: 260, right: 1200, top: 0, bottom: 800, width: 940, height: 800 });
    const pdRow = h.doc.createElement('button');
    pdRow.setAttribute('data-ag-pd-chat', NEW_CID);
    pdRow.getBoundingClientRect = () => ({ left: 296, right: 800, top: 200, bottom: 244, width: 504, height: 44 });
    const pdTitle = h.doc.createElement('span');
    pdTitle.className = 'ag-pd-chat-title';
    pdTitle.textContent = 'Implement Chat Branching Feature';
    pdTitle.getBoundingClientRect = () => ({ left: 302, right: 600, top: 212, bottom: 232, width: 298, height: 20 });
    pdRow.appendChild(pdTitle);
    projView.appendChild(pdRow);
    h.mainEl.appendChild(projView);

    // 4. Titlebar breadcrumb (project + active conversation)
    const crumbProj = h.doc.createElement('span');
    crumbProj.setAttribute('data-testid', 'breadcrumb-segment');
    crumbProj.textContent = 'Anti-Claude';
    const crumbChat = h.doc.createElement('span');
    crumbChat.setAttribute('data-testid', 'breadcrumb-segment');
    const crumbTrunc = h.doc.createElement('span');
    crumbTrunc.className = 'truncate';
    crumbTrunc.textContent = 'Implement Chat Branching Feature';
    crumbChat.appendChild(crumbTrunc);
    h.mainEl.appendChild(crumbProj);
    h.mainEl.appendChild(crumbChat);

    await h.window.__agBranchChat.syncBranchedIdsFromDaemon(true);

    // Indented project row places hanging icon in left gutter at 28 - 18 = 10px without shifting title text
    assert.equal(sbRow.getAttribute('data-ag-branch-gutter'), '1', 'native sidebar row gets hanging gutter icon');
    assert.equal(sbRow.style['--ag-branch-ico-left'], '10px');
    assert.equal(titleSpan.hasAttribute('data-ag-branch-title'), false, 'title text flow must not be shifted');
    assert.equal(subSpan.hasAttribute('data-ag-branch-title'), false, 'subtitle span must not get duplicate icon');

    // Flat recent row hangs compact icon in gutter while keeping text aligned
    assert.equal(recentRow.getAttribute('data-ag-branch-gutter'), '1', 'recent row gets hanging gutter icon');
    assert.equal(recentRow.getAttribute('data-ag-branch-gutter-compact'), '1');
    assert.equal(recentTitle.hasAttribute('data-ag-branch-title'), false);

    // Project detail row hangs icon in left margin while keeping text aligned
    assert.equal(pdRow.getAttribute('data-ag-branch-gutter'), '1', 'project detail row gets hanging gutter icon');
    assert.equal(pdRow.style['--ag-branch-ico-left'], '-10px');

    // Titlebar breadcrumb uses inline icon
    assert.equal(crumbProj.hasAttribute('data-ag-branch-title'), false, 'project breadcrumb must not get branch icon');
    assert.equal(crumbTrunc.getAttribute('data-ag-branch-title'), '1', 'active chat breadcrumb gets inline branch icon');

    // Virtual row recycled to non-branched conversation clears the gutter mark
    sbRow.setAttribute('data-cascade-id', SRC_CID);
    h.window.__agBranchChat.decorateBranchedTitles();
    assert.equal(sbRow.hasAttribute('data-ag-branch-gutter'), false, 'recycled non-branched row must clear gutter icon');

    // Disabling clears all remaining branch marks
    h.window.__agBranchChat.setEnabled(false);
    assert.equal(h.doc.querySelectorAll('[data-ag-branch-title]').length, 0);
    assert.equal(h.doc.querySelectorAll('[data-ag-branch-gutter]').length, 0);
  } finally {
    h.close();
  }
});

test('shows actionable localized toast messages for known backend fork errors and strips gRPC prefix on fallback', async () => {
  let nextErr = null;
  const h = createHarness({
    lang: 'zh',
    forkConversation: async () => {
      throw nextErr;
    }
  });

  try {
    const { tb } = h.addToolbar({ steps: [makeStep(52)], isLatest: true });

    // 1. Running background task (non-terminal status) — zh
    nextErr = new Error(
      '[failed_precondition] cannot fork conversation "ce3431ea-51de-4629-9fc3-1556ccb12d60" at step 52: a fork must be taken at a turn boundary, but step 50 has non-terminal status CORTEX_STEP_STATUS_RUNNING'
    );
    const r1 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r1.ok, false);
    assert.equal(r1.errorCode, 'running_task');
    assert.match(r1.userMessage, /后台任务/);
    assert.equal(h.doc.getElementById('ag-branch-chat-toast').textContent, r1.userMessage);
    assert.equal(h.doc.getElementById('ag-branch-chat-toast').getAttribute('data-kind'), 'error');

    // 2. Running background task — en
    h.doc.documentElement.setAttribute('data-ag-ux-lang', 'en');
    const r2 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r2.errorCode, 'running_task');
    assert.match(r2.userMessage, /background task is running/i);

    // 3. Subagent conversation
    h.doc.documentElement.setAttribute('data-ag-ux-lang', 'zh');
    nextErr = new Error('cannot fork a subagent conversation; fork the parent conversation instead');
    const r3 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r3.errorCode, 'subagent_conversation');
    assert.match(r3.userMessage, /子代理对话/);

    // 4. Not at turn boundary
    nextErr = new Error('cannot fork conversation "x" at step 1: that step is a user message');
    const r4 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r4.errorCode, 'not_turn_boundary');
    assert.match(r4.userMessage, /回复的末尾/);

    // 5. Conversation that invoked subagents (real Antigravity backend restriction)
    nextErr = new Error(
      'internal: failed to create forked conversation: forking is not supported for conversations that have invoked subagents'
    );
    const r5 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r5.errorCode, 'has_subagents');
    assert.match(r5.userMessage, /子代理（Subagent）/);

    // 6. Unknown backend error preserves concise reason without gRPC/wrapper prefixes
    nextErr = new Error('internal: failed to create forked conversation: disk quota exceeded while cloning artifacts');
    const r6 = await h.window.__agBranchChat.branchFromToolbar(tb);
    assert.equal(r6.errorCode, 'fork_failed');
    assert.equal(r6.userMessage, '分支对话失败：disk quota exceeded while cloning artifacts');
  } finally {
    h.close();
  }
});
