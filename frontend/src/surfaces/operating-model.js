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
  let plan = null;
  let error = "";
  let planError = "";
  let loading = false;
  let planLoading = false;
  const pendingSessions = new Set();
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

  async function loadPlan(force = false) {
    if (planLoading || ((plan || planError) && !force)) return;
    planLoading = true;
    planError = "";
    try {
      const payload = await request(apiUrl("/api/my-plan"));
      if (!Array.isArray(payload?.sessions)) throw new Error("My Plan response is incomplete");
      plan = payload;
    } catch (caught) {
      planError = caught?.message || "My Plan is unavailable";
    } finally {
      planLoading = false;
      renderActive();
    }
  }

  async function addSession(session, anchorDate) {
    if (pendingSessions.has(session.id)) return;
    pendingSessions.add(session.id);
    planError = "";
    renderActive();
    try {
      await request(apiUrl(`/api/my-plan/sessions/${session.id}`), {
        method: "POST",
        body: JSON.stringify({
          expectedDefinitionRevision: plan?.revision || model?.revision,
          anchorDate,
        }),
      });
      await loadPlan(true);
    } catch (caught) {
      planError = caught?.message || "The session could not be added";
      if (caught?.status === 409) {
        plan = null;
        await loadPlan(true);
      }
    } finally {
      pendingSessions.delete(session.id);
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
          ? "Proposed sessions appear here once the model loads."
          : "Proposed sessions and plan actions are hidden until the model reloads.",
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
    if ((!error && !planError) || loading || planLoading || pendingSessions.size) {
      lastFailureRender = null;
      return false;
    }
    const key = JSON.stringify([view, section, error, planError, getActiveWorkspaceRoute()?.params?.toString()]);
    if (lastFailureRender?.key === key && lastFailureRender.model === model && lastFailureRender.plan === plan && documentList.children[0] === lastFailureRender.root) return true;
    lastFailureRender = { key, model, plan };
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

  function renderMyPlan() {
    if (keepFailureDOM("my-plan")) return;
    setRouteTitle("My Plan");
    const root = el(documentRef, "div", "operating-model-surface my-plan-surface");
    header(root, "My Plan");
    if (!model) { load(); unavailable(root); replaceSurface(root); return; }
    if (!plan && !planLoading) loadPlan();
    if (planLoading) root.append(el(documentRef, "p", "status-text", "Loading My Plan…"));
    if (planError) {
      const state = el(documentRef, "section", "review-empty-state");
      state.append(el(documentRef, "strong", "", "My Plan unavailable"), el(documentRef, "span", "", planError));
      if (!plan) state.append(el(documentRef, "span", "", "Proposed sessions remain visible. Load your plan before adding sessions."));
      const retry = el(documentRef, "button", "quiet-button", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => { loadPlan(true); renderActive(); });
      state.append(retry);
      root.append(state);
    }
    if (plan?.freshness === "stale") root.append(el(documentRef, "p", "status-text", "Showing your saved plan against the last valid operating model."));
    const selected = getActiveWorkspaceRoute()?.params?.get("sessionId");
    const sourceSessions = plan?.sessions || model.roadmap.sessions.map((session) => ({ ...session, state: "proposed", card: null }));
    const sessions = selected ? sourceSessions.filter((item) => item.id === selected) : sourceSessions;
    const list = el(documentRef, "section", "operating-model-list");
    for (const session of sessions) {
      const cardClass = `operating-model-row plan-session plan-${session.state || "proposed"}`;
      const card = el(documentRef, "article", cardClass);
      const state = session.state === "completed" ? "Completed" : session.state === "active" ? "Active" : "Proposed";
      card.append(
        el(documentRef, "span", "review-badge", state),
        el(documentRef, "h3", "", session.title),
        el(documentRef, "p", "", session.goal),
      );
      const meta = el(documentRef, "p", "operating-model-meta");
      meta.textContent = [
        humanModelDate(session.proposedDate),
        session.deliverables,
      ].filter(Boolean).join(" · ");
      card.append(meta);
      const details = el(documentRef, "dl", "operating-model-details");
      if (session.decisionsNeeded) {
        details.append(detail(documentRef, "Decisions for you", session.decisionsNeeded));
      }
      if (session.agentWork) {
        details.append(detail(documentRef, "Agent-preparable work", session.agentWork));
      }
      if (session.definitionOfDone) {
        details.append(detail(documentRef, "Definition of done", session.definitionOfDone));
      }
      if (details.children.length) card.append(details);
      if (selected) {
        card.append(openDocButton(session.documentId, "Open working session"));
        if (session.checklist?.length) {
          const preview = el(documentRef, "section", "plan-session-preview");
          preview.append(el(documentRef, "h4", "", "Checklist preview"));
          const checklist = el(documentRef, "ol", "");
          for (const task of session.checklist) {
            const item = el(documentRef, "li", "");
            item.append(el(documentRef, "strong", "", task.title));
            if (task.proof) item.append(el(documentRef, "span", "", `Proof: ${task.proof}`));
            checklist.append(item);
          }
          preview.append(checklist);
          card.append(preview);
        }
      }
      const actions = el(documentRef, "div", "plan-session-actions");
      if (session.card) {
        const open = el(documentRef, "button", "primary-button", "Open card");
        open.type = "button";
        open.addEventListener("click", () => navigateCanonicalWorkspace("/cards", { cardId: session.card.id }));
        actions.append(open);
      } else {
        const date = el(documentRef, "input", "plan-session-date");
        date.type = "date";
        date.value = session.proposedDate;
        date.setAttribute("aria-label", `Start date for ${session.id}`);
        const add = el(documentRef, "button", "primary-button", pendingSessions.has(session.id) ? "Adding…" : "Add to my plan");
        add.type = "button";
        add.disabled = pendingSessions.has(session.id) || planLoading || !plan;
        add.addEventListener("click", () => addSession(session, date.value));
        actions.append(date, add);
        if (!selected) {
          const focus = el(documentRef, "button", "quiet-button", "Open session");
          focus.type = "button"; focus.addEventListener("click", () => navigateCanonicalWorkspace("/my-plan", { sessionId: session.id }));
          actions.append(focus);
        }
      }
      card.append(actions);
      list.append(card);
    }
    if (selected) {
      const all = el(documentRef, "button", "quiet-button", "All sessions");
      all.type = "button"; all.addEventListener("click", () => navigateCanonicalWorkspace("/my-plan")); root.append(all);
    }
    root.append(list); replaceSurface(root);
  }

  function detail(documentRef, label, value) {
    const item = el(documentRef, "div", "operating-model-detail");
    item.append(el(documentRef, "dt", "", label), el(documentRef, "dd", "", value || "Not defined"));
    return item;
  }

  function renderActive() {
    const route = getActiveWorkspaceRoute();
    if (route?.view === "my-plan") renderMyPlan();
    else if (route?.view === "operating-model" && route.params.get("section")) renderSection(route.params.get("section"));
    else if (route?.view === "operating-model") renderOperatingModel();
  }
  return { renderOperatingModel, renderMyPlan };
}
