export function createInboxActions(context) {
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
  const { refreshIntakeSnapshot, renderInboxSurface } = context;

  function intakeActionMarkup(item, cardOptions) {
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
        ${mutation.action === action ? "open" : ""}
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
      const cardId = item.cardIds?.[0];
      const continuation = assistantJobId
        ? `<button type="button" class="primary-button" data-open-intake-assistant="${escapeHtml(assistantJobId)}">Continue assistant job</button>`
        : taskId
          ? `<button type="button" class="primary-button" data-open-intake-task="${escapeHtml(taskId)}">Continue task</button>`
          : cardId
            ? `<button type="button" class="primary-button" data-open-intake-card="${escapeHtml(cardId)}">Open card</button>`
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
          <select name="cardId">${cardOptions}</select>
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
          <select name="cardId">${cardOptions}</select>
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
        focus: { field: missing.name },
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
      focus: state.intakeMutation.focus || null,
      error: "",
      busy: true,
      status: "Saving…",
    };
    renderInboxSurface();
    const payloadByAction = {
      attach: {
        taskIds: values.taskId ? [values.taskId] : [],
        cardIds: values.cardId ? [values.cardId] : [],
        note: values.note || undefined,
      },
      "convert-task": {
        date: values.date,
        assigneeId: values.assigneeId || undefined,
        cardId: values.cardId || undefined,
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
        focus: null,
        error: "",
        busy: false,
        status: `${humanizeIntakeAction(action)} recorded.`,
      };
      await refreshIntakeSnapshot();
      renderInboxSurface();
      const createdTaskId =
        result.task?.id || (action === "attach" ? values.taskId : "");
      if (createdTaskId) openTaskPanel(createdTaskId);
      else if (action === "attach" && values.cardId)
        openCardPanel(values.cardId);
    } catch (error) {
      state.intakeMutation = {
        itemId: item.id,
        action,
        values,
        focus: state.intakeMutation.focus || null,
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
          event.metadata?.cardId ? `card ${event.metadata.cardId}` : "",
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

  return {
    intakeActionMarkup,
    renderIntakeHistoryMarkup,
    submitIntakeAction,
  };
}
