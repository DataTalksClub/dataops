function el(documentRef, tag, className, text = "") {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function detail(documentRef, label, value) {
  const item = el(documentRef, "div", "operating-model-detail");
  item.append(el(documentRef, "dt", "", label), el(documentRef, "dd", "", value || "Not defined"));
  return item;
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

  function openDocButton(documentId, label = "Open source document") {
    const button = el(documentRef, "button", "quiet-button", label);
    button.type = "button";
    button.addEventListener("click", () => {
      const document = resolveDocReference(documentId);
      if (document?.path) openDocument(document.path);
    });
    return button;
  }

  function header(root, kicker, title, description) {
    const block = el(documentRef, "header", "operating-model-header");
    block.append(el(documentRef, "p", "section-kicker", kicker), el(documentRef, "h1", "", title), el(documentRef, "p", "", description));
    root.append(block);
  }

  function unavailable(root) {
    const state = el(documentRef, "section", "review-empty-state");
    state.append(el(documentRef, "strong", "", loading ? "Loading operating model…" : "Operating model unavailable"));
    // The body states the impact, not the same proposition as the heading.
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

  function summaryCard(label, count, body, onOpen) {
    // Family row, not a stat card: the name leads, the description follows as
    // quiet metadata, the mono count is the quantity, and one chevron opens
    // the section. Eight identical "View" buttons would be filler.
    const row = el(documentRef, "article", "operating-model-card");
    row.append(
      el(documentRef, "h3", "", label),
      el(documentRef, "span", "operating-model-count", String(count)),
      el(documentRef, "p", "", body),
    );
    if (onOpen) {
      const open = el(documentRef, "button", "quiet-button operating-model-open");
      open.type = "button";
      open.setAttribute("aria-label", `Open ${label}`);
      open.innerHTML =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"'
        + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="m9 18 6-6-6-6"/></svg>';
      open.addEventListener("click", onOpen);
      row.append(open);
    }
    return row;
  }

  // Shell refreshes must preserve selected text on an unchanged failure screen.
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
    header(root, "Company system", "Operating Model", "See how business units, accountable functions, systems, gaps, and lifecycles fit together.");
    if (!model) { load(); unavailable(root); replaceSurface(root); return; }
    if (model.freshness === "stale") root.append(el(documentRef, "p", "status-text", "Showing the last valid model while definitions refresh."));
    const grid = el(documentRef, "section", "operating-model-grid");
    const items = [
      ["Business units", model.businessUnits, "Portfolio boundaries, economics, priorities, and separation rules."],
      ["Functions", model.functions, "Outcomes, accountable manager seats, and current coverage."],
      ["Systems", model.systems, "Current and draft systems connected to accountable functions."],
      ["Gaps", model.gaps, "Prioritized missing systems and their planned sessions."],
      ["Lifecycles", model.lifecycles, "Cross-functional journeys through the operating system."],
      ["Assets", model.assets, "Ownership, source of truth, and separation treatment for key assets."],
      ["Dependencies", model.dependencies, "Cross-unit and founder dependencies with risks and mitigations."],
      ["Roadmap", model.roadmap.sessions, "Thirteen proposed systems-day sessions with explicit decisions and outcomes."],
    ];
    for (const [label, values, body] of items) {
      grid.append(summaryCard(label, values.length, body, () =>
        navigateCanonicalWorkspace("/operating-model", { section: String(label).toLowerCase().replace(" ", "-") })));
    }
    root.append(grid, openDocButton(model.overviewDocumentId, "Open full operating-model guide"));
    replaceSurface(root);
  }

  function renderSection(section) {
    if (keepFailureDOM("operating-model", section)) return;
    setRouteTitle("Operating Model");
    const root = el(documentRef, "div", "operating-model-surface");
    const back = el(documentRef, "button", "quiet-button", "← Overview");
    back.type = "button"; back.addEventListener("click", () => navigateCanonicalWorkspace("/operating-model"));
    root.append(back);
    if (!model) {
      header(root, "Operating model", section.replaceAll("-", " "), "Current definitions");
      load(); unavailable(root); replaceSurface(root); return;
    }
    const key = section === "business-units" ? "businessUnits" : section === "roadmap" ? "roadmap" : section;
    const values = key === "roadmap" ? model?.roadmap?.sessions : model?.[key];
    header(root, "Operating model", section.replaceAll("-", " "), `${values?.length || 0} current definitions`);
    const list = el(documentRef, "section", "operating-model-list");
    for (const item of values || []) {
      const card = el(documentRef, "article", "operating-model-row");
      card.append(el(documentRef, "h3", "", item.name || item.title), el(documentRef, "p", "", item.outcome || item.goal || item.role || ""));
      const meta = el(documentRef, "dl", "operating-model-details");
      if (item.managerTitle) meta.append(detail(documentRef, "Accountable seat", item.managerTitle));
      if (item.currentCoverage) meta.append(detail(documentRef, "Current coverage", item.currentCoverage));
      if (item.priority) meta.append(detail(documentRef, "Priority", item.priority));
      if (item.proposedDate) meta.append(detail(documentRef, "Proposed date", humanModelDate(item.proposedDate)));
      if (item.primaryUnitId) meta.append(detail(documentRef, "Primary unit", item.primaryUnitId));
      if (item.owner) meta.append(detail(documentRef, "Owner", item.owner));
      if (item.consumerUnitId) meta.append(detail(documentRef, "Consumer unit", item.consumerUnitId));
      if (item.provider) meta.append(detail(documentRef, "Provider", item.provider));
      if (item.risk) meta.append(detail(documentRef, "Risk", item.risk));
      if (item.mitigation) meta.append(detail(documentRef, "Mitigation", item.mitigation));
      card.append(meta);
      if (item.documentId || item.id?.includes(".")) card.append(openDocButton(item.documentId || item.id));
      list.append(card);
    }
    root.append(list); replaceSurface(root);
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
