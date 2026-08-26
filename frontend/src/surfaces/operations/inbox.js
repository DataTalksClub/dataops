import { createCollectionLoader } from "../../core/collection-loader.js";
import { renderDataSummary } from "../operations-overview.js";
import { createIntakeCaptureSurface } from "./inbox-capture.js";

export function createInboxSurface(context) {
  const {
    assistantJobsFromPayload,
    clearSelectionButton,
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
    libraryTitle,
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
  const { intakeActionMarkup, renderIntakeHistoryMarkup, submitIntakeAction } =
    context;
  const document = context.document || documentList?.ownerDocument || globalThis.document;

  let intakeCardsLoader;
  let intakeRefreshSequence = 0;

  const { renderManualIntakeForm } = createIntakeCaptureSurface({
    ...context,
    refreshIntakeSnapshot: (...args) => context.refreshIntakeSnapshot(...args),
    renderInboxSurface: (...args) => renderInboxSurface(...args),
  });

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
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

  function intakeDraftValues(details) {
    return Object.fromEntries(
      [...details.querySelectorAll("input,select,textarea")].map((field) => [
        field.name,
        field.value,
      ]),
    );
  }

  function intakeDraftFocus(field) {
    const focus = { field: field.name };
    if (typeof field.selectionStart === "number") {
      focus.selectionStart = field.selectionStart;
      focus.selectionEnd = field.selectionEnd;
    }
    return focus;
  }

  function rememberIntakeDraft(item, action, details, field = null) {
    const previous =
      state.intakeMutation.itemId === item.id &&
      state.intakeMutation.action === action
        ? state.intakeMutation
        : {};
    state.intakeMutation = {
      itemId: item.id,
      action,
      values: intakeDraftValues(details),
      focus: field ? intakeDraftFocus(field) : previous.focus || null,
      error: previous.error || "",
      busy: previous.busy || false,
      status: previous.status || "",
      phase: previous.phase || "idle",
      routeToken: previous.routeToken ?? getActiveWorkspaceRouteToken(),
    };
  }

  function intakeDisclosureChain(details) {
    const disclosures = [];
    for (let node = details; node; node = node.parentElement) {
      if (node.tagName === "DETAILS") disclosures.push(node);
    }
    return disclosures;
  }

  function clearIntakeDraft(item, action) {
    if (
      state.intakeMutation.itemId !== item.id ||
      state.intakeMutation.action !== action ||
      state.intakeMutation.busy
    )
      return;
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

  function bindIntakeDraft(item, button) {
    const action = button.dataset.intakeSubmit;
    const details = button.closest("details");
    if (!details) return;
    const disclosureChain = intakeDisclosureChain(details);
    const mutation =
      state.intakeMutation.itemId === item.id &&
      state.intakeMutation.action === action
        ? state.intakeMutation
        : null;
    if (mutation) {
      for (const disclosure of disclosureChain) disclosure.open = true;
      for (const field of details.querySelectorAll("input,select,textarea")) {
        if (Object.hasOwn(mutation.values || {}, field.name)) {
          field.value = mutation.values[field.name];
        }
      }
    }
    details.addEventListener("toggle", () => {
      if (details.open) {
        rememberIntakeDraft(item, action, details);
      } else clearIntakeDraft(item, action);
    });
    for (const ancestor of disclosureChain.slice(1)) {
      ancestor.addEventListener("toggle", () => {
        if (!ancestor.open) clearIntakeDraft(item, action);
      });
    }
    for (const field of details.querySelectorAll("input,select,textarea")) {
      const capture = () => rememberIntakeDraft(item, action, details, field);
      field.addEventListener("input", capture);
      field.addEventListener("change", capture);
      field.addEventListener("focus", capture);
    }
    const focus = mutation?.focus;
    if (focus?.field) {
      scheduleAnimationFrame(() => {
        if (
          state.intakeMutation.itemId !== item.id ||
          state.intakeMutation.action !== action
        )
          return;
        const field = [...details.querySelectorAll("input,select,textarea")].find(
          (candidate) => candidate.name === focus.field,
        );
        if (
          !field?.isConnected ||
          field.offsetParent === null ||
          disclosureChain.some((disclosure) => !disclosure.open)
        )
          return;
        field.focus();
        if (
          typeof field.setSelectionRange === "function" &&
          typeof focus.selectionStart === "number"
        ) {
          field.setSelectionRange(focus.selectionStart, focus.selectionEnd);
        }
      });
    }
  }

  async function refreshIntakeSnapshot(options = {}) {
    const sequence = ++intakeRefreshSequence;
    let intakeError = null;
    intakeCardsLoader = createCollectionLoader({
      request,
      createUrl: (parameters) => workApiUrl("/api/cards", parameters),
      collection: "cards",
    });

    const cardsPromise = intakeCardsLoader.load();
    const [intakeResult, cardsResult] = await Promise.allSettled([
      request(workApiUrl("/api/intake")),
      cardsPromise,
    ]);
    if (intakeResult.status === "rejected") {
      intakeError = intakeResult.reason?.message || "Inbox could not be loaded";
    }
    let cardPage = cardsResult.status === "fulfilled"
      ? cardsResult.value
      : intakeCardsLoader.getSnapshot();
    if (cardsResult.status === "rejected") {
      cardPage = {
        ...cardPage,
        failed: true,
        error: cardsResult.reason?.message || "Card relationships could not be loaded",
      };
    }
    while (cardPage.moreAvailable && !cardPage.failed) {
      cardPage = await intakeCardsLoader.loadMore();
    }
    if (sequence !== intakeRefreshSequence || !routeIsFresh(options.token)) {
      return { applied: false };
    }
    const intakeItems =
      intakeResult.status === "fulfilled" &&
      Array.isArray(intakeResult.value?.items)
        ? intakeResult.value.items
        : [];
    if (
      intakeResult.status === "fulfilled" &&
      !Array.isArray(intakeResult.value?.items)
    ) {
      intakeError ||= "Inbox API response was invalid";
    }
    state.intake = {
      ...state.intake,
      items: intakeItems,
      cards: cardPage.items || [],
      cardsLoaded: Boolean(cardPage.loaded),
      cardsComplete: Boolean(cardPage.complete),
      cardsLoading: false,
      cardsError: cardPage.failed
        ? cardPage.error || "Card relationships could not be loaded"
        : "",
      loaded: !intakeError,
      error: intakeError || "",
    };
    if (
      options.rerender &&
      getActiveWorkspaceView() === "inbox" &&
      isOperationsHomeVisible()
    )
      renderInboxSurface();
    return {
      applied: true,
      loaded: state.intake.loaded,
      error: state.intake.error,
      itemCount: state.intake.items.length,
    };
  }

  async function retryInboxCards(options = {}) {
    if (!intakeCardsLoader || state.intake.cardsLoading) return;
    const routeToken = options.token ?? getActiveWorkspaceRouteToken();
    const current = intakeCardsLoader.getSnapshot();
    state.intake.cardsLoading = true;
    state.intake.cardsError = "";
    renderInboxSurface();
    let cardPage =
      current.failed && !current.cursor
        ? await intakeCardsLoader.load()
        : current.failed || current.moreAvailable
          ? await intakeCardsLoader.loadMore()
          : await intakeCardsLoader.load();
    while (cardPage.moreAvailable && !cardPage.failed) {
      cardPage = await intakeCardsLoader.loadMore();
    }
    if (!routeIsFresh(routeToken)) return { applied: false };
    state.intake = {
      ...state.intake,
      cards: cardPage.items || [],
      cardsLoaded: Boolean(cardPage.loaded),
      cardsComplete: Boolean(cardPage.complete),
      cardsLoading: false,
      cardsError: cardPage.failed
        ? cardPage.error || "Card relationships could not be loaded"
        : "",
    };
    renderInboxSurface();
    return { applied: true, error: state.intake.cardsError };
  }

  function renderIntakeCardsState() {
    if (state.intake.cardsLoading) {
      const status = document.createElement("p");
      status.className = "intake-card-status";
      status.setAttribute("role", "status");
      status.textContent = "Retrying more Card relationships…";
      return status;
    }
    if (state.intake.cardsComplete) return null;
    if (!state.intake.cardsLoading && state.intake.cardsError) {
      const status = document.createElement("p");
      status.className = "intake-card-status";
      status.setAttribute("role", "alert");
      status.textContent =
        (state.intake.cardsLoaded
          ? "More Card relationships are available, but loading failed"
          : "Card relationships could not be loaded") +
        (state.intake.cardsError ? `: ${state.intake.cardsError}` : ".");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button";
      retry.dataset.retryInboxCards = "true";
      retry.textContent = "Retry loading Cards";
      retry.addEventListener("click", () => {
        void retryInboxCards();
      });
      status.append(document.createTextNode(" "), retry);
      return status;
    }
    if (!state.intake.cardsLoaded) return null;
    const status = document.createElement("p");
    status.className = "intake-card-status";
    status.setAttribute("role", "alert");
    status.textContent =
      "More Card relationships are available, but loading failed" +
      (state.intake.cardsError ? `: ${state.intake.cardsError}` : ".");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "quiet-button";
    retry.dataset.retryInboxCards = "true";
    retry.textContent = "Retry loading Cards";
    retry.addEventListener("click", () => {
      void retryInboxCards();
    });
    status.append(document.createTextNode(" "), retry);
    return status;
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

  function renderInboxSurface() {
    const currentToken = getActiveWorkspaceRouteToken();
    if (
      state.intakeMutation.itemId &&
      !state.intakeMutation.busy &&
      state.intakeMutation.routeToken !== undefined &&
      state.intakeMutation.routeToken !== currentToken
    ) {
      state.intakeMutation = {
        itemId: "",
        action: "",
        values: {},
        focus: null,
        error: "",
        busy: false,
        status: "",
        phase: "idle",
        routeToken: currentToken,
      };
    }
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Inbox";
    setRouteTitle("Inbox");
    clearSelectionButton.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-inbox";
    const intro = document.createElement("p");
    intro.className = "ops-surface-intro";
    intro.textContent =
      "Capture raw operational inputs, then attach, convert, defer, resolve, or prepare them for an assistant.";
    wrap.append(intro);
    const inboxErrors = [
      state.intake.error,
      state.intake.cardsError &&
        (state.intake.cardsLoaded
          ? `Some Card relationships are unavailable: ${state.intake.cardsError}`
          : state.intake.cardsError),
    ].filter(Boolean);
    const retryInbox = async () => {
      const token = getActiveWorkspaceRouteToken();
      if (state.intake.error) {
        await refreshIntakeSnapshot({ token, rerender: false });
      } else {
        await retryInboxCards({ token });
      }
      if (routeIsFresh(token)) renderInboxSurface();
    };
    wrap.append(
      renderDataSummary({
        id: "inbox",
        label: "Inbox",
        loaded: state.intake.loaded,
        errors: inboxErrors,
        empty: state.intake.loaded && state.intake.items.length === 0,
        messages: {
          loading: "Fetching intake items and Card relationships.",
          unavailable: "Inbox is unavailable; no intake rows are shown until it reloads.",
          partial: "Inbox items are loaded, but some Card relationships are unavailable.",
          empty: "No intake items have been captured yet.",
          ready: `${state.intake.items.length} intake item${state.intake.items.length === 1 ? "" : "s"} loaded.`,
        },
        retryLabel: "Retry loading Inbox",
        onRetry: retryInbox,
      }),
    );
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
      button.setAttribute("aria-pressed", String(state.intake.filter === id));
      button.textContent = label;
      button.addEventListener("click", () => {
        state.intake.filter = id;
        navigateCanonicalWorkspace("/inbox");
      });
      filters.append(button);
    }
    wrap.append(filters);

    const cardsState = renderIntakeCardsState();
    if (cardsState) wrap.append(cardsState);

    if (state.intake.error) {
      documentList.replaceChildren(wrap);
      return;
    }
    if (!state.intake.loaded) {
      documentList.replaceChildren(wrap);
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
    const cardOptions = [
      `<option value="">No card</option>`,
      ...state.intake.cards.map(
        (card) => `
          <option value="${escapeHtml(card.id)}">
            ${escapeHtml(card.title || card.id)}
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
    const cardRelationships =
      (item.cardIds || [])
        .map(
          (id) => `
            <button type="button" data-open-intake-card="${escapeHtml(id)}">
              ${escapeHtml(state.intake.cards.find((card) => card.id === id)?.title || id)}
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
    const actionMarkup = intakeActionMarkup(item, cardOptions);
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
        <div><strong>Cards:</strong> ${cardRelationships}</div>
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
      .querySelectorAll("[data-open-intake-card]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openCardPanel(button.dataset.openIntakeCard),
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
      .forEach((button) => {
        bindIntakeDraft(item, button);
        button.addEventListener("click", () =>
          submitIntakeAction(panel, item, button.dataset.intakeSubmit),
        );
      });
    panel.querySelectorAll("[data-intake-reload]").forEach((button) => {
      button.addEventListener("click", () => {
        void context.reloadIntakeAction(item);
      });
    });
    panel.querySelectorAll("[data-intake-discard]").forEach((button) => {
      button.addEventListener("click", () => context.discardIntakeAction(item));
    });
    if (state.intakeMutation.itemId === item.id && state.intakeMutation.error) {
      const error = panel.querySelector("[data-intake-inline-error]");
      const focusField = state.intakeMutation.focus?.field;
      scheduleAnimationFrame(() => {
        const target = focusField
          ? [...panel.querySelectorAll("input,select,textarea")].find(
              (field) => field.name === focusField,
            )
          : error;
        const fallback = target || error;
        if (fallback?.isConnected) fallback.focus();
      });
    }
    return panel;
  }

  return {
    refreshIntakeSnapshot,
    renderInboxSurface,
    resolveIntakeRouteEntity,
  };
}
