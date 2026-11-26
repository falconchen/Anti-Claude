/* Independent renderer module. Adds ChatGPT-style "..." -> "Branch in new chat" popover to assistant reply toolbars using native ForkConversation RPC (current workspace) with same-project fallback persistence. */
(function () {
  if (typeof window.__agBranchChat?.dispose === 'function') window.__agBranchChat.dispose();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const RESERVED_PROJECTS = new Set(['outside-of-project', 'default-cli-project']);
  const FORK_TARGET_CURRENT_WORKSPACE = 1;
  const AGENT_WORKING_H6_RE = /^(?:Agent\s+working|Agent\s*正在执行|Agent\s*正在工作|正在工作)$/i;
  const BRANCHED_IDS_STORAGE_KEY = 'ag_branch_chat_ids_v1';
  const BRANCHED_PARENTS_STORAGE_KEY = 'ag_branch_chat_parents_v1';
  const COLLAPSED_PARENTS_STORAGE_KEY = 'ag_branch_chat_collapsed_v1';
  const MAX_VISUAL_DEPTH = 3;
  const VIRT_PATCH_TOKEN = Symbol('agBranchVirtPatch');

  const MORE_ICON_SVG =
    '<svg class="ag-branch-ico h-4 w-4" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="19" cy="12" r="1.75"/></svg>';
  const BRANCH_ICON_SVG =
    '<svg class="ag-branch-menu-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h6.5"/><path d="M10.5 12 19 5"/><path d="M14.5 5H19v4.5"/><path d="M10.5 12 19 19"/><path d="M14.5 19H19v-4.5"/></svg>';
  const SPINNER_ICON_SVG =
    '<svg class="ag-branch-spinner h-4 w-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-opacity="0.22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>';
  const CHEVRON_DOWN_SVG =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6 3.5 4 3.5-4"/></svg>';

  let enabled = ctx.modules?.branchChat !== false;
  let disposed = false;
  let forking = false;
  let cachedService = null;
  let cachedStore = null;
  let cachedActions = null;
  let cachedRouter = null;
  let activePopover = null;
  let activeTriggerBtn = null;
  let activeToolbarEl = null;
  let toastTimer = 0;
  let obs = null;
  let rafId = 0;
  let dclHandler = null;
  let lastBranchedFetchAt = 0;
  let branchedFetchInFlight = false;
  let treeVersion = 1;
  let patchedVirt = null;
  let lastSidebarMetaByCid = new Map();
  const branchedIds = new Set();
  const parentByChild = new Map();
  const collapsedParents = new Set();
  const stats = { branchedCount: 0, fallbackMovedCount: 0, lastBranchedId: '', lastError: '' };

  function loadStoredBranchedIds() {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return;
      const raw = localStorage.getItem(BRANCHED_IDS_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        for (const id of arr) {
          const s = String(id || '').trim().toLowerCase();
          if (UUID_RE.test(s)) branchedIds.add(s);
        }
      }
      const rawParents = localStorage.getItem(BRANCHED_PARENTS_STORAGE_KEY);
      const pObj = rawParents ? JSON.parse(rawParents) : null;
      if (pObj && typeof pObj === 'object' && !Array.isArray(pObj)) {
        for (const [k, v] of Object.entries(pObj)) {
          const child = String(k || '').trim().toLowerCase();
          const parent = String(v || '').trim().toLowerCase();
          if (UUID_RE.test(child) && UUID_RE.test(parent) && child !== parent) {
            branchedIds.add(child);
            parentByChild.set(child, parent);
          }
        }
      }
      const rawCol = localStorage.getItem(COLLAPSED_PARENTS_STORAGE_KEY);
      const colArr = rawCol ? JSON.parse(rawCol) : null;
      if (Array.isArray(colArr)) {
        for (const id of colArr) {
          const s = String(id || '').trim().toLowerCase();
          if (UUID_RE.test(s)) collapsedParents.add(s);
        }
      }
    } catch {}
  }

  function persistStoredBranchedIds() {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(BRANCHED_IDS_STORAGE_KEY, JSON.stringify(Array.from(branchedIds).slice(-500)));
        const entries = Array.from(parentByChild.entries()).slice(-500);
        localStorage.setItem(BRANCHED_PARENTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
      }
    } catch {}
  }

  function persistCollapsedParents() {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(COLLAPSED_PARENTS_STORAGE_KEY, JSON.stringify(Array.from(collapsedParents).slice(-200)));
      }
    } catch {}
  }

  function emitTreeUpdated() {
    try {
      if (typeof CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ag-branch-tree-updated', { detail: { version: treeVersion } }));
      }
    } catch {}
  }

  function markBranchedId(cid, parentCid = '') {
    const norm = String(cid || '').trim().toLowerCase();
    if (!UUID_RE.test(norm)) return false;
    let changed = false;
    if (!branchedIds.has(norm)) {
      branchedIds.add(norm);
      changed = true;
    }
    const normParent = String(parentCid || '').trim().toLowerCase();
    if (UUID_RE.test(normParent) && normParent !== norm && parentByChild.get(norm) !== normParent) {
      parentByChild.set(norm, normParent);
      changed = true;
    }
    if (changed) {
      treeVersion += 1;
      persistStoredBranchedIds();
      emitTreeUpdated();
    }
    return changed;
  }

  function expandAncestorsOf(cid) {
    let cur = String(cid || '').trim().toLowerCase();
    const seen = new Set();
    let changed = false;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (collapsedParents.delete(cur)) changed = true;
      cur = parentByChild.get(cur) || '';
    }
    if (changed) {
      treeVersion += 1;
      persistCollapsedParents();
    }
    return changed;
  }

  function isBranched(cid, titleHint = '') {
    const norm = String(cid || '').trim().toLowerCase();
    if (norm && branchedIds.has(norm)) return true;
    if (titleHint && /\(fork\)\s*$/i.test(String(titleHint))) return true;
    return false;
  }

  function getParentId(cid) {
    const norm = String(cid || '').trim().toLowerCase();
    return norm ? parentByChild.get(norm) || '' : '';
  }

  function isParentCollapsed(cid) {
    const norm = String(cid || '').trim().toLowerCase();
    return Boolean(norm && collapsedParents.has(norm));
  }

  function groupConversationRun(ids, { respectCollapsed = true } = {}) {
    const len = Array.isArray(ids) ? ids.length : 0;
    if (len === 0) return { entries: [], changed: false, reordered: false };

    const normIds = new Array(len);
    const indexByCid = new Map();
    for (let i = 0; i < len; i++) {
      const c = String(ids[i] || '').trim().toLowerCase();
      normIds[i] = c;
      if (c && !indexByCid.has(c)) indexByCid.set(c, i);
    }

    const childrenOf = new Map();
    const roots = [];
    let hasAnyRelation = false;

    for (let i = 0; i < len; i++) {
      const cid = normIds[i];
      let parentPos = -1;
      if (cid) {
        let cur = parentByChild.get(cid) || '';
        const seen = new Set([cid]);
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          if (indexByCid.has(cur)) {
            parentPos = indexByCid.get(cur);
            break;
          }
          cur = parentByChild.get(cur) || '';
        }
      }
      if (parentPos >= 0 && parentPos !== i) {
        hasAnyRelation = true;
        let list = childrenOf.get(parentPos);
        if (!list) {
          list = [];
          childrenOf.set(parentPos, list);
        }
        list.push(i);
      } else {
        roots.push(i);
      }
    }

    if (!hasAnyRelation) {
      const entries = new Array(len);
      for (let i = 0; i < len; i++) {
        entries[i] = {
          origPos: i,
          cid: normIds[i],
          depth: 0,
          rawDepth: 0,
          parentCid: '',
          directChildCount: 0,
          totalDescendantCount: 0,
          collapsed: false,
          isLastChild: false,
          isGroupedChild: false
        };
      }
      return { entries, changed: false, reordered: false };
    }

    const bestPosCache = new Map();
    const descCountCache = new Map();
    const computeMetrics = (pos, stack = new Set()) => {
      if (bestPosCache.has(pos)) return { best: bestPosCache.get(pos), desc: descCountCache.get(pos) };
      if (stack.has(pos)) return { best: pos, desc: 0 };
      stack.add(pos);
      let best = pos;
      let desc = 0;
      const kids = childrenOf.get(pos);
      if (kids) {
        for (const k of kids) {
          const m = computeMetrics(k, stack);
          if (m.best < best) best = m.best;
          desc += 1 + m.desc;
        }
      }
      stack.delete(pos);
      bestPosCache.set(pos, best);
      descCountCache.set(pos, desc);
      return { best, desc };
    };

    for (let i = 0; i < len; i++) computeMetrics(i);
    const cmpByBest = (a, b) => {
      const ba = bestPosCache.get(a) ?? a;
      const bb = bestPosCache.get(b) ?? b;
      return ba !== bb ? ba - bb : a - b;
    };
    roots.sort(cmpByBest);
    for (const list of childrenOf.values()) list.sort(cmpByBest);

    const entries = [];
    const emitted = new Set();
    const visit = (pos, depth, parentCid, isLastChild) => {
      if (emitted.has(pos)) return;
      emitted.add(pos);
      const cid = normIds[pos];
      const kids = childrenOf.get(pos) || [];
      const totalDesc = descCountCache.get(pos) || 0;
      const collapsed = Boolean(respectCollapsed && totalDesc > 0 && cid && collapsedParents.has(cid));
      entries.push({
        origPos: pos,
        cid,
        depth: Math.min(depth, MAX_VISUAL_DEPTH),
        rawDepth: depth,
        parentCid,
        directChildCount: kids.length,
        totalDescendantCount: totalDesc,
        collapsed,
        isLastChild,
        isGroupedChild: depth > 0
      });
      if (kids.length > 0 && !collapsed) {
        for (let k = 0; k < kids.length; k++) {
          visit(kids[k], depth + 1, cid, k === kids.length - 1);
        }
      }
    };

    for (const r of roots) visit(r, 0, '', false);

    let reordered = entries.length !== len;
    if (!reordered) {
      for (let i = 0; i < len; i++) {
        if (entries[i].origPos !== i) {
          reordered = true;
          break;
        }
      }
    }
    return { entries, changed: true, reordered };
  }

  function orderConversationList(items, { respectCollapsed = true } = {}) {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (!enabled || disposed || parentByChild.size === 0) return items;

    const out = [];
    let i = 0;
    while (i < items.length) {
      const pinnedFlag = Boolean(items[i]?.pinned);
      let j = i + 1;
      while (j < items.length && Boolean(items[j]?.pinned) === pinnedFlag) j++;
      const slice = items.slice(i, j);
      const grouped = groupConversationRun(
        slice.map((it) => it?.id || it?.cascadeId || ''),
        { respectCollapsed }
      );
      for (const e of grouped.entries) {
        const src = slice[e.origPos];
        out.push(
          Object.assign({}, src, {
            branchDepth: e.depth,
            branchParentId: e.parentCid,
            branchChildCount: e.totalDescendantCount,
            branchCollapsed: e.collapsed,
            branchIsLastChild: e.isLastChild,
            branchIsGroupedChild: e.isGroupedChild
          })
        );
      }
      i = j;
    }
    return out;
  }

  loadStoredBranchedIds();

  const L = (zh, en) => (document.documentElement?.getAttribute('data-ag-ux-lang') === 'zh' ? zh : en);
  const callDaemon = (action, payload) =>
    typeof window.__agProjectCall === 'function'
      ? window.__agProjectCall(action, payload, 12000)
      : Promise.resolve({ ok: false, error: 'rpc_unavailable' });

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  function activeFiber(el) {
    if (!el || typeof el !== 'object') return null;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = key ? el[key] : null;
    if (!fiber) return null;
    let root = fiber;
    while (root?.return) root = root.return;
    if (root?.stateNode?.current && root.stateNode.current !== root) {
      fiber = fiber.alternate || fiber;
    }
    return fiber;
  }

  function findBindings(anchorEl = null) {
    let service = null;
    let store = null;
    let actions = null;
    let router = null;

    const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const row = sb?.querySelector('[data-testid="conversation-row-sidebar"]');
    const anchors = [
      anchorEl,
      sb?.firstElementChild,
      sb,
      row,
      document.querySelector('.bg-sidebar'),
      document.getElementById('antigravity.agentSidePanelInputBox'),
      document.querySelector('main'),
      document.getElementById('root')?.firstElementChild
    ];

    const scan = (val) => {
      if (!val || typeof val !== 'object') return;
      if (!service && typeof val.forkConversation === 'function') service = val;
      if (!store && val.sidebarStore && typeof val.sidebarStore.getState === 'function') store = val.sidebarStore;
      if (!store && val.store && typeof val.store.getState === 'function' && val.store.getState()?.trajectorySummaries?.summaries) {
        store = val.store;
      }
      if (!actions && val.sidebarActions && typeof val.sidebarActions.writeSummary === 'function') actions = val.sidebarActions;
      if (!actions && typeof val.writeSummary === 'function') actions = val;
      if (!actions && val.sidebarActions && typeof val.sidebarActions.updateConversationAnnotations === 'function') actions = val.sidebarActions;
      if (!router && val.sidebarRouter && typeof val.sidebarRouter.navigate === 'function') router = val.sidebarRouter;
      if (
        !router &&
        typeof val.navigate === 'function' &&
        (typeof val.buildLocation === 'function' || (val.state && val.state.location))
      ) {
        router = val;
      }
    };

    for (const anchor of anchors) {
      if (!anchor) continue;
      let fiber = activeFiber(anchor);
      for (let d = 0; fiber && d < 70; d++, fiber = fiber.return) {
        scan(fiber.memoizedProps);
        scan(fiber.memoizedProps?.value);
        for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) {
          scan(dep.memoizedValue);
        }
        if (service && store && actions && router) break;
      }
      if (service && store && actions && router) break;
    }

    if (service) cachedService = service;
    if (store) cachedStore = store;
    if (actions) cachedActions = actions;
    if (router) cachedRouter = router;

    return {
      service: service || cachedService,
      store: store || cachedStore,
      actions: actions || cachedActions,
      router: router || cachedRouter
    };
  }

  function stepTailSig(steps) {
    if (!Array.isArray(steps) || !steps.length) return -1;
    let maxIdx = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      const idx = steps[i]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
      if (Number.isSafeInteger(idx) && idx >= 0) {
        maxIdx = idx;
        break;
      }
    }
    const last = steps[steps.length - 1];
    const v = last?.step?.value;
    const txt = v && typeof v === 'object' ? v.modifiedResponse || v.response || '' : '';
    return steps.length * 1000000 + Math.max(0, maxIdx) * 1000 + txt.length;
  }

  function extractStepIndex(steps) {
    if (!Array.isArray(steps) || !steps.length) return -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      const idx = steps[i]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
      if (Number.isSafeInteger(idx) && idx >= 0) return idx;
    }
    return -1;
  }

  function readToolbarPropsFromFiber(toolbarEl) {
    const key = toolbarEl && Object.keys(toolbarEl).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? toolbarEl[key] : null;
    let bestSteps = null;
    let isLatest = null;
    let cascadeId = '';

    for (let d = 0; f && d < 24; d++, f = f.return) {
      for (const branch of [f, f.alternate]) {
        const p = branch?.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        if (Array.isArray(p.steps) && stepTailSig(p.steps) > stepTailSig(bestSteps)) {
          bestSteps = p.steps;
          if (typeof p.isLatest === 'boolean') isLatest = p.isLatest;
        } else if (p.container && Array.isArray(p.container.steps) && stepTailSig(p.container.steps) > stepTailSig(bestSteps)) {
          bestSteps = p.container.steps;
          if (typeof p.container.isLatest === 'boolean') isLatest = p.container.isLatest;
        }
        if (!cascadeId && typeof p.cascadeId === 'string' && UUID_RE.test(p.cascadeId)) {
          cascadeId = p.cascadeId;
        }
      }
    }

    if (!bestSteps) {
      const turnEl = toolbarEl?.closest?.('[data-testid="agent-response"]');
      const tk = turnEl && Object.keys(turnEl).find((k) => k.startsWith('__reactFiber$'));
      let tf = tk ? turnEl[tk] : null;
      for (let d = 0; tf && d < 12; d++, tf = tf.return) {
        for (const branch of [tf, tf.alternate]) {
          const p = branch?.memoizedProps;
          const steps = p?.container?.steps;
          if (Array.isArray(steps) && stepTailSig(steps) > stepTailSig(bestSteps)) {
            bestSteps = steps;
            if (typeof p.container.isLatest === 'boolean') isLatest = p.container.isLatest;
          }
          if (!cascadeId && typeof p?.cascadeId === 'string' && UUID_RE.test(p.cascadeId)) {
            cascadeId = p.cascadeId;
          }
        }
      }
    }

    if (!cascadeId) {
      const m = String(window.location?.pathname || '').match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) cascadeId = m[1];
    }

    return { steps: bestSteps, isLatest, cascadeId };
  }

  function hasNativeForkButton(toolbarEl) {
    if (!toolbarEl || typeof toolbarEl.querySelector !== 'function') return false;
    return Boolean(
      toolbarEl.querySelector(
        'button[aria-label="Fork Conversation"], button[data-ag-orig-aria-label="Fork Conversation"], button[data-tooltip-id^="fork-"]'
      )
    );
  }

  function isSideQuestionToolbar(toolbarEl) {
    if (!toolbarEl || typeof toolbarEl.querySelector !== 'function') return false;
    return Boolean(toolbarEl.querySelector('[data-testid="side-question-insert-to-main"]'));
  }

  function isBattleConversation(cascadeId, store) {
    if (/^\/battle\//i.test(String(window.location?.pathname || ''))) return true;
    const state = store?.getState?.();
    const summary = cascadeId ? state?.trajectorySummaries?.summaries?.[cascadeId] : null;
    if (summary && (summary.battleId || summary.trajectoryMetadata?.battleId)) return true;
    return false;
  }

  function isTurnActivelyStreaming(toolbarEl, isLatest) {
    if (isLatest === false) return false;
    const turnEl = toolbarEl?.closest?.('[data-testid="agent-response"]');
    if (!turnEl) return false;
    const h6 = turnEl.querySelector(':scope > h6.sr-only, :scope > h6');
    if (h6) {
      const origMap = window.__ag_orig_text_map;
      const raw =
        (origMap && h6.firstChild && origMap.get(h6.firstChild)?.origRaw) ||
        h6.textContent ||
        '';
      if (AGENT_WORKING_H6_RE.test(raw.trim())) return true;
    }
    if (isLatest === true) {
      let cur = turnEl.parentElement;
      for (let i = 0; i < 16 && cur; i++, cur = cur.parentElement) {
        const inputBox = cur.querySelector?.('[id="antigravity.agentSidePanelInputBox"]');
        if (inputBox) {
          return Boolean(inputBox.querySelector('button[data-testid="input-cancel-button"]'));
        }
      }
    }
    return false;
  }

  function findIconGroup(toolbarEl) {
    if (!toolbarEl || typeof toolbarEl.querySelector !== 'function') return null;
    const refBtn = toolbarEl.querySelector(
      'button[aria-label="Bad response"], button[data-ag-orig-aria-label="Bad response"], button[aria-label="Good response"], button[data-ag-orig-aria-label="Good response"], button[aria-label="Copy"], button[aria-label="Copied"], button[data-ag-orig-aria-label="Copy"], button[data-ag-orig-aria-label="Copied"]'
    );
    if (refBtn && refBtn.parentElement) {
      return { group: refBtn.parentElement, refBtn };
    }
    const btns = toolbarEl.querySelectorAll('button:not([data-ag-branch-more])');
    if (btns.length > 0 && btns[0].parentElement) {
      return { group: btns[0].parentElement, refBtn: btns[0] };
    }
    return null;
  }

  function readSourceProjectAndWorkspaces(cascadeId, store) {
    const state = store?.getState?.();
    const summary = cascadeId ? state?.trajectorySummaries?.summaries?.[cascadeId] : null;
    let urlPid = '';
    try {
      urlPid = new URLSearchParams(String(window.location?.search || '')).get('project') || '';
    } catch {}
    const rawPid = String(
      summary?.projectId ||
      summary?.trajectoryMetadata?.projectId ||
      urlPid ||
      ''
    ).trim();
    const projectId = rawPid && !RESERVED_PROJECTS.has(rawPid) ? rawPid : '';

    const uris = [];
    const pushUri = (raw) => {
      const u = String(raw || '').trim();
      if (u && !uris.includes(u)) uris.push(u);
    };
    if (Array.isArray(summary?.trajectoryMetadata?.workspaceUris)) {
      for (const u of summary.trajectoryMetadata.workspaceUris) pushUri(u);
    }
    const wsLists = [
      ...(Array.isArray(summary?.trajectoryMetadata?.workspaces) ? summary.trajectoryMetadata.workspaces : []),
      ...(Array.isArray(summary?.workspaces) ? summary.workspaces : [])
    ];
    for (const ws of wsLists) {
      pushUri(ws?.workspaceFolderAbsoluteUri || ws?.uri || (typeof ws === 'string' ? ws : ''));
    }

    return { projectId, workspaceUris: uris, summary };
  }

  function buildUpdatedSummary(summary, projectId, workspaceUris) {
    const cleanUris = (Array.isArray(workspaceUris) ? workspaceUris : [])
      .map((u) => String(u || '').trim())
      .filter(Boolean);
    const nextWorkspaces = cleanUris.map((uri) => ({
      $typeName: 'exa.cortex_pb.CortexWorkspaceMetadata',
      workspaceFolderAbsoluteUri: uri,
      gitRootAbsoluteUri: uri
    }));
    const prevTm = summary.trajectoryMetadata && typeof summary.trajectoryMetadata === 'object' ? summary.trajectoryMetadata : {};
    const nextTm = Object.assign({}, prevTm, {
      $typeName: prevTm.$typeName || 'exa.jetski_cortex_pb.TrajectoryMetadata',
      projectId,
      workspaceUris: cleanUris,
      workspaces: nextWorkspaces
    });
    const nextSummary = Object.assign({}, summary, {
      workspaces: nextWorkspaces,
      trajectoryMetadata: nextTm
    });
    if (Object.prototype.hasOwnProperty.call(summary, 'projectId')) {
      nextSummary.projectId = projectId;
    }
    return nextSummary;
  }

  async function ensureSameProject(newCascadeId, sourceProjectId, returnedProjectId, { store, actions }) {
    if (!sourceProjectId || RESERVED_PROJECTS.has(sourceProjectId)) {
      return { projectId: returnedProjectId || '', moved: false };
    }
    if (returnedProjectId === sourceProjectId) {
      return { projectId: sourceProjectId, moved: false };
    }

    /* Native fork did not preserve sourceProjectId: persist via Anti-Claude moveConversationToProject with bounded retries for SQLite flush */
    let diskRes = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      diskRes = await callDaemon('moveConversationToProject', {
        conversationId: newCascadeId,
        projectId: sourceProjectId
      });
      if (diskRes?.ok) break;
      if (diskRes?.error !== 'conversation_not_found' && diskRes?.error !== 'summaries_db_missing') break;
      await sleep(200);
    }

    if (!diskRes?.ok) {
      return { projectId: returnedProjectId || sourceProjectId, moved: false, error: diskRes?.error || 'move_failed' };
    }

    stats.fallbackMovedCount += 1;
    const workspaceUris = Array.isArray(diskRes.workspaceUris) ? diskRes.workspaceUris : [];
    const liveSummary = store?.getState?.()?.trajectorySummaries?.summaries?.[newCascadeId];
    if (liveSummary) {
      const nextSummary = buildUpdatedSummary(liveSummary, sourceProjectId, workspaceUris);
      if (actions && typeof actions.writeSummary === 'function') {
        try {
          await actions.writeSummary({ cascadeId: newCascadeId, summary: nextSummary });
        } catch {}
      }
      if (store && typeof store.dispatch === 'function') {
        try {
          store.dispatch({
            type: 'trajectorySummaries/applyStreamBatch',
            payload: { updates: [[newCascadeId, nextSummary]], deletes: [] }
          });
        } catch {}
      }
    }

    return { projectId: sourceProjectId, moved: true };
  }

  function navigateToConversation(newCascadeId, projectId, { router }) {
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({
          to: '/c/$cascadeId',
          params: { cascadeId: newCascadeId },
          search: (prev) => {
            const next = Object.assign({}, prev && typeof prev === 'object' ? prev : {});
            delete next.q;
            delete next.focused;
            delete next.skipBattleRedirect;
            if (projectId && !RESERVED_PROJECTS.has(projectId)) {
              next.project = projectId;
            } else {
              delete next.project;
            }
            return next;
          }
        });
        return 'router';
      } catch {}
    }

    const row = document.querySelector(`[data-testid="conversation-row-sidebar"][data-cascade-id="${newCascadeId}"]`);
    if (row) {
      const link = row.querySelector('a') || row;
      if (typeof link.click === 'function') {
        link.click();
        return 'sidebar_click';
      }
    }

    const q = projectId && !RESERVED_PROJECTS.has(projectId) ? `?project=${encodeURIComponent(projectId)}` : '';
    const nextUrl = `/c/${encodeURIComponent(newCascadeId)}${q}`;
    try {
      if (window.location && typeof window.location.assign === 'function') {
        window.location.assign(nextUrl);
        return 'location';
      }
    } catch {}
    return 'none';
  }

  function formatBranchError(rawMsg) {
    const raw = String(rawMsg || '').trim();
    const cleaned = raw
      .replace(/^\[[a-z0-9_]+\]\s*/i, '')
      .replace(/^(?:internal|failed_precondition|invalid_argument|unimplemented)\s*:\s*/i, '')
      .replace(/^failed to create forked conversation\s*:\s*/i, '')
      .trim();

    if (/invoked subagents/i.test(cleaned)) {
      return {
        code: 'has_subagents',
        durationMs: 5200,
        message: L(
          '该对话曾调用过子代理（Subagent），Antigravity 后端暂不支持分支此类对话',
          'Antigravity does not support branching conversations that have invoked subagents'
        )
      };
    }
    if (/non-terminal status/i.test(cleaned)) {
      return {
        code: 'running_task',
        durationMs: 5200,
        message: L(
          '对话中仍有运行中的后台任务，无法从此节点分支（请先停止任务或从更早的回复分支）',
          'Cannot branch here while a background task is running (stop it or branch from an earlier reply)'
        )
      };
    }
    if (/subagent conversation/i.test(cleaned)) {
      return {
        code: 'subagent_conversation',
        durationMs: 4200,
        message: L(
          '子代理对话不支持直接分支，请从主对话发起分支',
          'Cannot branch a subagent conversation; branch from the parent chat instead'
        )
      };
    }
    if (/battle mode/i.test(cleaned)) {
      return {
        code: 'battle_mode',
        durationMs: 4200,
        message: L(
          '对比模式（Battle Mode）对话不支持分支，请先结束对比后再试',
          'Cannot branch a Battle Mode conversation; end the battle first'
        )
      };
    }
    if (/executable agent/i.test(cleaned)) {
      return {
        code: 'executable_agent',
        durationMs: 4200,
        message: L(
          '该对话由可执行代理驱动，Antigravity 后端暂不支持分支',
          'Antigravity does not support branching conversations driven by an executable agent'
        )
      };
    }
    if (/end of a turn|user message|turn boundary/i.test(cleaned)) {
      return {
        code: 'not_turn_boundary',
        durationMs: 4200,
        message: L(
          '只能从已完成回复的末尾创建分支，请等待当前轮次结束',
          'Can only branch from the end of a completed reply'
        )
      };
    }
    if (/shared workspace/i.test(cleaned)) {
      return {
        code: 'shared_workspace',
        durationMs: 4200,
        message: L(
          '当前共享工作区不支持直接分支对话',
          'Cannot branch into this shared workspace'
        )
      };
    }
    if (/out of bounds/i.test(cleaned)) {
      return {
        code: 'step_out_of_bounds',
        durationMs: 4200,
        message: L(
          '该回复节点已失效，请刷新对话后重试',
          'This reply checkpoint is out of date; refresh and try again'
        )
      };
    }
    if (/resolve a workspace/i.test(cleaned)) {
      return {
        code: 'workspace_unresolved',
        durationMs: 4200,
        message: L(
          '无法解析当前对话的工作区路径，分支失败',
          'Could not resolve the workspace for this chat'
        )
      };
    }
    if (/forking is not supported in this environment/i.test(cleaned)) {
      return {
        code: 'unsupported_env',
        durationMs: 4200,
        message: L(
          '当前运行环境暂不支持对话分支',
          'Branching is not supported in this environment'
        )
      };
    }
    if (cleaned && cleaned !== 'fork_failed' && cleaned !== 'empty_new_cascade_id') {
      const brief = cleaned.length > 140 ? `${cleaned.slice(0, 139)}…` : cleaned;
      return {
        code: 'fork_failed',
        durationMs: 4800,
        message: L(`分支对话失败：${brief}`, `Failed to branch chat: ${brief}`)
      };
    }
    return {
      code: 'fork_failed',
      durationMs: 3200,
      message: L('分支对话失败，请稍后重试', 'Failed to branch chat')
    };
  }

  function showToast(text, kind = 'ok', durationMs = 2400) {
    try {
      let el = document.getElementById('ag-branch-chat-toast');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = 'ag-branch-chat-toast';
        el.setAttribute('data-ag-i18n-ignore', '1');
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      if (!el) return;
      el.textContent = text;
      el.setAttribute('data-kind', kind);
      el.setAttribute('data-visible', 'true');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = durationMs > 0
        ? setTimeout(() => {
            toastTimer = 0;
            el.setAttribute('data-visible', 'false');
          }, durationMs)
        : 0;
    } catch {}
  }

  function setTriggerBusy(btn, busy) {
    if (!btn || !btn.isConnected) return;
    btn.disabled = Boolean(busy);
    btn.setAttribute('data-busy', busy ? 'true' : 'false');
    btn.innerHTML = busy ? SPINNER_ICON_SVG : MORE_ICON_SVG;
  }

  function closePopover() {
    if (activeTriggerBtn) {
      try {
        activeTriggerBtn.setAttribute('aria-expanded', 'false');
        activeTriggerBtn.removeAttribute('data-open');
      } catch {}
    }
    if (activePopover) {
      try {
        activePopover.remove();
      } catch {}
      activePopover = null;
    }
    activeTriggerBtn = null;
    activeToolbarEl = null;
  }

  function positionPopover(pop, triggerEl) {
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const popW = Math.max(156, pop.offsetWidth || 172);
    const popH = Math.max(44, pop.offsetHeight || 52);

    const fitsBelow = rect.bottom + 8 + popH <= vh - 12;
    const top = fitsBelow ? rect.bottom + 8 : Math.max(8, rect.top - popH - 8);
    const idealLeft = rect.left + rect.width / 2 - popW / 2;
    const left = Math.max(12, Math.min(idealLeft, vw - popW - 12));

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.setAttribute('data-side', fitsBelow ? 'bottom' : 'top');
  }

  function openPopover(triggerBtn, toolbarEl) {
    if (disposed || !enabled || forking || !document.body) return;
    if (activePopover && activeTriggerBtn === triggerBtn) {
      closePopover();
      return;
    }
    closePopover();

    const pop = document.createElement('div');
    pop.id = 'ag-branch-popover';
    pop.setAttribute('role', 'menu');
    pop.setAttribute('data-ag-i18n-ignore', '1');
    pop.innerHTML = `<button type="button" class="ag-branch-menu-item" role="menuitem" data-ag-branch-action="fork">${BRANCH_ICON_SVG}<span class="ag-branch-menu-label">${escapeHtml(
      L('分支到新聊天', 'Branch in new chat')
    )}</span></button>`;

    pop.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
    });
    pop.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-ag-branch-action="fork"]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const targetToolbar = activeToolbarEl;
      const targetTrigger = activeTriggerBtn;
      closePopover();
      if (targetToolbar) {
        branchFromToolbar(targetToolbar, targetTrigger);
      }
    });

    document.body.appendChild(pop);
    activePopover = pop;
    activeTriggerBtn = triggerBtn;
    activeToolbarEl = toolbarEl;
    triggerBtn.setAttribute('aria-expanded', 'true');
    triggerBtn.setAttribute('data-open', 'true');
    positionPopover(pop, triggerBtn);
  }

  async function branchAtStep({ sourceCascadeId, forkAtStepIndex, anchorEl = null, triggerBtn = null }) {
    const cid = String(sourceCascadeId || '').trim();
    const stepIdx = Number(forkAtStepIndex);
    if (!UUID_RE.test(cid) || !Number.isSafeInteger(stepIdx) || stepIdx < 0) {
      stats.lastError = 'invalid_branch_point';
      showToast(L('当前回复无法确定分支节点', 'Cannot resolve branch point for this reply'), 'error');
      return { ok: false, error: 'invalid_branch_point' };
    }
    if (forking) return { ok: false, error: 'already_forking' };

    const bindings = findBindings(anchorEl);
    const { service, store, actions, router } = bindings;
    if (!service || typeof service.forkConversation !== 'function') {
      stats.lastError = 'service_unavailable';
      showToast(L('未连接到 Antigravity 分支服务', 'Branch service unavailable'), 'error');
      return { ok: false, error: 'service_unavailable' };
    }

    const { projectId: sourceProjectId, workspaceUris } = readSourceProjectAndWorkspaces(cid, store);

    forking = true;
    setTriggerBusy(triggerBtn, true);
    showToast(L('正在创建分支对话…', 'Branching into new chat…'), 'info', 0);

    try {
      const req = {
        sourceCascadeId: cid,
        forkAtStepIndex: stepIdx,
        targetForkWorkspace: FORK_TARGET_CURRENT_WORKSPACE
      };
      if (workspaceUris.length > 0) req.sourceWorkspaceUris = workspaceUris;

      const res = await service.forkConversation(req);
      const newCascadeId = String(res?.newCascadeId || '').trim();
      if (!UUID_RE.test(newCascadeId)) {
        throw new Error('empty_new_cascade_id');
      }

      const returnedPid = String(res?.newProjectId || '').trim();
      markBranchedId(newCascadeId, cid);
      expandAncestorsOf(cid);
      const projSync = await ensureSameProject(newCascadeId, sourceProjectId, returnedPid, { store, actions });
      const targetProjectId = projSync.projectId || (returnedPid && !RESERVED_PROJECTS.has(returnedPid) ? returnedPid : '');

      try {
        if (typeof CustomEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('ag-title-sync-updated', { detail: { ids: [newCascadeId], projectId: targetProjectId } })
          );
        }
      } catch {}

      const navMode = navigateToConversation(newCascadeId, targetProjectId, { router });
      stats.branchedCount += 1;
      stats.lastBranchedId = newCascadeId;
      stats.lastError = '';
      notifyVirtualizerChange();
      decorateBranchedTitles();
      showToast(L('已分支到新聊天', 'Branched into new chat'), 'ok');

      return {
        ok: true,
        sourceCascadeId: cid,
        newCascadeId,
        forkedAtStepIndex: Number.isSafeInteger(res?.forkedAtStepIndex) ? res.forkedAtStepIndex : stepIdx,
        projectId: targetProjectId,
        fallbackMoved: Boolean(projSync.moved),
        navMode,
        warnings: Array.isArray(res?.warnings) ? res.warnings : []
      };
    } catch (err) {
      const msg = String(err?.rawMessage || err?.message || err || 'fork_failed').trim() || 'fork_failed';
      const friendly = formatBranchError(msg);
      stats.lastError = msg;
      showToast(friendly.message, 'error', friendly.durationMs);
      return { ok: false, error: msg, errorCode: friendly.code, userMessage: friendly.message };
    } finally {
      forking = false;
      setTriggerBusy(triggerBtn, false);
    }
  }

  async function branchFromToolbar(toolbarEl, triggerBtn = null) {
    const info = readToolbarPropsFromFiber(toolbarEl);
    const stepIdx = extractStepIndex(info.steps);
    return branchAtStep({
      sourceCascadeId: info.cascadeId,
      forkAtStepIndex: stepIdx,
      anchorEl: toolbarEl,
      triggerBtn
    });
  }

  function removeToolbarButton(toolbarEl) {
    const existing = toolbarEl?.querySelector?.('[data-ag-branch-more]');
    if (!existing) return;
    if (activeTriggerBtn === existing) closePopover();
    existing.remove();
  }

  function enhanceToolbar(toolbarEl) {
    if (!toolbarEl) return;
    if (disposed || !enabled) {
      removeToolbarButton(toolbarEl);
      return;
    }
    /* Auto-yield when Antigravity natively renders its own Fork Conversation button on this toolbar */
    if (hasNativeForkButton(toolbarEl) || isSideQuestionToolbar(toolbarEl)) {
      removeToolbarButton(toolbarEl);
      return;
    }

    const info = readToolbarPropsFromFiber(toolbarEl);
    const { store } = findBindings(toolbarEl);
    if (!info.cascadeId || isBattleConversation(info.cascadeId, store)) {
      removeToolbarButton(toolbarEl);
      return;
    }

    const stepIdx = extractStepIndex(info.steps);
    const streaming = isTurnActivelyStreaming(toolbarEl, info.isLatest);
    if (stepIdx < 0 || streaming) {
      removeToolbarButton(toolbarEl);
      return;
    }

    const iconTarget = findIconGroup(toolbarEl);
    if (!iconTarget || !iconTarget.group) return;

    let btn = toolbarEl.querySelector('[data-ag-branch-more]');
    const label = L('更多操作', 'More options');
    if (btn) {
      if (btn.parentElement !== iconTarget.group) {
        iconTarget.group.appendChild(btn);
      }
      if (btn.getAttribute('aria-label') !== label) {
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }
      return;
    }

    btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-ag-branch-more', '1');
    btn.setAttribute('data-ag-i18n-ignore', '1');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);

    const baseCls = String(iconTarget.refBtn?.className || '')
      .replace(/\bbg-secondary\b/g, '')
      .replace(/\bshadow-xs\b/g, '')
      .replace(/\bopacity-40\b/g, '')
      .trim();
    btn.className = `${baseCls} ag-branch-more-btn`.trim();
    btn.innerHTML = MORE_ICON_SVG;

    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPopover(btn, toolbarEl);
    });

    iconTarget.group.appendChild(btn);
  }

  function isSectionHeaderKey(key) {
    const s = String(key || '');
    return s.startsWith('section-') || s === 'main-section-header';
  }

  function isPinnedInStore(cid, store) {
    if (!cid || !store) return false;
    try {
      const state = store.getState?.();
      const pinnedIdx = state?.trajectorySummaries?.indexes?.pinned;
      if (pinnedIdx) {
        if (Array.isArray(pinnedIdx) && pinnedIdx.includes(cid)) return true;
        if (pinnedIdx instanceof Set && pinnedIdx.has(cid)) return true;
        if (typeof pinnedIdx === 'object' && Object.prototype.hasOwnProperty.call(pinnedIdx, cid) && pinnedIdx[cid]) {
          return true;
        }
      }
      const sum = state?.trajectorySummaries?.summaries?.[cid];
      if (sum?.annotations?.pinned === true) return true;
    } catch {}
    return false;
  }

  function findSidebarVirtualizer() {
    const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!sb) return null;
    const seen = new Set();
    const starts = [sb.firstElementChild, sb];
    for (const node of starts) {
      if (!node) continue;
      let fiber = activeFiber(node);
      for (let d = 0; fiber && d < 18; d++, fiber = fiber.return) {
        if (seen.has(fiber)) break;
        seen.add(fiber);
        for (const branch of [fiber, fiber.alternate]) {
          let hook = branch?.memoizedState;
          for (let hi = 0; hook && hi < 64; hi++, hook = hook.next) {
            for (const cand of [hook.memoizedState, hook.memoizedState?.current]) {
              if (
                cand &&
                typeof cand === 'object' &&
                cand.scrollElement === sb &&
                typeof cand.getVirtualItems === 'function' &&
                typeof cand.getTotalSize === 'function' &&
                typeof cand.getMeasurements === 'function'
              ) {
                return cand;
              }
            }
          }
        }
      }
    }
    return null;
  }

  function computeVirtualPlan(virt) {
    const count = Number(virt?.options?.count || 0);
    const getItemKey = virt?.options?.getItemKey;
    if (!enabled || disposed || count <= 0 || typeof getItemKey !== 'function' || parentByChild.size === 0) {
      lastSidebarMetaByCid = new Map();
      return null;
    }

    const { store } = findBindings(virt.scrollElement || null);
    const keys = new Array(count);
    const isUuid = new Array(count);
    const pinnedArr = new Array(count);
    let sigParts = `${treeVersion}|${count}`;

    for (let i = 0; i < count; i++) {
      let k = '';
      try {
        k = String(getItemKey(i) ?? '');
      } catch {}
      keys[i] = k;
      const u = UUID_RE.test(k);
      isUuid[i] = u;
      const p = u ? isPinnedInStore(k, store) : false;
      pinnedArr[i] = p;
      sigParts += `|${k}${p ? ':P' : ''}`;
    }

    const patchState = virt[VIRT_PATCH_TOKEN];
    if (patchState && patchState.cachedPlan && patchState.cachedPlan.sig === sigParts) {
      lastSidebarMetaByCid = patchState.cachedPlan.metaByCid;
      return patchState.cachedPlan;
    }

    const displayOrder = [];
    const origToSlot = new Map();
    const metaByCid = new Map();
    let reordered = false;

    let i = 0;
    while (i < count) {
      if (!isUuid[i]) {
        origToSlot.set(i, displayOrder.length);
        displayOrder.push(i);
        i += 1;
        continue;
      }
      const pFlag = pinnedArr[i];
      let j = i + 1;
      while (j < count && isUuid[j] && pinnedArr[j] === pFlag) j += 1;

      const runSlice = keys.slice(i, j);
      const grouped = groupConversationRun(runSlice, { respectCollapsed: true });
      if (grouped.reordered) reordered = true;

      for (const e of grouped.entries) {
        const origIdx = i + e.origPos;
        origToSlot.set(origIdx, displayOrder.length);
        displayOrder.push(origIdx);
        if (e.cid && (e.isGroupedChild || e.totalDescendantCount > 0)) {
          metaByCid.set(e.cid, e);
        }
      }
      i = j;
    }

    const plan = {
      sig: sigParts,
      count,
      keys,
      displayOrder,
      origToSlot,
      metaByCid,
      reordered
    };
    if (patchState) {
      patchState.cachedPlan = plan;
      patchState.cachedLayout = null;
    }
    lastSidebarMetaByCid = metaByCid;
    return plan;
  }

  function computeVirtualLayout(virt, plan, origGetMeasurements) {
    const raw = origGetMeasurements.call(virt);
    const scrollMargin = Number(virt?.options?.scrollMargin || 0);
    const patchState = virt[VIRT_PATCH_TOKEN];
    if (
      patchState &&
      patchState.cachedLayout &&
      patchState.cachedLayout.plan === plan &&
      patchState.cachedLayout.raw === raw &&
      patchState.cachedLayout.scrollMargin === scrollMargin
    ) {
      return patchState.cachedLayout;
    }

    const baseStart = raw && raw.length > 0 && Number.isFinite(raw[0].start) ? raw[0].start : scrollMargin;
    const slots = new Array(plan.displayOrder.length);
    let cursor = baseStart;

    for (let s = 0; s < plan.displayOrder.length; s++) {
      const origIdx = plan.displayOrder[s];
      const m = raw?.[origIdx];
      const size = m && Number.isFinite(m.size) ? m.size : 33;
      const start = cursor;
      const end = start + size;
      slots[s] = {
        index: origIdx,
        key: m ? m.key : plan.keys[origIdx] ?? origIdx,
        start,
        size,
        end,
        lane: m ? m.lane ?? 0 : 0
      };
      cursor = end;
    }

    const totalSize = slots.length > 0 ? Math.max(0, slots[slots.length - 1].end - scrollMargin) : 0;
    const layout = { plan, raw, scrollMargin, slots, totalSize };
    if (patchState) patchState.cachedLayout = layout;
    return layout;
  }

  function computeOffsetForSlot(virt, layout, slotIdx, align = 'auto') {
    const slot = layout.slots[slotIdx];
    if (!slot) return undefined;
    const scrollOffset = Number(virt.getScrollOffset?.() ?? virt.scrollOffset ?? 0);
    const viewport = Number(virt.scrollRect?.height ?? virt.scrollElement?.clientHeight ?? 800);
    let resolved = align || 'auto';
    if (resolved === 'auto') {
      if (slot.end >= scrollOffset + viewport) resolved = 'end';
      else if (slot.start <= scrollOffset) resolved = 'start';
      else return [scrollOffset, 'auto'];
    }
    let offset = slot.start;
    if (resolved === 'center') offset = slot.start - viewport / 2 + slot.size / 2;
    else if (resolved === 'end') offset = slot.end - viewport;
    const maxOff = Math.max(0, layout.totalSize - viewport);
    return [Math.max(0, Math.min(maxOff, offset)), resolved];
  }

  function unpatchVirtualizer(virt = patchedVirt) {
    if (!virt || !virt[VIRT_PATCH_TOKEN]) {
      if (virt === patchedVirt) patchedVirt = null;
      return;
    }
    const orig = virt[VIRT_PATCH_TOKEN].orig;
    try {
      virt.getVirtualItems = orig.getVirtualItems;
      virt.getTotalSize = orig.getTotalSize;
      if (orig.getOffsetForIndex) virt.getOffsetForIndex = orig.getOffsetForIndex;
      if (orig.scrollToIndex) virt.scrollToIndex = orig.scrollToIndex;
    } catch {}
    try {
      delete virt[VIRT_PATCH_TOKEN];
    } catch {}
    if (virt === patchedVirt) patchedVirt = null;
    try {
      virt.options?.onChange?.(virt, false);
    } catch {}
  }

  function notifyVirtualizerChange() {
    const virt = ensureVirtualizerPatched();
    if (!virt) return;
    const patchState = virt[VIRT_PATCH_TOKEN];
    if (patchState) {
      patchState.cachedPlan = null;
      patchState.cachedLayout = null;
    }
    try {
      virt.options?.onChange?.(virt, false);
    } catch {}
  }

  function ensureVirtualizerPatched() {
    if (disposed || !enabled) return null;
    const virt = findSidebarVirtualizer();
    if (!virt) return null;
    if (patchedVirt && patchedVirt !== virt) {
      unpatchVirtualizer(patchedVirt);
    }
    if (virt[VIRT_PATCH_TOKEN]) {
      patchedVirt = virt;
      computeVirtualPlan(virt);
      return virt;
    }

    const orig = {
      getVirtualItems: virt.getVirtualItems,
      getTotalSize: virt.getTotalSize,
      getMeasurements: virt.getMeasurements,
      getOffsetForIndex: typeof virt.getOffsetForIndex === 'function' ? virt.getOffsetForIndex : null,
      scrollToIndex: typeof virt.scrollToIndex === 'function' ? virt.scrollToIndex : null
    };

    virt[VIRT_PATCH_TOKEN] = {
      orig,
      cachedPlan: null,
      cachedLayout: null
    };

    virt.getVirtualItems = function agBranchGetVirtualItems() {
      const plan = computeVirtualPlan(virt);
      if (!plan || !plan.reordered) return orig.getVirtualItems.call(virt);
      const layout = computeVirtualLayout(virt, plan, orig.getMeasurements);
      const slots = layout.slots;
      if (!slots.length) return [];

      const scrollOffset = Number(virt.getScrollOffset?.() ?? virt.scrollOffset ?? 0);
      const viewport = Number(virt.scrollRect?.height ?? virt.scrollElement?.clientHeight ?? 800);
      const overscan = Math.max(4, Number(virt.options?.overscan ?? 10));

      let startSlot = 0;
      while (startSlot < slots.length - 1 && slots[startSlot].end < scrollOffset) startSlot += 1;
      let endSlot = startSlot;
      const viewBottom = scrollOffset + viewport;
      while (endSlot < slots.length - 1 && slots[endSlot].start <= viewBottom) endSlot += 1;

      const from = Math.max(0, startSlot - overscan);
      const to = Math.min(slots.length - 1, endSlot + overscan);

      /* Preserve active sticky section-header above viewport just like z$c rangeExtractor */
      let stickySlot = -1;
      for (let s = startSlot; s >= 0; s--) {
        if (isSectionHeaderKey(slots[s].key)) {
          stickySlot = s;
          break;
        }
      }

      const out = [];
      if (stickySlot >= 0 && stickySlot < from) out.push(slots[stickySlot]);
      for (let s = from; s <= to; s++) out.push(slots[s]);
      return out;
    };

    virt.getTotalSize = function agBranchGetTotalSize() {
      const plan = computeVirtualPlan(virt);
      if (!plan || !plan.reordered) return orig.getTotalSize.call(virt);
      const layout = computeVirtualLayout(virt, plan, orig.getMeasurements);
      return layout.totalSize;
    };

    if (orig.getOffsetForIndex) {
      virt.getOffsetForIndex = function agBranchGetOffsetForIndex(index, align = 'auto') {
        const plan = computeVirtualPlan(virt);
        if (!plan || !plan.reordered) return orig.getOffsetForIndex.call(virt, index, align);
        const slotIdx = plan.origToSlot.get(index);
        if (slotIdx === undefined) return orig.getOffsetForIndex.call(virt, index, align);
        const layout = computeVirtualLayout(virt, plan, orig.getMeasurements);
        return computeOffsetForSlot(virt, layout, slotIdx, align);
      };
    }

    if (orig.scrollToIndex) {
      virt.scrollToIndex = function agBranchScrollToIndex(index, opts) {
        let plan = computeVirtualPlan(virt);
        if (!plan || !plan.reordered) return orig.scrollToIndex.call(virt, index, opts);
        let slotIdx = plan.origToSlot.get(index);
        if (slotIdx === undefined) {
          const targetKey = plan.keys[index];
          if (targetKey && expandAncestorsOf(targetKey)) {
            plan = computeVirtualPlan(virt);
            slotIdx = plan?.origToSlot?.get(index);
            notifyVirtualizerChange();
          }
        }
        if (slotIdx === undefined || typeof virt.scrollToOffset !== 'function') {
          return orig.scrollToIndex.call(virt, index, opts);
        }
        const layout = computeVirtualLayout(virt, plan, orig.getMeasurements);
        const res = computeOffsetForSlot(virt, layout, slotIdx, opts?.align || 'auto');
        if (res) {
          virt.scrollToOffset(res[0], Object.assign({}, opts, { adjustments: 0 }));
        }
      };
    }

    patchedVirt = virt;
    const initialPlan = computeVirtualPlan(virt);
    if (initialPlan && initialPlan.reordered) {
      try {
        virt.options?.onChange?.(virt, false);
      } catch {}
    }
    return virt;
  }

  function setParentCollapsed(parentCid, nextCollapsed) {
    const norm = String(parentCid || '').trim().toLowerCase();
    if (!UUID_RE.test(norm)) return false;
    const want = Boolean(nextCollapsed);
    const had = collapsedParents.has(norm);
    if (want === had) return false;
    if (want) collapsedParents.add(norm);
    else collapsedParents.delete(norm);
    treeVersion += 1;
    persistCollapsedParents();
    notifyVirtualizerChange();
    emitTreeUpdated();
    scheduleScan();
    return true;
  }

  function toggleParentCollapsed(parentCid) {
    const norm = String(parentCid || '').trim().toLowerCase();
    if (!UUID_RE.test(norm)) return false;
    return setParentCollapsed(norm, !collapsedParents.has(norm));
  }

  function formatToggleLabel(count, collapsed) {
    return collapsed
      ? L(`展开 ${count} 个分支对话`, `Expand ${count} branched chats`)
      : L(`收起 ${count} 个分支对话`, `Collapse ${count} branched chats`);
  }

  function removeTreeRowDecorations(row) {
    if (!row) return;
    const attrs = [
      'data-ag-branch-flat',
      'data-ag-branch-child',
      'data-ag-branch-depth',
      'data-ag-branch-last',
      'data-ag-branch-parent',
      'data-ag-branch-collapsed'
    ];
    for (const a of attrs) {
      if (row.hasAttribute?.(a)) row.removeAttribute(a);
    }
    row.querySelectorAll?.('[data-ag-branch-toggle], [data-ag-branch-count]').forEach((n) => n.remove());
  }

  function clearAllBranchedTitleMarks() {
    document.querySelectorAll('[data-ag-branch-title]').forEach((el) => el.removeAttribute('data-ag-branch-title'));
    document.querySelectorAll('[data-ag-branch-gutter]').forEach((el) => {
      el.removeAttribute('data-ag-branch-gutter');
      el.removeAttribute('data-ag-branch-gutter-compact');
      try {
        el.style?.removeProperty?.('--ag-branch-ico-left');
      } catch {}
    });
    document.querySelectorAll('[data-ag-branched-row]').forEach((el) => el.removeAttribute('data-ag-branched-row'));
    document
      .querySelectorAll('[data-ag-branch-parent], [data-ag-branch-child], [data-ag-branch-flat]')
      .forEach((el) => removeTreeRowDecorations(el));
    document.querySelectorAll('[data-ag-branch-toggle], [data-ag-branch-count]').forEach((n) => n.remove());
    lastSidebarMetaByCid = new Map();
  }

  function syncSidebarTreeRow(row, cid, meta) {
    if (!row) return;
    const norm = String(cid || '').trim().toLowerCase();
    const isFlat = !String(row.className || '').includes('pl-[30px]');

    if (!meta) {
      removeTreeRowDecorations(row);
      return;
    }

    if (isFlat) {
      if (row.getAttribute('data-ag-branch-flat') !== '1') row.setAttribute('data-ag-branch-flat', '1');
    } else if (row.hasAttribute('data-ag-branch-flat')) {
      row.removeAttribute('data-ag-branch-flat');
    }

    if (meta.isGroupedChild && meta.depth > 0) {
      if (row.getAttribute('data-ag-branch-child') !== '1') row.setAttribute('data-ag-branch-child', '1');
      const dStr = String(meta.depth);
      if (row.getAttribute('data-ag-branch-depth') !== dStr) row.setAttribute('data-ag-branch-depth', dStr);
      if (meta.isLastChild) {
        if (row.getAttribute('data-ag-branch-last') !== '1') row.setAttribute('data-ag-branch-last', '1');
      } else if (row.hasAttribute('data-ag-branch-last')) {
        row.removeAttribute('data-ag-branch-last');
      }
    } else {
      if (row.hasAttribute('data-ag-branch-child')) row.removeAttribute('data-ag-branch-child');
      if (row.hasAttribute('data-ag-branch-depth')) row.removeAttribute('data-ag-branch-depth');
      if (row.hasAttribute('data-ag-branch-last')) row.removeAttribute('data-ag-branch-last');
    }

    if (meta.totalDescendantCount > 0) {
      if (row.getAttribute('data-ag-branch-parent') !== '1') row.setAttribute('data-ag-branch-parent', '1');
      const colStr = meta.collapsed ? '1' : '0';
      if (row.getAttribute('data-ag-branch-collapsed') !== colStr) row.setAttribute('data-ag-branch-collapsed', colStr);

      const label = formatToggleLabel(meta.totalDescendantCount, meta.collapsed);
      const toggleLeftPx = (isFlat ? 5 : 9) + meta.depth * 16;
      const toggleLeftVal = `${toggleLeftPx}px`;

      let btn = row.querySelector('[data-ag-branch-toggle]');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-branch-tree-toggle';
        btn.setAttribute('data-ag-i18n-ignore', '1');
        btn.innerHTML = CHEVRON_DOWN_SVG;
        const stopEv = (ev) => {
          ev.stopPropagation();
        };
        btn.addEventListener('pointerdown', stopEv);
        btn.addEventListener('mousedown', stopEv);
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const targetId = btn.getAttribute('data-ag-branch-toggle') || '';
          if (targetId) toggleParentCollapsed(targetId);
        });
        row.appendChild(btn);
      }
      if (btn.getAttribute('data-ag-branch-toggle') !== norm) btn.setAttribute('data-ag-branch-toggle', norm);
      const expStr = meta.collapsed ? 'false' : 'true';
      if (btn.getAttribute('aria-expanded') !== expStr) btn.setAttribute('aria-expanded', expStr);
      if (btn.getAttribute('aria-label') !== label) {
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
      }
      if (btn.style && typeof btn.style.setProperty === 'function') {
        if (btn.style.getPropertyValue?.('--ag-branch-toggle-left') !== toggleLeftVal) {
          btn.style.setProperty('--ag-branch-toggle-left', toggleLeftVal);
        }
      } else if (btn.style) {
        btn.style['--ag-branch-toggle-left'] = toggleLeftVal;
      }

      let chip = row.querySelector('[data-ag-branch-count]');
      if (meta.collapsed) {
        if (!chip) {
          chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ag-branch-tree-count';
          chip.setAttribute('data-ag-i18n-ignore', '1');
          const stopEv = (ev) => {
            ev.stopPropagation();
          };
          chip.addEventListener('pointerdown', stopEv);
          chip.addEventListener('mousedown', stopEv);
          chip.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const targetId = chip.getAttribute('data-ag-branch-count') || '';
            if (targetId) setParentCollapsed(targetId, false);
          });
          /* Place before the right-side timestamp container when possible */
          const kids = row.children;
          const rightSide = kids && kids.length >= 3 ? kids[2] : null;
          if (rightSide && typeof row.insertBefore === 'function') {
            row.insertBefore(chip, rightSide);
          } else {
            row.appendChild(chip);
          }
        }
        const countTxt = String(meta.totalDescendantCount);
        if (chip.getAttribute('data-ag-branch-count') !== norm) chip.setAttribute('data-ag-branch-count', norm);
        if (chip.textContent !== countTxt) chip.textContent = countTxt;
        if (chip.getAttribute('title') !== label) {
          chip.setAttribute('title', label);
          chip.setAttribute('aria-label', label);
        }
      } else if (chip) {
        chip.remove();
      }
    } else {
      if (row.hasAttribute('data-ag-branch-parent')) row.removeAttribute('data-ag-branch-parent');
      if (row.hasAttribute('data-ag-branch-collapsed')) row.removeAttribute('data-ag-branch-collapsed');
      row.querySelectorAll('[data-ag-branch-toggle], [data-ag-branch-count]').forEach((n) => n.remove());
    }
  }

  function computeGutterIconLeft(containerEl, titleEl) {
    if (!containerEl || !titleEl) return null;
    if (typeof containerEl.getBoundingClientRect !== 'function' || typeof titleEl.getBoundingClientRect !== 'function') {
      return null;
    }
    const cr = containerEl.getBoundingClientRect();
    const tr = titleEl.getBoundingClientRect();
    if (!cr || !tr || (cr.width === 0 && tr.width === 0)) return null;
    const textLeft = tr.left - cr.left;
    if (textLeft >= 18) {
      return { leftPx: Math.round(textLeft - 18), compact: false };
    }
    const clipRoot =
      containerEl.closest?.('[data-testid="conversation-list-sidebar"], .bg-sidebar, #ag-claude-projects-view') ||
      containerEl.parentElement;
    const rr = clipRoot && typeof clipRoot.getBoundingClientRect === 'function' ? clipRoot.getBoundingClientRect() : null;
    const availFromClip = rr ? tr.left - rr.left : textLeft;
    if (availFromClip >= 15) {
      const icoLeft = Math.round(textLeft - 16);
      const minLeft = rr ? Math.round(rr.left - cr.left + 2) : icoLeft;
      return { leftPx: Math.max(minLeft, icoLeft), compact: true };
    }
    return null;
  }

  function applyBranchTitleMark(containerEl, titleEl, shouldMark) {
    if (!containerEl) return;
    if (shouldMark && titleEl) {
      if (containerEl.getAttribute('data-ag-branched-row') !== '1') {
        containerEl.setAttribute('data-ag-branched-row', '1');
      }
      const gutter = computeGutterIconLeft(containerEl, titleEl);
      if (gutter) {
        if (containerEl.getAttribute('data-ag-branch-gutter') !== '1') {
          containerEl.setAttribute('data-ag-branch-gutter', '1');
        }
        if (gutter.compact) containerEl.setAttribute('data-ag-branch-gutter-compact', '1');
        else containerEl.removeAttribute('data-ag-branch-gutter-compact');
        const nextLeft = `${gutter.leftPx}px`;
        if (containerEl.style && typeof containerEl.style.setProperty === 'function') {
          if (containerEl.style.getPropertyValue?.('--ag-branch-ico-left') !== nextLeft) {
            containerEl.style.setProperty('--ag-branch-ico-left', nextLeft);
          }
        } else if (containerEl.style) {
          containerEl.style['--ag-branch-ico-left'] = nextLeft;
        }
        containerEl.querySelectorAll('[data-ag-branch-title]').forEach((n) => n.removeAttribute('data-ag-branch-title'));
      } else {
        if (containerEl.hasAttribute('data-ag-branch-gutter')) {
          containerEl.removeAttribute('data-ag-branch-gutter');
          containerEl.removeAttribute('data-ag-branch-gutter-compact');
          try {
            containerEl.style?.removeProperty?.('--ag-branch-ico-left');
          } catch {}
        }
        if (titleEl.getAttribute('data-ag-branch-title') !== '1') {
          titleEl.setAttribute('data-ag-branch-title', '1');
        }
        containerEl.querySelectorAll('[data-ag-branch-title]').forEach((other) => {
          if (other !== titleEl) other.removeAttribute('data-ag-branch-title');
        });
      }
    } else {
      if (containerEl.hasAttribute('data-ag-branched-row')) containerEl.removeAttribute('data-ag-branched-row');
      if (containerEl.hasAttribute('data-ag-branch-gutter')) {
        containerEl.removeAttribute('data-ag-branch-gutter');
        containerEl.removeAttribute('data-ag-branch-gutter-compact');
        try {
          containerEl.style?.removeProperty?.('--ag-branch-ico-left');
        } catch {}
      }
      containerEl.querySelectorAll('[data-ag-branch-title]').forEach((n) => n.removeAttribute('data-ag-branch-title'));
    }
  }

  function decorateBranchedTitles() {
    if (disposed) return;
    if (!enabled) {
      clearAllBranchedTitleMarks();
      return;
    }

    ensureVirtualizerPatched();

    /* 1. Native sidebar rows (Projects, Outside of Project, Pinned) */
    const nativeRows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (const row of nativeRows) {
      const cid = row.getAttribute('data-cascade-id') || '';
      const norm = cid.trim().toLowerCase();
      const meta = lastSidebarMetaByCid.get(norm) || null;
      /* Apply tree indentation & parent toggle BEFORE measuring gutter icon position */
      syncSidebarTreeRow(row, norm, meta);
      const titleEl = row.querySelector('a[href^="/c/"] span.truncate') || row.querySelector('span.truncate');
      const hint = titleEl?.textContent || '';
      applyBranchTitleMark(row, titleEl, isBranched(cid, hint));
    }

    /* 2. Anti-Claude Recent 20 & Unified Recents rows */
    const recentRows = document.querySelectorAll('#ag-claude-recent-section [data-ag-recent-id]');
    for (const row of recentRows) {
      const cid = row.getAttribute('data-ag-recent-id') || '';
      const titleEl = row.querySelector('.ag-recent-title');
      const hint = row.getAttribute('data-ag-recent-title') || titleEl?.textContent || '';
      applyBranchTitleMark(row, titleEl, isBranched(cid, hint));
    }

    /* 3. Anti-Claude Projects Detail chat list */
    const pdRows = document.querySelectorAll('#ag-claude-projects-view [data-ag-pd-chat]');
    for (const row of pdRows) {
      const cid = row.getAttribute('data-ag-pd-chat') || '';
      const titleEl = row.querySelector('.ag-pd-chat-title');
      const hint = row.getAttribute('data-ag-pd-chat-title') || titleEl?.textContent || '';
      applyBranchTitleMark(row, titleEl, isBranched(cid, hint));
    }

    /* 4. Chat top titlebar breadcrumb for the currently open branched conversation */
    const activeMatch = String(window.location?.pathname || '').match(
      /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    const activeCid = activeMatch ? activeMatch[1] : '';
    const crumbs = Array.from(document.querySelectorAll('[data-testid="breadcrumb-segment"]'));
    const lastCrumb = crumbs.length > 0 ? crumbs[crumbs.length - 1] : null;
    for (const cr of crumbs) {
      const target = cr.querySelector('.truncate') || cr;
      const shouldMark = Boolean(cr === lastCrumb && activeCid && isBranched(activeCid, target?.textContent || ''));
      if (shouldMark) {
        if (target.getAttribute('data-ag-branch-title') !== '1') target.setAttribute('data-ag-branch-title', '1');
      } else {
        if (cr.hasAttribute('data-ag-branch-title')) cr.removeAttribute('data-ag-branch-title');
        cr.querySelectorAll('[data-ag-branch-title]').forEach((n) => n.removeAttribute('data-ag-branch-title'));
      }
    }
  }

  async function syncBranchedIdsFromDaemon(force = false) {
    if (disposed || !enabled || branchedFetchInFlight) return { ok: false, skipped: true };
    const now = Date.now();
    if (!force && now - lastBranchedFetchAt < 5000) return { ok: true, cached: true };
    branchedFetchInFlight = true;
    lastBranchedFetchAt = now;
    try {
      const res = await callDaemon('listBranchedConversations', {});
      if (disposed || !res?.ok || !Array.isArray(res.ids)) return res || { ok: false };
      let changed = false;
      for (const id of res.ids) {
        const norm = String(id || '').trim().toLowerCase();
        if (UUID_RE.test(norm) && !branchedIds.has(norm)) {
          branchedIds.add(norm);
          changed = true;
        }
      }
      if (res.parents && typeof res.parents === 'object' && !Array.isArray(res.parents)) {
        for (const [rawChild, rawParent] of Object.entries(res.parents)) {
          const child = String(rawChild || '').trim().toLowerCase();
          const parent = String(rawParent || '').trim().toLowerCase();
          if (UUID_RE.test(child) && UUID_RE.test(parent) && child !== parent) {
            if (!branchedIds.has(child)) {
              branchedIds.add(child);
              changed = true;
            }
            if (parentByChild.get(child) !== parent) {
              parentByChild.set(child, parent);
              changed = true;
            }
          }
        }
      }
      if (changed) {
        treeVersion += 1;
        persistStoredBranchedIds();
        notifyVirtualizerChange();
        emitTreeUpdated();
      }
      decorateBranchedTitles();
      return { ok: true, count: branchedIds.size, parentLinks: parentByChild.size, changed };
    } catch {
      return { ok: false };
    } finally {
      branchedFetchInFlight = false;
    }
  }

  function scanToolbars() {
    if (disposed) return;
    const toolbars = document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]');
    for (const tb of toolbars) {
      enhanceToolbar(tb);
    }
    decorateBranchedTitles();
    if (activePopover && (!activeTriggerBtn || !activeTriggerBtn.isConnected)) {
      closePopover();
    }
  }

  function refreshLanguage() {
    if (disposed) return;
    const label = L('更多操作', 'More options');
    document.querySelectorAll('[data-ag-branch-more]').forEach((btn) => {
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
    if (activePopover) {
      const span = activePopover.querySelector('.ag-branch-menu-label');
      if (span) span.textContent = L('分支到新聊天', 'Branch in new chat');
    }
    decorateBranchedTitles();
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    treeVersion += 1;
    if (!enabled) {
      closePopover();
      document.querySelectorAll('[data-ag-branch-more]').forEach((n) => n.remove());
      unpatchVirtualizer();
      clearAllBranchedTitleMarks();
      emitTreeUpdated();
      return;
    }
    syncBranchedIdsFromDaemon(true);
    notifyVirtualizerChange();
    emitTreeUpdated();
    scheduleScan();
  }

  function onGlobalPointerDown(ev) {
    if (!activePopover) return;
    if (ev.target?.closest?.('#ag-branch-popover, [data-ag-branch-more]')) return;
    closePopover();
  }

  function onGlobalKeyDown(ev) {
    if (ev.key === 'Escape' && activePopover) {
      ev.preventDefault();
      ev.stopPropagation();
      closePopover();
    }
  }

  function onGlobalScroll(ev) {
    if (!activePopover) return;
    if (ev.target?.closest?.('#ag-branch-popover')) return;
    closePopover();
  }

  function scheduleScan() {
    if (disposed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      scanToolbars();
    });
  }

  function startObserver() {
    if (disposed || obs || typeof MutationObserver !== 'function' || !document.body) return;
    obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const t = m.target;
        if (t && t.nodeType === 1 && t.closest?.('#ag-branch-popover, #ag-branch-chat-toast')) continue;
        scheduleScan();
        return;
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cascade-id', 'data-ag-recent-id', 'data-ag-pd-chat']
    });
    syncBranchedIdsFromDaemon(true);
    scanToolbars();
  }

  const onWindowFocusOrNav = () => {
    if (disposed || !enabled) return;
    syncBranchedIdsFromDaemon(false);
    scheduleScan();
  };

  document.addEventListener('pointerdown', onGlobalPointerDown, true);
  document.addEventListener('keydown', onGlobalKeyDown, true);
  document.addEventListener('scroll', onGlobalScroll, true);
  window.addEventListener('resize', closePopover);
  window.addEventListener('focus', onWindowFocusOrNav);
  window.addEventListener('popstate', onWindowFocusOrNav);

  if (document.body) {
    startObserver();
  } else if (typeof window.addEventListener === 'function') {
    dclHandler = () => {
      dclHandler = null;
      startObserver();
    };
    window.addEventListener('DOMContentLoaded', dclHandler, { once: true });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    closePopover();
    if (dclHandler) {
      try { window.removeEventListener('DOMContentLoaded', dclHandler); } catch {}
      dclHandler = null;
    }
    if (rafId) {
      try { cancelAnimationFrame(rafId); } catch {}
      rafId = 0;
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    if (obs) {
      try { obs.disconnect(); } catch {}
      obs = null;
    }
    document.removeEventListener('pointerdown', onGlobalPointerDown, true);
    document.removeEventListener('keydown', onGlobalKeyDown, true);
    document.removeEventListener('scroll', onGlobalScroll, true);
    window.removeEventListener('resize', closePopover);
    window.removeEventListener('focus', onWindowFocusOrNav);
    window.removeEventListener('popstate', onWindowFocusOrNav);
    document.querySelectorAll('[data-ag-branch-more]').forEach((n) => n.remove());
    unpatchVirtualizer();
    clearAllBranchedTitleMarks();
    document.getElementById('ag-branch-chat-toast')?.remove();
    cachedService = null;
    cachedStore = null;
    cachedActions = null;
    cachedRouter = null;
    if (window.__agBranchChat === api) delete window.__agBranchChat;
  }

  const api = {
    branchFromToolbar,
    branchAtStep,
    scanToolbars,
    decorateBranchedTitles,
    syncBranchedIdsFromDaemon,
    isBranched,
    getParentId,
    getParentMap: () => Object.fromEntries(parentByChild.entries()),
    getBranchedIds: () => Array.from(branchedIds),
    groupConversationRun,
    orderConversationList,
    isParentCollapsed,
    setParentCollapsed,
    toggleParentCollapsed,
    ensureVirtualizerPatched,
    setEnabled,
    refreshLanguage,
    closePopover,
    dispose,
    getStatus: () => ({
      enabled,
      disposed,
      forking,
      branchedTotal: branchedIds.size,
      parentLinks: parentByChild.size,
      collapsedParents: collapsedParents.size,
      virtualizerPatched: Boolean(patchedVirt),
      ...stats
    })
  };

  window.__agBranchChat = api;
  ctx.onCleanup?.(dispose);
})();
