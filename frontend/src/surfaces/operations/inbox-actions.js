import {
  reportFieldValidation,
  setFieldError,
} from "../operations-overview.js";
import { isInvoiceRouteIntake } from "./inbox-finance.js";

export function createInboxActions(context) {
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
  const { refreshIntakeSnapshot, renderInboxSurface } = context;

  function intakeActionMarkup(item, cardOptions, options = {}) {
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
    const actionForm = (
      action,
      label,
      fields,
      primary = false,
      destructive = false,
    ) => `
      <div
        class="intake-action ${primary ? "is-primary" : ""} ${destructive ? "is-destructive" : ""}"
        data-intake-action="${action}"
      >
        <div class="intake-action-fields">
          ${fields}
          <button
            type="button"
            class="${primary ? "primary-button" : destructive ? "danger-button" : ""}"
            data-intake-submit="${action}"
            ${mutation.busy ? "disabled aria-busy=\"true\"" : ""}
          >
            ${escapeHtml(mutation.busy && mutation.action === action ? `${label}…` : label)}
          </button>
        </div>
      </div>
    `;
    if (isInvoiceRouteIntake(item)) {
      return `
        <section class="intake-finance-handoff">
          <h4>This is Finance work</h4>
          <p>Forwarded invoices and receipts are reviewed in Finance, not converted into tasks.</p>
          <button type="button" class="primary-button" data-open-finance>Open Finance</button>
        </section>
      `;
    }
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
          ? actionForm(
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
    const convert = actionForm(
      "convert-task",
      "Convert to task",
      "",
      true,
    );
    const attach = actionForm(
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
    const block = actionForm(
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
    const follow = actionForm(
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
    const response = actionForm(
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
    const assistant = actionForm(
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
    const otherActions = options.compact
      ? status === "blocked"
        ? due
          ? follow
          : response
        : convert
      : status === "blocked"
        ? `
          ${due ? follow : response}
          ${due ? response : follow}
        `
        : `
          ${convert}
          ${attach}
          ${block}
          ${assistant}
          ${actionForm(
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
          ${actionForm("ignore", "Ignore item", reasonField, false, true)}
          ${actionForm("archive", "Archive item", reasonField, false, true)}
        `;
    return `
      <section class="intake-next-actions">
        ${otherActions}
        ${intakeMutationFeedback(item)}
      </section>
    `;
  }

  function intakeMutationFeedback(item) {
    if (state.intakeMutation.itemId !== item.id) return "";
    const mutation = state.intakeMutation;
    const failing = Boolean(mutation.error);
    const role = failing ? "alert" : "status";
    const live = failing ? "assertive" : "polite";
    const recovery = failing
      ? `
          <div class="intake-mutation-recovery" aria-label="Intake action recovery">
            <button type="button" data-intake-reload="${escapeHtml(item.id)}">Reload current item</button>
            <button type="button" data-intake-discard="${escapeHtml(item.id)}">Discard draft</button>
          </div>
        `
      : "";
    return `
      <p
        class="intake-inline-feedback ${failing ? "is-error" : ""}"
        data-intake-inline-error
        data-intake-feedback-state="${escapeHtml(mutation.phase || (failing ? "error" : "success"))}"
        tabindex="-1"
        role="${role}"
        aria-live="${live}"
      >
        ${escapeHtml(mutation.error || mutation.status || "")}
      </p>
      ${recovery}
    `;
  }

  async function submitIntakeAction(panel, item, action) {
    if (state.intakeMutation.busy) return;
    const form = panel
      .querySelector(`[data-intake-submit="${cssEscape(action)}"]`)
      ?.closest("[data-intake-action]");
    if (!form) return;
    form.querySelectorAll("[aria-invalid]").forEach((field) => {
      field.removeAttribute("aria-invalid");
      setFieldError(field, "");
    });
    const values = Object.fromEntries(
      [...form.querySelectorAll("input,select,textarea")].map((field) => [
        field.name,
        field.value.trim(),
      ]),
    );
    if (action === "convert-task") values.date = values.date || todayIsoDate();
    const missing = [
      ...form.querySelectorAll(
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
      const message = `${labels[missing.name] || "This field"} is required.`;
      state.intakeMutation = {
        itemId: item.id,
        action,
        values,
        focus: { field: missing.name },
        error: message,
        busy: false,
        status: "",
        phase: "error",
        routeToken: getActiveWorkspaceRouteToken(),
      };
      reportFieldValidation([[missing, message]]);
      renderInboxSurface();
      return;
    }
    const routeToken = getActiveWorkspaceRouteToken();
    state.intakeMutation = {
      itemId: item.id,
      action,
      values,
      focus: state.intakeMutation.focus || null,
      error: "",
      busy: true,
      status: `${humanizeIntakeAction(action)}…`,
      phase: "pending",
      routeToken,
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
      const refreshed = await refreshIntakeSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!isWorkspaceRouteFresh(routeToken)) return;
      if (
        refreshed?.applied === false ||
        state.intake.error ||
        !state.intake.items.some((candidate) => candidate.id === item.id)
      ) {
        throw new Error(
          "The Inbox could not confirm this change after saving. Retry loading the Inbox.",
        );
      }
      state.intakeMutation = {
        itemId: item.id,
        action: "",
        values: {},
        focus: null,
        error: "",
        busy: false,
        status: `${humanizeIntakeAction(action)} is visible in the refreshed Inbox.`,
        phase: "success",
        routeToken,
      };
      renderInboxSurface();
      const createdTaskId =
        result.task?.id || (action === "attach" ? values.taskId : "");
      if (createdTaskId) openTaskPanel(createdTaskId);
      else if (action === "attach" && values.cardId)
        openCardPanel(values.cardId);
    } catch (error) {
      if (!isWorkspaceRouteFresh(routeToken)) return;
      const conflict = error.status === 409;
      state.intakeMutation = {
        itemId: item.id,
        action,
        values,
        focus: state.intakeMutation.focus || null,
        error: conflict
          ? `This intake changed since it was loaded. Your entries are kept. Reload the current item, then retry this action. (${error.message || "conflict"})`
          : error.message || "Intake action failed. Select the action to retry.",
        busy: false,
        status: "",
        phase: conflict ? "conflict" : "error",
        routeToken,
      };
      renderInboxSurface();
    }
  }

  async function reloadIntakeAction(item) {
    const mutation = state.intakeMutation;
    if (mutation.itemId !== item.id || mutation.busy) return;
    const routeToken = getActiveWorkspaceRouteToken();
    state.intakeMutation = {
      ...mutation,
      busy: true,
      error: "",
      status: "Reloading the current intake…",
      phase: "pending",
      routeToken,
    };
    renderInboxSurface();
    try {
      const refreshed = await refreshIntakeSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!isWorkspaceRouteFresh(routeToken)) return;
      const found = state.intake.items.some((candidate) => candidate.id === item.id);
      state.intakeMutation = {
        ...state.intakeMutation,
        busy: false,
        error:
          refreshed?.applied === false || state.intake.error || !found
            ? "The current intake could not be reloaded. Try Reload current item again."
            : "The current intake is refreshed. Review it, then retry the action.",
        status: "",
        phase:
          refreshed?.applied === false || state.intake.error || !found
            ? "error"
            : "success",
        routeToken,
      };
      renderInboxSurface();
    } catch (error) {
      if (!isWorkspaceRouteFresh(routeToken)) return;
      state.intakeMutation = {
        ...state.intakeMutation,
        busy: false,
        error: `Could not reload the current intake: ${error.message || "request failed"}`,
        status: "",
        phase: "error",
        routeToken,
      };
      renderInboxSurface();
    }
  }

  function discardIntakeAction(item) {
    if (state.intakeMutation.itemId !== item.id || state.intakeMutation.busy) return;
    state.intakeMutation = {
      itemId: "",
      action: "",
      values: {},
      focus: null,
      error: "",
      busy: false,
      status: "",
      phase: "idle",
      routeToken: getActiveWorkspaceRouteToken(),
    };
    renderInboxSurface();
  }

  function humanizeIntakeAction(action) {
    return (
      {
        "manual-created": "Captured manually",
        created: "Captured",
        updated: "Updated details",
        attach: "Attached to work",
        "convert-task": "Converted to task",
        block: "Blocked for a response",
        attached: "Attached to work",
        "converted-to-task": "Converted to task",
        "handed-off-to-finance": "Handed off to Finance",
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
    reloadIntakeAction,
    renderIntakeHistoryMarkup,
    discardIntakeAction,
    submitIntakeAction,
  };
}
