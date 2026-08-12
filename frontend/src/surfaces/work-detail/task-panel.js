export function createTaskPanel(context) {
  const {
    buildTaskProcessQualityFindings,
    closeTaskPanel,
    createTaskActionButton,
    defaultNextFollowUpDate,
    detail,
    formatTaskDateMeta,
    getActiveWorkspaceRoute,
    getCurrentOperator,
    hasApprovedArtifactEvidence,
    isArchivedWorkBundle,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    loadArtifactsForTask,
    markTaskWaiting,
    navigateCanonicalWorkspace,
    navigateTaskToWorkflow,
    openDocument,
    openQualityFinding,
    parseWorkspaceHash,
    recordTaskFollowUpSent,
    recordTaskResponseReceived,
    renderEntityLoadState,
    renderTaskArtifactSection,
    renderTaskFileSection,
    request,
    resolveDocReference = () => null,
    saveTaskLink,
    state,
    taskPanelBody,
    taskPanelTitle,
    taskRequiresApprovedArtifact,
    todayIsoDate,
    updateTaskStatus,
    workApiUrl,
    workTaskTitle,
  } = context;

  function taskRouteParams(taskId) {
    const route = parseWorkspaceHash();
    if (route && !route.invalid && route.path === "/tasks") {
      const params = new URLSearchParams(route.params);
      params.set("taskId", taskId);
      return { path: "/tasks", params };
    }
    if (detail.activeBundlePanelId) {
      const path =
        getActiveWorkspaceRoute()?.path === "/cards/archive"
          ? "/cards/archive"
          : "/cards";
      return { path, params: { cardId: detail.activeBundlePanelId, taskId } };
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
      if (!isWorkspaceRouteFresh(token) || detail.activeTaskPanelId !== taskId)
        return;
      const fetched =
        payload && typeof payload === "object" && payload.id ? payload : null;
      if (
        options.expectedBundleId &&
        fetched &&
        fetched.bundleId !== options.expectedBundleId
      ) {
        detail.activeTaskPanelTask = null;
        detail.activeTaskPanelArtifacts = [];
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
        detail.activeTaskPanelTask = fetched;
        detail.activeTaskPanelArtifacts = [];
        renderTaskPanel();
      }
      const artifacts = fetched ? await loadArtifactsForTask(fetched) : [];
      if (
        !isWorkspaceRouteFresh(token) ||
        detail.activeTaskPanelId !== taskId ||
        detail.activeTaskPanelTask?.id !== fetched?.id
      )
        return;
      detail.activeTaskPanelArtifacts = artifacts;
      renderTaskPanel();
    } catch (err) {
      if (isWorkspaceRouteFresh(token) && detail.activeTaskPanelId === taskId) {
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

  function renderTaskPanel() {
    const task = detail.activeTaskPanelTask;
    taskPanelTitle.textContent = task ? workTaskTitle(task) : "Task";
    taskPanelBody.replaceChildren();
    if (!task) return;

    const status = String(task.status || "todo").toLowerCase();
    const today = todayIsoDate();

    const routeContextParts = [
      detail.taskRouteContext.date
        ? `Queue date ${detail.taskRouteContext.date}`
        : "",
      detail.taskRouteContext.bundleId
        ? `Filtered to card ${detail.taskRouteContext.filterBundle?.title || detail.taskRouteContext.bundleId}`
        : "",
      detail.taskRouteContext.contextBundleId
        ? `Return to ${detail.taskRouteContext.contextBundle?.title || detail.taskRouteContext.contextBundleId}`
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
      const missingFile =
        task.requiresFile && !detail.activeTaskPanelTask?._hasFiles;
      const missingArtifact =
        taskRequiresApprovedArtifact(task) &&
        !hasApprovedArtifactEvidence(task, detail.activeTaskPanelArtifacts);
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
      detail.taskRouteContext.filterBundle,
      detail.taskRouteContext.contextBundle,
      detail.activeBundlePanelData?.bundle,
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

  return {
    hydrateTaskPanel,
    openTaskPanel,
    renderTaskPanel,
    resolveAssigneeLabel,
    resolveBundleLabel,
  };
}
