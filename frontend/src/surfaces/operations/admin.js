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
    setRouteTitle,
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
    setRouteTitle("Admin");
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
    setRouteTitle("Users");
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
