import {
  createFormFeedback,
  reportFieldValidation,
  setFieldError,
} from "../operations-overview.js";

export function createAssistantCreateSurface(context) {
  const {
    assistantMutation,
    escapeHtml,
    getActiveWorkspaceRouteToken = () => undefined,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    refreshAssistantSnapshot,
    refreshDocuments,
    request,
    resetAssistantMutation,
    routeIsFresh,
    scheduleAnimationFrame,
    state,
    tasksFromWorkPayload,
    workApiUrl,
    workTaskTitle,
  } = context;
  const document =
    context.document || context.documentList?.ownerDocument || globalThis.document;
  let taskLoadSequence = 0;

  function renderAssistantCreatePanel() {
    const panel = document.createElement("section");
    panel.className = "assistant-panel";
    const mutation =
      assistantMutation().target === "create" ? assistantMutation() : null;
    const values = mutation?.values || {};
    const cardOptions = (state.workSnapshot.cards || [])
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
      <form class="assistant-create-form" novalidate>
        <div class="assistant-create-grid">
          <label>
            Card
            <select name="cardId" data-assistant-card>
              <option value="">Select card</option>
              ${cardOptions}
            </select>
          </label>
          <label>
            Task
            <select name="taskId" data-assistant-task>
              <option value="">Card-level job</option>
            </select>
          </label>
          <label>
            Assistant type
            <input name="assistantType" data-assistant-type value="${escapeHtml(values.assistantType || "podcast")}">
          </label>
          <label>
            Title
            <input name="title" data-assistant-title value="${escapeHtml(values.title || "")}" placeholder="DataOps Assistant podcast prep">
          </label>
          <button
            type="submit"
            class="primary-button"
            data-assistant-create
            ${mutation?.busy ? "disabled aria-busy=\"true\"" : ""}
          >
            ${mutation?.busy && mutation.action === "create" ? "Creating assistant draft…" : "Ask DataOps Assistant"}
          </button>
        </div>
      </form>
    `;
    const feedback = createFormFeedback();
    feedback.node.classList.add("assistant-create-feedback");
    panel.append(feedback.node);
    if (mutation?.phase === "pending") feedback.pending(mutation.status);
    else if (mutation?.error) {
      if (mutation.phase === "conflict") feedback.conflict(mutation.error);
      else feedback.failure(mutation.error);
      appendAssistantCreateRecovery(panel, mutation);
    } else if (mutation?.status) feedback.success(mutation.status);

    const cardSelect = panel.querySelector("[data-assistant-card]");
    const taskSelect = panel.querySelector("[data-assistant-task]");
    const typeField = panel.querySelector("[data-assistant-type]");
    const titleField = panel.querySelector("[data-assistant-title]");
    if (values.cardId) cardSelect.value = values.cardId;
    if (values.taskId) taskSelect.value = values.taskId;
    const loadTasks = async () => {
      const cardId = cardSelect.value;
      const sequence = ++taskLoadSequence;
      taskSelect.innerHTML = `<option value="">Card-level job</option>`;
      if (!cardId) {
        taskSelect.disabled = false;
        return;
      }
      taskSelect.disabled = true;
      const currentMutation = assistantMutation();
      if (!currentMutation.busy && !currentMutation.error) {
        feedback.pending("Loading tasks for the selected Card…");
      }
      try {
        const payload = await request(workApiUrl("/api/tasks", { cardId }));
        if (sequence !== taskLoadSequence) return;
        for (const task of tasksFromWorkPayload(payload)) {
          const option = document.createElement("option");
          option.value = task.id;
          option.textContent = workTaskTitle(task);
          taskSelect.append(option);
        }
        if (values.taskId) taskSelect.value = values.taskId;
        const latestMutation = assistantMutation();
        if (!latestMutation.busy && !latestMutation.error && !latestMutation.status) {
          feedback.clear();
        }
      } catch (error) {
        if (sequence !== taskLoadSequence) return;
        if (assistantMutation().busy || assistantMutation().error) return;
        feedback.failure(
          `Could not load tasks for this Card: ${error.message || "request failed"}`,
        );
        appendAssistantTaskRetry(panel, loadTasks);
      } finally {
        if (sequence === taskLoadSequence) taskSelect.disabled = false;
      }
    };
    cardSelect?.addEventListener("change", loadTasks);
    if (values.cardId) void loadTasks();

    const captureValues = () => ({
      cardId: cardSelect?.value || "",
      taskId: taskSelect?.value || "",
      assistantType: typeField?.value.trim() || "podcast",
      title: titleField?.value.trim() || "",
    });
    const submit = (event) => {
      event?.preventDefault?.();
      return submitAssistantCreate(panel, captureValues());
    };
    panel.querySelector(".assistant-create-form")?.addEventListener("submit", submit);
    panel.querySelector("[data-assistant-create]")?.addEventListener("click", submit);
    for (const field of [cardSelect, taskSelect, typeField, titleField]) {
      field?.addEventListener("input", () => {
        if (assistantMutation().target !== "create") return;
        state.assistantMutation = {
          ...assistantMutation(),
          values: { ...assistantMutation().values, ...captureValues() },
        };
      });
      field?.addEventListener("change", () => {
        if (assistantMutation().target !== "create") return;
        state.assistantMutation = {
          ...assistantMutation(),
          values: { ...assistantMutation().values, ...captureValues() },
        };
      });
    }
    if (mutation?.focus) {
      const focusSelector = {
        card: "[data-assistant-card]",
        title: "[data-assistant-title]",
        type: "[data-assistant-type]",
      }[mutation.focus];
      if (focusSelector) {
        scheduleAnimationFrame(() => panel.querySelector(focusSelector)?.focus());
      }
    }
    return panel;
  }

  function appendAssistantCreateRecovery(panel, mutation) {
    const recovery = document.createElement("div");
    recovery.className = "assistant-mutation-recovery";
    recovery.setAttribute("aria-label", "Assistant creation recovery");
    if (mutation.values?.createdJobId) {
      const review = document.createElement("button");
      review.type = "button";
      review.textContent = "Review created draft";
      review.addEventListener("click", () => {
        void navigateCanonicalWorkspace("/assistants", {
          assistantJobId: mutation.values.createdJobId,
        }).ready;
      });
      recovery.append(review);
    } else {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Reload assistant queue";
      reload.addEventListener("click", async () => {
        const token = getActiveWorkspaceRouteToken();
        state.assistantMutation = {
          ...assistantMutation(),
          busy: true,
          error: "",
          status: "Reloading assistant queue…",
          phase: "pending",
          routeToken: token,
        };
        refreshDocuments();
        await refreshAssistantSnapshot({ token, rerender: false });
        if (!routeIsFresh(token)) return;
        state.assistantMutation = {
          ...assistantMutation(),
          busy: false,
          error: state.assistantSnapshot.errors[0] || "",
          status: state.assistantSnapshot.errors.length
            ? "Reload failed. Try again."
            : "Assistant queue reloaded. Review the draft, then retry.",
          phase: state.assistantSnapshot.errors.length ? "error" : "success",
          routeToken: token,
        };
        refreshDocuments();
      });
      recovery.append(reload);
    }
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard draft";
    discard.addEventListener("click", () => {
      resetAssistantMutation();
      refreshDocuments();
    });
    recovery.append(discard);
    panel.append(recovery);
  }

  function appendAssistantTaskRetry(panel, retry) {
    if (panel.querySelector("[data-assistant-task-retry]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.assistantTaskRetry = "true";
    button.textContent = "Retry loading tasks";
    button.addEventListener("click", retry);
    panel.append(button);
  }

  async function submitAssistantCreate(panel, values) {
    const mutation = assistantMutation();
    if (mutation.busy) return;
    const card = panel.querySelector("[data-assistant-card]");
    const task = panel.querySelector("[data-assistant-task]");
    const routeToken = getActiveWorkspaceRouteToken();
    for (const field of [card, task]) setFieldError(field, "");
    if (!values.cardId && !values.taskId) {
      const message = "Select a Card or Task before requesting assistant help.";
      state.assistantMutation = {
        target: "create",
        action: "create",
        values,
        error: message,
        busy: false,
        status: "",
        phase: "error",
        routeToken,
        focus: "card",
      };
      reportFieldValidation([[card, message]]);
      refreshDocuments();
      return;
    }
    state.assistantMutation = {
      target: "create",
      action: "create",
      values,
      error: "",
      busy: true,
      status: "Creating assistant draft…",
      phase: "pending",
      routeToken,
    };
    refreshDocuments();
    try {
      let job;
      if (values.createdJobId) {
        const payload = await request(
          workApiUrl(
            `/api/assistant-jobs/${encodeURIComponent(values.createdJobId)}/submit`,
          ),
          { method: "POST" },
        );
        job = payload.job || payload;
      } else {
        const inputRefs = [];
        if (values.cardId) inputRefs.push({ type: "card", id: values.cardId });
        if (values.taskId) inputRefs.push({ type: "task", id: values.taskId });
        const created = await request(workApiUrl("/api/assistant-jobs"), {
          method: "POST",
          body: JSON.stringify({
            assistantType: values.assistantType,
            title: values.title || `DataOps Assistant: ${values.assistantType}`,
            cardId: values.cardId || undefined,
            taskId: values.taskId || undefined,
            inputRefs,
            approvalRequired: true,
            maxAttempts: 2,
          }),
        });
        job = created.job || created;
        if (!job?.id) throw new Error("Assistant API returned no job id");
        try {
          const submitted = await request(
            workApiUrl(
              `/api/assistant-jobs/${encodeURIComponent(job.id)}/submit`,
            ),
            { method: "POST" },
          );
          job = submitted.job || job;
        } catch (error) {
          await refreshAssistantSnapshot({ token: routeToken, rerender: false });
          if (!routeIsFresh(routeToken)) return;
          const durable = state.assistantSnapshot.jobs.find((candidate) => candidate.id === job.id);
          state.assistantMutation = {
            target: "create",
            action: "create",
            values: { ...values, createdJobId: job.id },
          error:
            `Assistant draft was created, but it could not be queued: ${error.message || "submit failed"}. ` +
            `Review the draft or retry Submit.${durable ? "" : " The queue refresh did not find the draft."}`,
            busy: false,
            status: "",
            phase: "error",
            routeToken,
          };
          refreshDocuments();
          return;
        }
      }
      await refreshAssistantSnapshot({ token: routeToken, rerender: false });
      if (!routeIsFresh(routeToken)) return;
      const durable = state.assistantSnapshot.jobs.find((candidate) => candidate.id === job.id);
      if (!durable || !["queued", "running", "retrying"].includes(durable.status)) {
        throw new Error("The assistant queue refresh did not confirm this job as queued. Retry loading assistants.");
      }
      resetAssistantMutation();
      await navigateCanonicalWorkspace("/assistants", {
        assistantJobId: job.id,
      }).ready;
    } catch (error) {
      if (!routeIsFresh(routeToken)) return;
      const conflict = error.status === 409;
      state.assistantMutation = {
        target: "create",
        action: "create",
        values,
        error: conflict
          ? `Assistant creation changed elsewhere. Your entries are kept. Reload the queue, then retry creation. (${error.message || "conflict"})`
          : error.message || "Could not create assistant job. Select Ask DataOps Assistant to retry.",
        busy: false,
        status: "",
        phase: conflict ? "conflict" : "error",
        routeToken,
      };
      refreshDocuments();
    }
  }

  return { renderAssistantCreatePanel };
}
