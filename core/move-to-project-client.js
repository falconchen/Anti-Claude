/* Independent renderer module. Adds "Move to Project" submenu to Out-of-Project conversation context menus and persists via daemon + native writeSummary RPC. */
(function () {
  if (typeof window.__agMoveToProject?.dispose === 'function') window.__agMoveToProject.dispose();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const RESERVED_PROJECTS = new Set(['outside-of-project', 'default-cli-project']);
  const FOLDER_ICON_SVG =
    '<svg class="ag-mp-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>';
  const CHEVRON_SVG =
    '<svg class="ag-mp-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  let disposed = false;
  let cachedActions = null;
  let cachedStore = null;
  let lastTrigger = { id: '', ts: 0 };
  let activeSubmenu = null;
  let submenuCloseTimer = 0;
  let toastTimer = 0;
  let movingIds = new Set();

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

  function findBindings() {
    let store = null;
    let actions = null;
    const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const row = sb?.querySelector('[data-testid="conversation-row-sidebar"]');
    const anchors = [
      sb?.firstElementChild,
      sb,
      row,
      document.querySelector('.bg-sidebar'),
      document.querySelector('main'),
      document.getElementById('root')?.firstElementChild
    ];

    const scan = (val) => {
      if (!val || typeof val !== 'object') return;
      if (!store && val.sidebarStore && typeof val.sidebarStore.getState === 'function') store = val.sidebarStore;
      if (!store && val.store && typeof val.store.getState === 'function' && val.store.getState()?.trajectorySummaries?.summaries) {
        store = val.store;
      }
      if (!actions && val.sidebarActions && typeof val.sidebarActions.updateConversationAnnotations === 'function') {
        actions = val.sidebarActions;
      }
      if (!actions && typeof val.updateConversationAnnotations === 'function') actions = val;
    };

    for (const anchor of anchors) {
      if (!anchor) continue;
      const key = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
      let fiber = key ? anchor[key] : null;
      let root = fiber;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber?.alternate || fiber;
      for (let d = 0; fiber && d < 60; d++, fiber = fiber.return) {
        scan(fiber.memoizedProps);
        scan(fiber.memoizedProps?.value);
        for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) scan(dep.memoizedValue);
        if (store && actions) break;
      }
      if (store && actions) break;
    }

    if (store) cachedStore = store;
    if (actions) cachedActions = actions;
    return { store: store || cachedStore, actions: actions || cachedActions };
  }

  function listProjects(storeArg) {
    const store = storeArg || findBindings().store;
    const raw = store?.getState?.()?.sidebarProjects?.projects;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const p of raw) {
      if (!p || typeof p.id !== 'string') continue;
      const id = p.id.trim();
      if (!id || RESERVED_PROJECTS.has(id) || seen.has(id)) continue;
      const name = String(p.name || '').trim();
      if (!name) continue;
      seen.add(id);
      const folderUris = Array.isArray(p.folderUris)
        ? p.folderUris.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : [];
      out.push({ id, name, folderUris });
    }
    return out;
  }

  function isOutOfProject(cascadeId, storeArg) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) return false;
    const store = storeArg || findBindings().store;
    const state = store?.getState?.();
    const summary = state?.trajectorySummaries?.summaries?.[cascadeId];
    if (!summary || summary.killed) return false;
    const pid = String(summary.projectId || summary.trajectoryMetadata?.projectId || '').trim();
    if (!pid || pid === 'outside-of-project') return true;
    const outIdx = state?.trajectorySummaries?.indexes?.outsideOfProject;
    if (outIdx) {
      if (Array.isArray(outIdx) && outIdx.includes(cascadeId)) return true;
      if (outIdx instanceof Set && outIdx.has(cascadeId)) return true;
      if (typeof outIdx === 'object' && Object.prototype.hasOwnProperty.call(outIdx, cascadeId) && outIdx[cascadeId]) return true;
    }
    return false;
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

  function showToast(text, isError = false) {
    try {
      let el = document.getElementById('ag-move-project-toast');
      if (!el && document.body) {
        el = document.createElement('div');
        el.id = 'ag-move-project-toast';
        el.setAttribute('data-ag-i18n-ignore', '1');
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
      }
      if (!el) return;
      el.textContent = text;
      el.setAttribute('data-kind', isError ? 'error' : 'ok');
      el.setAttribute('data-visible', 'true');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = 0;
        el.setAttribute('data-visible', 'false');
      }, 2400);
    } catch {}
  }

  async function move(cascadeId, projectId) {
    const cid = String(cascadeId || '').trim();
    const pid = String(projectId || '').trim();
    if (!UUID_RE.test(cid) || !pid || RESERVED_PROJECTS.has(pid)) {
      return { ok: false, error: 'invalid_args' };
    }
    if (movingIds.has(cid)) return { ok: false, error: 'already_moving' };
    movingIds.add(cid);

    try {
      const { store, actions } = findBindings();
      const summary = store?.getState?.()?.trajectorySummaries?.summaries?.[cid];
      const project = listProjects(store).find((p) => p.id === pid) || { id: pid, name: pid, folderUris: [] };

      const diskRes = await callDaemon('moveConversationToProject', { conversationId: cid, projectId: pid });
      if (!diskRes || !diskRes.ok) {
        showToast(L('移入项目失败，请重试', 'Failed to move conversation to project'), true);
        return diskRes || { ok: false, error: 'daemon_failed' };
      }

      const workspaceUris = Array.isArray(diskRes.workspaceUris) ? diskRes.workspaceUris : project.folderUris;
      const projectName = diskRes.projectName || project.name;
      let liveSynced = false;

      if (summary) {
        const nextSummary = buildUpdatedSummary(summary, pid, workspaceUris);
        if (actions && typeof actions.writeSummary === 'function') {
          try {
            await actions.writeSummary({ cascadeId: cid, summary: nextSummary });
            liveSynced = true;
          } catch {}
        }
        if (store && typeof store.dispatch === 'function') {
          try {
            store.dispatch({
              type: 'trajectorySummaries/applyStreamBatch',
              payload: { updates: [[cid, nextSummary]], deletes: [] }
            });
            liveSynced = true;
          } catch {}
        }
      }

      try {
        if (typeof CustomEvent === 'function') {
          window.dispatchEvent(
            new CustomEvent('ag-title-sync-updated', { detail: { ids: [cid], projectId: pid } })
          );
        }
      } catch {}

      showToast(L(`已移入项目「${projectName}」`, `Moved to "${projectName}"`));
      return Object.assign({}, diskRes, { liveSynced });
    } finally {
      movingIds.delete(cid);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Native Sidebar Context / More Menu Injection                             */
  /* ------------------------------------------------------------------------ */

  function closeSubmenu() {
    if (submenuCloseTimer) {
      clearTimeout(submenuCloseTimer);
      submenuCloseTimer = 0;
    }
    if (activeSubmenu) {
      try {
        activeSubmenu.remove();
      } catch {}
      activeSubmenu = null;
    }
  }

  function dismissNativeMenu() {
    closeSubmenu();
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    } catch {}
  }

  function scheduleCloseSubmenu() {
    if (submenuCloseTimer) clearTimeout(submenuCloseTimer);
    submenuCloseTimer = setTimeout(() => {
      submenuCloseTimer = 0;
      closeSubmenu();
    }, 160);
  }

  function cancelCloseSubmenu() {
    if (submenuCloseTimer) {
      clearTimeout(submenuCloseTimer);
      submenuCloseTimer = 0;
    }
  }

  function openNativeSubmenu(triggerEl, cascadeId, projects) {
    cancelCloseSubmenu();
    if (activeSubmenu && activeSubmenu.getAttribute('data-cascade-id') === cascadeId) return;
    closeSubmenu();
    if (!document.body || !projects.length) return;

    const sub = document.createElement('div');
    sub.id = 'ag-move-project-submenu';
    sub.setAttribute('role', 'menu');
    sub.setAttribute('data-ag-i18n-ignore', '1');
    sub.setAttribute('data-cascade-id', cascadeId);

    sub.innerHTML = projects
      .map((p) => {
        const folderHint = p.folderUris[0]
          ? decodeURIComponent(p.folderUris[0].replace(/^file:\/\//, ''))
          : '';
        return `<button type="button" class="ag-mp-sub-item" role="menuitem" data-ag-mp-pid="${escapeHtml(p.id)}" title="${escapeHtml(folderHint || p.name)}">${FOLDER_ICON_SVG}<span class="ag-mp-sub-name">${escapeHtml(p.name)}</span></button>`;
      })
      .join('');

    sub.addEventListener('mouseenter', cancelCloseSubmenu);
    sub.addEventListener('mouseleave', scheduleCloseSubmenu);
    sub.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
    });
    sub.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-ag-mp-pid]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const targetPid = btn.getAttribute('data-ag-mp-pid');
      dismissNativeMenu();
      move(cascadeId, targetPid);
    });

    document.body.appendChild(sub);
    activeSubmenu = sub;

    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const subW = Math.max(180, Math.min(240, sub.offsetWidth || 204));
    const subH = Math.min(320, sub.scrollHeight || projects.length * 30 + 12);
    const fitsRight = rect.right + 4 + subW <= vw - 8;
    const left = fitsRight ? rect.right + 4 : Math.max(8, rect.left - subW - 4);
    const top = Math.max(8, Math.min(rect.top - 4, vh - subH - 8));
    sub.style.left = `${Math.round(left)}px`;
    sub.style.top = `${Math.round(top)}px`;
  }

  function enhanceNativeMenu(menuEl) {
    if (disposed || !menuEl || menuEl.querySelector('[data-ag-move-project-item]')) return;
    if (Date.now() - lastTrigger.ts > 2500 || !lastTrigger.id) return;
    const cid = lastTrigger.id;
    const { store } = findBindings();
    if (!isOutOfProject(cid, store)) return;
    const projects = listProjects(store);
    if (!projects.length) return;

    const anchorItem =
      menuEl.querySelector('[data-testid="conversation-mark-read-menu-item"]') ||
      menuEl.querySelector('[data-testid="conversation-pin-menu-item"]') ||
      menuEl.querySelector('[data-testid="conversation-rename-menu-item"]');
    if (!anchorItem) return;

    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('data-ag-move-project-item', cid);
    item.setAttribute('data-ag-i18n-ignore', '1');
    item.className = `${anchorItem.className || ''} ag-mp-native-item`.trim();
    item.innerHTML = `<span class="ag-mp-native-label">${escapeHtml(L('移入项目', 'Move to Project'))}</span>${CHEVRON_SVG}`;

    item.addEventListener('mouseenter', () => openNativeSubmenu(item, cid, projects));
    item.addEventListener('mouseleave', scheduleCloseSubmenu);
    item.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openNativeSubmenu(item, cid, projects);
    });

    anchorItem.insertAdjacentElement('afterend', item);

    if (!menuEl.hasAttribute('data-ag-mp-hover-bound')) {
      menuEl.setAttribute('data-ag-mp-hover-bound', '1');
      menuEl.addEventListener(
        'pointerover',
        (ev) => {
          if (!activeSubmenu) return;
          const overItem = ev.target?.closest?.('[role="menuitem"]');
          if (overItem && !overItem.hasAttribute('data-ag-move-project-item')) {
            closeSubmenu();
          }
        },
        true
      );
    }
  }

  function scanNativeMenus() {
    if (disposed) return;
    const markReadItems = document.querySelectorAll(
      '[data-testid="conversation-mark-read-menu-item"], [data-testid="conversation-rename-menu-item"]'
    );
    const seenMenus = new Set();
    for (const el of markReadItems) {
      const menu = el.closest('[role="menu"]');
      if (!menu || menu.id === 'ag-recent-row-menu' || seenMenus.has(menu)) continue;
      seenMenus.add(menu);
      enhanceNativeMenu(menu);
    }
    if (activeSubmenu && seenMenus.size === 0) {
      closeSubmenu();
    }
  }

  function recordRowTrigger(ev) {
    if (disposed) return;
    const row = ev.target?.closest?.('[data-testid="conversation-row-sidebar"]');
    if (!row) return;
    const cid = row.getAttribute('data-cascade-id') || '';
    if (UUID_RE.test(cid)) {
      lastTrigger = { id: cid, ts: Date.now() };
    }
  }

  function onGlobalPointerDown(ev) {
    if (!activeSubmenu) return;
    if (ev.target?.closest?.('#ag-move-project-submenu, [data-ag-move-project-item]')) return;
    closeSubmenu();
  }

  function onGlobalKeyDown(ev) {
    if (ev.key === 'Escape' && activeSubmenu) closeSubmenu();
  }

  let obs = null;
  let rafId = 0;
  let dclHandler = null;
  function scheduleScan() {
    if (disposed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      scanNativeMenus();
    });
  }

  function startObserver() {
    if (disposed || obs || typeof MutationObserver !== 'function' || !document.body) return;
    obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('contextmenu', recordRowTrigger, true);
  document.addEventListener('pointerdown', recordRowTrigger, true);
  document.addEventListener('mousedown', onGlobalPointerDown, true);
  document.addEventListener('keydown', onGlobalKeyDown, true);

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
    closeSubmenu();
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
    document.removeEventListener('contextmenu', recordRowTrigger, true);
    document.removeEventListener('pointerdown', recordRowTrigger, true);
    document.removeEventListener('mousedown', onGlobalPointerDown, true);
    document.removeEventListener('keydown', onGlobalKeyDown, true);
    document.querySelectorAll('[data-ag-move-project-item]').forEach((n) => n.remove());
    document.getElementById('ag-move-project-toast')?.remove();
    cachedActions = null;
    cachedStore = null;
    if (window.__agMoveToProject === api) delete window.__agMoveToProject;
  }

  const api = {
    listProjects,
    isOutOfProject,
    move,
    scanNativeMenus,
    dispose
  };

  window.__agMoveToProject = api;
  ctx.onCleanup?.(dispose);
})();
