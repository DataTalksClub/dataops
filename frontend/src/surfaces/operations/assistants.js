import {
  createFormFeedback,
  renderDataSummary,
  reportFieldValidation,
  setFieldError,
} from "../operations-overview.js";
import { createAssistantCreateSurface } from "./assistants-create.js";

export function createAssistantsSurface(context) {
  const {
    assistantJobsFromPayload,
    cssEscape,
    dedupeArtifacts,
    defaultNextFollowUpDate,
    documentList,
    escapeHtml,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken = () => undefined,
    getActiveWorkspaceView,
    isOperationsHomeVisible,
    isMobileShell,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openCardPanel,
    openTaskPanel,
    promptUser,
    refreshDocuments,
    renderEntityLoadState,
    renderHonestState,
    request,
    scheduleAnimationFrame,
    setRouteTitle,
    state,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workTaskTitle,
  } = context;
  const document = context.document || documentList?.ownerDocument || globalThis.document;

  let assistantRefreshSequence = 0;

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
  }

  function assistantMutation() {
    if (!state.assistantMutation) {
      state.assistantMutation = {
        target: "",
        action: "",
        values: {},
        error: "",
        busy: false,
        status: "",
        phase: "idle",
        routeToken: getActiveWorkspaceRouteToken(),
      };
    }
    return state.assistantMutation;
  }

  function resetAssistantMutation() {
    state.assistantMutation = {
      target: "",
      action: "",
      values: {},
      error: "",
      busy: false,
      status: "",
      phase: "idle",
      routeToken: getActiveWorkspaceRouteToken(),
    };
  }

  function renderAssistantFeedback(node, mutation) {
    const feedback = createFormFeedback();
    feedback.node.classList.add("assistant-detail-feedback");
    node.append(feedback.node);
    if (mutation?.phase === "pending") feedback.pending(mutation.status);
    else if (mutation?.error) {
      if (mutation.phase === "conflict") feedback.conflict(mutation.error);
      else feedback.failure(mutation.error);
    } else if (mutation?.status) feedback.success(mutation.status);
    return feedback;
  }

  function assistantVisibleMessage(title, detail, role = "status") {
    const node = renderHonestState(title, detail);
    node.setAttribute("role", role);
    node.setAttribute("aria-live", role === "alert" ? "assertive" : "polite");
    return node;
  }

  const { renderAssistantCreatePanel } = createAssistantCreateSurface({
    ...context,
    assistantMutation,
    document,
    refreshAssistantSnapshot: (...args) =>
      refreshOperationsAssistantSnapshot(...args),
    resetAssistantMutation,
    routeIsFresh,
  });

  function renderAssistantsSurface() {
    const currentToken = getActiveWorkspaceRouteToken();
    const currentMutation = assistantMutation();
    if (
      currentMutation.target &&
      !currentMutation.busy &&
      currentMutation.routeToken !== undefined &&
      currentMutation.routeToken !== currentToken
    ) {
      resetAssistantMutation();
    }
    const section = document.createElement("section");
    section.className = "assistant-workspace";
    section.setAttribute("aria-label", "Assistant jobs");
    const snapshot = state.assistantSnapshot;
    section.append(
      renderDataSummary({
        id: "assistants",
        label: "Assistants",
        loaded: snapshot.loaded,
        errors: snapshot.errors,
        empty: snapshot.loaded && snapshot.jobs.length === 0,
        messages: {
          loading: "Loading assistant jobs from the work API.",
          unavailable: "Assistant jobs unavailable; no lifecycle state is being invented.",
          partial: "Assistant jobs are only partially available.",
          empty: "No assistant jobs have been created yet.",
          ready: `${snapshot.jobs.length} assistant job${snapshot.jobs.length === 1 ? "" : "s"} loaded.`,
        },
        retryLabel: "Retry loading assistants",
        onRetry: async () => {
          const token = getActiveWorkspaceRouteToken();
          await refreshOperationsAssistantSnapshot({ rerender: true, token });
        },
      }),
    );
    if (!state.assistantSnapshot.loaded) {
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
      button.setAttribute(
        "aria-pressed",
        String(state.assistantQueue.filter === id),
      );
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
        assistantVisibleMessage(
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
        assistantVisibleMessage(
          "Assistant job detail",
          "Select a job to inspect inputs, events, output artifacts, and approval history.",
        ),
      );
    return section;
  }

  function renderAssistantJobRow(job) {
    const row = document.createElement("article");
    row.className = `assistant-job-row ${job.id === state.assistantQueue.selectedJobId ? "is-selected" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute(
      "aria-label",
      `Open assistant job ${job.title || job.assistantType || job.id || "job"}`,
    );
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
    const openJob = () => {
      navigateCanonicalWorkspace("/assistants", { assistantJobId: job.id });
    };
    row.addEventListener("click", openJob);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openJob();
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

  function assistantActionLabel(action) {
    return {
      submit: "Submit",
      "run-dry": "Run dry",
      approve: "Approve",
      reject: "Reject",
      retry: "Retry",
      cancel: "Cancel",
    }[action] || action.replace(/-/g, " ");
  }

  function assistantActionSucceeded(action, status) {
    if (action === "run-dry") return ["waiting_approval", "succeeded", "approved"].includes(status);
    if (action === "retry" || action === "submit") return ["queued", "running", "retrying"].includes(status);
    return status === ({
      approve: "approved",
      reject: "rejected",
      cancel: "canceled",
    }[action] || status);
  }

  async function runAssistantAction(job, action) {
    const existing = assistantMutation();
    if (existing.busy) return;
    let body;
    if (action === "reject") {
      const reason = promptUser("Rejection reason");
      if (!reason?.trim()) return;
      body = JSON.stringify({ reason: reason.trim() });
    }
    const routeToken = getActiveWorkspaceRouteToken();
    state.assistantMutation = {
      target: `job:${job.id}`,
      action,
      values: action === "reject" && body ? { reason: JSON.parse(body).reason } : {},
      error: "",
      busy: true,
      status: `${assistantActionLabel(action)} assistant job…`,
      phase: "pending",
      routeToken,
    };
    refreshDocuments();
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
      await refreshOperationsAssistantSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!routeIsFresh(routeToken)) return;
      const durable = state.assistantSnapshot.jobs.find(
        (candidate) => candidate.id === job.id,
      );
      if (!durable || !assistantActionSucceeded(action, durable.status)) {
        throw new Error(
          `The refreshed assistant queue did not confirm ${assistantActionLabel(action).toLowerCase()}.`,
        );
      }
      state.assistantMutation = {
        target: `job:${job.id}`,
        action: "",
        values: {},
        error: "",
        busy: false,
        status: `Assistant job is ${String(durable.status).replace(/_/g, " ")} in the refreshed queue.`,
        phase: "success",
        routeToken,
      };
      refreshDocuments();
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
      const conflict = error.status === 409;
      state.assistantMutation = {
        target: `job:${job.id}`,
        action,
        values:
          action === "reject" && body
            ? { reason: JSON.parse(body).reason }
            : {},
        error: conflict
          ? `This assistant job changed since it was loaded. Review or reload ` +
            `the current job, then retry ${assistantActionLabel(action).toLowerCase()}. (${error.message || "conflict"})`
          : error.message ||
            `Could not ${assistantActionLabel(action).toLowerCase()} the assistant job. Select ${assistantActionLabel(action)} to retry.`,
        busy: false,
        status: "",
        phase: conflict ? "conflict" : "error",
        routeToken,
      };
      refreshDocuments();
    }
  }

  function appendAssistantDetailRecovery(container, jobId) {
    const mutation = assistantMutation();
    if (!mutation.error) return;
    const recovery = document.createElement("div");
    recovery.className = "assistant-mutation-recovery";
    recovery.setAttribute("aria-label", "Assistant job recovery");
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload current job";
    reload.addEventListener("click", () => {
      resetAssistantMutation();
      void renderAssistantJobDetail(container, jobId);
    });
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard changes";
    discard.addEventListener("click", () => {
      resetAssistantMutation();
      void renderAssistantJobDetail(container, jobId);
    });
    recovery.append(reload, discard);
    container.append(recovery);
  }

  async function saveAssistantDraft(container, job, routeToken) {
    const mutation = assistantMutation();
    if (mutation.busy) return;
    const titleField = container.querySelector("[data-assistant-edit-title]");
    const typeField = container.querySelector("[data-assistant-edit-type]");
    const approvalField = container.querySelector("[data-assistant-edit-approval]");
    const values = {
      title: titleField?.value.trim() || "",
      assistantType: typeField?.value.trim() || "",
      approvalRequired: approvalField?.value === "true",
    };
    for (const field of [titleField, typeField]) setFieldError(field, "");
    const invalid = [];
    if (!values.title) invalid.push([titleField, "Title is required."]);
    if (!values.assistantType) invalid.push([typeField, "Assistant type is required."]);
    if (invalid.length) {
      state.assistantMutation = {
        target: `job:${job.id}`,
        action: "save",
        values,
        error: invalid[0][1],
        busy: false,
        status: "",
        phase: "error",
        routeToken,
        focus: invalid[0][0]?.dataset?.assistantEditTitle ? "title" : "type",
      };
      reportFieldValidation(invalid);
      void renderAssistantJobDetail(container, job.id);
      return;
    }
    state.assistantMutation = {
      target: `job:${job.id}`,
      action: "save",
      values,
      error: "",
      busy: true,
      status: "Saving assistant draft fields…",
      phase: "pending",
      routeToken,
    };
    void renderAssistantJobDetail(container, job.id);
    try {
      await request(
        workApiUrl(`/api/assistant-jobs/${encodeURIComponent(job.id)}`),
        {
          method: "PUT",
          body: JSON.stringify(values),
        },
      );
      const refreshed = await refreshOperationsAssistantSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!routeIsFresh(routeToken)) return;
      if (
        !refreshed?.applied ||
        refreshed.errors?.length ||
        !state.assistantSnapshot.jobs.some((candidate) => candidate.id === job.id)
      ) {
        throw new Error(
          "The refreshed assistant queue did not confirm the saved draft.",
        );
      }
      const detail = await request(
        workApiUrl(`/api/assistant-jobs/${encodeURIComponent(job.id)}`),
      );
      if (!detail?.job && !detail?.id) throw new Error("Assistant detail refresh returned no job.");
      state.assistantMutation = {
        target: `job:${job.id}`,
        action: "",
        values: {},
        error: "",
        busy: false,
        status: "Draft fields are saved in the refreshed assistant job.",
        phase: "success",
        routeToken,
      };
      await renderAssistantJobDetail(container, job.id);
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
      const conflict = error.status === 409;
      state.assistantMutation = {
        target: `job:${job.id}`,
        action: "save",
        values,
        error: conflict
          ? `This assistant draft changed since it was loaded. Your edits are kept. Reload the current job, then retry saving. (${error.message || "conflict"})`
          : error.message || "Could not save assistant draft fields. Select Save draft fields to retry.",
        busy: false,
        status: "",
        phase: conflict ? "conflict" : "error",
        routeToken,
      };
      await renderAssistantJobDetail(container, job.id);
    }
  }

  async function renderAssistantJobDetail(container, jobId) {
    const routeToken = getActiveWorkspaceRouteToken();
    container.replaceChildren(
      assistantVisibleMessage(
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
        !container.isConnected ||
        !routeIsFresh(routeToken)
      )
        return;
      const job = payload.job || payload;
      const artifacts = payload.artifacts || [];
      const events = payload.events || [];
      const mutation =
        assistantMutation().target === `job:${jobId}`
          ? assistantMutation()
          : null;
      const editValues = mutation?.action === "save" ? mutation.values || {} : {};
      const mutationBusy =
        mutation?.target === `job:${jobId}` && mutation.busy;
      const currentAction = mutationBusy ? mutation.action : "";
      const actionButtons = assistantActionButtons(job)
        .map(([action, label]) => {
          const pending = currentAction === action;
          return `
            <button
              type="button"
              data-assistant-lifecycle="${action}"
              class="${action === "approve" ? "primary-button" : ""}"
              ${mutationBusy ? "disabled aria-busy=\"true\"" : ""}
            >
              ${escapeHtml(pending ? `${label}…` : label)}
            </button>
          `;
        })
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
            <input data-assistant-edit-title value="${escapeHtml(editValues.title ?? job.title ?? "")}">
          </label>
          <label>
            Assistant type
            <input data-assistant-edit-type value="${escapeHtml(editValues.assistantType ?? job.assistantType ?? "")}">
          </label>
          <label>
            Approval required
            <select data-assistant-edit-approval>
              <option value="true" ${(editValues.approvalRequired ?? job.approvalRequired !== false) ? "selected" : ""}>Yes</option>
              <option value="false" ${(editValues.approvalRequired ?? job.approvalRequired === false) ? "selected" : ""}>No</option>
            </select>
          </label>
          <button
            type="button"
            data-assistant-save
            ${job.status !== "draft" || mutationBusy ? "disabled aria-busy=\"true\"" : ""}
          >
            ${mutation?.busy && mutation.action === "save" ? "Saving draft fields…" : "Save draft fields"}
          </button>
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
      const feedback = renderAssistantFeedback(
        container,
        mutation?.target === `job:${jobId}` ? mutation : null,
      );
      if (mutation?.error) appendAssistantDetailRecovery(container, jobId);
      if (mutation?.error || mutation?.status) {
        scheduleAnimationFrame(() => {
          const target = mutation.error ? feedback.errorNode : feedback.statusNode;
          if (target?.isConnected) target.focus();
        });
      }
      container
        .querySelector("[data-assistant-save]")
        ?.addEventListener("click", () =>
          saveAssistantDraft(container, job, routeToken),
        );
      container
        .querySelectorAll("[data-assistant-lifecycle]")
        .forEach((button) =>
          button.addEventListener("click", () =>
            runAssistantAction(job, button.dataset.assistantLifecycle),
          ),
        );
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
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
    const sequence = ++assistantRefreshSequence;
    const snapshot = {
      loaded: false,
      jobs: [],
      errors: [],
    };
    try {
      const payload = await request(workApiUrl("/api/assistant-jobs"));
      if (sequence !== assistantRefreshSequence || !routeIsFresh(options.token)) {
        return { applied: false };
      }
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
      if (sequence !== assistantRefreshSequence || !routeIsFresh(options.token)) {
        return { applied: false };
      }
      snapshot.errors = [err?.message || "Assistant jobs API request failed"];
    }
    if (sequence !== assistantRefreshSequence || !routeIsFresh(options.token)) {
      return { applied: false };
    }
    state.assistantSnapshot = snapshot;
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
    return { applied: true, ...snapshot };
  }

  return {
    refreshOperationsAssistantSnapshot,
    renderAssistantsSurface,
  };
}
