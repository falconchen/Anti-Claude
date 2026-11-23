/* Independent renderer module. Syncs externally updated conversation titles into live Redux & language_server via native annotation RPC. */
(function () {
  if (typeof window.__agTitleSync?.dispose === 'function') window.__agTitleSync.dispose();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_TITLE_LENGTH = 200;
  let enabled = ctx.modules?.titleSync !== false;
  let disposed = false;
  let cachedActionsCtx = null;
  let draining = false;
  const pending = new Map();
  let drainWaiters = [];
  const stats = { syncedCount: 0, skippedCount: 0, failedCount: 0, lastSyncedAt: 0 };

  function normalizeTitle(raw) {
    if (typeof raw !== 'string') return '';
    const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return cleaned.length > 0 && cleaned.length <= MAX_TITLE_LENGTH ? cleaned : '';
  }

  function findBindings() {
    let store = null;
    let actionsCtx = null;
    const sb = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const row = sb?.querySelector('[data-testid="conversation-row-sidebar"]');
    const anchors = [
      sb?.firstElementChild,
      sb,
      row,
      document.querySelector('.bg-sidebar'),
      document.getElementById('antigravity.agentSidePanelInputBox'),
      document.querySelector('[data-testid="settings-sidebar"]'),
      document.querySelector('main'),
      document.getElementById('root')?.firstElementChild
    ];

    const scan = (value) => {
      if (!value || typeof value !== 'object') return;
      if (!store && value.sidebarStore && typeof value.sidebarStore.getState === 'function') {
        store = value.sidebarStore;
      }
      if (!store && value.store && typeof value.store.getState === 'function' && value.store.getState()?.trajectorySummaries?.summaries) {
        store = value.store;
      }
      if (!actionsCtx && value.sidebarActions && typeof value.sidebarActions.updateConversationAnnotations === 'function') {
        actionsCtx = value.sidebarActions;
      }
      if (!actionsCtx && typeof value.updateConversationAnnotations === 'function') {
        actionsCtx = value;
      }
    };

    for (const anchor of anchors) {
      if (!anchor) continue;
      const key = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
      let fiber = key ? anchor[key] : null;
      let root = fiber;
      while (root?.return) root = root.return;
      if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber?.alternate || fiber;
      for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) {
        scan(fiber.memoizedProps);
        scan(fiber.memoizedProps?.value);
        for (let dep = fiber.dependencies?.firstContext; dep; dep = dep.next) {
          scan(dep.memoizedValue);
        }
        if (store && actionsCtx) break;
      }
      if (store && actionsCtx) break;
    }

    if (actionsCtx) cachedActionsCtx = actionsCtx;
    return { store, actionsCtx: actionsCtx || cachedActionsCtx };
  }

  function readCurrentTitle(summary) {
    if (!summary || typeof summary !== 'object') return '';
    return String((summary.annotations && summary.annotations.title) || summary.summary || '');
  }

  function withTimeout(promise, ms) {
    let timer = 0;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('title_sync_timeout')), ms);
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  function notifySidebarUpdated(ids) {
    if (!ids.length) return;
    try {
      if (typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ag-title-sync-updated', { detail: { ids } }));
      }
    } catch {}
  }

  async function drain(intervalMs, timeoutMs) {
    if (draining) return;
    draining = true;
    const summaryResult = { ok: true, updated: [], unchanged: [], missing: [], failed: [] };

    try {
      while (!disposed && enabled && pending.size > 0) {
        const nextEntry = pending.entries().next().value;
        if (!nextEntry) break;
        const [id, title] = nextEntry;
        pending.delete(id);

        const { store, actionsCtx } = findBindings();
        if (!store || !actionsCtx || typeof actionsCtx.updateConversationAnnotations !== 'function') {
          summaryResult.failed.push(id);
          stats.failedCount += 1;
          for (const restId of pending.keys()) {
            summaryResult.failed.push(restId);
            stats.failedCount += 1;
          }
          pending.clear();
          summaryResult.ok = false;
          summaryResult.error = 'bindings_unavailable';
          break;
        }

        const summaries = store.getState?.()?.trajectorySummaries?.summaries;
        if (!summaries || !Object.prototype.hasOwnProperty.call(summaries, id)) {
          summaryResult.missing.push(id);
          continue;
        }

        const currentTitle = readCurrentTitle(summaries[id]);
        if (currentTitle === title) {
          summaryResult.unchanged.push(id);
          stats.skippedCount += 1;
          continue;
        }

        try {
          await withTimeout(actionsCtx.updateConversationAnnotations(id, { title }, true), timeoutMs);
          summaryResult.updated.push(id);
          stats.syncedCount += 1;
          stats.lastSyncedAt = Date.now();
        } catch {
          summaryResult.failed.push(id);
          stats.failedCount += 1;
        }

        if (!disposed && enabled && pending.size > 0 && intervalMs > 0) {
          await sleep(intervalMs);
        }
      }
    } finally {
      draining = false;
      if (summaryResult.updated.length > 0) {
        notifySidebarUpdated(summaryResult.updated);
      }
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const resolve of waiters) {
        try {
          resolve(summaryResult);
        } catch {}
      }
    }
  }

  function syncBatch(entries, opts = {}) {
    if (disposed || !enabled) {
      return Promise.resolve({ ok: true, skipped: 'disabled', updated: [], unchanged: [], missing: [], failed: [] });
    }
    const list = Array.isArray(entries) ? entries : [];
    for (const item of list) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      const title = normalizeTitle(item?.title);
      if (!UUID_RE.test(id) || !title) continue;
      pending.set(id, title);
    }
    if (pending.size === 0 && !draining) {
      return Promise.resolve({ ok: true, updated: [], unchanged: [], missing: [], failed: [] });
    }
    const intervalMs = Number.isFinite(Number(opts.intervalMs)) ? Math.max(0, Number(opts.intervalMs)) : 25;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(100, Number(opts.timeoutMs)) : 6000;
    return new Promise((resolve) => {
      drainWaiters.push(resolve);
      drain(intervalMs, timeoutMs);
    });
  }

  function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) pending.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pending.clear();
    cachedActionsCtx = null;
    const waiters = drainWaiters.splice(0, drainWaiters.length);
    for (const resolve of waiters) {
      try {
        resolve({ ok: true, skipped: 'disposed', updated: [], unchanged: [], missing: [], failed: [] });
      } catch {}
    }
    if (window.__agTitleSync === api) delete window.__agTitleSync;
  }

  const api = {
    syncBatch,
    setEnabled,
    dispose,
    getStatus: () => ({ enabled, disposed, draining, queued: pending.size, ...stats })
  };

  window.__agTitleSync = api;
  ctx.onCleanup?.(dispose);
})();
