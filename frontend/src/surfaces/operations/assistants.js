export function createAssistantsSurface(context) {
  const {
    assistantJobsFromPayload,
    clearSelectionButton,
    cssEscape,
    dedupeArtifacts,
    defaultNextFollowUpDate,
    documentList,
    escapeHtml,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    isOperationsHomeVisible,
    isMobileShell,
    isWorkspaceRouteFresh,
    libraryTitle,
    navigateCanonicalWorkspace,
    openCardPanel,
    openTaskPanel,
    promptUser,
    refreshDocuments,
    renderEntityLoadState,
    renderHonestState,
    reportError,
    request,
    scheduleAnimationFrame,
    setPageTitle,
    setStatus,
    showCreate,
    state,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workTaskTitle,
  } = context;

  function renderAssistantsSurface() {
    const section = document.createElement("section");
    section.className = "assistant-workspace";
    section.setAttribute("aria-label", "Assistant jobs");
    if (!state.assistantSnapshot.loaded) {
      section.append(
        renderHonestState(
          "Assistant jobs unavailable",
          state.assistantSnapshot.errors[0] ||
            "The assistant job API is not connected in this environment.",
        ),
      );
      return section;
    }

    section.append(renderAssistantCreatePanel());
    const filters = document.createElement("nav");
    filters.className = "ops-subnav assistant-filter-bar";
    filters.setAttribute("aria-label", "Assistant job filters");
    for (const [id, label] of [
      ["podcast", "Podcast jobs"],
      ["needs-approval", "Needs approval"],
      ["failed", "Failed"],
      ["running", "Running/queued"],
      ["completed", "Completed"],
      ["all", "All"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ops-subnav-tab ${state.assistantQueue.filter === id ? "is-active" : ""}`;
      button.textContent = label;
      button.addEventListener("click", () => {
        state.assistantQueue.filter = id;
        navigateCanonicalWorkspace("/assistants");
      });
      filters.append(button);
    }
    section.append(filters);

    const filtered = state.assistantSnapshot.jobs
      .filter((job) => assistantMatchesFilter(job, state.assistantQueue.filter))
      .sort(
        (a, b) =>
          assistantJobGroupOrder(a) - assistantJobGroupOrder(b) ||
          String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      )
      .slice(0, 60);
    const layout = document.createElement("div");
    layout.className = "assistant-layout";
    const queue = document.createElement("section");
    queue.className = "assistant-panel assistant-queue";
    const heading = document.createElement("h3");
    heading.textContent = "Operational assistant queue";
    queue.append(heading);
    if (!filtered.length)
      queue.append(
        renderHonestState(
          "No matching assistant jobs",
          "Choose another filter or request assistant help for a Card.",
        ),
      );
    for (const job of filtered) queue.append(renderAssistantJobRow(job));
    const detail = document.createElement("section");
    detail.className = "assistant-panel assistant-detail";
    detail.dataset.assistantDetail = "";
    layout.append(queue, detail);
    section.append(layout);
    const selectedId = state.assistantQueue.selectedJobId;
    state.assistantQueue.selectedJobId = selectedId || null;
    if (selectedId) renderAssistantJobDetail(detail, selectedId);
    else
      detail.append(
        renderHonestState(
          "Assistant job detail",
          "Select a job to inspect inputs, events, output artifacts, and approval history.",
        ),
      );
    return section;
  }

  function renderAssistantJobRow(job) {
    const row = document.createElement("article");
    row.className = `assistant-job-row ${job.id === state.assistantQueue.selectedJobId ? "is-selected" : ""}`;
    const context = assistantContextLabel(job);
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(job.title || job.assistantType || job.id || "Assistant job")}</strong>
        <span>
          ${escapeHtml(job.assistantType || "assistant")}
          · attempt ${Number(job.attemptCount || 0)}/${Number(job.maxAttempts || 1)}
          ${context ? ` · ${escapeHtml(context)}` : ""}
        </span>
        <small>
          ${escapeHtml(assistantNextAction(job))}
          ${job.lastError ? ` · Error: ${escapeHtml(job.lastError.summary || job.lastError.code || "failed")}` : ""}
        </small>
      </div>
      <em>${escapeHtml(String(job.status || "draft").replace(/_/g, " "))}</em>
    `;
    row.addEventListener("click", () => {
      navigateCanonicalWorkspace("/assistants", { assistantJobId: job.id });
    });
    return row;
  }

  function assistantMatchesFilter(job, filter) {
    if (filter === "needs-approval") return job.status === "waiting_approval";
    if (filter === "failed") return job.status === "failed";
    if (filter === "running")
      return ["running", "queued", "retrying"].includes(job.status);
    if (filter === "completed")
      return ["approved", "succeeded", "rejected", "canceled"].includes(
        job.status,
      );
    if (filter === "podcast") return job.assistantType === "podcast";
    return true;
  }

  function assistantJobGroupOrder(job) {
    if (job.status === "waiting_approval") return 0;
    if (job.status === "failed") return 1;
    if (["running", "retrying"].includes(job.status)) return 2;
    if (["queued", "draft"].includes(job.status)) return 3;
    return 4;
  }

  function assistantNextAction(job) {
    if (job.status === "waiting_approval") return "Review output";
    if (["failed", "rejected"].includes(job.status))
      return assistantCanRetry(job)
        ? "Retry with failure context"
        : "Retry limit reached";
    if (job.status === "queued") return "Run dry or wait for runner";
    if (job.status === "running") return "Watch timeline";
    if (job.status === "draft") return "Submit or run dry";
    if (job.status === "retrying") return "Submit retry";
    if (job.status === "approved") return "Output approved";
    if (job.status === "succeeded") return "Output attached";
    if (job.status === "canceled") return "Canceled";
    return "Check status";
  }

  function assistantCanRetry(job) {
    return (
      ["failed", "rejected"].includes(job?.status) &&
      Number(job.attemptCount || 0) < Number(job.maxAttempts || 1)
    );
  }

  function assistantCanCancel(job) {
    return [
      "draft",
      "queued",
      "running",
      "retrying",
      "waiting_approval",
    ].includes(job?.status);
  }

  function assistantContextLabel(job) {
    const card = (state.workSnapshot.cards || []).find(
      (candidate) => candidate.id === job.cardId,
    );
    if (card) return `card ${card.title || card.id}`;
    if (job.cardId) return `card ${job.cardId}`;
    if (job.taskId) return `task ${job.taskId}`;
    return "";
  }

  function renderAssistantCreatePanel() {
    const panel = document.createElement("section");
    panel.className = "assistant-panel";
    const cards = state.workSnapshot.cards || [];
    const cardOptions = cards
      .map(
        (card) => `
          <option value="${escapeHtml(card.id)}">
            ${escapeHtml(card.title || card.id)}
          </option>
        `,
      )
      .join("");
    panel.innerHTML = `
      <h3>Request DataOps Assistant help</h3>
      <div class="assistant-create-grid">
        <label>
          Card
          <select data-assistant-card>
            <option value="">Select card</option>
            ${cardOptions}
          </select>
        </label>
        <label>
          Task
          <select data-assistant-task>
            <option value="">Card-level job</option>
          </select>
        </label>
        <label>
          Assistant type
          <input data-assistant-type value="podcast">
        </label>
        <label>
          Title
          <input data-assistant-title placeholder="DataOps Assistant podcast prep">
        </label>
        <button class="primary-button" data-assistant-create>
          Ask DataOps Assistant
        </button>
      </div>
    `;
    const cardSelect = panel.querySelector("[data-assistant-card]");
    const taskSelect = panel.querySelector("[data-assistant-task]");
    cardSelect.addEventListener("change", async () => {
      taskSelect.innerHTML = `<option value="">Card-level job</option>`;
      if (!cardSelect.value) return;
      try {
        const payload = await request(
          workApiUrl("/api/tasks", { cardId: cardSelect.value }),
        );
        for (const task of tasksFromWorkPayload(payload)) {
          const option = document.createElement("option");
          option.value = task.id;
          option.textContent = workTaskTitle(task);
          taskSelect.append(option);
        }
      } catch (error) {
        reportError(error.message || "Could not load card tasks");
      }
    });
    panel
      .querySelector("[data-assistant-create]")
      .addEventListener("click", async () => {
        const cardId = cardSelect.value;
        const taskId = taskSelect.value;
        if (!cardId && !taskId)
          return reportError(
            "Select a Card or Task before requesting assistant help.",
          );
        const assistantType =
          panel.querySelector("[data-assistant-type]").value.trim() ||
          "podcast";
        const title =
          panel.querySelector("[data-assistant-title]").value.trim() ||
          `DataOps Assistant: ${assistantType}`;
        const inputRefs = [];
        if (cardId) inputRefs.push({ type: "card", id: cardId });
        if (taskId) inputRefs.push({ type: "task", id: taskId });
        try {
          const created = await request(workApiUrl("/api/assistant-jobs"), {
            method: "POST",
            body: JSON.stringify({
              assistantType,
              title,
              cardId: cardId || undefined,
              taskId: taskId || undefined,
              inputRefs,
              approvalRequired: true,
              maxAttempts: 2,
            }),
          });
          const job = created.job || created;
          await request(
            workApiUrl(
              `/api/assistant-jobs/${encodeURIComponent(job.id)}/submit`,
            ),
            { method: "POST" },
          );
          setStatus("Assistant job queued.");
          await navigateCanonicalWorkspace("/assistants", {
            assistantJobId: job.id,
          }).ready;
        } catch (error) {
          reportError(error.message || "Could not create assistant job");
        }
      });
    return panel;
  }

  function assistantActionButtons(job) {
    const actions = [];
    if (["draft", "retrying"].includes(job.status))
      actions.push(["submit", "Submit"]);
    if (["draft", "queued", "retrying", "running"].includes(job.status))
      actions.push(["run-dry", "Run dry"]);
    if (job.status === "waiting_approval")
      actions.push(["approve", "Approve"], ["reject", "Reject"]);
    if (assistantCanRetry(job)) actions.push(["retry", "Retry"]);
    if (assistantCanCancel(job)) actions.push(["cancel", "Cancel"]);
    return actions;
  }

  async function runAssistantAction(job, action) {
    let body;
    if (action === "reject") {
      const reason = promptUser("Rejection reason");
      if (!reason?.trim()) return;
      body = JSON.stringify({ reason: reason.trim() });
    }
    try {
      const result = await request(
        workApiUrl(
          `/api/assistant-jobs/${encodeURIComponent(job.id)}/${action}`,
        ),
        { method: "POST", ...(body ? { body } : {}) },
      );
      if (action === "retry" && result?.job?.status === "retrying") {
        await request(
          workApiUrl(
            `/api/assistant-jobs/${encodeURIComponent(job.id)}/submit`,
          ),
          { method: "POST" },
        );
      }
      setStatus(`Assistant job ${action.replace(/-/g, " ")} complete.`);
      await refreshOperationsAssistantSnapshot({ rerender: true });
    } catch (error) {
      reportError(error.message || "Assistant action failed");
    }
  }

  async function renderAssistantJobDetail(container, jobId) {
    container.replaceChildren(
      renderHonestState(
        "Assistant job detail",
        "Loading job events and artifacts…",
      ),
    );
    try {
      const payload = await request(
        workApiUrl(`/api/assistant-jobs/${encodeURIComponent(jobId)}`),
      );
      if (
        state.assistantQueue.selectedJobId !== jobId ||
        !container.isConnected
      )
        return;
      const job = payload.job || payload;
      const artifacts = payload.artifacts || [];
      const events = payload.events || [];
      const actionButtons = assistantActionButtons(job)
        .map(
          ([action, label]) => `
            <button
              data-assistant-lifecycle="${action}"
              class="${action === "approve" ? "primary-button" : ""}"
            >
              ${label}
            </button>
          `,
        )
        .join("");
      const inputReferences = (job.inputRefs || []).length
        ? job.inputRefs
            .map(
              (ref) => `
                <code>
                  ${escapeHtml(ref.title || ref.uri || ref.id || ref.type || "input")}
                </code>
              `,
            )
            .join(" ")
        : "No input references recorded.";
      const artifactLinks = artifacts.length
        ? artifacts
            .map(
              (artifact) => `
                <a
                  href="${escapeHtml(artifact.storageUri || "#")}"
                  target="_blank"
                  rel="noopener"
                >
                  <strong>${escapeHtml(artifact.title || artifact.type || "Artifact")}</strong>
                  <span>
                    ${escapeHtml(artifact.status || "draft")}
                    · ${escapeHtml(artifact.storageProvider || "unknown")}
                  </span>
                </a>
              `,
            )
            .join("")
        : "No output artifacts attached.";
      const timeline = events.length
        ? events
            .slice(-12)
            .reverse()
            .map(
              (event) => `
                <li>
                  <strong>
                    ${escapeHtml(String(event.action || "event").replace(/_/g, " "))}
                  </strong>
                  <span>
                    ${escapeHtml(event.createdAt || "")}
                    ${event.summary ? ` · ${escapeHtml(event.summary)}` : ""}
                  </span>
                </li>
              `,
            )
            .join("")
        : "<li>No run events recorded.</li>";
      container.innerHTML = `
        <header>
          <div>
            <h3>${escapeHtml(job.title || job.assistantType || job.id)}</h3>
            <small>${escapeHtml(assistantContextLabel(job))}</small>
          </div>
          <span class="assistant-status">
            ${escapeHtml(String(job.status || "draft").replace(/_/g, " "))}
          </span>
        </header>
        <div class="assistant-editor">
          <label>
            Title
            <input data-assistant-edit-title value="${escapeHtml(job.title || "")}">
          </label>
          <label>
            Assistant type
            <input data-assistant-edit-type value="${escapeHtml(job.assistantType || "")}">
          </label>
          <label>
            Approval required
            <select data-assistant-edit-approval>
              <option value="true" ${job.approvalRequired !== false ? "selected" : ""}>Yes</option>
              <option value="false" ${job.approvalRequired === false ? "selected" : ""}>No</option>
            </select>
          </label>
          <button data-assistant-save>Save draft fields</button>
        </div>
        <div class="assistant-actions">
          ${actionButtons}
          ${["failed", "rejected"].includes(job.status) && !assistantCanRetry(job) ? "<span>Retry limit reached</span>" : ""}
        </div>
        <section>
          <h4>Input references</h4>
          <div class="assistant-ref-list">${inputReferences}</div>
        </section>
        <section>
          <h4>Output artifacts and proof</h4>
          <div class="assistant-artifacts">${artifactLinks}</div>
        </section>
        <section>
          <h4>Run log and status history</h4>
          <ul class="assistant-timeline">${timeline}</ul>
        </section>
      `;
      container
        .querySelector("[data-assistant-save]")
        .addEventListener("click", async () => {
          try {
            await request(
              workApiUrl(`/api/assistant-jobs/${encodeURIComponent(job.id)}`),
              {
                method: "PUT",
                body: JSON.stringify({
                  title: container
                    .querySelector("[data-assistant-edit-title]")
                    .value.trim(),
                  assistantType: container
                    .querySelector("[data-assistant-edit-type]")
                    .value.trim(),
                  approvalRequired:
                    container.querySelector("[data-assistant-edit-approval]")
                      .value === "true",
                }),
              },
            );
            setStatus("Assistant draft fields saved.");
            await refreshOperationsAssistantSnapshot({ rerender: true });
          } catch (error) {
            reportError(error.message || "Could not update assistant job");
          }
        });
      container
        .querySelectorAll("[data-assistant-lifecycle]")
        .forEach((button) =>
          button.addEventListener("click", () =>
            runAssistantAction(job, button.dataset.assistantLifecycle),
          ),
        );
    } catch (error) {
      renderEntityLoadState(container, {
        kind: "assistant job",
        id: jobId,
        status: error.status === 404 ? "not-found" : "error",
        error: error.message,
        retry: () => renderAssistantJobDetail(container, jobId),
        returnToList: () => {
          navigateCanonicalWorkspace("/assistants");
        },
      });
    }
  }

  async function refreshOperationsAssistantSnapshot(options = {}) {
    const snapshot = {
      loaded: false,
      jobs: [],
      errors: [],
    };
    try {
      const payload = await request(workApiUrl("/api/assistant-jobs"));
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      const jobs = assistantJobsFromPayload(payload);
      if (
        jobs.length > 0 ||
        Array.isArray(payload?.jobs) ||
        Array.isArray(payload?.assistantJobs) ||
        Array.isArray(payload?.items) ||
        Array.isArray(payload)
      ) {
        snapshot.loaded = true;
        snapshot.jobs = jobs;
      } else {
        snapshot.errors = [
          "Assistant job lifecycle is not connected in this environment.",
        ];
      }
    } catch (err) {
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      snapshot.errors = [err?.message || "Assistant jobs API request failed"];
    }
    if (options.token && !isWorkspaceRouteFresh(options.token)) return;
    state.assistantSnapshot = snapshot;
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
  }

  return {
    refreshOperationsAssistantSnapshot,
    renderAssistantsSurface,
  };
}
