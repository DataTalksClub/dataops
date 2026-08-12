export function createWorkDetailSurface(context) {
  const {
    addDaysIso,
    body,
    buildTaskProcessQualityFindings,
    escapeHtml,
    fetchResource,
    FOCUSABLE_SELECTOR,
    formatTaskDateMeta,
    getActiveTasksSection,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    getAllDocuments,
    getCurrentOperator,
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkBundle,
    isOpenWorkTask,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    localDocPathFromHref,
    navigateCanonicalWorkspace,
    openDocument,
    openQualityFinding,
    parseWorkspaceHash,
    promptUser,
    refreshDocuments,
    refreshOperationsWorkSnapshot,
    refreshWorkBell,
    renderEntityLoadState,
    renderHonestState,
    renderTasksSurface,
    reportError,
    request,
    scheduleAnimationFrame,
    setStatus,
    settledPayload,
    showUndoToast,
    state,
    summarizeBundleProgress,
    taskDate,
    taskProofState,
    taskRequiresApprovedArtifact,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workBundleTitle,
    workTaskTitle,
    workflowTaskGroups,
    taskPanel,
    taskPanelTitle,
    taskPanelBody,
    taskPanelClose,
    bundlePanel,
    bundlePanelTitle,
    bundlePanelBody,
    bundlePanelClose,
  } = context;

  let activeTaskPanelId = null;
  let activeTaskPanelTask = null;
  let activeTaskPanelArtifacts = [];
  let activeBundlePanelId = null;
  let activeBundlePanelData = null;
  let taskRouteContext = emptyTaskRouteContext();

  function findWorkTaskInSnapshot(taskId) {
    const snap = state.workSnapshot;
    const pools = [
      ...tasksFromWorkPayload(snap.todayTasks || []),
      ...tasksFromWorkPayload(snap.overdueTasks || []),
      ...tasksFromWorkPayload(snap.waitingTasks || []),
    ];
    for (const task of pools) {
      if (task && task.id === taskId) return task;
    }
    for (const tasks of Object.values(snap.bundleTasks || {})) {
      for (const task of tasksFromWorkPayload(tasks)) {
        if (task && task.id === taskId) return task;
      }
    }
    return null;
  }

  function taskRouteParams(taskId) {
    const route = parseWorkspaceHash();
    if (route && !route.invalid && route.path === "/tasks") {
      const params = new URLSearchParams(route.params);
      params.set("taskId", taskId);
      return { path: "/tasks", params };
    }
    if (activeBundlePanelId) {
      const path =
        getActiveWorkspaceRoute()?.path === "/cards/archive"
          ? "/cards/archive"
          : "/cards";
      return { path, params: { cardId: activeBundlePanelId, taskId } };
    }
    return { path: "/tasks", params: { taskId } };
  }

  function openTaskPanel(taskId, options = {}) {
    let target = taskRouteParams(taskId);
    if (options.preserveBundle && options.expectedBundleId) {
      const expected = state.workSnapshot.bundlesById?.get(
        options.expectedBundleId,
      );
      const path = isArchivedWorkBundle(expected) ? "/cards/archive" : "/cards";
      target = { path, params: { cardId: options.expectedBundleId, taskId } };
    }
    return navigateCanonicalWorkspace(target.path, target.params).ready;
  }

  async function hydrateTaskPanel(taskId, token, options = {}) {
    try {
      const payload = await request(
        workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`),
      );
      if (!isWorkspaceRouteFresh(token) || activeTaskPanelId !== taskId) return;
      const fetched =
        payload && typeof payload === "object" && payload.id ? payload : null;
      if (
        options.expectedBundleId &&
        fetched &&
        fetched.bundleId !== options.expectedBundleId
      ) {
        activeTaskPanelTask = null;
        activeTaskPanelArtifacts = [];
        renderEntityLoadState(taskPanelBody, {
          kind: "task/card",
          id: taskId,
          status: "mismatch",
          error: `Task belongs to card ${fetched.bundleId || "none"}, not ${options.expectedBundleId}.`,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => closeTaskPanel(),
        });
        taskPanelTitle.textContent = "Task/card mismatch";
        return;
      }
      if (fetched) {
        activeTaskPanelTask = fetched;
        activeTaskPanelArtifacts = [];
        renderTaskPanel();
      }
      const artifacts = fetched ? await loadArtifactsForTask(fetched) : [];
      if (
        !isWorkspaceRouteFresh(token) ||
        activeTaskPanelId !== taskId ||
        activeTaskPanelTask?.id !== fetched?.id
      )
        return;
      activeTaskPanelArtifacts = artifacts;
      renderTaskPanel();
    } catch (err) {
      if (isWorkspaceRouteFresh(token) && activeTaskPanelId === taskId) {
        taskPanelTitle.textContent =
          err.status === 404 ? "Task not found" : "Task unavailable";
        renderEntityLoadState(taskPanelBody, {
          kind: "task",
          id: taskId,
          status: err.status === 404 ? "not-found" : "error",
          error: err.message,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => closeTaskPanel(),
        });
      }
    }
  }

  function closeTaskPanel(options = {}) {
    const route = parseWorkspaceHash();
    if (
      options.updateUrl === false ||
      !route ||
      route.invalid ||
      !route.params.has("taskId")
    ) {
      resetTaskPanel();
      return;
    }
    if (route.params.has("taskId")) {
      const taskId = route.params.get("taskId");
      const params = new URLSearchParams(route.params);
      params.delete("taskId");
      return navigateCanonicalWorkspace(route.path, params, {
        restoreFocus: {
          kind: "task",
          id: taskId,
          surface:
            route.path === "/cards" || route.path === "/cards/archive"
              ? "workflows"
              : "tasks",
        },
      }).ready;
    }
  }

  // Task detail can sit above workflow detail, so one handler selects the
  // top-most entity dialog. This prevents one Escape event from closing both
  // canonical route layers and keeps Tab/Shift+Tab inside the active dialog.
  function handleWorkspaceEntityModalKeydown(event) {
    if (event.defaultPrevented) return;
    const activePanel = !taskPanel.hidden
      ? taskPanel.querySelector(".task-modal-panel")
      : !bundlePanel.hidden
        ? bundlePanel.querySelector(".workflow-modal-panel")
        : null;
    if (!activePanel) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!taskPanel.hidden) closeTaskPanel();
      else closeBundlePanel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [
      ...activePanel.querySelectorAll(FOCUSABLE_SELECTOR),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !activePanel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !activePanel.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  function renderTaskPanel() {
    const task = activeTaskPanelTask;
    taskPanelTitle.textContent = task ? workTaskTitle(task) : "Task";
    taskPanelBody.replaceChildren();
    if (!task) return;

    const status = String(task.status || "todo").toLowerCase();
    const today = todayIsoDate();

    const routeContextParts = [
      taskRouteContext.date ? `Queue date ${taskRouteContext.date}` : "",
      taskRouteContext.bundleId
        ? `Filtered to card ${taskRouteContext.filterBundle?.title || taskRouteContext.bundleId}`
        : "",
      taskRouteContext.contextBundleId
        ? `Return to ${taskRouteContext.contextBundle?.title || taskRouteContext.contextBundleId}`
        : "",
    ].filter(Boolean);
    if (routeContextParts.length > 0) {
      const routeContext = document.createElement("section");
      routeContext.className = "task-panel-route-context";
      routeContext.setAttribute("aria-label", "Queue context");
      const heading = document.createElement("strong");
      heading.textContent = "Queue context";
      const description = document.createElement("p");
      description.textContent = routeContextParts.join(" · ");
      routeContext.append(heading, description);
      taskPanelBody.append(routeContext);
    }

    const actor = getCurrentOperator();
    const assignee = task.assigneeId
      ? state.workSnapshot.usersById?.get(task.assigneeId)
      : null;
    if (actor && assignee && String(actor.id) !== String(assignee.id)) {
      const delegation = document.createElement("section");
      delegation.className = "task-delegation-notice";
      const heading = document.createElement("strong");
      heading.textContent = `Working on ${assignee.name || "a teammate"}’s task`;
      const description = document.createElement("p");
      description.textContent = `You remain signed in as ${actor.name || "yourself"}. ${assignee.name || "Your teammate"} stays assigned.`;
      delegation.append(heading, description);
      taskPanelBody.append(delegation);
    }

    const meta = document.createElement("div");
    meta.className = "task-detail-meta";
    const badge = document.createElement("span");
    badge.className = `task-status-badge ${status}`;
    badge.textContent = status;
    meta.append(badge);
    if (task.date) {
      const dateRow = document.createElement("div");
      dateRow.append(
        document.createTextNode("Due "),
        formatMetaDate(task.date, today),
      );
      meta.append(dateRow);
    }
    if (task.bundleId) {
      const bundleRow = document.createElement("div");
      bundleRow.append(document.createTextNode("Card "));
      const link = document.createElement("button");
      link.type = "button";
      link.className = "task-instruction-doc-link";
      link.textContent = resolveBundleLabel(task.bundleId);
      link.addEventListener("click", () => navigateTaskToWorkflow(task));
      bundleRow.append(link);
      meta.append(bundleRow);
    }
    if (task.assigneeId) {
      const assigneeRow = document.createElement("div");
      assigneeRow.append(
        document.createTextNode("Assignee "),
        formatMetaText(resolveAssigneeLabel(task.assigneeId)),
      );
      meta.append(assigneeRow);
    }
    taskPanelBody.append(meta);
    const taskQuality = taskProcessQualityFindings(task);
    if (taskQuality.length > 0)
      taskPanelBody.append(renderTaskQualityNotice(taskQuality));

    // Required link field
    if (task.requiredLinkName) {
      const wrap = document.createElement("div");
      wrap.className = "task-required-link";
      const label = document.createElement("label");
      label.textContent = `${task.requiredLinkName}`;
      const input = document.createElement("input");
      input.type = "url";
      input.value = task.link || "";
      input.placeholder = "https://...";
      input.addEventListener("change", () =>
        saveTaskLink(task.id, input.value.trim()),
      );
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        }
      });
      label.append(input);
      wrap.append(label);
      taskPanelBody.append(wrap);
    }

    // Waiting/follow-up info
    if (status === "waiting") {
      const waiting = document.createElement("div");
      waiting.className = "task-detail-meta";
      if (task.waitingFor) {
        const row = document.createElement("div");
        row.append(
          document.createTextNode("Waiting for "),
          formatMetaText(task.waitingFor),
        );
        waiting.append(row);
      }
      if (task.followUpAt) {
        const row = document.createElement("div");
        row.append(
          document.createTextNode("Follow up "),
          formatMetaDate(task.followUpAt, today),
        );
        waiting.append(row);
      }
      taskPanelBody.append(waiting);
    }

    // Actions
    const actions = document.createElement("div");
    actions.className = "task-action-group";
    if (status === "done") {
      const reopen = createTaskActionButton("Reopen", () =>
        updateTaskStatus(task.id, "todo"),
      );
      reopen.classList.add("is-primary");
      actions.append(reopen);
    } else if (status === "waiting") {
      const response = createTaskActionButton("Response received", () =>
        recordTaskResponseReceived(task.id),
      );
      response.classList.add("is-primary");
      actions.append(response);

      const followRow = document.createElement("div");
      followRow.className = "task-follow-up-row";
      const nextLabel = document.createElement("label");
      nextLabel.textContent = "Next";
      const nextInput = document.createElement("input");
      nextInput.type = "date";
      nextInput.value = defaultNextFollowUpDate();
      nextLabel.append(nextInput);
      followRow.append(nextLabel);
      const followUp = createTaskActionButton("Follow-up sent", () =>
        recordTaskFollowUpSent(task.id, nextInput.value),
      );
      followRow.append(followUp);
      actions.append(followRow);
    } else {
      const missingLink = task.requiredLinkName && !task.link;
      const missingFile = task.requiresFile && !activeTaskPanelTask?._hasFiles;
      const missingArtifact =
        taskRequiresApprovedArtifact(task) &&
        !hasApprovedArtifactEvidence(task, activeTaskPanelArtifacts);
      const canComplete = !missingLink && !missingFile && !missingArtifact;
      const complete = createTaskActionButton("Mark done", () =>
        updateTaskStatus(task.id, "done"),
      );
      complete.classList.add("is-primary");
      if (!canComplete) {
        complete.disabled = true;
        const reasons = [];
        if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
        if (missingFile) reasons.push("Upload required file");
        if (missingArtifact) reasons.push("Approve an attached artifact");
        complete.title = reasons.join("; ");
      }
      actions.append(complete);

      const markWaiting = createTaskActionButton("Mark waiting", () =>
        markTaskWaiting(task.id),
      );
      actions.append(markWaiting);
    }
    // File upload for required-file tasks
    renderTaskFileSection(task);
    renderTaskArtifactSection(task);

    taskPanelBody.append(actions);

    // History / comment. New transitions use the backend's atomic task-action
    // contract and return structured history; legacy comment history remains
    // visible for records created before that contract.
    const structuredHistory = Array.isArray(task.taskHistory)
      ? task.taskHistory.map((event) => {
          const labels = {
            "waiting-started": `Marked waiting for ${event.waitingFor || "a response"}${event.followUpAt ? `; follow up ${String(event.followUpAt).slice(0, 10)}` : ""}`,
            "follow-up-sent": `Follow-up sent${event.followUpAt ? `; next follow-up ${String(event.followUpAt).slice(0, 10)}` : ""}`,
            "response-received": "Response received",
            unblocked: "Task unblocked",
            "wait-resolved": "Wait resolved",
            completed: "Task completed",
            reopened: "Task reopened",
          };
          const label =
            labels[event.action] ||
            labelizeWorkValue(event.action || "updated");
          const detail =
            event.note && event.note !== label ? ` — ${event.note}` : "";
          return `[${event.createdAt || task.updatedAt || new Date().toISOString()}] ${label}${detail}`;
        })
      : [];
    const legacyHistory = task.comment
      ? String(task.comment).split("\n").filter(Boolean)
      : [];
    const historyLines = [...legacyHistory, ...structuredHistory];
    if (historyLines.length) {
      const history = document.createElement("div");
      history.className = "task-history";
      const historyLabel = document.createElement("div");
      historyLabel.className = "task-history-label";
      historyLabel.textContent = "History";
      history.append(historyLabel);
      const list = document.createElement("div");
      list.className = "task-history-list";
      for (const line of historyLines) {
        const event = document.createElement("div");
        event.className = "task-history-event";
        event.append(...formatHistoryLine(line));
        list.append(event);
      }
      history.append(list);
      taskPanelBody.append(history);
    }

    // Instructions link
    if (task.instructionDocId) {
      taskPanelBody.append(renderTaskInstructionDoc(task));
    } else if (task.instructionsUrl) {
      const instructions = document.createElement("div");
      instructions.className = "task-detail-meta";
      const link = document.createElement("a");
      link.href = String(task.instructionsUrl);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open instructions";
      instructions.append(link);
      taskPanelBody.append(instructions);
    }
  }

  function renderTaskInstructionDoc(task) {
    const instruction = document.createElement("div");
    instruction.className = "task-instruction-doc";
    const docId = String(task.instructionDocId || "");
    const doc = resolveDocReference(docId);

    const label = document.createElement("div");
    label.className = "task-history-label";
    label.textContent = "Process doc";
    instruction.append(label);

    if (doc) {
      const title = document.createElement("button");
      title.type = "button";
      title.className = "task-instruction-doc-link";
      title.textContent = doc.title || doc.id || doc.path;
      title.addEventListener("click", () =>
        openDocument(doc.path, {
          returnContext: {
            type: "task",
            id: task.id,
            title:
              typeof workTaskTitle === "function"
                ? workTaskTitle(task)
                : task.description || task.title || task.id || "Task",
          },
        }),
      );
      instruction.append(title);

      const meta = document.createElement("div");
      meta.className = "task-detail-meta";
      const docMeta = [doc.doc_type, doc.path].filter(Boolean).join(" - ");
      if (docMeta) meta.append(document.createTextNode(docMeta));
      if (doc.summary) {
        const summary = document.createElement("span");
        summary.textContent = doc.summary;
        meta.append(summary);
      }
      instruction.append(meta);
    } else {
      const missing = document.createElement("div");
      missing.className = "task-detail-meta";
      missing.textContent = `Document unavailable: ${docId}`;
      instruction.append(missing);
    }

    if (
      task.phase ||
      task.instructionStepId ||
      (Array.isArray(task.systems) && task.systems.length > 0)
    ) {
      const context = document.createElement("div");
      context.className = "task-detail-meta";
      if (task.phase) {
        const phase = document.createElement("span");
        phase.textContent = `Phase: ${task.phase}`;
        context.append(phase);
      }
      if (task.instructionStepId) {
        const step = document.createElement("span");
        step.textContent = `Step: ${task.instructionStepId}`;
        context.append(step);
      }
      if (Array.isArray(task.systems) && task.systems.length > 0) {
        const systems = document.createElement("div");
        systems.className = "ops-card-chips";
        for (const system of task.systems) {
          const chip = document.createElement("small");
          chip.textContent = system;
          systems.append(chip);
        }
        context.append(systems);
      }
      instruction.append(context);
    }

    if (task.validation) {
      const validation = document.createElement("div");
      validation.className = "task-detail-meta";
      validation.append(
        document.createTextNode("Validation "),
        formatValidationInstruction(task.validation),
      );
      instruction.append(validation);
    }

    return instruction;
  }

  function taskProcessQualityFindings(task) {
    return buildTaskProcessQualityFindings(task, state.qualitySnapshot);
  }

  function renderTaskQualityNotice(findings) {
    const notice = document.createElement("div");
    notice.className = "task-quality-notice";
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.textContent = `Process quality risk (${findings.length})`;
    notice.append(label);
    for (const finding of findings.slice(0, 3)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `task-quality-row ops-quality-${finding.severity}`;
      row.addEventListener("click", () => openQualityFinding(finding));
      const title = document.createElement("strong");
      title.textContent = finding.title;
      const summary = document.createElement("span");
      summary.textContent = finding.summary;
      row.append(title, summary);
      notice.append(row);
    }
    return notice;
  }

  function formatValidationInstruction(validation) {
    if (typeof validation === "string") return formatMetaText(validation);
    if (!validation || typeof validation !== "object")
      return formatMetaText("");
    const parts = [];
    if (validation.requiredEvidence)
      parts.push(`Required evidence: ${validation.requiredEvidence}`);
    if (validation.acceptance) parts.push(String(validation.acceptance));
    if (parts.length === 0) parts.push(JSON.stringify(validation));
    return formatMetaText(parts.join(" - "));
  }

  function renderTaskFileSection(task) {
    if (!task.requiresFile && !task.id) return;
    const section = document.createElement("div");
    section.className = "task-required-link";

    const label = document.createElement("label");
    label.textContent = task.requiresFile ? "Required file" : "Attach file";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0])
        uploadTaskFile(task.id, fileInput.files[0]);
    });
    label.append(fileInput);
    section.append(label);

    // Show existing files
    const fileList = document.createElement("div");
    fileList.className = "task-file-list";
    section.append(fileList);

    taskPanelBody.append(section);
    loadTaskFiles(task.id, fileList);
  }

  async function loadTaskFiles(taskId, container) {
    try {
      const payload = await request(workApiUrl("/api/files", { taskId }));
      const files = Array.isArray(payload) ? payload : payload.files || [];
      const hasActiveTask =
        activeTaskPanelTask && activeTaskPanelTask.id === taskId;
      const hadFiles = Boolean(hasActiveTask && activeTaskPanelTask._hasFiles);
      container.replaceChildren();
      if (files.length === 0) {
        if (hasActiveTask) activeTaskPanelTask._hasFiles = false;
        if (hadFiles && activeTaskPanelId === taskId) {
          renderTaskPanel();
          return;
        }
        const empty = document.createElement("small");
        empty.className = "task-file-empty";
        empty.textContent = "No files attached.";
        container.append(empty);
        return;
      }
      if (hasActiveTask) {
        activeTaskPanelTask._hasFiles = true;
        if (!hadFiles && activeTaskPanelId === taskId) {
          renderTaskPanel();
          return;
        }
      }
      for (const file of files) {
        const item = document.createElement("div");
        item.className = "task-file-item";
        const name = document.createElement("span");
        name.textContent = file.filename || file.id;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "quiet-button task-file-remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", () =>
          removeTaskFile(file.id, taskId, container),
        );
        item.append(name, remove);
        container.append(item);
      }
    } catch {
      container.replaceChildren();
      const empty = document.createElement("small");
      empty.className = "task-file-empty";
      empty.textContent = "Could not load files.";
      container.append(empty);
    }
  }

  async function loadArtifactsForTask(task) {
    const results = await Promise.allSettled([
      request(workApiUrl("/api/artifacts", { taskId: task.id })),
      task.bundleId
        ? request(workApiUrl("/api/artifacts", { bundleId: task.bundleId }))
        : Promise.resolve({ artifacts: [] }),
    ]);
    const artifacts = [];
    for (const result of results) {
      const payload = settledPayload(result);
      if (payload && Array.isArray(payload.artifacts))
        artifacts.push(...payload.artifacts);
    }
    return dedupeArtifacts(artifacts);
  }

  async function loadArtifactsForBundle(bundleId) {
    const payload = await request(workApiUrl("/api/artifacts", { bundleId }));
    return dedupeArtifacts(
      Array.isArray(payload?.artifacts) ? payload.artifacts : [],
    );
  }

  function renderTaskArtifactSection(task) {
    taskPanelBody.append(
      renderArtifactList({
        ownerType: "task",
        ownerId: task.id,
        artifacts: activeTaskPanelArtifacts,
        required: taskRequiresApprovedArtifact(task),
        onRefresh: () => refreshTaskPanel(task.id),
      }),
    );
  }

  async function uploadTaskFile(taskId, file) {
    const formData = new FormData();
    formData.append("taskId", taskId);
    formData.append("category", "document");
    formData.append("file", file);
    try {
      const response = await fetchResource(workApiUrl("/api/files"), {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const text = await response.text();
        let msg = `HTTP ${response.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {}
        reportError(`Upload failed: ${msg}`);
        return;
      }
      await response.json();
      if (activeTaskPanelTask) activeTaskPanelTask._hasFiles = true;
      renderTaskPanel();
    } catch (err) {
      reportError(`Upload failed: ${err.message || "request failed"}`);
    }
  }

  async function removeTaskFile(fileId, taskId, container) {
    try {
      const url = workApiUrl(`/api/files/${encodeURIComponent(fileId)}`);
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        reportError(`Could not remove file: HTTP ${response.status}`);
        return;
      }
      loadTaskFiles(taskId, container);
    } catch (err) {
      reportError(`Could not remove file: ${err.message || "request failed"}`);
    }
  }

  function formatMetaDate(value, today) {
    const strong = document.createElement("strong");
    strong.textContent =
      formatTaskDateMeta(value, today) || String(value || "").slice(0, 10);
    return strong;
  }

  function formatMetaText(value) {
    const strong = document.createElement("strong");
    strong.textContent = String(value || "");
    return strong;
  }

  // Resolve bundle/user ids to human-readable labels for the task detail meta
  // rows. Exact route-owned bundle responses take precedence over the coarse
  // work snapshot, which can still be hydrating on a fresh deep link. The route
  // context and active bundle data are both token-guarded before assignment.
  function resolveBundleLabel(bundleId) {
    if (!bundleId) return "Open card";
    const exactBundles = [
      taskRouteContext.filterBundle,
      taskRouteContext.contextBundle,
      activeBundlePanelData?.bundle,
    ];
    const exact = exactBundles.find((candidate) => candidate?.id === bundleId);
    if (exact?.title) return exact.title;
    const bundle = state.workSnapshot.bundlesById?.get(bundleId);
    if (bundle && bundle.title) return bundle.title;
    return "Open card";
  }

  function resolveAssigneeLabel(assigneeId) {
    if (!assigneeId) return "—";
    const user = state.workSnapshot.usersById?.get(assigneeId);
    if (user && user.name) return user.name;
    return "—";
  }

  function formatHistoryLine(line) {
    // Lines are "[timestamp] event text"; render the stamp as code, rest as text.
    const match = String(line).match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match) return [document.createTextNode(line)];
    const stamp = document.createElement("code");
    stamp.textContent = match[1].slice(0, 19).replace("T", " ");
    return [stamp, document.createTextNode(` ${match[2]}`)];
  }

  function createTaskActionButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-action-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function defaultNextFollowUpDate() {
    return addDaysIso(todayIsoDate(), 3);
  }

  async function updateTaskStatus(taskId, status) {
    try {
      await request(workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      showUndoToast(`Task marked ${status}.`, () =>
        updateTaskStatus(taskId, status === "done" ? "todo" : "done"),
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(`Could not update task: ${err.message || "request failed"}`);
    }
  }

  async function refreshTaskPanel(taskId) {
    if (activeTaskPanelId !== taskId) return;
    const token = activeWorkspaceRouteToken;
    try {
      const payload = await request(
        workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`),
      );
      if (
        payload &&
        payload.id &&
        activeTaskPanelId === taskId &&
        isWorkspaceRouteFresh(token)
      ) {
        activeTaskPanelTask = payload;
        const artifacts = await loadArtifactsForTask(payload);
        if (!isWorkspaceRouteFresh(token) || activeTaskPanelId !== taskId)
          return;
        activeTaskPanelArtifacts = artifacts;
        renderTaskPanel();
      }
    } catch {
      // keep the panel as-is; snapshot already refreshed
    }
  }

  async function saveTaskLink(taskId, linkValue) {
    try {
      await request(workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
        method: "PUT",
        body: JSON.stringify({ link: linkValue }),
      });
      if (activeTaskPanelTask) activeTaskPanelTask.link = linkValue;
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not save link: ${err.message || "request failed"}`);
    }
  }

  async function markTaskWaiting(taskId) {
    const today = todayIsoDate();
    const followUp = defaultNextFollowUpDate();
    const existing = activeTaskPanelTask?.waitingFor || "";
    const waitingFor =
      existing || promptUser("Who/what are you waiting for?", "") || "";
    if (!waitingFor.trim()) {
      reportError("Waiting tasks need a 'waiting for' description.");
      return;
    }
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/mark-waiting`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            waitingFor: waitingFor.trim(),
            followUpAt: followUp,
            channel: "portal",
            note: "Marked waiting from the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not mark task waiting: ${err.message || "request failed"}`,
      );
    }
  }

  async function recordTaskResponseReceived(taskId) {
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/response-received`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            channel: "portal",
            note: "Response received in the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not record response: ${err.message || "request failed"}`,
      );
    }
  }

  async function recordTaskFollowUpSent(taskId, nextDate) {
    if (!nextDate) {
      reportError("Choose the next follow-up date.");
      return;
    }
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/follow-up-sent`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            nextFollowUpAt: nextDate,
            channel: "portal",
            note: "Follow-up sent from the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not record follow-up: ${err.message || "request failed"}`,
      );
    }
  }

  // ---------- Bundle (workflow) detail panel ----------

  function openBundlePanel(bundleId) {
    const bundle = state.workSnapshot.bundlesById?.get(bundleId);
    const path = isArchivedWorkBundle(bundle) ? "/cards/archive" : "/cards";
    return navigateCanonicalWorkspace(path, { cardId: bundleId }).ready;
  }

  async function hydrateBundlePanel(bundleId, token) {
    try {
      const [bundleResult, tasksResult, artifactsResult] =
        await Promise.allSettled([
          request(workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`)),
          request(workApiUrl(`/api/tasks`, { bundleId })),
          loadArtifactsForBundle(bundleId),
        ]);
      if (!isWorkspaceRouteFresh(token) || activeBundlePanelId !== bundleId)
        return;
      if (bundleResult.status === "rejected") throw bundleResult.reason;
      const bundlePayload = settledPayload(bundleResult);
      const bundle = bundlePayload && (bundlePayload.bundle || bundlePayload);
      const tasks = tasksFromWorkPayload(settledPayload(tasksResult));
      const artifacts = Array.isArray(settledPayload(artifactsResult))
        ? settledPayload(artifactsResult)
        : [];
      if (isWorkspaceRouteFresh(token) && activeBundlePanelId === bundleId) {
        activeBundlePanelData = { bundle, tasks, artifacts };
        renderBundlePanel();
        if (activeTaskPanelTask?.bundleId === bundleId) renderTaskPanel();
      }
    } catch (err) {
      if (isWorkspaceRouteFresh(token) && activeBundlePanelId === bundleId) {
        bundlePanelTitle.textContent =
          err.status === 404 ? "Card not found" : "Card unavailable";
        renderEntityLoadState(bundlePanelBody, {
          kind: "card",
          id: bundleId,
          status: err.status === 404 ? "not-found" : "error",
          error: err.message,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => closeBundlePanel(),
        });
      }
    }
  }

  function closeBundlePanel(options = {}) {
    const route = parseWorkspaceHash();
    if (
      options.updateUrl === false ||
      !route ||
      route.invalid ||
      !["/cards", "/cards/archive"].includes(route.path)
    ) {
      resetBundlePanel();
      return;
    }
    return navigateCanonicalWorkspace(
      route.path,
      {},
      {
        restoreFocus: {
          kind: "workflow",
          id: route.params.get("cardId"),
          surface: "workflows",
        },
      },
    ).ready;
  }

  function renderEntityLoadingState(container, kind, id) {
    const loadingState = document.createElement("section");
    loadingState.className = "entity-route-state entity-route-loading";
    loadingState.setAttribute("role", "status");
    loadingState.textContent = `Loading ${kind} ${id}…`;
    container.replaceChildren(loadingState);
  }

  function renderBundlePanel() {
    const data = activeBundlePanelData;
    const bundle = data?.bundle;
    const tasks = data?.tasks || [];
    const artifacts = data?.artifacts || [];
    bundlePanelTitle.textContent = bundle ? workBundleTitle(bundle) : "Card";
    bundlePanelBody.replaceChildren();
    if (!bundle) return;

    const today = todayIsoDate();
    const progress = summarizeBundleProgress(bundle, tasks, today);
    const layout = document.createElement("div");
    layout.className = "workflow-modal-layout";
    const main = document.createElement("div");
    main.className = "workflow-modal-main";
    const sidebar = document.createElement("aside");
    sidebar.className = "workflow-modal-sidebar";
    sidebar.setAttribute("aria-label", "Card controls and status");
    const sidebarHeading = document.createElement("strong");
    sidebarHeading.className = "workflow-sidebar-heading";
    sidebarHeading.textContent = "Card";
    sidebar.append(sidebarHeading);
    layout.append(main, sidebar);
    bundlePanelBody.append(layout);

    // Stage + progress summary
    const meta = document.createElement("div");
    meta.className = "task-detail-meta workflow-detail-summary";
    const stageLabel = document.createElement("label");
    stageLabel.className = "workflow-stage-field";
    if (isArchivedWorkBundle(bundle)) {
      stageLabel.textContent = "Status";
      const completed = document.createElement("span");
      completed.className = "bundle-stage-static";
      completed.textContent = "Completed";
      stageLabel.append(completed);
    } else {
      stageLabel.textContent = "Stage ";
      const stageSelect = document.createElement("select");
      stageSelect.className = "bundle-stage-select";
      for (const stage of ["preparation", "announced", "after-event"]) {
        const opt = document.createElement("option");
        opt.value = stage;
        opt.textContent = labelizeWorkValue(stage);
        if (bundle.stage === stage) opt.selected = true;
        stageSelect.append(opt);
      }
      stageSelect.addEventListener("change", () =>
        updateBundleStage(bundle.id, stageSelect.value),
      );
      stageLabel.append(stageSelect);
    }
    sidebar.append(stageLabel);
    if (bundle.anchorDate) {
      const row = document.createElement("div");
      row.className = "workflow-sidebar-meta";
      row.append(
        document.createTextNode("Anchor "),
        formatMetaDate(bundle.anchorDate, today),
      );
      sidebar.append(row);
    }
    const progressRow = document.createElement("div");
    progressRow.className = "workflow-progress-copy";
    progressRow.textContent = progress.label;
    meta.append(progressRow);
    const riskRow = document.createElement("div");
    riskRow.className = "ops-card-chips";
    for (const chipText of [
      `Risk ${progress.risk}`,
      progress.nextDueTask
        ? `Next: ${workTaskTitle(progress.nextDueTask)}`
        : "",
      `${progress.overdue} overdue`,
      `${progress.waiting} waiting/follow-up`,
      `${progress.missingProof || 0} missing proof`,
    ].filter(Boolean)) {
      const chip = document.createElement("small");
      chip.className = "ops-card-chip";
      chip.textContent = chipText;
      riskRow.append(chip);
    }
    meta.append(riskRow);
    if (bundle.description) {
      const descRow = document.createElement("div");
      descRow.className = "workflow-description";
      descRow.textContent = bundle.description;
      meta.append(descRow);
    }
    main.append(meta);

    // Progress bar
    if (progress.total > 0) {
      const bar = document.createElement("div");
      bar.className = "ops-progress";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", progress.label);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(progress.percent));
      const fill = document.createElement("i");
      fill.style.width = `${progress.percent}%`;
      bar.append(fill);
      main.append(bar);
    }

    // Bundle links
    if (Array.isArray(bundle.bundleLinks) && bundle.bundleLinks.length > 0) {
      const linksSection = document.createElement("div");
      linksSection.className =
        "task-history workflow-detail-section workflow-links-section";
      const linksLabel = document.createElement("div");
      linksLabel.className = "task-history-label";
      linksLabel.textContent = "Links";
      linksSection.append(linksLabel);
      for (const link of bundle.bundleLinks) {
        const linkName = link.name || link.label || "Link";
        const linkUrl = link.url || "";
        const wrap = document.createElement("div");
        wrap.className = "task-required-link";
        const label = document.createElement("label");
        label.textContent = linkName;
        const input = document.createElement("input");
        input.type = "url";
        input.value = linkUrl;
        input.placeholder = "https://...";
        input.addEventListener("change", () =>
          saveBundleLink(
            bundle.id,
            bundle.bundleLinks,
            linkName,
            input.value.trim(),
          ),
        );
        label.append(input);
        wrap.append(label);
        linksSection.append(wrap);
      }
      main.append(linksSection);
    }

    // Task checklist
    if (tasks.length > 0) {
      const checklistSection = document.createElement("div");
      checklistSection.className =
        "task-history workflow-detail-section workflow-checklist-section";
      const checklistLabel = document.createElement("div");
      checklistLabel.className = "task-history-label";
      checklistLabel.textContent = "Tasks";
      checklistSection.append(checklistLabel);
      const list = document.createElement("div");
      list.className = "task-history-list";
      for (const group of workflowTaskGroups(tasks, today)) {
        const groupTitle = document.createElement("div");
        groupTitle.className = "bundle-task-group-title";
        groupTitle.textContent = `${group.title} (${group.tasks.length})`;
        list.append(groupTitle);
        if (group.tasks.length === 0) {
          const empty = document.createElement("div");
          empty.className = "task-history-event";
          empty.textContent = group.empty;
          list.append(empty);
        } else {
          for (const task of group.tasks)
            list.append(renderBundleChecklistItem(task, bundle.id, today));
        }
      }
      checklistSection.append(list);
      main.append(checklistSection);
    }

    // References and artifact links (always shown, with add capability)
    const refsSection = document.createElement("div");
    refsSection.className =
      "task-history workflow-detail-section workflow-references-section";
    const refsLabel = document.createElement("div");
    refsLabel.className = "task-history-label";
    refsLabel.textContent = "Process references";
    refsSection.append(refsLabel);
    const refsList = document.createElement("div");
    refsList.className = "task-history-list";
    const existingRefs = Array.isArray(bundle.references)
      ? bundle.references
      : [];
    for (const ref of existingRefs) {
      const refUrl = typeof ref === "string" ? ref : ref.url || ref.link || "";
      const refName =
        typeof ref === "string" ? ref : ref.name || ref.title || refUrl;
      if (!refUrl) continue;
      const item = document.createElement("div");
      item.className = "task-history-event";
      const docPath = localDocPathFromHref(refUrl);
      if (docPath) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "task-instruction-doc-link";
        link.textContent = String(refName);
        link.addEventListener("click", () =>
          openDocument(docPath, {
            returnContext: {
              type: "workflow",
              id: bundle.id,
              title: workBundleTitle(bundle),
            },
          }),
        );
        item.append(link);
      } else {
        const link = document.createElement("a");
        link.href = String(refUrl);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = String(refName);
        item.append(link);
      }
      refsList.append(item);
    }
    refsSection.append(refsList);
    if (!refsList.children.length) {
      const empty = document.createElement("div");
      empty.className = "task-history-event";
      empty.textContent = "No internal Process Docs linked to this Card.";
      refsList.append(empty);
    }

    const assistantState = document.createElement("div");
    assistantState.className = "task-history-event";
    assistantState.textContent = state.assistantSnapshot.loaded
      ? "Assistant jobs are available from the Assistants surface when linked to this Card."
      : "Assistant jobs are not connected to this Card.";
    refsSection.append(assistantState);

    // Add artifact/reference link form
    const addRow = document.createElement("div");
    addRow.className = "task-follow-up-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Label (e.g. Podcast doc)";
    nameInput.className = "bundle-ref-name";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    urlInput.className = "bundle-ref-url";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", () =>
      addBundleReference(
        bundle.id,
        existingRefs,
        nameInput.value.trim(),
        urlInput.value.trim(),
      ),
    );
    addRow.append(nameInput, urlInput, addBtn);
    refsSection.append(addRow);
    refsSection.append(
      renderArtifactList({
        ownerType: "bundle",
        ownerId: bundle.id,
        artifacts,
        required: false,
        onRefresh: async () => {
          activeBundlePanelData = {
            ...activeBundlePanelData,
            artifacts: await loadArtifactsForBundle(bundle.id),
          };
          renderBundlePanel();
        },
      }),
    );
    main.append(refsSection);
  }

  function renderBundleChecklistItem(task, bundleId, today) {
    const row = document.createElement("div");
    row.className = "bundle-checklist-item";
    const status = String(task.status || "todo").toLowerCase();
    const isDone = status === "done";
    const isWaiting = status === "waiting";
    const bundleArtifacts = activeBundlePanelData?.artifacts || [];

    const missingLink = !isDone && task.requiredLinkName && !task.link;
    const missingFile =
      !isDone && task.requiresFile && !hasTaskFileEvidence(task);
    const missingArtifact =
      !isDone &&
      taskRequiresApprovedArtifact(task) &&
      !hasApprovedArtifactEvidence(task, bundleArtifacts);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute(
      "aria-label",
      `${isDone ? "Reopen" : "Complete"} ${workTaskTitle(task)}`,
    );
    checkbox.checked = isDone;
    checkbox.disabled =
      isWaiting || missingLink || missingFile || missingArtifact;
    if (checkbox.disabled && !isDone) {
      const reasons = [];
      if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
      if (missingFile) reasons.push("Upload required file");
      if (missingArtifact) reasons.push("Approve an attached artifact");
      if (isWaiting) reasons.push("Waiting task");
      checkbox.title = reasons.join("; ");
    }
    checkbox.addEventListener("change", () => {
      updateTaskStatus(task.id, isDone ? "todo" : "done");
    });

    const label = document.createElement("button");
    label.type = "button";
    label.className = `bundle-checklist-label ${isDone ? "is-done" : ""}`;
    label.dataset.taskId = task.id;
    label.textContent = workTaskTitle(task);
    label.addEventListener("click", () =>
      openTaskPanel(task.id, {
        preserveBundle: true,
        expectedBundleId: bundleId,
      }),
    );

    const dateMeta = document.createElement("small");
    dateMeta.className = "bundle-checklist-date";
    if (task.date) dateMeta.textContent = formatTaskDateMeta(task.date, today);
    if (isWaiting) dateMeta.textContent = `waiting: ${task.waitingFor || ""}`;

    if (!isDone && (missingLink || missingFile || missingArtifact)) {
      const badge = document.createElement("span");
      badge.className = "bundle-checklist-evidence";
      if (missingLink) badge.textContent += `${task.requiredLinkName} missing`;
      if (missingLink && missingFile) badge.textContent += "; ";
      if (missingFile) badge.textContent += "file missing";
      if ((missingLink || missingFile) && missingArtifact)
        badge.textContent += "; ";
      if (missingArtifact) badge.textContent += "artifact review missing";
      dateMeta.append(document.createTextNode(" "), badge);
    }
    row.append(checkbox, label, dateMeta);
    return row;
  }

  async function navigateTaskToWorkflow(task) {
    if (!task?.bundleId) return;
    const bundle = state.workSnapshot.bundlesById?.get(task.bundleId);
    const path = isArchivedWorkBundle(bundle) ? "/cards/archive" : "/cards";
    await navigateCanonicalWorkspace(path, {
      cardId: task.bundleId,
      taskId: task.id,
    }).ready;
  }

  function dedupeArtifacts(artifacts) {
    const seen = new Set();
    const out = [];
    for (const artifact of artifacts || []) {
      if (!artifact || typeof artifact !== "object" || !artifact.id) continue;
      if (seen.has(artifact.id)) continue;
      seen.add(artifact.id);
      out.push(artifact);
    }
    return out;
  }

  function renderArtifactList(options) {
    const section = document.createElement("div");
    section.className = "task-history";
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.textContent = options.required ? "Artifact proof" : "Artifacts";
    section.append(label);

    const list = document.createElement("div");
    list.className = "task-history-list";
    const artifacts = options.artifacts || [];
    if (artifacts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-history-event";
      empty.textContent = options.required
        ? "No approved artifact attached."
        : "No artifacts registered.";
      list.append(empty);
    }
    for (const artifact of artifacts) {
      const item = document.createElement("div");
      item.className = "task-history-event";
      const link = document.createElement("a");
      link.href = artifact.storageUri || "#";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = artifact.title || artifact.storageUri || artifact.id;
      item.append(link);
      const status = document.createElement("span");
      status.className = `task-status-badge ${artifact.status || "draft"}`;
      status.textContent = artifact.status || "draft";
      item.append(document.createTextNode(" "), status);
      if (artifact.status !== "approved" && artifact.status !== "archived") {
        const approve = createTaskActionButton("Approve", async () =>
          updateArtifactStatus(artifact.id, "approved", options.onRefresh),
        );
        item.append(document.createTextNode(" "), approve);
      }
      list.append(item);
    }
    section.append(list);

    const addRow = document.createElement("div");
    addRow.className = "task-follow-up-row";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Artifact title";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Register";
    addBtn.addEventListener("click", () =>
      registerExternalArtifact({
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        title: titleInput.value.trim(),
        url: urlInput.value.trim(),
        onRefresh: options.onRefresh,
      }),
    );
    addRow.append(titleInput, urlInput, addBtn);
    section.append(addRow);
    return section;
  }

  async function registerExternalArtifact(options) {
    if (!options.url) {
      reportError("Artifact URL is required.");
      return;
    }
    const body = {
      type: "external-link",
      title: options.title || options.url,
      storageUri: options.url,
      storageProvider: "external-url",
      dataClass: "internal",
      sourceType: "manual-link",
      status: "needs-review",
    };
    if (options.ownerType === "task") body.taskId = options.ownerId;
    if (options.ownerType === "bundle") body.bundleId = options.ownerId;
    try {
      await request(workApiUrl("/api/artifacts"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (typeof options.onRefresh === "function") await options.onRefresh();
    } catch (err) {
      reportError(
        `Could not register artifact: ${err.message || "request failed"}`,
      );
    }
  }

  async function updateArtifactStatus(artifactId, status, onRefresh) {
    try {
      await request(
        workApiUrl(`/api/artifacts/${encodeURIComponent(artifactId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ status }),
        },
      );
      if (typeof onRefresh === "function") await onRefresh();
    } catch (err) {
      reportError(
        `Could not update artifact: ${err.message || "request failed"}`,
      );
    }
  }

  async function addBundleReference(bundleId, currentRefs, name, url) {
    if (!url) {
      reportError("URL is required.");
      return;
    }
    const ref = { name: name || url, url };
    const updatedRefs = [...(currentRefs || []), ref];
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ references: updatedRefs }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && activeBundlePanelId === bundleId) {
        activeBundlePanelData = {
          ...activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
    } catch (err) {
      reportError(`Could not add link: ${err.message || "request failed"}`);
    }
  }

  async function updateBundleStage(bundleId, stage) {
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ stage }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && activeBundlePanelId === bundleId) {
        activeBundlePanelData = {
          ...activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not update stage: ${err.message || "request failed"}`);
    }
  }

  async function saveBundleLink(bundleId, currentLinks, linkName, linkValue) {
    const updatedLinks = (currentLinks || []).map((link) =>
      (link.name || link.label) === linkName
        ? { ...link, url: linkValue }
        : link,
    );
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ bundleLinks: updatedLinks }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && activeBundlePanelId === bundleId) {
        activeBundlePanelData = {
          ...activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not save link: ${err.message || "request failed"}`);
    }
  }

  // ---------- Notification bell ----------

  function emptyTaskRouteContext(route = null) {
    const date = route?.params.get("date") || "";
    const bundleId = route?.params.get("bundleId") || "";
    return {
      date,
      bundleId,
      contextBundleId: route?.params.get("contextBundleId") || "",
      tasks: date || bundleId ? [] : null,
      filterBundle: null,
      contextBundle: null,
      failures: [],
    };
  }

  function resetTaskPanel() {
    activeTaskPanelId = null;
    activeTaskPanelTask = null;
    activeTaskPanelArtifacts = [];
    taskPanel.hidden = true;
    if (!bundlePanel.hidden) {
      bundlePanel.inert = false;
      bundlePanel.removeAttribute("aria-hidden");
      body.classList.add("task-panel-open", "task-modal-open");
    } else {
      body.classList.remove("task-panel-open", "task-modal-open");
    }
  }

  function resetBundlePanel() {
    activeBundlePanelId = null;
    activeBundlePanelData = null;
    bundlePanel.hidden = true;
    body.classList.remove("task-panel-open");
    body.classList.remove("task-modal-open");
  }

  function prepareTaskPanel(taskId) {
    if (!taskId) return;
    activeTaskPanelId = taskId;
    activeTaskPanelTask = null;
    activeTaskPanelArtifacts = [];
    taskPanelTitle.textContent = "Loading task...";
    taskPanelBody.replaceChildren();
    taskPanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    if (!bundlePanel.hidden) {
      bundlePanel.inert = true;
      bundlePanel.setAttribute("aria-hidden", "true");
    }
    renderEntityLoadingState(taskPanelBody, "task", taskId);
    taskPanelClose.focus();
  }

  function prepareBundlePanel(bundleId) {
    if (!bundleId) return;
    activeBundlePanelId = bundleId;
    activeBundlePanelData = null;
    bundlePanelTitle.textContent = "Loading card...";
    bundlePanelBody.replaceChildren();
    bundlePanel.inert = false;
    bundlePanel.removeAttribute("aria-hidden");
    bundlePanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    renderEntityLoadingState(bundlePanelBody, "card", bundleId);
    bundlePanelClose.focus();
  }

  async function resolveTaskQueueRouteContext(route, token) {
    const context = taskRouteContext;
    const { date, bundleId, contextBundleId } = context;
    const sources = [
      bundleId
        ? {
            source: "filter-bundle",
            id: bundleId,
            load: () =>
              request(
                workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
              ),
          }
        : null,
      date || bundleId
        ? {
            source: "task-query",
            id: [date, bundleId].filter(Boolean).join(" · "),
            load: () => request(workApiUrl("/api/tasks", { date, bundleId })),
          }
        : null,
      contextBundleId
        ? {
            source: "return-context",
            id: contextBundleId,
            load: () =>
              request(
                workApiUrl(
                  `/api/bundles/${encodeURIComponent(contextBundleId)}`,
                ),
              ),
          }
        : null,
    ].filter(Boolean);
    const results = await Promise.allSettled(
      sources.map((entry) => entry.load()),
    );
    if (!isWorkspaceRouteFresh(token) || taskRouteContext !== context) return;
    results.forEach((result, index) => {
      const entry = sources[index];
      if (result.status === "rejected") {
        context.failures.push({
          source: entry.source,
          id: entry.id,
          status: result.reason?.status === 404 ? "not-found" : "error",
          error: result.reason?.message || "Request failed",
        });
        return;
      }
      if (entry.source === "filter-bundle")
        context.filterBundle = result.value.bundle || result.value;
      else if (entry.source === "task-query")
        context.tasks = tasksFromWorkPayload(result.value);
      else context.contextBundle = result.value.bundle || result.value;
    });
    if (
      getActiveWorkspaceView() === "tasks" &&
      getActiveTasksSection() === "queue"
    )
      renderTasksSurface(getAllDocuments(), "queue");
    if (activeTaskPanelTask && isWorkspaceRouteFresh(token)) renderTaskPanel();
  }

  return {
    closeBundlePanel,
    closeTaskPanel,
    dedupeArtifacts,
    defaultNextFollowUpDate,
    getTaskRouteContext: () => taskRouteContext,
    handleWorkspaceEntityModalKeydown,
    hydrateBundlePanel,
    hydrateTaskPanel,
    openBundlePanel,
    openTaskPanel,
    prepareBundlePanel,
    prepareTaskPanel,
    renderArtifactList,
    resetBundlePanel,
    resetTaskPanel,
    resolveAssigneeLabel,
    resolveBundleLabel,
    resolveTaskQueueRouteContext,
    setTaskRouteContextFromRoute: (route) => {
      taskRouteContext =
        route?.path === "/tasks"
          ? emptyTaskRouteContext(route)
          : emptyTaskRouteContext();
    },
  };
}
