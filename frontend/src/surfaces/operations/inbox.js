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
  const { intakeActionMarkup, renderIntakeHistoryMarkup, submitIntakeAction } =
    context;

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

  return {
    refreshIntakeSnapshot,
    renderInboxSurface,
    resolveIntakeRouteEntity,
  };
}
