import "../../dakit/collection.js";
import {
  createFormFeedback,
  createPageHeader,
  renderDataSummary,
  reportFieldValidation,
  setControlPending,
} from "../operations-overview.js";
import { mountIntakeRecovery } from "../finance/invoices.js";
import { describeOpenWork, openUserLifecycleDialog } from "./user-lifecycle-dialog.js";
import { personAvatar } from "../../core/identity.js";

export function createAdminSurface(context) {
  const {
    apiUrl,
    currentOperatorIdFromPayload,
    documentList,
    getActiveWorkspaceView,
    getActiveWorkspaceRouteToken,
    isWorkspaceRouteFresh,
    readLocalPreviewContext,
    refreshAccountIdentity,
    refreshDocuments,
    renderHonestState,
    renderInBackground,
    renderSurfaceHeader,
    request,
    setRouteTitle,
    settledPayload,
    surfaceDescription,
    usersFromWorkPayload,
    workApiUrl,
  } = context;
  // Tests drive the lifecycle without a real <dialog>; the app uses the kit one.
  const openLifecycleDialog = context.openUserLifecycleDialog || openUserLifecycleDialog;

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
  let activeUserForm = null;
  const userRowErrors = new Map();
  // The workspace default assignee: who gets new work nothing else assigns.
  let defaultAssignee = { loaded: false, defaultAssigneeId: null, version: 0 };
  let defaultAssigneeError = "";

  function renderAdminSurfaceView() {
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setRouteTitle("Admin");

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-admin";
    // No page eyebrow: the sidebar already names the destination, and an
    // uppercase kicker over the title is the admin-template tell.
    wrap.append(renderSurfaceHeader("Admin", surfaceDescription("admin")));
    wrap.append(renderAdminSurface());
    // The received-intake reprocessor is developer recovery tooling; it lives
    // here, off the bookkeeping page it used to open (#242).
    const intakeRecovery = document.createElement("section");
    intakeRecovery.className = "ops-admin-intake-recovery";
    intakeRecovery.setAttribute("aria-label", "Intake recovery");
    wrap.append(intakeRecovery);
    mountIntakeRecovery(intakeRecovery, context);

    documentList.replaceChildren(wrap);
  }
  function isCurrentUserAdmin() {
    return Boolean(usersSnapshot.isAdmin);
  }

  async function refreshUsersSurface(options = {}) {
    const usersUrl = workApiUrl("/api/users");
    const meUrl = workApiUrl("/api/me");
    const [usersResult, meResult, defaultResult] = await Promise.allSettled([
      request(usersUrl),
      request(meUrl),
      request(workApiUrl("/api/team-members/default-assignee")),
    ]);
    const previous = { usersSnapshot, defaultAssignee };
    const defaultPayload = settledPayload(defaultResult);
    defaultAssignee = defaultPayload && typeof defaultPayload === "object"
      ? {
          loaded: true,
          defaultAssigneeId: defaultPayload.defaultAssigneeId || null,
          version: Number(defaultPayload.version) || 0,
        }
      : { loaded: false, defaultAssigneeId: null, version: 0 };
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
    if (typeof refreshAccountIdentity === "function") {
      const localContext =
        typeof readLocalPreviewContext === "function"
          ? await readLocalPreviewContext()
          : null;
      await refreshAccountIdentity(
        settledPayload(meResult),
        users,
        localContext,
      );
    }
    const usersVisible = () => getActiveWorkspaceView() === "users";
    if (options.background) {
      renderInBackground({
        previous,
        next: { usersSnapshot, defaultAssignee },
        when: usersVisible,
      });
    } else if (options.rerender && usersVisible()) {
      refreshDocuments();
    }
  }

  function renderUsersSurfaceView() {
    // A background snapshot must not replace an editor opened on this route.
    // Navigation changes the route token and discards the previous draft.
    if (activeUserForm && isWorkspaceRouteFresh(activeUserForm.routeToken)) {
      if (activeUserForm.wrap.parentNode !== documentList) documentList.replaceChildren(activeUserForm.wrap);
      return;
    }
    activeUserForm = null;
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setRouteTitle("Users");

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-users";
    wrap.append(
      createPageHeader({
        title: "Users",
        className: "ops-surface-header",
      }),
    );
    // A loaded list states nothing: the table is the evidence, and a
    // "3 users." bar would restate it (dakit principle 4).
    const summary = renderUsersSummary();
    if (summary.dataset.summaryState !== "ready") wrap.append(summary);
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

  // Users reports its own load state while it is fetching, unreachable,
  // empty, or partial. Recovery is a retry of the same fetch, in the surface.
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
    // Add user rides on the account list it adds to; only admins see it.
    section.append(globalThis.dakitCollection.header({
      title: "Accounts",
      create: isCurrentUserAdmin()
        ? globalThis.dakitCollection.createButton({ label: "Add user", onClick: () => openUserForm(null) })
        : null,
    }));

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
    // A workspace setting, not the page's subject: it follows the account
    // list so the list itself starts near the top, also on a phone.
    section.append(renderDefaultAssignee());
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
    nameCell.append(personAvatar(user, { size: "sm", className: "ops-user-avatar" }), name);
    if (user.disabled) {
      const badge = document.createElement("span");
      badge.className = "ops-user-badge";
      badge.textContent = "disabled";
      nameCell.append(badge);
    }
    if (defaultAssignee.loaded && String(user.id) === String(defaultAssignee.defaultAssigneeId)) {
      const badge = document.createElement("span");
      badge.className = "ops-user-badge";
      badge.textContent = "default assignee";
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
    if (isCurrentUserAdmin()) actionsCell.append(renderUserMenu(user));
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

  // Every action on an account sits in one "⋯" menu, so each row carries the
  // same single control whatever state the account is in. Disabling and
  // deleting open the handover dialog; Delete only exists once an account is
  // disabled.
  function renderUserMenu(user) {
    const wrap = document.createElement("div");
    wrap.className = "ops-user-menu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dk-icon-button ops-user-menu-trigger";
    trigger.innerHTML =
      '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">' +
      '<circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/></svg>';
    trigger.setAttribute("aria-label", `Actions for ${user.name || user.email || user.id}`);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "dk-menu ops-user-menu-list";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const isSelf = String(user.id) === String(usersSnapshot.currentUserId);
    const items = [
      ["Edit", () => openUserForm(user)],
      ["Reassign open work…", () => openLifecycle(user, "reassign", trigger)],
      ...(isSelf
        ? []
        : user.disabled
          ? [
              ["Enable", () => enableUser(user, trigger)],
              ["Delete…", () => openLifecycle(user, "delete", trigger), "danger"],
            ]
          : [["Disable…", () => openLifecycle(user, "disable", trigger), "danger"]]),
    ];
    const buttons = items.map(([label, action, tone]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = tone ? "dk-menu__item dk-menu__item--danger" : "dk-menu__item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        close();
        action();
      });
      return item;
    });
    menu.append(...buttons);

    const onOutside = (event) => {
      if (!wrap.contains(event.target)) close();
    };
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      globalThis.removeEventListener?.("scroll", close, true);
      globalThis.removeEventListener?.("resize", close);
    }
    trigger.addEventListener("click", () => {
      if (!menu.hidden) {
        close();
        return;
      }
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // The table clips overflow, so the menu is placed against the viewport
      // under its trigger, end-aligned, and closes when the page moves. A row
      // too near the bottom opens it upward; where neither side has room it
      // is held inside the viewport. It is placed before focus moves into
      // it, or focusing an off-screen item would scroll the page and close it.
      const rect = trigger.getBoundingClientRect?.();
      if (rect) {
        const gap = 4;
        const margin = 8;
        const viewportHeight = globalThis.innerHeight || 0;
        menu.style.right = `${Math.max(margin, Math.round(globalThis.innerWidth - rect.right))}px`;
        menu.style.top = `${Math.round(rect.bottom + gap)}px`;
        const height = menu.getBoundingClientRect?.().height || 0;
        if (viewportHeight && rect.bottom + gap + height > viewportHeight - margin) {
          const above = rect.top - gap - height;
          const top = above >= margin ? above : Math.max(margin, viewportHeight - margin - height);
          menu.style.top = `${Math.round(top)}px`;
        }
      }
      document.addEventListener("pointerdown", onOutside, true);
      globalThis.addEventListener?.("scroll", close, true);
      globalThis.addEventListener?.("resize", close);
      buttons[0]?.focus();
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        trigger.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    });
    wrap.append(trigger, menu);
    return wrap;
  }

  function personName(id) {
    const person = usersSnapshot.users.find((user) => String(user.id) === String(id));
    return person?.name || person?.email || id;
  }

  const LIFECYCLE_PATHS = {
    disable: (id) => [`/api/users/${id}/disable`, "POST"],
    reassign: (id) => [`/api/users/${id}/reassign`, "POST"],
    delete: (id) => [`/api/users/${id}`, "DELETE"],
  };

  function lifecycleOutcome(user, mode, result) {
    const name = user.name || user.email || user.id;
    const moved = result?.moved ? describeOpenWork(result.moved) : "";
    const handedOver = moved ? ` ${moved} went to ${personName(result.reassignedTo)}.` : "";
    if (mode === "disable") return `${name} is now disabled.${handedOver}`;
    if (mode === "delete") return `${name} was deleted; past work still shows the name.${handedOver}`;
    const remaining = describeOpenWork(result?.remaining);
    const done = moved
      ? `Moved ${moved} from ${name} to ${personName(result.reassignedTo)}.`
      : `${name} had no open work to move.`;
    return remaining ? `${done} Still open: ${remaining}; reassign again.` : done;
  }

  // Disable, Delete and Reassign share one dialog: it loads the person's open
  // work, asks who takes it over, and runs the action; a refusal stays in the
  // dialog with the server's reason.
  function openLifecycle(user, mode, trigger) {
    const candidates = usersSnapshot.users
      .filter((person) => !person.disabled && String(person.id) !== String(user.id))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return openLifecycleDialog({
      mode,
      user,
      trigger,
      candidates,
      loadHandover: (signal) => request(workApiUrl(`/api/users/${encodeURIComponent(user.id)}/handover`), signal ? { signal } : {}),
      onConfirm: async (payload) => {
        const routeToken = getActiveWorkspaceRouteToken();
        const [path, method] = LIFECYCLE_PATHS[mode](encodeURIComponent(user.id));
        const result = await request(workApiUrl(path), { method, body: JSON.stringify(payload) });
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshUsersSurface({ rerender: false });
          return;
        }
        userRowErrors.delete(user.id);
        usersOutcome = lifecycleOutcome(user, mode, result);
        await refreshUsersSurface({ rerender: true });
      },
    });
  }

  // Default assignee: who receives new work that no Template, schedule or
  // imported title names. One labelled control under the list; an admin's
  // change saves at once and is confirmed by a toast.
  function renderDefaultAssignee() {
    const section = document.createElement("div");
    section.className = "ops-default-assignee";
    const label = document.createElement("label");
    label.className = "dk-label ops-default-assignee-label";
    label.textContent = "Default assignee";
    const hint = document.createElement("p");
    hint.className = "dk-hint ops-default-assignee-hint";
    hint.id = "ops-default-assignee-hint";
    hint.textContent = "New tasks that no template, schedule or imported title assigns go to this person.";

    if (!defaultAssignee.loaded) {
      const unavailable = document.createElement("span");
      unavailable.className = "ops-default-assignee-value";
      unavailable.textContent = "Could not be loaded.";
      section.append(label, unavailable, hint);
      return section;
    }
    const current = usersSnapshot.users.find(
      (user) => String(user.id) === String(defaultAssignee.defaultAssigneeId),
    );
    if (!isCurrentUserAdmin()) {
      const value = document.createElement("span");
      value.className = "ops-default-assignee-value";
      value.textContent = current ? current.name || current.email || current.id : "Nobody: new tasks stay unassigned";
      section.append(label, value, hint);
      return section;
    }

    const select = document.createElement("select");
    select.className = "dk-select";
    select.name = "defaultAssigneeId";
    select.id = "ops-default-assignee-select";
    select.setAttribute("aria-describedby", hint.id);
    label.htmlFor = select.id;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Nobody (new tasks stay unassigned)";
    select.append(none);
    const candidates = usersSnapshot.users
      .filter((user) => !user.disabled || String(user.id) === String(defaultAssignee.defaultAssigneeId))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const user of candidates) {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = user.disabled
        ? `${user.name || user.email || user.id} (disabled)`
        : user.name || user.email || user.id;
      select.append(option);
    }
    select.value = defaultAssignee.defaultAssigneeId || "";
    select.addEventListener("change", () => {
      void saveDefaultAssignee(select.value || null, select);
    });
    section.append(label, select, hint);
    if (defaultAssigneeError) {
      const error = document.createElement("p");
      error.className = "dk-field-error ops-default-assignee-error";
      error.setAttribute("role", "alert");
      error.textContent = defaultAssigneeError;
      section.append(error);
    }
    return section;
  }

  let toastTimer = 0;
  function showToast(message) {
    if (!document.body) return;
    document.querySelector(".ops-users-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "dk-toast ops-users-toast";
    toast.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "dk-toast__message";
    text.textContent = message;
    toast.append(text);
    document.body.append(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 4000);
  }

  async function saveDefaultAssignee(defaultAssigneeId, select) {
    const routeToken = getActiveWorkspaceRouteToken();
    select.disabled = true;
    select.setAttribute("aria-busy", "true");
    try {
      await request(workApiUrl("/api/team-members/default-assignee"), {
        method: "PUT",
        body: JSON.stringify({ defaultAssigneeId, expectedVersion: defaultAssignee.version }),
      });
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshUsersSurface({ rerender: false });
        return;
      }
      defaultAssigneeError = "";
      await refreshUsersSurface({ rerender: true });
      showToast(defaultAssigneeId
        ? `New tasks now go to ${personName(defaultAssigneeId)}.`
        : "No default assignee: new tasks stay unassigned.");
    } catch (err) {
      if (!isWorkspaceRouteFresh(routeToken)) return;
      defaultAssigneeError = err?.status === 409
        ? "Someone changed the default assignee since this page loaded. It now shows their choice; pick again."
        : `Could not save the default assignee: ${err?.message || "request failed"}`;
      await refreshUsersSurface({ rerender: true });
    }
    if (isWorkspaceRouteFresh(routeToken)) documentList.querySelector?.("#ops-default-assignee-select")?.focus();
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
    // Email is the SSO identity the user signs in with, so it is entered once
    // at creation and shown read-only afterwards.
    const emailInput = isEdit
      ? null
      : labeledInput("Email", { type: "email", required: true });
    const emailField = emailInput ? emailInput.wrap : staticField("Email", user.email || "");
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

    form.append(nameInput.wrap, emailField, roleLabel);

    const actions = document.createElement("div");
    actions.className = "ops-user-form-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    let reloadUserOnCancel = false;
    cancel.addEventListener("click", async () => {
      activeUserForm = null;
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
      const payload = { name: nameInput.input.value.trim() };
      if (emailInput) payload.email = emailInput.input.value.trim();
      payload.role = roleSelect.value;
      const invalid = reportFieldValidation([
        [nameInput, payload.name ? "" : "Name is required."],
        ...(emailInput
          ? [[emailInput, payload.email ? "" : "Email is required."]]
          : []),
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
        activeUserForm = null;
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
        // A 409 on create means the email already has an account, not a
        // concurrent edit, so it reads as a plain failure.
        const editConflict = isEdit && err?.status === 409;
        reloadUserOnCancel = editConflict;
        if (editConflict) feedback.conflict(conflict).focus();
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
    activeUserForm = { wrap, routeToken: getActiveWorkspaceRouteToken() };
    documentList.replaceChildren(wrap);
    nameInput.input.focus();
  }

  async function enableUser(user, trigger) {
    const routeToken = getActiveWorkspaceRouteToken();
    trigger.setAttribute("aria-busy", "true");
    try {
      await request(workApiUrl(`/api/users/${encodeURIComponent(user.id)}/enable`), { method: "POST", body: "{}" });
      if (!isWorkspaceRouteFresh(routeToken)) {
        await refreshUsersSurface({ rerender: false });
        return;
      }
      userRowErrors.delete(user.id);
      usersOutcome = `${user.name || user.email || user.id} is now enabled.`;
      await refreshUsersSurface({ rerender: true });
    } catch (err) {
      if (!isWorkspaceRouteFresh(routeToken)) return;
      // The failure belongs to the row whose control was used, and the row is
      // re-rendered from the refreshed server state so nothing is guessed.
      userRowErrors.set(user.id, `Could not enable this account: ${err?.message || "request failed"} Select Enable to retry.`);
      await refreshUsersSurface({ rerender: true });
      if (isWorkspaceRouteFresh(routeToken))
        documentList.querySelector(".ops-user-row-error")?.focus();
    } finally {
      trigger.removeAttribute("aria-busy");
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

  function staticField(labelText, value) {
    const wrap = document.createElement("div");
    wrap.className = "ops-field";
    const label = document.createElement("span");
    label.textContent = labelText;
    const text = document.createElement("span");
    text.className = "ops-field-static";
    text.textContent = value;
    wrap.append(label, text);
    return wrap;
  }
  function renderAdminSurface() {
    const section = document.createElement("section");
    section.className = "ops-admin-grid";
    const cards = [
      [
        "Diagnostics",
        "Check process quality, daily export status, and the current knowledge revision.",
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
        <span>Diagnostics show saved knowledge and daily export status.</span>
      </header>
      <article data-diagnostic="quality">
        <strong>Process quality</strong>
        <span>Loading local validation…</span>
      </article>
      <article data-diagnostic="knowledge-status">
        <strong>Daily GitHub export</strong>
        <span>Loading availability…</span>
      </article>
      <article data-diagnostic="knowledge-publication">
        <strong>Knowledge revision</strong>
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
      for (const name of ["quality", "knowledge-status", "knowledge-publication"])
        diagnosticText(name, "Loading availability…");
      diagnosticText("quality", "Loading local validation…");

      const [quality, knowledgeStatus, publication] = await Promise.allSettled([
        request(apiUrl("/docs/process-quality")),
        request(apiUrl("/knowledge/status")),
        request(apiUrl("/knowledge/publication")),
      ]);
      // A retry that finishes after another retry or after leaving Admin must
      // not overwrite the newer run or a surface it no longer owns.
      if (runId !== diagnosticsRunId || !diagnostics.isConnected) return;

      const results = [quality, knowledgeStatus, publication];
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
      // When every diagnostic answered, the summary says nothing: "all fine"
      // is carried by the answers themselves, not by a mechanics sentence.
      if (answered === 3) {
        diagnosticsSummary.hidden = true;
        diagnosticsSummary.textContent = "";
      } else {
        diagnosticsSummary.hidden = false;
        diagnosticsSummary.textContent = `${answered} of 3 read-only diagnostics answered; the rest are unavailable.`;
      }
      retryDiagnostics.hidden = answered === 3;
      if (answered < 3) {
        retryDiagnostics.disabled = false;
        retryDiagnostics.removeAttribute("aria-busy");
        retryDiagnostics.textContent = "Retry diagnostics";
      }
      const qualityTotal = Number(quality.value?.summary?.total || 0);
      const qualityErrors = Number(
        quality.value?.validationErrors?.length || 0,
      );
      const findingsLabel = qualityTotal === 1 ? "finding" : "findings";
      const errorsLabel = qualityErrors === 1 ? "error" : "errors";
      diagnosticText(
        "quality",
        quality.status === "fulfilled"
          ? `${qualityTotal} quality ${findingsLabel}; ${qualityErrors === 0 ? "no" : qualityErrors} validation ${errorsLabel}.`
          : `Unavailable: ${quality.reason?.message || "request failed"}`,
      );
      diagnosticText(
        "knowledge-status",
        knowledgeStatus.status === "fulfilled"
          ? knowledgeStatus.value.exportLag ? "Newer saves await the daily GitHub export." : "Daily GitHub export is current."
          : `Export status unavailable: ${knowledgeStatus.reason?.message || "request failed"}. Saved knowledge is independent of GitHub.`,
      );
      diagnosticText(
        "knowledge-publication",
        publication.status === "fulfilled"
          ? publication.value.revision
            // A 36-char UUID wraps into a diagnostic dump; the first group
            // identifies the revision, and the full id stays in the API.
            ? `Current revision: ${String(publication.value.revision).slice(0, 8)}…`
            : "Not published yet."
          : `Unavailable: ${publication.reason?.message || "request failed"}`,
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
