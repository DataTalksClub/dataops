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

  async function load() {
    if (loading || model) return;
    loading = true;
    error = "";
    try {
      const payload = await request(apiUrl("/api/operating-model"));
      model = payload?.model || null;
      if (!model) throw new Error("Operating model response is incomplete");
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
    block.append(el(documentRef, "p", "section-kicker", kicker), el(documentRef, "h2", "", title), el(documentRef, "p", "", description));
    root.append(block);
  }

  function unavailable(root) {
    const state = el(documentRef, "section", "review-empty-state");
    state.append(el(documentRef, "strong", "", loading ? "Loading operating model…" : "Operating model unavailable"));
    if (error) state.append(el(documentRef, "span", "", error));
    if (!loading) {
      const retry = el(documentRef, "button", "quiet-button", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => { model = null; load(); });
      state.append(retry);
    }
    root.append(state);
  }

  function summaryCard(label, count, body, action) {
    const card = el(documentRef, "article", "operating-model-card");
    card.append(el(documentRef, "span", "operating-model-count", String(count)), el(documentRef, "h3", "", label), el(documentRef, "p", "", body));
    if (action) card.append(action);
    return card;
  }

  function renderOperatingModel() {
    setRouteTitle("Operating Model");
    const root = el(documentRef, "div", "operating-model-surface");
    header(root, "Company system", "Operating Model", "See how business units, accountable functions, systems, gaps, and lifecycles fit together.");
    if (!model) { unavailable(root); documentList.replaceChildren(root); load(); return; }
    if (model.freshness === "stale") root.append(el(documentRef, "p", "status-text", "Showing the last valid model while definitions refresh."));
    const grid = el(documentRef, "section", "operating-model-grid");
    const items = [
      ["Business units", model.businessUnits, "Portfolio boundaries, economics, priorities, and separation rules."],
      ["Functions", model.functions, "Outcomes, accountable manager seats, and current coverage."],
      ["Systems", model.systems, "Current and draft systems connected to accountable functions."],
      ["Gaps", model.gaps, "Prioritized missing systems and their planned sessions."],
      ["Lifecycles", model.lifecycles, "Cross-functional journeys through the operating system."],
      ["Roadmap", model.roadmap.sessions, "Thirteen proposed systems-day sessions with explicit decisions and outcomes."],
    ];
    for (const [label, values, body] of items) {
      const button = el(documentRef, "button", "quiet-button", "View");
      button.type = "button";
      button.addEventListener("click", () => navigateCanonicalWorkspace("/operating-model", { section: String(label).toLowerCase().replace(" ", "-") }));
      grid.append(summaryCard(label, values.length, body, button));
    }
    root.append(grid, openDocButton(model.overviewDocumentId, "Open full operating-model guide"));
    documentList.replaceChildren(root);
  }

  function renderSection(section) {
    setRouteTitle("Operating Model");
    const root = el(documentRef, "div", "operating-model-surface");
    const back = el(documentRef, "button", "quiet-button", "← Overview");
    back.type = "button"; back.addEventListener("click", () => navigateCanonicalWorkspace("/operating-model"));
    root.append(back);
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
      if (item.proposedDate) meta.append(detail(documentRef, "Proposed date", item.proposedDate));
      card.append(meta);
      if (item.documentId || item.id?.includes(".")) card.append(openDocButton(item.documentId || item.id));
      list.append(card);
    }
    root.append(list); documentList.replaceChildren(root);
  }

  function renderMyPlan() {
    setRouteTitle("My Plan");
    const root = el(documentRef, "div", "operating-model-surface my-plan-surface");
    header(root, "Personal systems work", "My Plan", "The proposed sequence for turning the operating model into real decisions and deliverables.");
    if (!model) { unavailable(root); documentList.replaceChildren(root); load(); return; }
    const selected = getActiveWorkspaceRoute()?.params?.get("sessionId");
    const sessions = selected ? model.roadmap.sessions.filter((item) => item.id === selected) : model.roadmap.sessions;
    const list = el(documentRef, "section", "operating-model-list");
    for (const [index, session] of sessions.entries()) {
      const card = el(documentRef, "article", "operating-model-row plan-session");
      const state = index === 0 && !selected ? "Next" : "Proposed";
      card.append(
        el(documentRef, "span", "review-badge", `${session.id} · ${state}`),
        el(documentRef, "h3", "", session.title),
        el(documentRef, "p", "", session.goal),
      );
      const meta = el(documentRef, "dl", "operating-model-details");
      meta.append(
        detail(documentRef, "Proposed date", session.proposedDate),
        detail(documentRef, "Deliverables", session.deliverables),
        detail(documentRef, "Decisions for you", session.decisionsNeeded),
        detail(documentRef, "Agent-preparable work", session.agentWork),
        detail(documentRef, "Definition of done", session.definitionOfDone),
      );
      card.append(meta, openDocButton(session.documentId, "Open working session"));
      if (!selected) {
        const focus = el(documentRef, "button", "quiet-button", "Focus session");
        focus.type = "button"; focus.addEventListener("click", () => navigateCanonicalWorkspace("/my-plan", { sessionId: session.id }));
        card.append(focus);
      }
      list.append(card);
    }
    if (selected) {
      const all = el(documentRef, "button", "quiet-button", "← All sessions");
      all.type = "button"; all.addEventListener("click", () => navigateCanonicalWorkspace("/my-plan")); root.append(all);
    }
    root.append(list); documentList.replaceChildren(root);
  }

  function renderActive() {
    const route = getActiveWorkspaceRoute();
    if (route?.view === "my-plan") renderMyPlan();
    else if (route?.view === "operating-model" && route.params.get("section")) renderSection(route.params.get("section"));
    else if (route?.view === "operating-model") renderOperatingModel();
  }
  return { renderOperatingModel, renderMyPlan };
}
