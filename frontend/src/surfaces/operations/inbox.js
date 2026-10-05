import { createCollectionLoader } from "../../core/collection-loader.js";
import { berlinIsoDate } from "../../core/workspace.js";
import { renderDataSummary } from "../operations-overview.js";
import { createIntakeCaptureSurface } from "./inbox-capture.js";
import { isInvoiceRouteIntake } from "./inbox-finance.js";

export function createInboxSurface(context) {
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
    renderSurfaceHeader,
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
    const assistantReady = item?.assistantReadiness?.status === "ready";
    if (filter === "dismissed")
      return [
        "attached",
        "converted",
        "ignored",
        "duplicate",
        "archived",
      ].includes(status);
    return (
      status === "new" ||
      status === "blocked" ||
      status === "triaged" ||
      assistantReady
    );
  }

  function formatIntakeDate(value) {
    // Captured moments are full timestamps whose business day is Berlin, not
    // the UTC date a raw slice would read (00:00–02:00 local borrows the
    // previous day); followUpAt is already a plain date and passes through
    // the same formatting unchanged.
    const day = berlinIsoDate(value) || String(value).slice(0, 10);
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isNaN(date.getTime())
      ? ""
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).format(date);
  }

  function intakeMeta(item) {
    return [
      item.source || "unknown",
      item.sourceReceivedAt
        ? `Captured ${formatIntakeDate(item.sourceReceivedAt)}`
        : "",
      item.status === "blocked" && item.waitingFor
        ? `waiting for ${item.waitingFor}`
        : "",
      item.status === "blocked" && item.followUpAt
        ? `follow up ${formatIntakeDate(item.followUpAt)}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Only exceptional states earn a pill: "new" and resolved states are
  // already carried by the row's marker edge, so a uniform pill is noise.
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
    const form = button.closest("[data-intake-action]");
    if (!form) return;
    const mutation =
      state.intakeMutation.itemId === item.id &&
      state.intakeMutation.action === action
        ? state.intakeMutation
        : null;
    if (mutation) {
      for (const field of form.querySelectorAll("input,select,textarea")) {
        if (Object.hasOwn(mutation.values || {}, field.name)) {
          field.value = mutation.values[field.name];
        }
      }
    }
    for (const field of form.querySelectorAll("input,select,textarea")) {
      const capture = () => rememberIntakeDraft(item, action, form, field);
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
        const field = [...form.querySelectorAll("input,select,textarea")].find(
          (candidate) => candidate.name === focus.field,
        );
        if (!field?.isConnected || field.offsetParent === null) return;
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
        ? intakeResult.value.items.filter((item) => !isInvoiceRouteIntake(item))
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

  function rememberFinanceHandoff(item) {
    state.intake.financeHandoff = item;
    state.intake.selectedId = item.id;
    state.workspaceEntity = {
      kind: "intake",
      id: item.id,
      status: "finance-owned",
    };
  }

  async function resolveIntakeRouteEntity(route, token) {
    await refreshIntakeSnapshot({ token });
    if (!isWorkspaceRouteFresh(token)) return;
    const intakeId = route.params.get("intakeId");
    if (!intakeId) {
      state.workspaceEntity = null;
      state.intake.financeHandoff = null;
      state.intake.selectedId = null;
      renderInboxSurface();
      return;
    }
    let item = state.intake.items.find(
      (candidate) => candidate.id === intakeId,
    );
    if (!item && state.intake.financeHandoff?.id === intakeId) {
      item = state.intake.financeHandoff;
    }
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
      } catch (error) {
        if (!isWorkspaceRouteFresh(token)) return;
        state.intake.financeHandoff = null;
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
    if (isInvoiceRouteIntake(item)) {
      rememberFinanceHandoff(item);
      renderInboxSurface();
      return;
    }
    state.intake.financeHandoff = null;
    if (!state.intake.items.some((candidate) => candidate.id === item.id)) {
      state.intake.items = [
        item,
        ...state.intake.items.filter((candidate) => candidate.id !== item.id),
      ];
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
    setRouteTitle("Inbox");

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-inbox";
    wrap.append(
      renderSurfaceHeader(
        "Inbox",
        "Untriaged inputs not already owned by another surface. Convert a note into a task, attach it to existing work, or dismiss it. Forwarded invoices are reviewed in Finance.",
      ),
    );
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
    // A fully loaded Inbox states nothing: the queue itself is the evidence.
    // Only loading, empty, partial, and failure states earn a sentence (1e).
    const inboxSummary = renderDataSummary({
      id: "inbox",
      label: "Inbox",
      loaded: state.intake.loaded,
      errors: inboxErrors,
      empty: state.intake.loaded && state.intake.items.length === 0,
      messages: {
        loading: "Fetching intake items and Card relationships.",
        unavailable: "Inbox is unavailable; no intake rows are shown until it reloads.",
        partial: "Inbox items are loaded, but some Card relationships are unavailable.",
        empty: "Nothing to triage. Forwarded invoices are reviewed in Finance, not Inbox.",
        ready: `${state.intake.items.length} intake item${state.intake.items.length === 1 ? "" : "s"} loaded.`,
      },
      retryLabel: "Retry loading Inbox",
      onRetry: retryInbox,
    });
    if (
      inboxSummary.dataset.summaryState !== "ready" &&
      inboxSummary.dataset.summaryState !== "empty"
    ) {
      wrap.append(inboxSummary);
    }
    wrap.append(renderManualIntakeForm());

    const filters = document.createElement("nav");
    filters.className = "ops-subnav intake-filter-bar";
    filters.setAttribute("aria-label", "Inbox filters");
    for (const [id, label] of [
      ["actionable", "Actionable"],
      ["dismissed", "Dismissed"],
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
      filtered.find((item) => item.id === state.intake.selectedId) ||
      state.intake.items.find((item) => item.id === state.intake.selectedId) ||
      null;
    if (selected && isInvoiceRouteIntake(selected)) {
      rememberFinanceHandoff(selected);
    }
    const financeItem =
      state.intake.financeHandoff &&
      isInvoiceRouteIntake(state.intake.financeHandoff)
        ? state.intake.financeHandoff
        : null;
    wrap.append(renderIntakeList(filtered, selected, financeItem));
    documentList.replaceChildren(wrap);
    if (selected && isMobileShell()) {
      scheduleAnimationFrame(() => {
        const row = documentList.querySelector(".intake-row.is-selected");
        if (row && state.intake.selectedId === selected.id)
          row.scrollIntoView({ block: "start" });
      });
    }
  }

  function renderIntakeList(items, selected, financeItem) {
    const panel = document.createElement("section");
    panel.className = "intake-panel intake-queue";
    if (
      state.workspaceEntity?.kind === "intake" &&
      ["not-found", "error"].includes(state.workspaceEntity.status)
    ) {
      const missing = document.createElement("div");
      missing.className = "intake-detail intake-detail-empty";
      renderEntityLoadState(missing, {
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
      panel.append(missing);
    }
    if (financeItem) panel.append(renderIntakeItem(financeItem, true));
    const visible = [...items];
    if (
      selected &&
      !isInvoiceRouteIntake(selected) &&
      !visible.some((item) => item.id === selected.id)
    ) {
      visible.unshift(selected);
    }
    if (!visible.length && !financeItem) {
      panel.append(
        renderHonestState(
          state.intake.filter === "dismissed"
            ? "No dismissed intake"
            : "Nothing to triage",
          state.intake.filter === "dismissed"
            ? "Actionable items stay in the default list."
            : "Forwarded invoices are reviewed in Finance, not Inbox.",
        ),
      );
      return panel;
    }
    for (const item of visible) {
      panel.append(renderIntakeItem(item, item.id === selected?.id));
    }
    return panel;
  }

  function renderIntakeItem(item, expanded) {
    const row = document.createElement("article");
    row.className = `intake-row intake-${item.status || "new"} ${expanded ? "is-selected" : ""}`;
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
    const main = document.createElement("button");
    main.type = "button";
    main.className = "intake-row-main";
    main.dataset.openIntakeItem = item.id;
    const marker = document.createElement("span");
    marker.setAttribute("aria-hidden", "true");
    marker.className = "intake-row-marker";
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = item.title || "Untitled intake";
    const meta = document.createElement("small");
    meta.textContent = intakeMeta(item);
    copy.append(title, meta);
    main.append(marker, copy);
    const statusLabel = intakeStatusLabel(item);
    if (["assistant ready", "blocked"].includes(statusLabel)) {
      const status = document.createElement("em");
      status.textContent = statusLabel;
      main.append(status);
    }
    const detail = document.createElement("div");
    detail.className = "intake-detail";
    detail.innerHTML = `
      ${intakeActionMarkup(item, cardOptions, { compact: !expanded })}
      ${expanded ? renderIntakeExpandedContext(item) : ""}
    `;
    row.append(main, detail);
    bindIntakeItem(row, item);
    return row;
  }

  function renderIntakeExpandedContext(item) {
    if (isInvoiceRouteIntake(item)) return "";
    const history = renderIntakeHistoryMarkup(item.history || []);
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
    return `
      <section class="intake-expanded-context">
        <div><strong>Tasks:</strong> ${taskRelationships}</div>
        <div><strong>Cards:</strong> ${cardRelationships}</div>
      </section>
      <section aria-labelledby="intake-history-heading-${escapeHtml(item.id)}">
        <h4 id="intake-history-heading-${escapeHtml(item.id)}">
          History <small>(newest first)</small>
        </h4>
        <ol class="intake-history">
          ${history || "<li>No triage history recorded.</li>"}
        </ol>
      </section>
    `;
  }

  function bindIntakeItem(row, item) {
    const detail = row.querySelector(".intake-detail") || row;
    row.querySelector("[data-open-intake-item]")?.addEventListener("click", () => {
      if (state.intake.selectedId === item.id) {
        navigateCanonicalWorkspace("/inbox");
        return;
      }
      navigateCanonicalWorkspace("/inbox", { intakeId: item.id });
    });
    detail.querySelector("[data-open-finance]")?.addEventListener("click", () => {
      navigateCanonicalWorkspace("/bookkeeping");
    });
    detail
      .querySelectorAll("[data-open-intake-task]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openTaskPanel(button.dataset.openIntakeTask),
        ),
      );
    detail
      .querySelectorAll("[data-open-intake-card]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          openCardPanel(button.dataset.openIntakeCard),
        ),
      );
    detail.querySelectorAll("[data-open-intake-assistant]").forEach((button) =>
      button.addEventListener("click", () => {
        navigateCanonicalWorkspace("/assistants", {
          assistantJobId: button.dataset.openIntakeAssistant,
        });
      }),
    );
    detail.querySelectorAll("[data-intake-submit]").forEach((button) => {
      bindIntakeDraft(item, button);
      button.addEventListener("click", () =>
        submitIntakeAction(detail, item, button.dataset.intakeSubmit),
      );
    });
    detail.querySelectorAll("[data-intake-reload]").forEach((button) => {
      button.addEventListener("click", () => {
        void context.reloadIntakeAction(item);
      });
    });
    detail.querySelectorAll("[data-intake-discard]").forEach((button) => {
      button.addEventListener("click", () => context.discardIntakeAction(item));
    });
    if (state.intakeMutation.itemId === item.id && state.intakeMutation.error) {
      const error = detail.querySelector("[data-intake-inline-error]");
      const focusField = state.intakeMutation.focus?.field;
      scheduleAnimationFrame(() => {
        const target = focusField
          ? [...detail.querySelectorAll("input,select,textarea")].find(
              (field) => field.name === focusField,
            )
          : error;
        const fallback = target || error;
        if (fallback?.isConnected) fallback.focus();
      });
    }
  }

  return {
    refreshIntakeSnapshot,
    renderInboxSurface,
    resolveIntakeRouteEntity,
  };
}
