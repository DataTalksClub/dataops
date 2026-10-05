function el(documentRef, tag, className, text = "") {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function titleCaseFamily(section) {
  return String(section || "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function createOperatingModelSurface(context) {
  const { apiUrl, documentList, documentRef = document, getActiveWorkspaceRoute, navigateCanonicalWorkspace, openDocument, request, resolveDocReference, setRouteTitle } = context;
  let model = null;
  let error = "";
  let loading = false;
  let lastFailureRender = null;

  async function load(force = false) {
    if (loading || model || (error && !force)) return;
    loading = true;
    error = "";
    try {
      const payload = await request(apiUrl("/api/operating-model"));
      const loaded = payload?.model;
      if (!loaded || !Array.isArray(loaded.roadmap?.sessions) ||
          !["businessUnits", "functions", "systems", "gaps", "lifecycles", "assets", "dependencies"].every((key) => Array.isArray(loaded[key]))) {
        throw new Error("Operating model response is incomplete");
      }
      model = loaded;
    } catch (caught) {
      error = caught?.message || "Operating model is unavailable";
    } finally {
      loading = false;
      renderActive();
    }
  }

  function resolvedDoc(documentId) {
    return resolveDocReference(documentId);
  }

  function openDocButton(documentId, label) {
    const doc = resolvedDoc(documentId);
    const button = el(documentRef, "button", "quiet-button operating-model-doc-link", label || doc?.title || "Open document");
    button.type = "button";
    button.addEventListener("click", () => {
      if (doc?.path) openDocument(doc.path);
      else {
        const next = resolvedDoc(documentId);
        if (next?.path) openDocument(next.path);
      }
    });
    return button;
  }

  function header(root, title) {
    const block = el(documentRef, "header", "operating-model-header");
    block.append(el(documentRef, "h1", "", title));
    root.append(block);
  }

  function unavailable(root) {
    const state = el(documentRef, "section", "review-empty-state");
    state.append(el(documentRef, "strong", "", loading ? "Loading operating model…" : "Operating model unavailable"));
    state.append(
      el(documentRef, "span", "",
        loading
          ? "Definitions appear here once the model loads."
          : "Definitions are hidden until the model reloads.",
      ),
    );
    if (!loading) {
      const retry = el(documentRef, "button", "quiet-button", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => { load(true); renderActive(); });
      state.append(retry);
    }
    root.append(state);
  }

  function summaryCard(label, count, onOpen) {
    const row = el(documentRef, "button", "operating-model-card");
    row.type = "button";
    row.setAttribute("aria-label", `Open ${label}`);
    row.append(
      el(documentRef, "h3", "", label),
      el(documentRef, "span", "operating-model-count", String(count)),
    );
    if (onOpen) row.addEventListener("click", onOpen);
    return row;
  }

  function keepFailureDOM(view, section = "") {
    if (!error || loading) {
      lastFailureRender = null;
      return false;
    }
    const key = JSON.stringify([view, section, error, getActiveWorkspaceRoute()?.params?.toString()]);
    if (lastFailureRender?.key === key && lastFailureRender.model === model && documentList.children[0] === lastFailureRender.root) return true;
    lastFailureRender = { key, model };
    return false;
  }

  function replaceSurface(root) {
    documentList.replaceChildren(root);
    if (lastFailureRender) lastFailureRender.root = root;
  }

  function renderOperatingModel() {
    const section = getActiveWorkspaceRoute()?.params?.get("section");
    if (section) { renderSection(section); return; }
    if (keepFailureDOM("operating-model")) return;
    setRouteTitle("Operating Model");
    const root = el(documentRef, "div", "operating-model-surface");
    header(root, "Operating Model");
    if (!model) { load(); unavailable(root); replaceSurface(root); return; }
    if (model.freshness === "stale") root.append(el(documentRef, "p", "status-text", "Showing the last valid model while definitions refresh."));
    const grid = el(documentRef, "section", "operating-model-grid");
    const items = [
      ["Business units", model.businessUnits],
      ["Functions", model.functions],
      ["Systems", model.systems],
      ["Gaps", model.gaps],
      ["Lifecycles", model.lifecycles],
      ["Assets", model.assets],
      ["Dependencies", model.dependencies],
      ["Roadmap", model.roadmap.sessions],
    ];
    for (const [label, values] of items) {
      grid.append(summaryCard(label, values.length, () =>
        navigateCanonicalWorkspace("/operating-model", { section: String(label).toLowerCase().replace(" ", "-") })));
    }
    const overview = resolvedDoc(model.overviewDocumentId);
    root.append(grid, openDocButton(model.overviewDocumentId, overview?.title || "Operating model"));
    replaceSurface(root);
  }

  function renderSection(section) {
    if (keepFailureDOM("operating-model", section)) return;
    setRouteTitle("Operating Model");
    const root = el(documentRef, "div", "operating-model-surface");
    const back = el(documentRef, "button", "quiet-button", "Overview");
    back.type = "button"; back.addEventListener("click", () => navigateCanonicalWorkspace("/operating-model"));
    root.append(back);
    if (!model) {
      header(root, titleCaseFamily(section));
      load(); unavailable(root); replaceSurface(root); return;
    }
    const key = section === "business-units" ? "businessUnits" : section === "roadmap" ? "roadmap" : section;
    const values = key === "roadmap" ? model?.roadmap?.sessions : model?.[key];
    header(root, titleCaseFamily(section));
    const list = el(documentRef, "section", "operating-model-list");
    for (const item of values || []) {
      const documentId = item.documentId || (item.id?.includes(".") ? item.id : "");
      const doc = documentId ? resolvedDoc(documentId) : null;
      const card = el(documentRef, documentId ? "button" : "article", "operating-model-row");
      if (documentId) {
        card.type = "button";
        card.setAttribute("aria-label", `Open ${item.name || item.title || doc?.title || "document"}`);
        card.addEventListener("click", () => {
          const next = resolvedDoc(documentId);
          if (next?.path) openDocument(next.path);
        });
      }
      card.append(el(documentRef, "h3", "", item.name || item.title), el(documentRef, "p", "", item.outcome || item.goal || item.role || ""));
      const meta = entityMeta(item);
      if (meta) card.append(el(documentRef, "p", "operating-model-meta", meta));
      list.append(card);
    }
    root.append(list); replaceSurface(root);
  }

  function entityMeta(item) {
    const parts = [
      item.managerTitle,
      item.currentCoverage,
      item.priority,
      item.proposedDate ? humanModelDate(item.proposedDate) : "",
      item.owner,
      item.provider,
      item.risk,
      item.mitigation,
    ].filter(Boolean);
    return parts.join(" · ");
  }

  function humanModelDate(value) {
    const parsed = new Date(`${String(value || "").slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? String(value || "")
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        }).format(parsed);
  }

  function renderActive() {
    const route = getActiveWorkspaceRoute();
    if (route?.view === "operating-model" && route.params.get("section")) renderSection(route.params.get("section"));
    else if (route?.view === "operating-model") renderOperatingModel();
  }
  return { renderOperatingModel };
}
