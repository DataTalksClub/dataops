import {
  createFormFeedback,
  reportFieldValidation,
  setFieldError,
} from "../operations-overview.js";

const MANUAL_INTAKE_ID = "__manual-intake__";

export function createIntakeCaptureSurface(context) {
  const {
    escapeHtml,
    getActiveWorkspaceRouteToken = () => undefined,
    isWorkspaceRouteFresh,
    refreshIntakeSnapshot,
    renderInboxSurface,
    request,
    scheduleAnimationFrame,
    state,
    workApiUrl,
  } = context;
  const document = context.document || globalThis.document;

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
  }

  function renderManualIntakeForm() {
    const panel = document.createElement("details");
    panel.className = "intake-panel";
    const mutation =
      state.intakeMutation.itemId === MANUAL_INTAKE_ID &&
      state.intakeMutation.action === "capture"
        ? state.intakeMutation
        : null;
    if (mutation) panel.open = true;
    const values = mutation?.values || {};
    panel.innerHTML = `
      <summary>Capture a new intake item</summary>
      <form class="intake-create-form" data-intake-create-form novalidate>
        <div class="intake-create-grid">
          <label class="wide">
            Note
            <textarea
              name="note"
              data-intake-create-note
              placeholder="Paste the request, context, and safe links"
            >${escapeHtml(values.note || "")}</textarea>
          </label>
          <label>
            Title
            <input name="title" data-intake-create-title value="${escapeHtml(values.title || "")}" placeholder="Short subject">
          </label>
          <label>
            Data class
            <select name="dataClass" data-intake-create-class>
              <option value="internal" ${values.dataClass === "internal" || !values.dataClass ? "selected" : ""}>internal</option>
              <option value="public" ${values.dataClass === "public" ? "selected" : ""}>public</option>
              <option value="private" ${values.dataClass === "private" ? "selected" : ""}>private</option>
              <option value="sensitive" ${values.dataClass === "sensitive" ? "selected" : ""}>sensitive</option>
            </select>
          </label>
          <label>
            Tags
            <input name="tags" data-intake-create-tags value="${escapeHtml(values.tags || "")}" placeholder="comma,separated">
          </label>
          <button
            type="submit"
            class="primary-button"
            data-intake-create
            ${mutation?.busy ? "disabled aria-busy=\"true\"" : ""}
          >
            ${mutation?.busy ? "Capturing intake…" : "Capture intake"}
          </button>
        </div>
      </form>
    `;
    const feedback = createFormFeedback();
    feedback.node.classList.add("intake-create-feedback");
    panel.append(feedback.node);

    if (mutation?.phase === "pending") feedback.pending(mutation.status);
    else if (mutation?.error) {
      if (mutation.phase === "conflict") feedback.conflict(mutation.error);
      else feedback.failure(mutation.error);
      appendManualCaptureRecovery(panel);
    } else if (mutation?.status) feedback.success(mutation.status);

    const noteField = panel.querySelector("[data-intake-create-note]");
    const titleField = panel.querySelector("[data-intake-create-title]");
    const classField = panel.querySelector("[data-intake-create-class]");
    const tagsField = panel.querySelector("[data-intake-create-tags]");
    for (const field of [noteField, titleField, classField, tagsField]) {
      field?.addEventListener("input", () => {
        if (state.intakeMutation.itemId !== MANUAL_INTAKE_ID) return;
        state.intakeMutation = {
          ...state.intakeMutation,
          values: {
            ...state.intakeMutation.values,
            note: noteField?.value || "",
            title: titleField?.value || "",
            dataClass: classField?.value || "internal",
            tags: tagsField?.value || "",
          },
        };
      });
    }
    const form = panel.querySelector(".intake-create-form");
    const submit = (event) => {
      event?.preventDefault?.();
      return submitManualIntake(panel);
    };
    form?.addEventListener("submit", submit);
    // Prevent the browser's click activation from submitting twice while also
    // keeping the fake DOM and keyboard submit path on the same handler.
    panel.querySelector("[data-intake-create]")?.addEventListener("click", submit);
    if (mutation?.focus) {
      scheduleAnimationFrame(() => {
        panel
          .querySelector(`[data-intake-create-${mutation.focus}]`)
          ?.focus();
      });
    }
    return panel;
  }

  function appendManualCaptureRecovery(panel) {
    const recovery = document.createElement("div");
    recovery.className = "intake-mutation-recovery";
    recovery.setAttribute("aria-label", "Capture recovery");
    const reload = document.createElement("button");
    reload.type = "button";
    reload.dataset.intakeCreateReload = "true";
    reload.textContent = "Reload Inbox";
    reload.addEventListener("click", () => {
      void reloadManualCapture();
    });
    const discard = document.createElement("button");
    discard.type = "button";
    discard.dataset.intakeCreateDiscard = "true";
    discard.textContent = "Discard draft";
    discard.addEventListener("click", discardManualCapture);
    recovery.append(reload, discard);
    panel.append(recovery);
  }

  function manualCaptureValues(panel) {
    return {
      note: panel.querySelector("[data-intake-create-note]")?.value.trim() || "",
      title: panel.querySelector("[data-intake-create-title]")?.value.trim() || "",
      dataClass: panel.querySelector("[data-intake-create-class]")?.value || "internal",
      tags: panel.querySelector("[data-intake-create-tags]")?.value || "",
    };
  }

  function resetManualCapture() {
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
  }

  async function submitManualIntake(panel) {
    if (
      state.intakeMutation.busy &&
      state.intakeMutation.itemId === MANUAL_INTAKE_ID
    )
      return;
    const values = manualCaptureValues(panel);
    const noteField = panel.querySelector("[data-intake-create-note]");
    const titleField = panel.querySelector("[data-intake-create-title]");
    for (const field of [noteField, titleField]) setFieldError(field, "");
    const routeToken = getActiveWorkspaceRouteToken();
    if (!values.note && !values.title) {
      state.intakeMutation = {
        itemId: MANUAL_INTAKE_ID,
        action: "capture",
        values,
        focus: "note",
        error: "Add a note or title before capturing intake.",
        busy: false,
        status: "",
        phase: "error",
        routeToken,
      };
      reportFieldValidation([[noteField, state.intakeMutation.error]]);
      renderInboxSurface();
      return;
    }
    state.intakeMutation = {
      itemId: MANUAL_INTAKE_ID,
      action: "capture",
      values,
      focus: null,
      error: "",
      busy: true,
      status: "Capturing intake…",
      phase: "pending",
      routeToken,
    };
    renderInboxSurface();
    try {
      const created = await request(workApiUrl("/api/intake"), {
        method: "POST",
        body: JSON.stringify({
          source: "manual",
          title: values.title || values.note.split(/\r?\n/)[0],
          note: values.note || values.title,
          dataClass: values.dataClass,
          tags: values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      });
      const refreshed = await refreshIntakeSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!routeIsFresh(routeToken)) return;
      const createdItem = created?.item || created;
      const confirmed = createdItem?.id
        ? state.intake.items.some((item) => item.id === createdItem.id)
        : Boolean(refreshed?.loaded && !state.intake.error);
      if (!confirmed) {
        throw new Error(
          "The Inbox refresh did not show the captured item. Retry loading Inbox before trying again.",
        );
      }
      state.intake.filter = "actionable";
      state.intakeMutation = {
        itemId: MANUAL_INTAKE_ID,
        action: "capture",
        values: {},
        focus: null,
        error: "",
        busy: false,
        status: "Intake captured and visible in the refreshed Inbox.",
        phase: "success",
        routeToken,
      };
      renderInboxSurface();
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
      const conflict = error.status === 409;
      state.intakeMutation = {
        itemId: MANUAL_INTAKE_ID,
        action: "capture",
        values,
        focus: null,
        error: conflict
          ? `This capture changed elsewhere. Your draft is kept. Reload Inbox, then retry capture. (${error.message || "conflict"})`
          : error.message || "Could not capture intake. Select Capture intake to retry.",
        busy: false,
        status: "",
        phase: conflict ? "conflict" : "error",
        routeToken,
      };
      renderInboxSurface();
    }
  }

  async function reloadManualCapture() {
    const mutation = state.intakeMutation;
    if (mutation.itemId !== MANUAL_INTAKE_ID || mutation.busy) return;
    const routeToken = getActiveWorkspaceRouteToken();
    state.intakeMutation = {
      ...mutation,
      busy: true,
      error: "",
      status: "Reloading Inbox…",
      phase: "pending",
      routeToken,
    };
    renderInboxSurface();
    try {
      const refreshed = await refreshIntakeSnapshot({
        token: routeToken,
        rerender: false,
      });
      if (!routeIsFresh(routeToken)) return;
      state.intakeMutation = {
        ...state.intakeMutation,
        busy: false,
        error:
          refreshed?.applied === false || state.intake.error
            ? "Inbox could not be reloaded. Try Reload Inbox again."
            : "Inbox reloaded. Review the draft, then retry capture.",
        status: "",
        phase:
          refreshed?.applied === false || state.intake.error
            ? "error"
            : "success",
      };
      renderInboxSurface();
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
      state.intakeMutation = {
        ...state.intakeMutation,
        busy: false,
        error: `Could not reload Inbox: ${error.message || "request failed"}`,
        status: "",
        phase: "error",
      };
      renderInboxSurface();
    }
  }

  function discardManualCapture() {
    if (
      state.intakeMutation.itemId !== MANUAL_INTAKE_ID ||
      state.intakeMutation.busy
    )
      return;
    resetManualCapture();
    renderInboxSurface();
  }

  return { renderManualIntakeForm };
}
