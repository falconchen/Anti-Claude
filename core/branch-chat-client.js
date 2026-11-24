/* Independent renderer module. Adds ChatGPT-style "..." -> "Branch in new chat" popover to assistant reply toolbars using native ForkConversation RPC (current workspace) with same-project fallback persistence. */
(function () {
  if (typeof window.__agBranchChat?.dispose === 'function') window.__agBranchChat.dispose();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const RESERVED_PROJECTS = new Set(['outside-of-project', 'default-cli-project']);
  const FORK_TARGET_CURRENT_WORKSPACE = 1;
  const AGENT_WORKING_H6_RE = /^(?:Agent\s+working|Agent\s*正在执行|Agent\s*正在工作|正在工作)$/i;
  const BRANCHED_IDS_STORAGE_KEY = 'ag_branch_chat_ids_v1';

  const MORE_ICON_SVG =
    '<svg class="ag-branch-ico h-4 w-4" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="19" cy="12" r="1.75"/></svg>';
  const BRANCH_ICON_SVG =
    '<svg class="ag-branch-menu-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h6.5"/><path d="M10.5 12 19 5"/><path d="M14.5 5H19v4.5"/><path d="M10.5 12 19 19"/><path d="M14.5 19H19v-4.5"/></svg>';
  const SPINNER_ICON_SVG =
    '<svg class="ag-branch-spinner h-4 w-4" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-opacity="0.22"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>';

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
  const branchedIds = new Set();
  const stats = { branchedCount: 0, fallbackMovedCount: 0, lastBranchedId: '', lastError: '' };

  function loadStoredBranchedIds() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(BRANCHED_IDS_STORAGE_KEY) : null;
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        for (const id of arr) {
          const s = String(id || '').trim().toLowerCase();
          if (UUID_RE.test(s)) branchedIds.add(s);
        }
      }
    } catch {}
  }

  function persistStoredBranchedIds() {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(BRANCHED_IDS_STORAGE_KEY, JSON.stringify(Array.from(branchedIds).slice(-500)));
      }
    } catch {}
  }

  function markBranchedId(cid) {
    const norm = String(cid || '').trim().toLowerCase();
    if (!UUID_RE.test(norm)) return false;
    if (branchedIds.has(norm)) return false;
    branchedIds.add(norm);
    persistStoredBranchedIds();
    return true;
  }

  function isBranched(cid, titleHint = '') {
    const norm = String(cid || '').trim().toLowerCase();
    if (norm && branchedIds.has(norm)) return true;
    if (titleHint && /\(fork\)\s*$/i.test(String(titleHint))) return true;
    return false;
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
      markBranchedId(newCascadeId);
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
      const msg = String(err?.message || err || 'fork_failed');
      stats.lastError = msg;
      showToast(L('分支对话失败，请稍后重试', 'Failed to branch chat'), 'error');
      return { ok: false, error: msg };
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

    /* 1. Native sidebar rows (Projects, Outside of Project, Pinned) */
    const nativeRows = document.querySelectorAll('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    for (const row of nativeRows) {
      const cid = row.getAttribute('data-cascade-id') || '';
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
      if (changed) persistStoredBranchedIds();
      decorateBranchedTitles();
      return { ok: true, count: branchedIds.size, changed };
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
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) {
      closePopover();
      document.querySelectorAll('[data-ag-branch-more]').forEach((n) => n.remove());
      clearAllBranchedTitleMarks();
      return;
    }
    syncBranchedIdsFromDaemon(true);
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
    getBranchedIds: () => Array.from(branchedIds),
    setEnabled,
    refreshLanguage,
    closePopover,
    dispose,
    getStatus: () => ({ enabled, disposed, forking, branchedTotal: branchedIds.size, ...stats })
  };

  window.__agBranchChat = api;
  ctx.onCleanup?.(dispose);
})();
