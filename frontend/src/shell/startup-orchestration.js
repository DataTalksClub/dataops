// Route-aware startup dispatch for the shared bootstrap snapshots.
//
// Cold-loading a self-loading surface (CRM, Bookkeeping, Calendar,
// Newsletter, Podcast, Users) needs none of the shared work, recurring, or
// process-quality snapshots: those surfaces fetch and own their data, and a
// snapshot landing mid-session must not repaint them (see the background
// render gate in runtime/surface-composition.js). Firing the whole snapshot
// fanout anyway — tasks, cards plus per-card task paging, users, templates,
// resources, recurring, quality — only contends with the surface the operator
// actually asked for: on a synthetic cold CRM load the pipeline endpoint
// answers in ~290ms while first useful rows land at ~1200ms behind 25
// unrelated requests (see ~/tmp/agent-reports/crm-startup/cold-crm-*.json;
// local synthetic figures, never production claims).
//
// So the bootstrap defers those three snapshots on self-loading routes and
// starts each of them at most once, the first time a surface that reads the
// shared snapshots is committed (Tasks/Cards/Templates/Recurring, Docs,
// Admin, the operating model, or a Card/Task dialog over any route) or the
// operator explicitly refreshes. There are no timers, no sleeps, no caches,
// and no auth handling here: deferral is driven only by the committed route,
// and every explicit refresh still refetches.

// Views that fetch and own their data. Mirrors SELF_LOADING_VIEWS in
// runtime/surface-composition.js, which owns the repaint side of the same
// contract; keep the two sets identical.
const STARTUP_DEFERRED_VIEWS = Object.freeze(
  new Set(["bookkeeping", "calendar", "newsletter", "podcast", "sponsors", "users"]),
);

export function startupDeferredViews() {
  return STARTUP_DEFERRED_VIEWS;
}

// Whether committing this route needs none of the shared snapshots yet. An
// unknown or invalid route, a document/folder address, and any Card/Task
// dialog (which reads work and quality state) all need them, so only a clean
// self-loading workspace route defers.
export function isStartupDeferredRoute(route) {
  if (!route || route.invalid || typeof route.view !== "string") return false;
  if (!STARTUP_DEFERRED_VIEWS.has(route.view)) return false;
  return !route.modalCardId && !route.modalTaskId;
}

const SNAPSHOT_NAMES = Object.freeze(["work", "recurring", "quality"]);

export function createStartupOrchestration({
  refreshOperationsWorkSnapshot,
  refreshOperationsRecurringSnapshot,
  refreshOperationsQualitySnapshot,
}) {
  const refreshers = {
    work: refreshOperationsWorkSnapshot,
    recurring: refreshOperationsRecurringSnapshot,
    quality: refreshOperationsQualitySnapshot,
  };
  const started = { work: false, recurring: false, quality: false };
  const inflight = { work: null, recurring: null, quality: null };

  function beginSnapshot(name, options) {
    started[name] = true;
    const promise = Promise.resolve().then(() => refreshers[name](options));
    inflight[name] = promise;
    const settle = () => {
      if (inflight[name] === promise) inflight[name] = null;
    };
    promise.then(settle, settle);
    return promise;
  }

  // The bootstrap call: start the snapshots unless the initial route is a
  // clean self-loading surface. Start-once like the navigation ensure, so a
  // repeated dispatch never duplicates the fanout. Always returns the
  // per-snapshot promises (null when deferred or already started) so tests
  // can assert the dispatch exactly.
  function dispatchBootstrapSnapshots(route) {
    const outcome = { work: null, recurring: null, quality: null };
    if (isStartupDeferredRoute(route)) return outcome;
    for (const name of SNAPSHOT_NAMES) {
      if (!started[name]) outcome[name] = beginSnapshot(name, { background: true });
    }
    return outcome;
  }

  // The navigation call: start whatever has not started yet when a route
  // that reads the shared snapshots commits. Fire-and-forget by design: the
  // route already painted its honest loading state synchronously, and the
  // background gate repaints it when the data lands.
  function ensureSharedSnapshots(route) {
    const outcome = { work: null, recurring: null, quality: null };
    if (isStartupDeferredRoute(route)) return outcome;
    for (const name of SNAPSHOT_NAMES) {
      if (!started[name]) outcome[name] = beginSnapshot(name, { background: true });
    }
    return outcome;
  }

  function refreshSnapshot(name, options) {
    started[name] = true;
    return refreshers[name](options);
  }

  return {
    dispatchBootstrapSnapshots,
    ensureSharedSnapshots,
    isSnapshotStarted: (name) => Boolean(started[name]),
    refreshOperationsWorkSnapshot: (options) => refreshSnapshot("work", options),
    refreshOperationsRecurringSnapshot: (options) =>
      refreshSnapshot("recurring", options),
    refreshOperationsQualitySnapshot: (options) =>
      refreshSnapshot("quality", options),
  };
}
