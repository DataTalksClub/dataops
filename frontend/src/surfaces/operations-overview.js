import { docsAvailabilityView } from "../core/operations-model.js";

export function createOperationsOverview(context) {
  const {
    document,
    labelizeWorkValue,
    openCardPanel,
    openDocument,
    openTaskPanel,
    resolveDocReference,
    showWorkspaceSurface,
    state,
    tasksSectionTitle,
  } = context;

  function operationsViewTitle(view, tasksSection) {
    if (view === "home") return "Today";
    if (view === "inbox") return "Inbox";
    if (view === "tasks") return tasksSectionTitle(tasksSection);
    if (view === "docs") return "Docs";
    if (view === "users") return "Users";
    if (view === "bookkeeping") return "Bookkeeping";
    if (view === "sponsors") return "Sponsors";
    if (view === "newsletter") return "Newsletter";
    if (view === "calendar") return "Calendar";
    if (view === "mailing-exports") return "Mailing exports";
    return "Home";
  }

  function surfaceDescription(view) {
    const descriptions = {
      queue:
        "Inspect tasks across cards by overdue, follow-up, waiting, missing proof, owner, source, and next action.",
      workflows:
        "Open active cards by stage, then inspect their tasks, proof, waiting, artifacts, and process context.",
      templates: "Create cards from reusable Templates.",
      recurring:
        "Create, edit, pause, and delete the schedules that generate recurring tasks.",
      assistants:
        "Card support jobs appear here only when the assistant job lifecycle is connected.",
      artifacts:
        "Review proof and operational outputs linked to cards and tasks.",
      processes:
        "SOPs, templates, and references are contextual support for work.",
      search:
        "Find Cards, Tasks, Artifacts, Assistant jobs, Templates, and Process Docs from one operator search.",
      admin:
        "Maintainer tools for process docs, content publishing, diagnostics, and configuration.",
    };
    return descriptions[view] || "";
  }

  function countLabel(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function referenceCountLabel(category, count) {
    const singular =
      {
        cards: "card",
        tasks: "task",
        recurrences: "recurrence",
        schedules: "schedule",
        calendar: "calendar item",
        notifications: "notification",
      }[category] || category;
    return countLabel(count, singular, category);
  }

  function surfaceStatusText(view, model) {
    if (view === "assistants") {
      return state.assistantSnapshot.loaded
        ? `${countLabel(state.assistantSnapshot.jobs.length, "assistant job")}.`
        : "Assistant jobs not connected.";
    }
    if (view === "artifacts") {
      return state.artifactSnapshot.loaded
        ? `${countLabel(state.artifactSnapshot.artifacts.length, "artifact")} indexed.`
        : "Artifact index not connected.";
    }
    if (view === "processes") {
      return state.qualitySnapshot.loaded
        ? `${countLabel(state.qualitySnapshot.findings.length, "process quality finding")}.`
        : "Process quality report unavailable.";
    }
    if (view === "search") return "Unified operator search.";
    return "Card and task workspace.";
  }

  function renderSurfaceHeader(titleText, descriptionText) {
    const header = document.createElement("section");
    header.className = "ops-surface-header";
    const title = document.createElement("h3");
    title.textContent = titleText;
    const description = document.createElement("p");
    description.textContent = descriptionText;
    header.append(title, description);
    return header;
  }

  function renderHonestState(titleText, bodyText) {
    const state = document.createElement("div");
    state.className = "ops-honest-state";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const body = document.createElement("span");
    body.textContent = bodyText;
    state.append(title, body);
    return state;
  }

  /**
   * The one renderer for process-document availability.
   *
   * Every surface that must tell an outage from an empty corpus renders this
   * node from the shared snapshot: an unreachable corpus carries the server's
   * own message verbatim, an answered-but-empty corpus says so in different
   * words, and a snapshot that is still loading renders nothing at all.
   */
  function renderDocsAvailabilityState(snapshot, options = {}) {
    const view = docsAvailabilityView(snapshot, options);
    if (!view) return null;
    const node = renderHonestState(view.title, view.body);
    node.classList.add("ops-docs-state");
    node.dataset.docsState = view.docsState;
    node.setAttribute("aria-label", "Process document availability");
    const detail = document.createElement("small");
    detail.className = "ops-docs-state-detail";
    detail.textContent = view.detail;
    node.append(detail);
    return node;
  }

  async function refreshOperationsRecurringSnapshot(options = {}) {
    const snapshot = emptyOperationsRecurringSnapshot();
    try {
      const payload = await request(workApiUrl("/api/recurring"));
      snapshot.loaded = true;
      snapshot.recurringConfigs = recurringConfigsFromPayload(payload);
    } catch (err) {
      snapshot.errors = [err?.message || "Recurring API request failed"];
    }
    operationsRecurringSnapshot =
      normalizeOperationsRecurringSnapshot(snapshot);
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
  }

  function isOperationsHomeVisible() {
    return (
      body.dataset.view === "library" &&
      !knowledgeState.selectedFolder &&
      !searchInput.value.trim()
    );
  }

  function workApiUrl(path, params = {}) {
    const url = apiUrl(`/work${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "")
        url.searchParams.set(key, String(value));
    }
    return url;
  }

  function allWorkTasks(work = operationsWorkSnapshot) {
    return dedupeWorkTasks([
      ...tasksFromWorkPayload(work.todayTasks || []),
      ...tasksFromWorkPayload(work.overdueTasks || []),
      ...tasksFromWorkPayload(work.waitingTasks || []),
      ...Object.values(work.cardTasks || {}).flatMap((tasks) =>
        tasksFromWorkPayload(tasks),
      ),
    ]);
  }

  // ---------- Quick create: ad-hoc task and workflow ----------

  function renderOperationsRuntimeState(runtime) {
    const errors = Array.isArray(runtime?.errors)
      ? runtime.errors.filter(Boolean)
      : [];
    if (runtime?.connected && errors.length === 0) return null;

    const section = document.createElement("section");
    section.className = "ops-runtime-state";
    section.setAttribute("aria-label", "Runtime data state");

    const title = document.createElement("strong");
    title.textContent = runtime?.connected
      ? "Live work data is partially unavailable"
      : "Live work data unavailable";
    const body = document.createElement("span");
    body.textContent = runtime?.connected
      ? "Some /work/api calls failed. Loaded tasks remain visible, and unavailable parts are not replaced with fake data."
      : "Operations Home could not load Card and Task data. Templates and internal Processes remain available from their dedicated views.";
    section.append(title, body);

    if (errors.length > 0) {
      const list = document.createElement("ul");
      for (const error of errors.slice(0, 3)) {
        const item = document.createElement("li");
        item.textContent = String(error);
        list.append(item);
      }
      section.append(list);
    }

    return section;
  }

  function renderOperationsFutureSections(sections) {
    const wrap = document.createElement("section");
    wrap.className = "ops-section ops-future-section";
    wrap.setAttribute("aria-label", "Future operations inputs");

    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Incoming And Quality Signals";
    const meta = document.createElement("span");
    meta.textContent = "No fake data";
    header.append(title, meta);
    wrap.append(header);

    const grid = document.createElement("div");
    grid.className = "ops-future-grid";
    for (const section of sections || []) {
      const card = document.createElement("article");
      card.className = "ops-future-card";
      const cardTitle = document.createElement("strong");
      cardTitle.textContent = section.title;
      const status = document.createElement("small");
      status.textContent = section.status;
      const body = document.createElement("span");
      body.textContent = section.body;
      card.append(cardTitle, status, body);
      grid.append(card);
    }
    wrap.append(grid);
    return wrap;
  }

  function renderProcessQualityHomeSection(quality) {
    const section = document.createElement("section");
    section.className = "ops-section ops-process-quality";
    section.setAttribute("aria-label", "Process quality");

    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Process Quality";
    const meta = document.createElement("span");
    if (!quality.loaded) meta.textContent = "Report unavailable";
    else if (quality.activeWorkLoaded)
      meta.textContent = `${quality.activeBlockingCount} active blockers`;
    else meta.textContent = "Active impact unknown";
    header.append(title, meta);

    const drilldown = document.createElement("button");
    drilldown.type = "button";
    drilldown.className = "ops-quick-btn";
    drilldown.textContent = "Open drill-down";
    drilldown.addEventListener("click", () =>
      showWorkspaceSurface("processes"),
    );
    header.append(drilldown);
    section.append(header);

    if (!quality.loaded) {
      section.append(
        renderHonestState(
          "Process quality could not load",
          quality.errors[0] || "Validation could not run in this environment.",
        ),
      );
      return section;
    }
    if (!quality.activeWorkLoaded) {
      section.append(
        renderHonestState(
          "Active-work impact cannot be confirmed",
          "Live Task and Card data is unavailable. Template and Process Doc findings below are maintainer warnings, not confirmed production blockers.",
        ),
      );
    } else if (quality.activeFindings.length === 0) {
      section.append(
        renderHonestState(
          "No active process blockers",
          "Loaded Tasks and active Cards have no unresolved internal Process Doc or proof-guidance blockers.",
        ),
      );
    }

    const list = document.createElement("div");
    list.className = "ops-quality-list";
    const findings = quality.visibleHomeFindings;
    if (findings.length === 0) {
      list.append(
        renderHonestState(
          "No process quality findings",
          "The deterministic report returned no findings for Templates or Process Docs.",
        ),
      );
    } else {
      for (const finding of findings) {
        const displayFinding = quality.activeWorkLoaded
          ? finding
          : {
              ...finding,
              severity:
                finding.severity === "blocking" ? "warning" : finding.severity,
            };
        list.append(renderQualityFindingRow(displayFinding));
      }
    }
    section.append(list);
    return section;
  }

  function renderQualityFindingRow(finding) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `ops-quality-row ops-quality-${finding.severity || "warning"}`;
    row.addEventListener("click", () => openQualityFinding(finding));

    const head = document.createElement("div");
    head.className = "ops-quality-row-head";
    const title = document.createElement("strong");
    title.textContent = finding.title;
    const severity = document.createElement("span");
    severity.textContent = labelizeWorkValue(finding.severity || "warning");
    head.append(title, severity);

    const summary = document.createElement("small");
    summary.textContent =
      finding.summary || finding.docPath || finding.instructionDocId || "";

    const meta = document.createElement("div");
    meta.className = "ops-queue-meta";
    for (const value of [
      finding.category,
      finding.workflowSlug || finding.templateId,
      finding.taskId ? `task ${finding.taskId}` : "",
      finding.docPath || finding.docId || finding.instructionDocId,
      finding.nextAction,
    ]
      .filter(Boolean)
      .slice(0, 5)) {
      const chip = document.createElement("span");
      chip.textContent = value;
      meta.append(chip);
    }
    row.append(head, summary, meta);
    return row;
  }

  function openQualityFinding(finding) {
    if (finding.taskId) {
      openTaskPanel(finding.taskId);
      return;
    }
    if (finding.cardId) {
      openCardPanel(finding.cardId);
      return;
    }
    const doc = finding.docPath
      ? { path: finding.docPath }
      : resolveDocReference(finding.docId || finding.instructionDocId);
    if (doc?.path) {
      openDocument(doc.path, {
        returnContext: finding.cardId
          ? {
              type: "workflow",
              id: finding.cardId,
              title: finding.workflowSlug || finding.templateId,
            }
          : null,
      });
      return;
    }
    if (finding.workflowSlug || finding.templateId)
      showWorkspaceSurface("templates");
  }

  function renderOperationalSurfaceStates() {
    const wrap = document.createElement("section");
    wrap.className = "ops-section ops-future-section";
    wrap.setAttribute("aria-label", "Operational surface states");
    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Assistant, Artifact, Inbox, And Search States";
    const meta = document.createElement("span");
    meta.textContent = "Honest availability";
    header.append(title, meta);
    wrap.append(header);

    const grid = document.createElement("div");
    grid.className = "ops-future-grid";
    const states = [
      state.assistantSnapshot.loaded
        ? [
            "Assistants",
            `${state.assistantSnapshot.jobs.length} real job rows loaded.`,
          ]
        : [
            "Assistants",
            "Not connected; #30/#44 job lifecycle is not represented with fake rows.",
          ],
      state.artifactSnapshot.loaded
        ? [
            "Artifacts",
            `${state.artifactSnapshot.artifacts.length} artifact rows loaded from /work/api/artifacts.`,
          ]
        : [
            "Artifacts",
            "Cross-workflow artifact index not connected; task/workflow artifacts still appear in context.",
          ],
      [
        "Inbox",
        "Not connected; #31 raw Telegram/email/manual intake is not represented with fake rows.",
      ],
      [
        "Search",
        "Connected through /search with partial-source states when work APIs are unavailable.",
      ],
    ];
    for (const [stateTitle, stateBody] of states) {
      const card = document.createElement("article");
      card.className = "ops-future-card";
      const strong = document.createElement("strong");
      strong.textContent = stateTitle;
      const status = document.createElement("small");
      status.textContent =
        stateBody.startsWith("Not connected") ||
        stateBody.startsWith("Docs-only")
          ? "Not connected yet"
          : "Connected";
      const body = document.createElement("span");
      body.textContent = stateBody;
      card.append(strong, status, body);
      grid.append(card);
    }
    wrap.append(grid);
    return wrap;
  }

  function renderOperationsLane(lane) {
    const section = document.createElement("section");
    section.className = `ops-lane ops-lane-${lane.id}`;
    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = lane.title;
    const count = document.createElement("span");
    count.textContent = String(lane.items.length);
    header.append(title, count);
    section.append(header);

    const list = document.createElement("div");
    list.className = "ops-lane-list";
    if (lane.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ops-empty";
      empty.textContent = lane.empty;
      list.append(empty);
    } else {
      for (const item of lane.items.slice(0, 6))
        list.append(renderOperationsLaneItem(item));
    }
    section.append(list);
    return section;
  }

  function renderOperationsLaneItem(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-lane-item";
    if (item.risk) button.classList.add(`ops-risk-${item.risk}`);
    if (item.path) {
      button.addEventListener("click", () => openDocument(item.path));
    } else if (item.taskId) {
      button.addEventListener("click", () => openTaskPanel(item.taskId));
    } else if (item.cardId) {
      button.addEventListener("click", () => openCardPanel(item.cardId));
    } else {
      button.disabled = true;
    }
    const title = document.createElement("strong");
    title.textContent = item.title;
    const summary = document.createElement("span");
    summary.textContent = item.summary || item.path || "";
    const meta = document.createElement("small");
    meta.textContent = item.meta || "";
    button.append(title, summary);
    if (item.nextAction) {
      const action = document.createElement("small");
      action.className = "ops-next-action";
      action.textContent = item.nextAction;
      button.append(action);
    }
    if (item.progress) {
      const progress = document.createElement("div");
      progress.className = "ops-progress";
      progress.setAttribute("aria-label", item.progress.label);
      const bar = document.createElement("i");
      bar.style.width = `${Math.max(0, Math.min(100, item.progress.percent || 0))}%`;
      progress.append(bar);
      button.append(progress);
    }
    button.append(meta);
    return button;
  }

  function renderOperationsReference(ref) {
    const el = ref.path
      ? document.createElement("button")
      : document.createElement("a");
    el.className = "ops-reference-link";
    if (ref.path) {
      el.type = "button";
      el.addEventListener("click", () => openDocument(ref.path));
    } else {
      el.href = ref.href;
      el.target = "_blank";
      el.rel = "noopener";
    }
    const title = document.createElement("strong");
    title.textContent = ref.title;
    const summary = document.createElement("span");
    summary.textContent = ref.summary || "";
    el.append(title, summary);
    return el;
  }

  return {
    countLabel,
    openQualityFinding,
    operationsViewTitle,
    referenceCountLabel,
    renderDocsAvailabilityState,
    renderHonestState,
    renderOperationalSurfaceStates,
    renderOperationsFutureSections,
    renderOperationsLane,
    renderOperationsLaneItem,
    renderOperationsReference,
    renderOperationsRuntimeState,
    renderProcessQualityHomeSection,
    renderQualityFindingRow,
    renderSurfaceHeader,
    surfaceDescription,
    surfaceStatusText,
  };
}
