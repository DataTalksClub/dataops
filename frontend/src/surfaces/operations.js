export function createAdminSurface(context) {
  const {
    apiUrl,
    buildOperationsHomeModel,
    clearSelectionButton,
    currentOperatorIdFromPayload,
    documentList,
    getActiveWorkspaceView,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    libraryTitle,
    listDraftPaths,
    refreshDocuments,
    renderHonestState,
    renderSurfaceHeader,
    request,
    setPageTitle,
    setStatus,
    settledPayload,
    showCreate,
    showErrorToast,
    showWorkspaceSurface,
    surfaceDescription,
    surfaceStatusText,
    usersFromWorkPayload,
    workApiUrl,
  } = context;

  const USER_ROLE_LABELS = { admin: "Admin", operator: "Operator" };
  let usersSnapshot = {
    loaded: false,
    users: [],
    currentUserId: "",
    isAdmin: false,
    errors: [],
  };

  function renderAdminSurfaceView(documents) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: getOperationsWorkSnapshot(),
      recurringSnapshot: getOperationsRecurringSnapshot(),
      qualitySnapshot: getOperationsQualitySnapshot(),
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Admin";
    setPageTitle("Admin", "Admin");
    clearSelectionButton.hidden = true;
    setStatus(surfaceStatusText("admin", model));

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-admin";
    wrap.append(renderSurfaceHeader("Admin", surfaceDescription("admin")));
    wrap.append(renderAdminSurface(model));

    documentList.replaceChildren(wrap);
  }
  function isCurrentUserAdmin() {
    return Boolean(usersSnapshot.isAdmin);
  }

  async function refreshUsersSurface(options = {}) {
    const usersUrl = workApiUrl("/api/users");
    const meUrl = workApiUrl("/api/me");
    const [usersResult, meResult] = await Promise.allSettled([
      request(usersUrl),
      request(meUrl),
    ]);
    const users = usersFromWorkPayload(settledPayload(usersResult));
    const currentUserId = currentOperatorIdFromPayload(
      settledPayload(meResult),
    );
    const current = users.find((u) => String(u?.id) === String(currentUserId));
    usersSnapshot = {
      loaded: usersResult.status === "fulfilled",
      users,
      currentUserId,
      isAdmin: current?.role === "admin",
      errors:
        usersResult.status === "rejected"
          ? [usersResult.reason?.message || "Failed to load users"]
          : [],
    };
    if (options.rerender && getActiveWorkspaceView() === "users")
      refreshDocuments();
  }

  function renderUsersSurfaceView() {
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Users";
    setPageTitle("Users", "Users");
    clearSelectionButton.hidden = true;
    const count = usersSnapshot.users.length;
    setStatus(
      usersSnapshot.loaded
        ? `${count} ${count === 1 ? "user" : "users"}.`
        : "Loading users…",
    );

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-users";
    wrap.append(
      renderSurfaceHeader(
        "Users",
        "People who can access this workspace. Admins can add, edit, and disable accounts.",
      ),
    );
    wrap.append(renderUsersSurface());
    documentList.replaceChildren(wrap);
  }

  function renderUsersSurface() {
    const section = document.createElement("section");
    section.className = "ops-state-list ops-users-surface";
    section.setAttribute("aria-label", "Users");

    if (!usersSnapshot.loaded) {
      section.append(
        renderHonestState(
          "Users unavailable",
          usersSnapshot.errors[0] || "Could not reach the work API.",
        ),
      );
      return section;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "ops-users-toolbar";
    if (isCurrentUserAdmin()) {
      const createButton = document.createElement("button");
      createButton.type = "button";
      createButton.className = "primary-button";
      createButton.textContent = "Add user";
      createButton.addEventListener("click", () => openUserForm(null));
      toolbar.append(createButton);
    }
    section.append(toolbar);

    const users = [...usersSnapshot.users].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || "")),
    );
    if (users.length === 0) {
      section.append(
        renderHonestState(
          "No users yet",
          "Add the first person with access to this workspace.",
        ),
      );
      return section;
    }

    const tableWrap = document.createElement("div");
    tableWrap.className = "ops-users-table-wrap";
    const table = document.createElement("table");
    table.className = "ops-users-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Name", "Email", "Role", "Created", ""]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const user of users) tbody.append(renderUserRow(user));
    table.append(tbody);
    tableWrap.append(table);
    section.append(tableWrap);
    return section;
  }

  function renderUserRow(user) {
    const row = document.createElement("tr");
    row.className = "ops-user-row";
    if (user.disabled) row.classList.add("is-disabled");

    const nameCell = document.createElement("td");
    nameCell.className = "ops-user-name";
    const name = document.createElement("strong");
    name.textContent = user.name || user.id || "Unnamed";
    nameCell.append(name);
    if (user.disabled) {
      const badge = document.createElement("span");
      badge.className = "ops-user-badge";
      badge.textContent = "disabled";
      nameCell.append(badge);
    }

    const emailCell = document.createElement("td");
    emailCell.textContent = user.email || "";
    emailCell.className = "ops-user-email";

    const roleCell = document.createElement("td");
    roleCell.className = "ops-user-role";
    roleCell.textContent =
      USER_ROLE_LABELS[user.role] || user.role || "Operator";

    const createdCell = document.createElement("td");
    createdCell.className = "ops-user-created";
    createdCell.textContent = formatUserCreated(user.createdAt);

    row.append(nameCell, emailCell, roleCell, createdCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "ops-user-actions";
    if (isCurrentUserAdmin()) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "quiet-button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => openUserForm(user));
      actionsCell.append(editButton);

      if (user.id !== usersSnapshot.currentUserId) {
        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.className = "quiet-button";
        toggleButton.textContent = user.disabled ? "Enable" : "Disable";
        toggleButton.addEventListener("click", () => toggleUserDisabled(user));
        actionsCell.append(toggleButton);
      }
    }
    row.append(actionsCell);
    return row;
  }

  function formatUserCreated(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function openUserForm(user) {
    const isEdit = Boolean(user && user.id);
    const panel = document.createElement("div");
    panel.className = "ops-user-form-panel";
    const heading = document.createElement("h3");
    heading.textContent = isEdit
      ? `Edit ${user.name || user.email || "user"}`
      : "Add user";
    panel.append(heading);

    const form = document.createElement("form");
    form.className = "ops-user-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const nameInput = labeledInput("Name", {
      value: user?.name || "",
      required: true,
    });
    const emailInput = labeledInput("Email", {
      value: user?.email || "",
      type: "email",
      required: true,
    });
    const roleSelect = document.createElement("select");
    for (const [value, label] of Object.entries(USER_ROLE_LABELS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      roleSelect.append(option);
    }
    roleSelect.value = user?.role || "operator";
    const roleLabel = document.createElement("label");
    roleLabel.className = "ops-field";
    roleLabel.append("Role", roleSelect);

    const passwordInput = labeledInput(
      isEdit ? "New password (optional)" : "Password",
      {
        type: "password",
        value: "",
        required: !isEdit,
      },
    );

    form.append(nameInput.wrap, emailInput.wrap, roleLabel, passwordInput.wrap);

    const actions = document.createElement("div");
    actions.className = "ops-user-form-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => renderUsersSurfaceView());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-button";
    submit.textContent = isEdit ? "Save changes" : "Create user";
    actions.append(cancel, submit);
    form.append(actions);

    const result = document.createElement("p");
    result.className = "ops-user-form-result";
    result.setAttribute("role", "status");

    submit.addEventListener("click", async () => {
      result.textContent = "";
      result.classList.remove("ops-error");
      const payload = {
        name: nameInput.input.value.trim(),
        email: emailInput.input.value.trim(),
        role: roleSelect.value,
      };
      if (passwordInput.input.value)
        payload.password = passwordInput.input.value;
      if (!payload.name || !payload.email) {
        result.textContent = "Name and email are required.";
        result.classList.add("ops-error");
        return;
      }
      submit.disabled = true;
      try {
        if (isEdit) {
          await request(workApiUrl(`/api/users/${user.id}`), {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
        } else {
          await request(workApiUrl("/api/users"), {
            method: "POST",
            body: JSON.stringify(payload),
          });
        }
        await refreshUsersSurface({ rerender: true });
      } catch (err) {
        submit.disabled = false;
        result.textContent = err?.message || "Could not save user.";
        result.classList.add("ops-error");
      }
    });

    panel.append(form, result);
    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-users";
    wrap.append(panel);
    documentList.replaceChildren(wrap);
    nameInput.input.focus();
  }

  async function toggleUserDisabled(user) {
    const next = !user.disabled;
    try {
      await request(workApiUrl(`/api/users/${user.id}`), {
        method: "PATCH",
        body: JSON.stringify({ disabled: next }),
      });
      await refreshUsersSurface({ rerender: true });
    } catch (err) {
      showErrorToast(err?.message || "Could not update user.");
    }
  }

  function labeledInput(
    labelText,
    { value = "", type = "text", required = false } = {},
  ) {
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.required = required;
    const label = document.createElement("label");
    label.className = "ops-field";
    label.append(labelText, input);
    return { input, wrap: label };
  }
  function renderAdminSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-admin-grid";
    const cards = [
      [
        "New process doc",
        "Create SOPs, templates, references, and playbooks in the git-backed content tree.",
        showCreate,
      ],
      [
        "Recurring config",
        `${model.recurring.configs.length} configs loaded. Generated tasks appear in Home and Work Queue.`,
        () => showWorkspaceSurface("templates"),
      ],
      [
        "Diagnostics",
        "Inspect local process quality and runtime availability without a mutation action.",
        () => section.querySelector(".ops-admin-diagnostics h3")?.focus(),
      ],
    ];
    for (const [title, body, action] of cards) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "ops-admin-card";
      const strong = document.createElement("strong");
      strong.textContent = title;
      const span = document.createElement("span");
      span.textContent = body;
      card.append(strong, span);
      card.addEventListener("click", action);
      section.append(card);
    }
    const diagnostics = document.createElement("section");
    diagnostics.className = "ops-section ops-admin-diagnostics";
    diagnostics.setAttribute("aria-label", "Read-only diagnostics");
    diagnostics.innerHTML = `
      <header>
        <h3>Read-only diagnostics</h3>
        <span>No pull, commit, publish, or provider action is available here.</span>
      </header>
      <article data-diagnostic="quality">
        <strong>Process quality</strong>
        <span>Loading local validation…</span>
      </article>
      <article data-diagnostic="git-status">
        <strong>Git status</strong>
        <span>Loading availability…</span>
      </article>
      <article data-diagnostic="git-history">
        <strong>Git history</strong>
        <span>Loading availability…</span>
      </article>
    `;
    diagnostics.querySelector("h3").tabIndex = -1;
    section.append(diagnostics);
    const diagnosticText = (name, value) => {
      const target = diagnostics.querySelector(
        `[data-diagnostic="${name}"] span`,
      );
      if (target && diagnostics.isConnected) target.textContent = value;
    };
    Promise.allSettled([
      request(apiUrl("/docs/process-quality")),
      request(apiUrl("/git/status")),
      request(apiUrl("/git/log")),
    ]).then(([quality, gitStatus, gitHistory]) => {
      diagnosticText(
        "quality",
        quality.status === "fulfilled"
          ? `${quality.value.summary?.total || 0} finding(s); ${quality.value.validationErrors?.length || 0} validation error(s).`
          : `Unavailable: ${quality.reason?.message || "request failed"}`,
      );
      diagnosticText(
        "git-status",
        gitStatus.status === "fulfilled"
          ? gitStatus.value.ok
            ? `${gitStatus.value.count || 0} changed file(s) on ${gitStatus.value.branch || "unknown"}.`
            : gitStatus.value.error || "Unavailable in this runtime."
          : `Unavailable: ${gitStatus.reason?.message || "request failed"}`,
      );
      diagnosticText(
        "git-history",
        gitHistory.status === "fulfilled"
          ? gitHistory.value.available === false
            ? gitHistory.value.error || "Unavailable in this runtime."
            : `${gitHistory.value.commits?.length || 0} commit(s) returned.`
          : `Unavailable: ${gitHistory.reason?.message || "request failed"}`,
      );
    });
    return section;
  }

  return {
    refreshUsersSurface,
    renderAdminSurface,
    renderAdminSurfaceView,
    renderUsersSurfaceView,
  };
}

export function createOperationsSurface(context) {
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
    openBundlePanel,
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
    const bundle = (state.workSnapshot.bundles || []).find(
      (candidate) => candidate.id === job.bundleId,
    );
    if (bundle) return `card ${bundle.title || bundle.id}`;
    if (job.bundleId) return `card ${job.bundleId}`;
    if (job.taskId) return `task ${job.taskId}`;
    return "";
  }

  function renderAssistantCreatePanel() {
    const panel = document.createElement("section");
    panel.className = "assistant-panel";
    const bundles = state.workSnapshot.bundles || [];
    const bundleOptions = bundles
      .map(
        (bundle) => `
          <option value="${escapeHtml(bundle.id)}">
            ${escapeHtml(bundle.title || bundle.id)}
          </option>
        `,
      )
      .join("");
    panel.innerHTML = `
      <h3>Request DataOps Assistant help</h3>
      <div class="assistant-create-grid">
        <label>
          Card
          <select data-assistant-bundle>
            <option value="">Select card</option>
            ${bundleOptions}
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
    const bundleSelect = panel.querySelector("[data-assistant-bundle]");
    const taskSelect = panel.querySelector("[data-assistant-task]");
    bundleSelect.addEventListener("change", async () => {
      taskSelect.innerHTML = `<option value="">Card-level job</option>`;
      if (!bundleSelect.value) return;
      try {
        const payload = await request(
          workApiUrl("/api/tasks", { bundleId: bundleSelect.value }),
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
        const bundleId = bundleSelect.value;
        const taskId = taskSelect.value;
        if (!bundleId && !taskId)
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
        if (bundleId) inputRefs.push({ type: "bundle", id: bundleId });
        if (taskId) inputRefs.push({ type: "task", id: taskId });
        try {
          const created = await request(workApiUrl("/api/assistant-jobs"), {
            method: "POST",
            body: JSON.stringify({
              assistantType,
              title,
              bundleId: bundleId || undefined,
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

  function intakeMatchesFilter(item, filter) {
    const status = String(item?.status || "new");
    const followUp = String(item?.followUpAt || "").slice(0, 10);
    const assistantReady = item?.assistantReadiness?.status === "ready";
    if (filter === "new") return status === "new";
    if (filter === "blocked") return status === "blocked";
    if (filter === "due")
      return (
        status === "blocked" &&
        !(item.taskIds || []).length &&
        followUp &&
        followUp <= todayIsoDate()
      );
    if (filter === "future")
      return status === "blocked" && followUp > todayIsoDate();
    if (filter === "assistant-ready") return assistantReady;
    if (filter === "resolved")
      return [
        "attached",
        "converted",
        "ignored",
        "duplicate",
        "archived",
      ].includes(status);
    if (filter === "all") return true;
    return status === "new" || status === "blocked" || assistantReady;
  }

  function intakeMeta(item) {
    return [
      item.source,
      item.priority,
      item.dataClass,
      item.status === "blocked" && item.waitingFor
        ? `waiting for ${item.waitingFor}`
        : "",
      item.status === "blocked" && item.followUpAt
        ? `follow up ${String(item.followUpAt).slice(0, 10)}`
        : "",
      item.sourceReceivedAt ? String(item.sourceReceivedAt).slice(0, 10) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function intakeStatusLabel(item) {
    return item?.assistantReadiness?.status === "ready"
      ? "assistant ready"
      : String(item?.status || "new").replace(/-/g, " ");
  }

  async function refreshIntakeSnapshot(options = {}) {
    try {
      const [intakePayload, bundlePayload] = await Promise.all([
        request(workApiUrl("/api/intake")),
        request(workApiUrl("/api/bundles")),
      ]);
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      state.intake = {
        ...state.intake,
        items: Array.isArray(intakePayload)
          ? intakePayload
          : intakePayload.items || [],
        bundles: Array.isArray(bundlePayload)
          ? bundlePayload
          : bundlePayload.bundles || [],
        loaded: true,
        error: "",
      };
    } catch (error) {
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      state.intake = {
        ...state.intake,
        loaded: false,
        error: error.message || "Inbox could not be loaded",
      };
    }
    if (
      options.rerender &&
      getActiveWorkspaceView() === "inbox" &&
      isOperationsHomeVisible()
    )
      renderInboxSurface();
  }

  async function resolveIntakeRouteEntity(route, token) {
    await refreshIntakeSnapshot({ token });
    if (!isWorkspaceRouteFresh(token)) return;
    const intakeId = route.params.get("intakeId");
    if (!intakeId) {
      state.workspaceEntity = null;
      renderInboxSurface();
      return;
    }
    let item = state.intake.items.find(
      (candidate) => candidate.id === intakeId,
    );
    if (!item) {
      state.workspaceEntity = {
        kind: "intake",
        id: intakeId,
        status: "loading",
      };
      renderInboxSurface();
      try {
        const payload = await request(
          workApiUrl(`/api/intake/${encodeURIComponent(intakeId)}`),
        );
        if (!isWorkspaceRouteFresh(token)) return;
        item = payload.item || payload;
        state.intake.items = [
          item,
          ...state.intake.items.filter((candidate) => candidate.id !== item.id),
        ];
      } catch (error) {
        if (!isWorkspaceRouteFresh(token)) return;
        state.workspaceEntity = {
          kind: "intake",
          id: intakeId,
          status: error.status === 404 ? "not-found" : "error",
          error: error.message,
        };
        renderInboxSurface();
        return;
      }
    }
    state.workspaceEntity = { kind: "intake", id: intakeId, status: "ready" };
    state.intake.selectedId = intakeId;
    renderInboxSurface();
  }

  async function mutateIntake(itemId, action, data, successMessage) {
    try {
      const payload = await request(
        workApiUrl(`/api/intake/${encodeURIComponent(itemId)}/${action}`),
        {
          method: "POST",
          body: JSON.stringify(data || {}),
        },
      );
      setStatus(successMessage);
      await refreshIntakeSnapshot({ rerender: true });
      return payload;
    } catch (error) {
      reportError(error.message || "Intake action failed");
      return null;
    }
  }

  function renderInboxSurface() {
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Inbox";
    setPageTitle("Inbox", "Inbox");
    clearSelectionButton.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-inbox";
    const intro = document.createElement("p");
    intro.className = "ops-surface-intro";
    intro.textContent =
      "Capture raw operational inputs, then attach, convert, defer, resolve, or prepare them for an assistant.";
    wrap.append(intro);
    wrap.append(renderManualIntakeForm());

    const filters = document.createElement("nav");
    filters.className = "ops-subnav intake-filter-bar";
    filters.setAttribute("aria-label", "Inbox filters");
    for (const [id, label] of [
      ["actionable", "Actionable"],
      ["new", "New"],
      ["blocked", "Blocked"],
      ["due", "Due"],
      ["future", "Future"],
      ["assistant-ready", "Assistant-ready"],
      ["resolved", "Resolved"],
      ["all", "All"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ops-subnav-tab ${state.intake.filter === id ? "is-active" : ""}`;
      button.textContent = label;
      button.addEventListener("click", () => {
        state.intake.filter = id;
        navigateCanonicalWorkspace("/inbox");
      });
      filters.append(button);
    }
    wrap.append(filters);

    if (state.intake.error) {
      wrap.append(renderHonestState("Inbox unavailable", state.intake.error));
      documentList.replaceChildren(wrap);
      setStatus(`Inbox unavailable: ${state.intake.error}`);
      return;
    }
    if (!state.intake.loaded) {
      wrap.append(
        renderHonestState(
          "Loading inbox",
          "Fetching intake items and Card relationships.",
        ),
      );
      documentList.replaceChildren(wrap);
      setStatus("Loading inbox…");
      return;
    }

    const filtered = state.intake.items.filter((item) =>
      intakeMatchesFilter(item, state.intake.filter),
    );
    const selected =
      state.intake.items.find((item) => item.id === state.intake.selectedId) ||
      null;
    state.intake.selectedId = selected?.id || null;
    const layout = document.createElement("div");
    layout.className = "intake-layout";
    layout.classList.toggle("has-selected-intake", Boolean(selected));
    layout.append(renderIntakeQueue(filtered), renderIntakeDetail(selected));
    wrap.append(layout);
    documentList.replaceChildren(wrap);
    if (selected && isMobileShell()) {
      scheduleAnimationFrame(() => {
        const detail = documentList.querySelector(".intake-detail");
        if (detail && state.intake.selectedId === selected.id)
          detail.scrollIntoView({ block: "start" });
      });
    }
    setStatus(
      `${filtered.length} inbox item${filtered.length === 1 ? "" : "s"} in ${state.intake.filter}.`,
    );
  }

  function renderManualIntakeForm() {
    const panel = document.createElement("details");
    panel.className = "intake-panel";
    panel.innerHTML = `
      <summary>Capture a new intake item</summary>
      <div class="intake-create-grid">
        <label class="wide">
          Note
          <textarea
            data-intake-create-note
            placeholder="Paste the request, context, and safe links"
          ></textarea>
        </label>
        <label>
          Title
          <input data-intake-create-title placeholder="Short subject">
        </label>
        <label>
          Data class
          <select data-intake-create-class>
            <option>internal</option>
            <option>public</option>
            <option>private</option>
            <option>sensitive</option>
          </select>
        </label>
        <label>
          Tags
          <input data-intake-create-tags placeholder="comma,separated">
        </label>
        <button class="primary-button" data-intake-create>Capture intake</button>
      </div>
    `;
    panel
      .querySelector("[data-intake-create]")
      .addEventListener("click", async () => {
        const note = panel
          .querySelector("[data-intake-create-note]")
          .value.trim();
        const title = panel
          .querySelector("[data-intake-create-title]")
          .value.trim();
        if (!note && !title)
          return reportError("Add a note or title before capturing intake.");
        try {
          await request(workApiUrl("/api/intake"), {
            method: "POST",
            body: JSON.stringify({
              source: "manual",
              title: title || note.split(/\r?\n/)[0],
              note: note || title,
              dataClass: panel.querySelector("[data-intake-create-class]")
                .value,
              tags: panel
                .querySelector("[data-intake-create-tags]")
                .value.split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            }),
          });
          state.intake.filter = "actionable";
          setStatus("Manual intake captured.");
          await refreshIntakeSnapshot({ rerender: true });
        } catch (error) {
          reportError(error.message || "Could not capture intake");
        }
      });
    return panel;
  }

  function renderIntakeQueue(items) {
    const panel = document.createElement("section");
    panel.className = "intake-panel intake-queue";
    const title = document.createElement("h3");
    title.textContent = "Inbox queue";
    panel.append(title);
    if (!items.length) {
      panel.append(
        renderHonestState(
          "No matching intake",
          "Choose another filter or capture a new item.",
        ),
      );
      return panel;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `intake-row ${item.id === state.intake.selectedId ? "is-selected" : ""}`;
      button.innerHTML = `
        <span>
          <strong>${escapeHtml(item.title || "Untitled intake")}</strong>
          <small>${escapeHtml(intakeMeta(item))}</small>
          <span>${escapeHtml(String(item.summary || "").slice(0, 180))}</span>
        </span>
        <em>${escapeHtml(intakeStatusLabel(item))}</em>
      `;
      button.addEventListener("click", () => {
        navigateCanonicalWorkspace("/inbox", { intakeId: item.id });
      });
      panel.append(button);
    }
    return panel;
  }

  function intakeRefList(label, values) {
    const items = (values || []).filter(Boolean);
    const references = items.length
      ? items
          .map((value) => {
            const title =
              typeof value === "string"
                ? value
                : value.title ||
                  value.filename ||
                  value.url ||
                  value.normalizedUrl ||
                  value.artifactId ||
                  value.fileId ||
                  "reference";
            return `<code>${escapeHtml(title)}</code>`;
          })
          .join(" ")
      : "None";
    return `
      <div class="intake-reference-group">
        <strong>${escapeHtml(label)}</strong>
        <span>${references}</span>
      </div>
    `;
  }

  function renderIntakeDetail(item) {
    const panel = document.createElement("section");
    panel.className = "intake-panel intake-detail";
    if (!item) {
      if (
        state.workspaceEntity?.kind === "intake" &&
        ["not-found", "error"].includes(state.workspaceEntity.status)
      ) {
        renderEntityLoadState(panel, {
          ...state.workspaceEntity,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => {
            navigateCanonicalWorkspace("/inbox");
          },
        });
        return panel;
      }
      panel.append(
        renderHonestState(
          "Intake detail",
          "Select an intake item to triage it into a Task or Card.",
        ),
      );
      return panel;
    }
    const bundleOptions = [
      `<option value="">No card</option>`,
      ...state.intake.bundles.map(
        (bundle) => `
          <option value="${escapeHtml(bundle.id)}">
            ${escapeHtml(bundle.title || bundle.id)}
          </option>
        `,
      ),
    ].join("");
    const taskRelationships =
      (item.taskIds || [])
        .map(
          (id) => `
            <button type="button" data-open-intake-task="${escapeHtml(id)}">
              Task ${escapeHtml(id)}
            </button>
          `,
        )
        .join(" ") || "None";
    const bundleRelationships =
      (item.bundleIds || [])
        .map(
          (id) => `
            <button type="button" data-open-intake-bundle="${escapeHtml(id)}">
              ${escapeHtml(state.intake.bundles.find((bundle) => bundle.id === id)?.title || id)}
            </button>
          `,
        )
        .join(" ") || "None";
    const assistantRelationships =
      (item.assistantJobIds || [])
        .map(
          (id) => `
            <button type="button" data-open-intake-assistant="${escapeHtml(id)}">
              Assistant job ${escapeHtml(id)}
            </button>
          `,
        )
        .join(" ") || "None";
    const history = renderIntakeHistoryMarkup(item.history || []);
    const actionMarkup = intakeActionMarkup(item, bundleOptions);
    panel.innerHTML = `
      <header>
        <div>
          <h3>${escapeHtml(item.title || "Untitled intake")}</h3>
          <small>${escapeHtml(intakeMeta(item))}</small>
        </div>
        <div class="intake-detail-heading-actions">
          <span class="intake-status">${escapeHtml(intakeStatusLabel(item))}</span>
          <button type="button" data-close-intake>Return to Inbox</button>
        </div>
      </header>
      <section>
        <h4>Intake context</h4>
        <p>${escapeHtml(item.summary || "")}</p>
        <small>
          Raw bodies and binaries remain behind storage references; this excerpt is not task proof.
        </small>
      </section>
      ${actionMarkup}
      <section>
        <h4>Relationships</h4>
        <div><strong>Tasks:</strong> ${taskRelationships}</div>
        <div><strong>Cards:</strong> ${bundleRelationships}</div>
        <div><strong>Assistants:</strong> ${assistantRelationships}</div>
      </section>
      <section>
        <h4>Links, files, and artifacts</h4>
        ${intakeRefList("Links", item.linkRefs)}
        ${intakeRefList("Files", item.fileRefs)}
        ${intakeRefList("Artifacts", item.artifactRefs)}
      </section>
      <section aria-labelledby="intake-history-heading">
        <h4 id="intake-history-heading">
          History <small>(newest first)</small>
        </h4>
        <ol class="intake-history">
          ${history || "<li>No triage history recorded.</li>"}
        </ol>
      </section>
    `;

    panel.querySelector("[data-close-intake]").addEventListener("click", () => {
      navigateCanonicalWorkspace("/inbox");
    });

    panel
      .querySelectorAll("[data-open-intake-task]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openTaskPanel(button.dataset.openIntakeTask),
        ),
      );
    panel
      .querySelectorAll("[data-open-intake-bundle]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openBundlePanel(button.dataset.openIntakeBundle),
        ),
      );
    panel.querySelectorAll("[data-open-intake-assistant]").forEach((button) =>
      button.addEventListener("click", () => {
        navigateCanonicalWorkspace("/assistants", {
          assistantJobId: button.dataset.openIntakeAssistant,
        });
      }),
    );
    panel
      .querySelectorAll("[data-intake-submit]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          submitIntakeAction(panel, item, button.dataset.intakeSubmit),
        ),
      );
    if (state.intakeMutation.itemId === item.id && state.intakeMutation.error) {
      const error = panel.querySelector("[data-intake-inline-error]");
      if (error) scheduleAnimationFrame(() => error.focus());
    }
    return panel;
  }

  function intakeActionMarkup(item, bundleOptions) {
    const status = String(item.status || "new");
    const due =
      status === "blocked" &&
      String(item.followUpAt || "").slice(0, 10) <= todayIsoDate();
    const resolved = ["duplicate", "ignored", "archived"].includes(status);
    const related =
      ["attached", "converted"].includes(status) ||
      item.assistantReadiness?.status === "ready";
    const mutation =
      state.intakeMutation.itemId === item.id
        ? state.intakeMutation
        : { values: {}, error: "", status: "" };
    const values = mutation.values || {};
    const value = (name, fallback = "") => escapeHtml(values[name] ?? fallback);
    const disclosure = (
      action,
      label,
      fields,
      primary = false,
      destructive = false,
    ) => `
      <details
        class="intake-action-disclosure ${primary ? "is-primary" : ""} ${destructive ? "is-destructive" : ""}"
        ${mutation.action === action && mutation.error ? "open" : ""}
      >
        <summary>${escapeHtml(label)}</summary>
        <div class="intake-action-fields">
          ${fields}
          <button
            type="button"
            class="${primary ? "primary-button" : destructive ? "danger-button" : ""}"
            data-intake-submit="${action}"
            ${mutation.busy ? "disabled" : ""}
          >
            ${escapeHtml(label)}
          </button>
        </div>
      </details>
    `;
    if (resolved) {
      return `
        <section class="intake-resolution-summary">
          <h4>Resolution</h4>
          <p>
            This item is ${escapeHtml(status)} and read-only.
            ${item.resolutionReason ? ` ${escapeHtml(item.resolutionReason)}` : ""}
          </p>
        </section>
      `;
    }
    if (related) {
      const assistantJobId = item.assistantJobIds?.[0];
      const taskId = item.taskIds?.[0];
      const bundleId = item.bundleIds?.[0];
      const continuation = assistantJobId
        ? `<button type="button" class="primary-button" data-open-intake-assistant="${escapeHtml(assistantJobId)}">Continue assistant job</button>`
        : taskId
          ? `<button type="button" class="primary-button" data-open-intake-task="${escapeHtml(taskId)}">Continue task</button>`
          : bundleId
            ? `<button type="button" class="primary-button" data-open-intake-bundle="${escapeHtml(bundleId)}">Open card</button>`
            : "";
      const createAssistant =
        item.assistantReadiness?.status === "ready" && !assistantJobId
          ? disclosure(
              "prepare-assistant",
              "Create assistant draft",
              `
                <label>
                  Assistant type
                  <input
                    name="assistantType"
                    value="${value("assistantType", item.assistantReadiness?.assistantType || "podcast")}"
                  >
                </label>
                <input name="createJob" value="true" type="hidden">
              `,
              !continuation,
            )
          : "";
      return `
        <section class="intake-next-actions">
          <h4>Continue work</h4>
          <p>Continue from the exact linked record.</p>
          ${continuation}
          ${createAssistant}
        </section>
        ${intakeMutationFeedback(item)}
      `;
    }
    const convert = disclosure(
      "convert-task",
      "Convert to task",
      `
        <label>
          Task date
          <input name="date" type="date" value="${value("date", todayIsoDate())}">
        </label>
        <label>
          Assignee
          <input
            name="assigneeId"
            value="${value("assigneeId", item.assigneeId || "")}"
            placeholder="User id"
          >
        </label>
        <label>
          Card
          <select name="bundleId">${bundleOptions}</select>
        </label>
      `,
      true,
    );
    const attach = disclosure(
      "attach",
      "Attach to existing work",
      `
        <label>
          Task ID
          <input name="taskId" value="${value("taskId")}" placeholder="Existing task id">
        </label>
        <label>
          Card
          <select name="bundleId">${bundleOptions}</select>
        </label>
        <label>
          Note
          <input name="note" value="${value("note")}" placeholder="Optional context">
        </label>
      `,
    );
    const block = disclosure(
      "block",
      "Block and schedule follow-up",
      `
        <label>
          Reason
          <input name="reason" value="${value("reason", item.blockedReason || "")}" required>
        </label>
        <label>
          Waiting for
          <input name="waitingFor" value="${value("waitingFor", item.waitingFor || "")}" required>
        </label>
        <label>
          Follow up
          <input
            name="followUpAt"
            type="date"
            value="${value("followUpAt", String(item.followUpAt || "").slice(0, 10) || defaultNextFollowUpDate())}"
            required
          >
        </label>
      `,
    );
    const follow = disclosure(
      "follow-up-sent",
      "Record follow-up sent",
      `
        <label>
          Operational note
          <input name="note" value="${value("note")}" required>
        </label>
        <label>
          Next follow-up
          <input
            name="nextFollowUpAt"
            type="date"
            value="${value("nextFollowUpAt", defaultNextFollowUpDate())}"
            required
          >
        </label>
      `,
      due,
    );
    const response = disclosure(
      "response-received",
      "Record response received",
      `
        <label>
          Operational note
          <input name="note" value="${value("note")}" required>
        </label>
      `,
      status === "blocked" && !due,
    );
    const assistant = disclosure(
      "prepare-assistant",
      "Prepare assistant input",
      `
        <label>
          Assistant type
          <input
            name="assistantType"
            value="${value("assistantType", item.assistantReadiness?.assistantType || "podcast")}"
          >
        </label>
        <label>
          Create job
          <select name="createJob">
            <option value="false">Prepare references only</option>
            <option value="true">Create draft job</option>
          </select>
        </label>
      `,
    );
    const reasonField = `
      <label>
        Reason
        <input name="reason" value="${value("reason")}" required>
      </label>
    `;
    const destructive = `
      <details class="intake-secondary-actions">
        <summary>Resolution actions</summary>
        ${disclosure(
          "mark-duplicate",
          "Mark duplicate",
          `
            <label>
              Duplicate of
              <input
                name="duplicateOfIntakeItemId"
                value="${value("duplicateOfIntakeItemId")}"
                required
              >
            </label>
            ${reasonField}
          `,
          false,
          true,
        )}
        ${disclosure("ignore", "Ignore item", reasonField, false, true)}
        ${disclosure("archive", "Archive item", reasonField, false, true)}
      </details>
    `;
    const otherActions =
      status === "blocked"
        ? `
          ${due ? follow : response}
          <details class="intake-secondary-actions">
            <summary>Other valid actions</summary>
            ${due ? response : follow}
          </details>
        `
        : `
          ${convert}
          <details class="intake-secondary-actions">
            <summary>Other valid actions</summary>
            ${attach}
            ${block}
            ${assistant}
          </details>
          ${destructive}
        `;
    return `
      <section class="intake-next-actions">
        <h4>Next action</h4>
        ${otherActions}
        ${intakeMutationFeedback(item)}
      </section>
    `;
  }

  function intakeMutationFeedback(item) {
    if (state.intakeMutation.itemId !== item.id) {
      return `
        <p
          class="intake-inline-feedback"
          data-intake-inline-error
          tabindex="-1"
          aria-live="polite"
        ></p>
      `;
    }
    const role = state.intakeMutation.error ? "alert" : "status";
    return `
      <p
        class="intake-inline-feedback ${state.intakeMutation.error ? "is-error" : ""}"
        data-intake-inline-error
        tabindex="-1"
        role="${role}"
        aria-live="assertive"
      >
        ${escapeHtml(state.intakeMutation.error || state.intakeMutation.status || "")}
      </p>
    `;
  }

  async function submitIntakeAction(panel, item, action) {
    if (state.intakeMutation.busy) return;
    const details = panel
      .querySelector(`[data-intake-submit="${cssEscape(action)}"]`)
      ?.closest("details");
    details
      .querySelectorAll("[aria-invalid]")
      .forEach((field) => field.removeAttribute("aria-invalid"));
    const values = Object.fromEntries(
      [...details.querySelectorAll("input,select,textarea")].map((field) => [
        field.name,
        field.value.trim(),
      ]),
    );
    const missing = [
      ...details.querySelectorAll(
        "input[required],select[required],textarea[required]",
      ),
    ].find((field) => !values[field.name]);
    if (missing) {
      const labels = {
        duplicateOfIntakeItemId: "Duplicate of",
        reason: "Reason",
        waitingFor: "Waiting for",
        followUpAt: "Follow up",
        note: "Operational note",
        nextFollowUpAt: "Next follow-up",
      };
      state.intakeMutation = {
        itemId: item.id,
        action,
        values,
        error: `${labels[missing.name] || "This field"} is required.`,
        busy: false,
        status: "",
      };
      missing.setAttribute("aria-invalid", "true");
      const error = panel.querySelector("[data-intake-inline-error]");
      if (error) {
        error.classList.add("is-error");
        error.setAttribute("role", "alert");
        error.setAttribute("aria-live", "assertive");
        error.textContent = state.intakeMutation.error;
      }
      missing.focus();
      return;
    }
    state.intakeMutation = {
      itemId: item.id,
      action,
      values,
      error: "",
      busy: true,
      status: "Saving…",
    };
    renderInboxSurface();
    const payloadByAction = {
      attach: {
        taskIds: values.taskId ? [values.taskId] : [],
        bundleIds: values.bundleId ? [values.bundleId] : [],
        note: values.note || undefined,
      },
      "convert-task": {
        date: values.date,
        assigneeId: values.assigneeId || undefined,
        bundleId: values.bundleId || undefined,
      },
      "mark-duplicate": {
        duplicateOfIntakeItemId: values.duplicateOfIntakeItemId,
        reason: values.reason,
      },
      block: {
        reason: values.reason,
        waitingFor: values.waitingFor,
        followUpAt: values.followUpAt,
      },
      "follow-up-sent": {
        note: values.note,
        nextFollowUpAt: values.nextFollowUpAt,
        channel: "intake",
      },
      "response-received": { note: values.note },
      "prepare-assistant": {
        assistantType: values.assistantType,
        createJob: values.createJob === "true",
      },
      ignore: { reason: values.reason },
      archive: { reason: values.reason },
    };
    try {
      const result = await request(
        workApiUrl(`/api/intake/${encodeURIComponent(item.id)}/${action}`),
        { method: "POST", body: JSON.stringify(payloadByAction[action]) },
      );
      state.intakeMutation = {
        itemId: item.id,
        action: "",
        values: {},
        error: "",
        busy: false,
        status: `${humanizeIntakeAction(action)} recorded.`,
      };
      await refreshIntakeSnapshot();
      renderInboxSurface();
      const createdTaskId =
        result.task?.id || (action === "attach" ? values.taskId : "");
      if (createdTaskId) openTaskPanel(createdTaskId);
      else if (action === "attach" && values.bundleId)
        openBundlePanel(values.bundleId);
    } catch (error) {
      state.intakeMutation = {
        itemId: item.id,
        action,
        values,
        error: error.message || "Intake action failed",
        busy: false,
        status: "",
      };
      renderInboxSurface();
    }
  }

  function humanizeIntakeAction(action) {
    return (
      {
        "manual-created": "Captured manually",
        created: "Captured",
        updated: "Updated details",
        attached: "Attached to work",
        "converted-to-task": "Converted to task",
        duplicate: "Marked as duplicate",
        blocked: "Blocked for a response",
        "follow-up-sent": "Follow-up sent",
        "response-received": "Response received",
        unblocked: "Unblocked",
        "assistant-input-prepared": "Prepared assistant input",
        "assistant-job-created": "Created assistant job",
        "assistant-job-queued": "Queued assistant job",
        ignored: "Ignored",
        archived: "Archived",
        "reference-registered": "Added a reference",
      }[action] || String(action || "Updated").replace(/[-_]/g, " ")
    );
  }

  function formatBerlinDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      return { datetime: "", text: String(value || "Unknown time") };
    return {
      datetime: date.toISOString(),
      text: new Intl.DateTimeFormat("en-GB", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Berlin",
        timeZoneName: "short",
      }).format(date),
    };
  }

  function renderIntakeHistoryMarkup(events) {
    return [...events]
      .sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
      )
      .map((event) => {
        const when = formatBerlinDateTime(event.createdAt);
        const context = [
          event.actorId ? `by ${event.actorId}` : "",
          event.reason || "",
          event.metadata?.waitingFor
            ? `waiting for ${event.metadata.waitingFor}`
            : "",
          event.metadata?.followUpAt
            ? `follow-up ${formatBerlinDateTime(event.metadata.followUpAt).text}`
            : "",
          event.metadata?.taskId ? `task ${event.metadata.taskId}` : "",
          event.metadata?.bundleId ? `card ${event.metadata.bundleId}` : "",
          event.metadata?.assistantJobId
            ? `assistant ${event.metadata.assistantJobId}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const timestamp = when.datetime
          ? `
              <time datetime="${escapeHtml(when.datetime)}">
                ${escapeHtml(when.text)}
              </time>
            `
          : escapeHtml(when.text);
        return `
          <li>
            <strong>${escapeHtml(humanizeIntakeAction(event.action))}</strong>
            <span>
              ${timestamp}
              ${context ? ` · ${escapeHtml(context)}` : ""}
            </span>
          </li>
        `;
      })
      .join("");
  }

  function renderArtifactsSurface() {
    const section = document.createElement("section");
    section.className = "ops-state-list";
    section.setAttribute("aria-label", "Artifacts");
    if (!state.artifactSnapshot.loaded) {
      section.append(
        renderHonestState(
          "Artifact review index not connected",
          "Task and Card panels still show artifacts loaded in context. This surface will list proof and output across Cards when the artifact index is available.",
        ),
      );
      return section;
    }
    if (state.artifactSnapshot.artifacts.length === 0) {
      section.append(
        renderHonestState(
          "No artifacts registered",
          "There are no artifact rows to review. No generated assistant outputs or proof links are being invented.",
        ),
      );
      return section;
    }
    for (const artifact of state.artifactSnapshot.artifacts)
      section.append(renderArtifactSurfaceRow(artifact));
    return section;
  }

  function renderArtifactSurfaceRow(artifact) {
    const row = document.createElement("article");
    row.className = "ops-data-row";
    const title = document.createElement("strong");
    title.textContent =
      artifact.title || artifact.storageUri || artifact.id || "Artifact";
    const meta = document.createElement("span");
    meta.textContent = [
      artifact.status || "draft",
      artifact.type || artifact.sourceType || "",
      artifact.bundleId ? `card ${artifact.bundleId}` : "",
      artifact.taskId ? `task ${artifact.taskId}` : "",
      artifact.storageUri ? "storage linked" : "storage missing",
    ]
      .filter(Boolean)
      .join(" · ");
    row.append(title, meta);
    if (artifact.storageUri) {
      const link = document.createElement("a");
      link.href = artifact.storageUri;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open";
      row.append(link);
    }
    return row;
  }

  async function refreshOperationsArtifactSnapshot(options = {}) {
    const snapshot = {
      loaded: false,
      artifacts: [],
      errors: [],
    };
    try {
      const payload = await request(workApiUrl("/api/artifacts"));
      const artifacts = Array.isArray(payload) ? payload : payload?.artifacts;
      if (Array.isArray(artifacts)) {
        snapshot.loaded = true;
        snapshot.artifacts = artifacts;
      } else {
        snapshot.errors = [
          "Artifact review index is not connected in this environment.",
        ];
      }
    } catch (err) {
      snapshot.errors = [err?.message || "Artifacts API request failed"];
    }
    state.artifactSnapshot = {
      loaded: snapshot.loaded,
      artifacts: dedupeArtifacts(snapshot.artifacts),
      errors: snapshot.errors,
    };
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
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
    refreshIntakeSnapshot,
    refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot,
    renderArtifactsSurface,
    renderAssistantsSurface,
    renderInboxSurface,
    resolveIntakeRouteEntity,
  };
}
