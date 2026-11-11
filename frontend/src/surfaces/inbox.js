import { createPageHeader } from "./operations-overview.js";

function el(documentRef, tag, className, text = "") {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const UNPROCESSED = new Set(["new", "triaged", "blocked"]);

export function createInboxSurface(context) {
  const { documentList, documentRef = document, getActiveWorkspaceRoute, navigateCanonicalWorkspace, request, setRouteTitle, workApiUrl } = context;
  let items = [];
  let unprocessedCount = 0;
  let totalCount = 0;
  let loading = false;
  let error = "";
  let detail = null;
  let detailError = "";
  let detailLoadingId = null;
  let loadedStatus = null;

  function syncInboxBadge() {
    const badge = documentRef.querySelector("#inbox-nav-count");
    if (!badge) return;
    if (unprocessedCount > 0) {
      badge.hidden = false;
      badge.textContent = String(unprocessedCount);
      badge.setAttribute("aria-label", `${unprocessedCount} unprocessed inbox items`);
    } else {
      badge.hidden = true;
      badge.textContent = "";
      badge.removeAttribute("aria-label");
    }
  }

  async function refreshInboxBadge() {
    try {
      const payload = await request(workApiUrl("/api/inbox", { status: "all" }));
      unprocessedCount = Number(payload?.unprocessedCount || 0);
      totalCount = Number(payload?.totalCount ?? payload?.items?.length ?? 0);
    } catch {
      // Badge stays at its last known value when the inbox is unreachable.
    }
    syncInboxBadge();
  }

  async function load(status) {
    if (loading) return;
    loading = true;
    error = "";
    loadedStatus = status || "all";
    try {
      const payload = await request(workApiUrl("/api/inbox", { status: status || "all" }));
      items = Array.isArray(payload?.items) ? payload.items : [];
      unprocessedCount = Number(payload?.unprocessedCount || 0);
      totalCount = Number(payload?.totalCount ?? items.length);
    } catch (caught) {
      error = caught?.message || "Inbox is unavailable";
      items = [];
    } finally {
      loading = false;
      syncInboxBadge();
      renderInbox();
    }
  }

  async function loadDetail(id) {
    if (detailLoadingId === id) return;
    detailLoadingId = id;
    detail = null;
    detailError = "";
    try {
      const payload = await request(workApiUrl(`/api/inbox/${encodeURIComponent(id)}`));
      detail = payload?.item || null;
      if (!detail) detailError = "Inbox item not found.";
    } catch (caught) {
      detailError = caught?.message || "Inbox item is unavailable";
    } finally {
      if (detailLoadingId === id) detailLoadingId = null;
    }
    renderInbox();
  }

  async function setStatus(id, status, extra = {}) {
    const payload = { status, ...extra };
    if ((status === "archived" || status === "ignored") && !payload.resolutionReason) {
      payload.resolutionReason = status === "archived" ? "Processed" : "Ignored";
    }
    try {
      await request(workApiUrl(`/api/inbox/${encodeURIComponent(id)}`), { method: "PUT", body: JSON.stringify(payload) });
      await load(currentStatus());
      if (currentItem()) await loadDetail(currentItem());
      else { detail = null; renderInbox(); }
      await refreshInboxBadge();
    } catch (caught) {
      detailError = caught?.message || "Could not update the inbox item";
      renderInbox();
    }
  }

  function currentStatus() {
    const route = getActiveWorkspaceRoute();
    return route?.params?.get("status") || "all";
  }

  function currentItem() {
    const route = getActiveWorkspaceRoute();
    return route?.params?.get("item") || "";
  }

  function header(root) {
    const countLabel = unprocessedCount === 0 ? "nothing unprocessed" : `${unprocessedCount} unprocessed`;
    root.append(createPageHeader({
      title: "Inbox",
      subtitle: `Materials saved so they are not lost. ${countLabel}.`,
      className: "inbox-header",
      documentRef,
    }));
  }

  function filterBar(root) {
    const bar = el(documentRef, "div", "inbox-filters");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Inbox filter");
    for (const [value, label] of [["all", "All"], ["unprocessed", "Unprocessed"], ["processed", "Processed"]]) {
      const button = el(documentRef, "button", `dk-button dk-button--sm${currentStatus() === value ? " dk-button--primary" : " dk-button--secondary"}`, label);
      button.type = "button";
      if (currentStatus() === value) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => navigateCanonicalWorkspace("/inbox", { status: value === "all" ? "" : value }));
      bar.append(button);
    }
    root.append(bar);
  }

  function statusPill(status) {
    const pill = el(documentRef, "span", `dk-pill inbox-status inbox-status--${status}`, UNPROCESSED.has(status) ? `Unprocessed · ${status}` : `Processed · ${status}`);
    return pill;
  }

  function renderList(root) {
    if (loading) {
      root.append(el(documentRef, "p", "status-text", "Loading inbox…"));
      return;
    }
    if (error) {
      const callout = el(documentRef, "div", "dk-callout dk-callout--danger", error);
      callout.setAttribute("role", "alert");
      const retry = el(documentRef, "button", "dk-button dk-button--secondary", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => load(currentStatus()));
      root.append(callout, retry);
      return;
    }
    if (items.length === 0) {
      root.append(el(documentRef, "p", "status-text", "Inbox is empty. Save materials here so they are not lost."));
      return;
    }
    const list = el(documentRef, "div", "inbox-list");
    for (const item of items) {
      const row = el(documentRef, "article", "inbox-row");
      const title = el(documentRef, "button", "inbox-row__title", item.title || "Untitled");
      title.type = "button";
      title.addEventListener("click", () => navigateCanonicalWorkspace("/inbox", {
        status: currentStatus() === "all" ? "" : currentStatus(),
        item: item.id,
      }));
      const meta = el(documentRef, "p", "inbox-row__meta", `${String(item.sourceReceivedAt || item.createdAt || "").slice(0, 10)} · ${item.summary || ""}`.trim());
      row.append(title, meta, statusPill(item.status));
      if (currentItem() === item.id) row.classList.add("is-active");
      list.append(row);
    }
    root.append(list);
  }

  function renderDetail(root) {
    const id = currentItem();
    if (!id) return;
    const pane = el(documentRef, "section", "inbox-detail");
    pane.setAttribute("aria-label", "Inbox item detail");
    const back = el(documentRef, "button", "quiet-button", "Back to list");
    back.type = "button";
    back.addEventListener("click", () => navigateCanonicalWorkspace("/inbox", { status: currentStatus() === "all" ? "" : currentStatus() }));
    pane.append(back);
    if (detailError) {
      const callout = el(documentRef, "div", "dk-callout dk-callout--danger", detailError);
      callout.setAttribute("role", "alert");
      pane.append(callout);
      root.append(pane);
      return;
    }
    if (!detail || detail.id !== id) {
      pane.append(el(documentRef, "p", "status-text", "Loading item…"));
      root.append(pane);
      loadDetail(id);
      return;
    }
    pane.append(el(documentRef, "h2", "", detail.title || "Untitled"));
    pane.append(statusPill(detail.status));
    if (detail.summary) pane.append(el(documentRef, "p", "inbox-detail__summary", detail.summary));
    if (detail.metadata?.provenance) {
      const provenance = el(documentRef, "details", "inbox-detail__provenance");
      const summary = el(documentRef, "summary", "", "Provenance");
      const pre = el(documentRef, "pre", "inbox-detail__body");
      pre.textContent = JSON.stringify(detail.metadata.provenance, null, 2);
      provenance.append(summary, pre);
      pane.append(provenance);
    }
    const body = el(documentRef, "pre", "inbox-detail__body");
    body.textContent = detail.bodyRef || "";
    pane.append(body);
    const actions = el(documentRef, "div", "inbox-detail__actions");
    if (UNPROCESSED.has(detail.status)) {
      const done = el(documentRef, "button", "dk-button dk-button--primary dk-button--sm", "Mark processed");
      done.type = "button";
      done.addEventListener("click", () => setStatus(detail.id, "archived"));
      actions.append(done);
    } else {
      const reopen = el(documentRef, "button", "dk-button dk-button--secondary dk-button--sm", "Reopen");
      reopen.type = "button";
      reopen.addEventListener("click", () => setStatus(detail.id, "new"));
      actions.append(reopen);
    }
    pane.append(actions);
    root.append(pane);
  }

  function renderInbox() {
    const route = getActiveWorkspaceRoute();
    if (route?.view !== "inbox") return;
    setRouteTitle("Inbox");
    const status = currentStatus();
    if (!loading && loadedStatus !== status) {
      load(status);
    }
    const root = el(documentRef, "div", "inbox-surface");
    header(root);
    filterBar(root);
    const columns = el(documentRef, "div", "inbox-columns");
    const listWrap = el(documentRef, "div", "inbox-list-wrap");
    renderList(listWrap);
    columns.append(listWrap);
    root.append(columns);
    renderDetail(root);
    documentList.replaceChildren(root);
    syncInboxBadge();
    const id = currentItem();
    if (id && (!detail || detail.id !== id) && !detailError && detailLoadingId !== id) loadDetail(id);
  }

  return { renderInbox, refreshInboxBadge, reloadInbox: load };
}
