import {
  createFormFeedback,
  renderDataSummary,
  reportFieldValidation,
  setControlPending,
} from "../operations-overview.js";

export function createAdminSurface(context) {
  const {
    apiUrl,
    buildOperationsHomeModel,
    clearSelectionButton,
    currentOperatorIdFromPayload,
    documentList,
    getActiveWorkspaceView,
    getActiveWorkspaceRouteToken,
    isWorkspaceRouteFresh,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    libraryTitle,
    listDraftPaths,
    refreshDocuments,
    renderHonestState,
    renderSurfaceHeader,
    request,
    setRouteTitle,
    settledPayload,
    showWorkspaceSurface,
    surfaceDescription,
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
  // Durable confirmation of the last completed mutation, shown once against the
  // refreshed server state and then forgotten, and per-row recovery text for a
  // mutation that failed where it was started.
  let usersOutcome = "";
  const userRowErrors = new Map();

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
    setRouteTitle("Admin");
    clearSelectionButton.hidden = true;

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
    setRouteTitle("Users");
    clearSelectionButton.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-users";
    wrap.append(
      renderSurfaceHeader(
        "Users",
        "People who can access this workspace. Admins can add, edit, and disable accounts.",
      ),
      renderUsersSummary(),
    );
    if (usersOutcome) {
      const outcome = document.createElement("p");
      outcome.className = "ops-users-outcome";
      outcome.setAttribute("role", "status");
      outcome.tabIndex = -1;
      outcome.textContent = usersOutcome;
      usersOutcome = "";
      wrap.append(outcome);
      wrap.append(renderUsersSurface());
      documentList.replaceChildren(wrap);
      outcome.focus();
      return;
    }
    wrap.append(renderUsersSurface());
    documentList.replaceChildren(wrap);
  }

  // Users reports its own load state: still fetching, unreachable, empty, or a
  // real count. Recovery is a retry of the same fetch, in the surface itself.
  function renderUsersSummary() {
    const count = usersSnapshot.users.length;
    return renderDataSummary({
      id: "users",
      label: "Users",
      loaded: usersSnapshot.loaded,
      errors: usersSnapshot.errors,
      empty: count === 0,
      messages: {
        loading: "Loading users from the work API…",
        unavailable: "Users could not be loaded, so no accounts are listed.",
        empty: "No users have access to this workspace yet.",
        partial: `${count} ${count === 1 ? "user" : "users"}. Some account data is unavailable.`,
        ready: `${count} ${count === 1 ? "user" : "users"}.`,
      },
      retryLabel: "Retry loading users",
      onRetry: () => refreshUsersSurface({ rerender: true }),
    });
  }

  function renderUsersSurface() {
    const section = document.createElement("section");
    section.className = "ops-state-list ops-users-surface";
    section.setAttribute("aria-label", "Users");

    // The summary above already names the outage and owns the retry; repeating
    // it here would be a second voice for the same fact.
    if (!usersSnapshot.loaded) return section;

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
        toggleButton.addEventListener("click", () =>
          toggleUserDisabled(user, toggleButton),
        );
        actionsCell.append(toggleButton);
      }
    }
    const rowError = userRowErrors.get(user.id);
    if (rowError) {
      const guidance = document.createElement("p");
      guidance.className = "ops-user-row-error";
      guidance.setAttribute("role", "alert");
      guidance.tabIndex = -1;
      guidance.textContent = rowError;
      actionsCell.append(guidance);
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
    // This form reports its own validation beside each control, so the native
    // transient bubble must not pre-empt it.
    form.noValidate = true;
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
    let reloadUserOnCancel = false;
    cancel.addEventListener("click", async () => {
      if (!reloadUserOnCancel) {
        renderUsersSurfaceView();
        return;
      }
      const routeToken = getActiveWorkspaceRouteToken();
      await refreshUsersSurface({ rerender: false });
      if (isWorkspaceRouteFresh(routeToken)) renderUsersSurfaceView();
    });
    const submitLabel = isEdit ? "Save changes" : "Create user";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-button";
    submit.textContent = submitLabel;
    actions.append(cancel, submit);
    form.append(actions);

    const feedback = createFormFeedback();
    feedback.node.classList.add("ops-user-form-result");
    let userSubmitInFlight = false;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (userSubmitInFlight) return;
      const payload = {
        name: nameInput.input.value.trim(),
        email: emailInput.input.value.trim(),
        role: roleSelect.value,
      };
      if (passwordInput.input.value)
        payload.password = passwordInput.input.value;
      const invalid = reportFieldValidation([
        [nameInput, payload.name ? "" : "Name is required."],
        [emailInput, payload.email ? "" : "Email is required."],
        [
          passwordInput,
          isEdit || passwordInput.input.value ? "" : "Password is required.",
        ],
      ]);
      if (invalid) {
        feedback.clear();
        return;
      }
      userSubmitInFlight = true;
      setControlPending(submit, {
        pending: true,
        pendingLabel: isEdit ? "Saving user…" : "Creating user…",
      });
      feedback.pending(isEdit ? "Saving user…" : "Creating user…");
      const routeToken = getActiveWorkspaceRouteToken();
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
        // Success is confirmed against the refreshed list, not against the
        // request that has just been sent.
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshUsersSurface({ rerender: false });
          return;
        }
        usersOutcome = `${payload.name} ${isEdit ? "saved" : "added"}.`;
        await refreshUsersSurface({ rerender: true });
      } catch (err) {
        if (!isWorkspaceRouteFresh(routeToken)) return;
        const conflict =
          `This account changed since the form was opened: ${err?.message || "version conflict"}` +
          ` Your entries are kept. Select Cancel to discard these changes and reload users,` +
          ` or ${submitLabel} to apply them anyway.`;
        const failure =
          `Could not save user: ${err?.message || "request failed"}` +
          ` Select ${submitLabel} to retry.`;
        reloadUserOnCancel = err?.status === 409;
        if (err?.status === 409) feedback.conflict(conflict).focus();
        else feedback.failure(failure).focus();
        setControlPending(submit, { pending: false, label: submitLabel });
      } finally {
        userSubmitInFlight = false;
      }
    });

    panel.append(form, feedback.node);
    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-users";
    wrap.append(panel);
    documentList.replaceChildren(wrap);
    nameInput.input.focus();
  }

  async function toggleUserDisabled(user, button) {
    const next = !user.disabled;
    const label = next ? "Disable" : "Enable";
    const routeToken = getActiveWorkspaceRouteToken();
    setControlPending(button, {
      pending: true,
      pendingLabel: next ? "Disabling…" : "Enabling…",
    });
    try {
      await request(workApiUrl(`/api/users/${user.id}`), {
        method: "PATCH",
        body: JSON.stringify({ disabled: next }),
      });
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshUsersSurface({ rerender: false });
        return;
      }
      userRowErrors.delete(user.id);
      usersOutcome = `${user.name || user.email || user.id} is now ${next ? "disabled" : "enabled"}.`;
      await refreshUsersSurface({ rerender: true });
    } catch (err) {
      if (!isWorkspaceRouteFresh(routeToken)) return;
      // The failure belongs to the row whose control was used, and the row is
      // re-rendered from the refreshed server state so nothing is guessed.
      userRowErrors.set(
        user.id,
        err?.status === 409
          ? `This account changed since the list was loaded: ${err.message || "version conflict"} Select Retry loading users, then ${label} again.`
          : `Could not ${label.toLowerCase()} this account: ${err?.message || "request failed"} Select ${label} to retry.`,
      );
      setControlPending(button, { pending: false, label });
      await refreshUsersSurface({ rerender: true });
      if (isWorkspaceRouteFresh(routeToken))
        documentList.querySelector(".ops-user-row-error")?.focus();
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
    // Admin owns the state of its own read-only checks: while they are in
    // flight the summary says so, and when they answer it says how many
    // answered rather than implying all three succeeded.
    const diagnosticsSummary = document.createElement("p");
    diagnosticsSummary.className = "ops-admin-diagnostics-summary";
    diagnosticsSummary.dataset.summaryState = "loading";
    diagnosticsSummary.setAttribute("role", "status");
    diagnosticsSummary.setAttribute("aria-live", "polite");
    diagnosticsSummary.setAttribute("aria-atomic", "true");
    diagnosticsSummary.textContent = "Loading 3 read-only diagnostics…";
    const retryDiagnostics = document.createElement("button");
    retryDiagnostics.type = "button";
    retryDiagnostics.className = "quiet-button surface-summary-retry";
    retryDiagnostics.textContent = "Retry diagnostics";
    retryDiagnostics.setAttribute("aria-label", "Retry read-only diagnostics");
    retryDiagnostics.hidden = true;
    diagnostics.append(diagnosticsSummary);
    diagnostics.append(retryDiagnostics);
    section.append(diagnostics);

    let diagnosticsRunId = 0;
    const diagnosticText = (name, value) => {
      const target = diagnostics.querySelector(
        `[data-diagnostic="${name}"] span`,
      );
      if (target && diagnostics.isConnected) target.textContent = value;
    };

    async function runDiagnostics() {
      const runId = ++diagnosticsRunId;
      retryDiagnostics.disabled = true;
      retryDiagnostics.setAttribute("aria-busy", "true");
      retryDiagnostics.textContent = "Retrying diagnostics…";
      diagnosticsSummary.dataset.summaryState = "loading";
      diagnosticsSummary.setAttribute("role", "status");
      diagnosticsSummary.setAttribute("aria-live", "polite");
      diagnosticsSummary.textContent =
        "Loading 3 read-only diagnostics…";
      for (const name of ["quality", "git-status", "git-history"])
        diagnosticText(name, "Loading availability…");
      diagnosticText("quality", "Loading local validation…");

      const [quality, gitStatus, gitHistory] = await Promise.allSettled([
        request(apiUrl("/docs/process-quality")),
        request(apiUrl("/git/status")),
        request(apiUrl("/git/log")),
      ]);
      // A retry that finishes after another retry or after leaving Admin must
      // not overwrite the newer run or a surface it no longer owns.
      if (runId !== diagnosticsRunId || !diagnostics.isConnected) return;

      const results = [quality, gitStatus, gitHistory];
      const answered = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      diagnosticsSummary.dataset.summaryState =
        answered === 3 ? "ready" : answered === 0 ? "unavailable" : "partial";
      diagnosticsSummary.setAttribute(
        "role",
        answered === 3 ? "status" : "alert",
      );
      diagnosticsSummary.setAttribute(
        "aria-live",
        answered === 3 ? "polite" : "assertive",
      );
      diagnosticsSummary.textContent =
        answered === 3
          ? "3 of 3 read-only diagnostics answered."
          : `${answered} of 3 read-only diagnostics answered; the rest are unavailable.`;
      retryDiagnostics.hidden = answered === 3;
      if (answered < 3) {
        retryDiagnostics.disabled = false;
        retryDiagnostics.removeAttribute("aria-busy");
        retryDiagnostics.textContent = "Retry diagnostics";
      }
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
    }

    retryDiagnostics.addEventListener("click", () => {
      void runDiagnostics();
    });
    void runDiagnostics();
    return section;
  }

  return {
    refreshUsersSurface,
    renderAdminSurface,
    renderAdminSurfaceView,
    renderUsersSurfaceView,
  };
}
