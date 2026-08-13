export function createCardPanel(context) {
  const {
    cardAnchorTone,
    closeCardPanel,
    createTaskActionButton,
    detail,
    formatCardAnchorLabel,
    getActiveWorkspaceRoute,
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkCard,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    loadArtifactsForCard,
    localDocPathFromHref,
    navigateCanonicalWorkspace,
    openDocument,
    openTaskPanel,
    refreshOperationsWorkSnapshot,
    renderArtifactList,
    renderEntityLoadState,
    reportError,
    request,
    settledPayload,
    state,
    summarizeCardProgress,
    taskRequiresApprovedArtifact,
    tasksFromWorkPayload,
    todayIsoDate,
    updateTaskStatus,
    workApiUrl,
    workCardTitle,
    workTaskTitle,
    workflowTaskGroups,
    cardPanelBody,
    cardPanelTitle,
  } = context;

  function openCardPanel(cardId) {
    const card = state.workSnapshot.cardsById?.get(cardId);
    const path = isArchivedWorkCard(card) ? "/cards/archive" : "/cards";
    return navigateCanonicalWorkspace(path, { cardId: cardId }).ready;
  }

  async function hydrateCardPanel(cardId, token) {
    try {
      const [cardResult, tasksResult, artifactsResult] =
        await Promise.allSettled([
          request(workApiUrl(`/api/cards/${encodeURIComponent(cardId)}`)),
          request(workApiUrl(`/api/tasks`, { cardId })),
          loadArtifactsForCard(cardId),
        ]);
      if (
        !isWorkspaceRouteFresh(token) ||
        detail.activeCardPanelId !== cardId
      )
        return;
      if (cardResult.status === "rejected") throw cardResult.reason;
      const cardPayload = settledPayload(cardResult);
      const card = cardPayload && (cardPayload.card || cardPayload);
      const tasks = tasksFromWorkPayload(settledPayload(tasksResult));
      const artifacts = Array.isArray(settledPayload(artifactsResult))
        ? settledPayload(artifactsResult)
        : [];
      if (
        isWorkspaceRouteFresh(token) &&
        detail.activeCardPanelId === cardId
      ) {
        detail.activeCardPanelData = { card, tasks, artifacts };
        renderCardPanel();
        if (detail.activeTaskPanelTask?.cardId === cardId)
          renderTaskPanel();
      }
    } catch (err) {
      if (
        isWorkspaceRouteFresh(token) &&
        detail.activeCardPanelId === cardId
      ) {
        cardPanelTitle.textContent =
          err.status === 404 ? "Card not found" : "Card unavailable";
        renderEntityLoadState(cardPanelBody, {
          kind: "card",
          id: cardId,
          status: err.status === 404 ? "not-found" : "error",
          error: err.message,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => closeCardPanel(),
        });
      }
    }
  }

  function renderEntityLoadingState(container, kind, id) {
    const loadingState = document.createElement("section");
    loadingState.className = "entity-route-state entity-route-loading";
    loadingState.setAttribute("role", "status");
    loadingState.textContent = `Loading ${kind} ${id}…`;
    container.replaceChildren(loadingState);
  }

  function renderCardPanel() {
    const data = detail.activeCardPanelData;
    const card = data?.card;
    const tasks = data?.tasks || [];
    const artifacts = data?.artifacts || [];
    cardPanelTitle.textContent = card ? workCardTitle(card) : "Card";
    cardPanelBody.replaceChildren();
    if (!card) return;

    const today = todayIsoDate();
    const progress = summarizeCardProgress(card, tasks, today);
    const layout = document.createElement("div");
    layout.className = "workflow-modal-layout";
    const main = document.createElement("div");
    main.className = "workflow-modal-main";
    layout.append(main);
    cardPanelBody.append(layout);

    // Stage + progress summary
    const meta = document.createElement("div");
    meta.className = "task-detail-meta workflow-detail-summary";
    const stageLabel = document.createElement("label");
    stageLabel.className = "workflow-stage-field";
    if (isArchivedWorkCard(card)) {
      stageLabel.textContent = "Status";
      const completed = document.createElement("span");
      completed.className = "card-stage-static";
      completed.textContent = "Completed";
      stageLabel.append(completed);
    } else {
      stageLabel.textContent = "Stage ";
      const stageSelect = document.createElement("select");
      stageSelect.className = "card-stage-select";
      for (const stage of ["preparation", "announced", "after-event"]) {
        const opt = document.createElement("option");
        opt.value = stage;
        opt.textContent = labelizeWorkValue(stage);
        if (card.stage === stage) opt.selected = true;
        stageSelect.append(opt);
      }
      stageSelect.addEventListener("change", () =>
        updateCardStage(card.id, stageSelect.value),
      );
      stageLabel.append(stageSelect);
    }
    const summaryTop = document.createElement("div");
    summaryTop.className = "workflow-summary-top";
    if (card.anchorDate) {
      const anchor = document.createElement("span");
      anchor.className = `workflow-card-anchor is-${cardAnchorTone(card.anchorDate, today) || "upcoming"}`;
      anchor.dataset.anchorDate = String(card.anchorDate).slice(0, 10);
      anchor.setAttribute("aria-label", `Card date ${card.anchorDate}`);
      anchor.textContent = formatCardAnchorLabel(card.anchorDate, today);
      summaryTop.append(anchor);
    }
    const countRow = document.createElement("span");
    countRow.className = "workflow-card-count";
    countRow.textContent =
      progress.total > 0
        ? `${progress.done}/${progress.total} tasks`
        : "No tasks loaded";
    summaryTop.append(countRow, stageLabel);
    meta.append(summaryTop);

    // Progress bar
    if (progress.total > 0) {
      const bar = document.createElement("div");
      bar.className = `ops-progress${progress.percent >= 100 ? " is-complete" : ""}`;
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", progress.label);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(progress.percent));
      const fill = document.createElement("i");
      fill.style.width = `${progress.percent}%`;
      bar.append(fill);
      meta.append(bar);
    }

    const flagRow = document.createElement("div");
    flagRow.className = "workflow-card-flags";
    for (const flag of [
      { count: progress.overdue, label: "overdue", tone: "danger" },
      { count: progress.waiting, label: "waiting", tone: "info" },
      { count: progress.missingProof, label: "missing proof", tone: "warning" },
    ].filter((flag) => Number(flag.count) > 0)) {
      const chip = document.createElement("small");
      chip.className = `workflow-card-flag is-${flag.tone}`;
      chip.textContent = `${flag.count} ${flag.label}`;
      flagRow.append(chip);
    }
    if (flagRow.children.length > 0) meta.append(flagRow);

    if (progress.nextDueTask) {
      const nextRow = document.createElement("p");
      nextRow.className = "workflow-next-task";
      const nextLabel = document.createElement("span");
      nextLabel.textContent = "Next up";
      const nextValue = document.createElement("strong");
      const nextDate = String(progress.nextDueTask.date || "").slice(0, 10);
      nextValue.textContent = nextDate
        ? `${workTaskTitle(progress.nextDueTask)} · ${formatCardAnchorLabel(nextDate, today)}`
        : workTaskTitle(progress.nextDueTask);
      nextRow.append(nextLabel, nextValue);
      meta.append(nextRow);
    }

    if (card.description) {
      const descRow = document.createElement("div");
      descRow.className = "workflow-description";
      descRow.textContent = card.description;
      meta.append(descRow);
    }
    main.append(meta);

    // Card links
    if (Array.isArray(card.cardLinks) && card.cardLinks.length > 0) {
      const linksSection = document.createElement("div");
      linksSection.className =
        "task-history workflow-detail-section workflow-links-section";
      const linksLabel = document.createElement("div");
      linksLabel.className = "task-history-label";
      linksLabel.textContent = "Links";
      linksSection.append(linksLabel);
      for (const link of card.cardLinks) {
        const linkName = link.name || link.label || "Link";
        const linkUrl = link.url || "";
        const wrap = document.createElement("div");
        wrap.className = "task-required-link card-link-row";
        const label = document.createElement("label");
        label.className = "card-link-label";
        const name = document.createElement("span");
        name.className = "card-link-name";
        name.textContent = linkName;
        const input = document.createElement("input");
        input.type = "url";
        input.className = "card-link-input";
        input.value = linkUrl;
        input.placeholder = "https://...";
        input.addEventListener("change", () =>
          saveCardLink(
            card.id,
            card.cardLinks,
            linkName,
            input.value.trim(),
          ),
        );
        label.append(name, input);
        wrap.append(label);
        if (/^https?:\/\//i.test(linkUrl)) {
          const open = document.createElement("a");
          open.className = "card-link-open";
          open.href = linkUrl;
          open.target = "_blank";
          open.rel = "noopener";
          open.textContent = "Open";
          open.setAttribute("aria-label", `Open ${linkName} in a new tab`);
          wrap.append(open);
        } else {
          const missing = document.createElement("span");
          missing.className = "workflow-card-flag is-warning card-link-state";
          missing.textContent = "missing";
          wrap.append(missing);
        }
        linksSection.append(wrap);
      }
      main.append(linksSection);
    }

    // Task checklist
    if (tasks.length > 0) {
      const checklistSection = document.createElement("div");
      checklistSection.className =
        "task-history workflow-detail-section workflow-checklist-section";
      const checklistLabel = document.createElement("div");
      checklistLabel.className = "task-history-label";
      checklistLabel.textContent = "Tasks";
      checklistSection.append(checklistLabel);
      const list = document.createElement("div");
      list.className = "task-history-list";
      for (const group of workflowTaskGroups(tasks, today)) {
        const groupTitle = document.createElement("div");
        groupTitle.className = "card-task-group-title";
        groupTitle.textContent = `${group.title} (${group.tasks.length})`;
        list.append(groupTitle);
        if (group.tasks.length === 0) {
          const empty = document.createElement("div");
          empty.className = "task-history-event";
          empty.textContent = group.empty;
          list.append(empty);
        } else {
          for (const task of group.tasks)
            list.append(renderCardChecklistItem(task, card.id, today));
        }
      }
      checklistSection.append(list);
      main.append(checklistSection);
    }

    // References and artifact links (always shown, with add capability)
    const refsSection = document.createElement("div");
    refsSection.className =
      "task-history workflow-detail-section workflow-references-section";
    const refsLabel = document.createElement("div");
    refsLabel.className = "task-history-label";
    refsLabel.textContent = "Process references";
    refsSection.append(refsLabel);
    const refsList = document.createElement("div");
    refsList.className = "task-history-list";
    const existingRefs = Array.isArray(card.references)
      ? card.references
      : [];
    for (const ref of existingRefs) {
      const refUrl = typeof ref === "string" ? ref : ref.url || ref.link || "";
      const refName =
        typeof ref === "string" ? ref : ref.name || ref.title || refUrl;
      if (!refUrl) continue;
      const item = document.createElement("div");
      item.className = "task-history-event";
      const docPath = localDocPathFromHref(refUrl);
      if (docPath) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "task-instruction-doc-link";
        link.textContent = String(refName);
        link.addEventListener("click", () =>
          openDocument(docPath, {
            returnContext: {
              type: "workflow",
              id: card.id,
              title: workCardTitle(card),
            },
          }),
        );
        item.append(link);
      } else {
        const link = document.createElement("a");
        link.href = String(refUrl);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = String(refName);
        item.append(link);
      }
      refsList.append(item);
    }
    refsSection.append(refsList);
    if (!refsList.children.length) {
      const empty = document.createElement("div");
      empty.className = "task-history-event";
      empty.textContent = "No internal Process Docs linked to this Card.";
      refsList.append(empty);
    }

    const assistantState = document.createElement("p");
    assistantState.className = "workflow-assistant-note";
    assistantState.textContent = state.assistantSnapshot.loaded
      ? "Assistant jobs are available from the Assistants surface when linked to this Card."
      : "Assistant jobs are not connected to this Card.";
    refsSection.append(assistantState);

    // Add artifact/reference link form
    const addRow = document.createElement("div");
    addRow.className = "task-follow-up-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Label (e.g. Podcast doc)";
    nameInput.className = "card-ref-name";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    urlInput.className = "card-ref-url";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", () =>
      addCardReference(
        card.id,
        existingRefs,
        nameInput.value.trim(),
        urlInput.value.trim(),
      ),
    );
    addRow.append(nameInput, urlInput, addBtn);
    refsSection.append(addRow);
    refsSection.append(
      renderArtifactList({
        ownerType: "card",
        ownerId: card.id,
        artifacts,
        required: false,
        onRefresh: async () => {
          detail.activeCardPanelData = {
            ...detail.activeCardPanelData,
            artifacts: await loadArtifactsForCard(card.id),
          };
          renderCardPanel();
        },
      }),
    );
    main.append(refsSection);
  }

  function renderCardChecklistItem(task, cardId, today) {
    const row = document.createElement("div");
    row.className = "card-checklist-item";
    const status = String(task.status || "todo").toLowerCase();
    const isDone = status === "done";
    const isWaiting = status === "waiting";
    const cardArtifacts = detail.activeCardPanelData?.artifacts || [];

    const missingLink = !isDone && task.requiredLinkName && !task.link;
    const missingFile =
      !isDone && task.requiresFile && !hasTaskFileEvidence(task);
    const missingArtifact =
      !isDone &&
      taskRequiresApprovedArtifact(task) &&
      !hasApprovedArtifactEvidence(task, cardArtifacts);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute(
      "aria-label",
      `${isDone ? "Reopen" : "Complete"} ${workTaskTitle(task)}`,
    );
    checkbox.checked = isDone;
    checkbox.disabled =
      isWaiting || missingLink || missingFile || missingArtifact;
    if (checkbox.disabled && !isDone) {
      const reasons = [];
      if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
      if (missingFile) reasons.push("Upload required file");
      if (missingArtifact) reasons.push("Approve an attached artifact");
      if (isWaiting) reasons.push("Waiting task");
      checkbox.title = reasons.join("; ");
    }
    checkbox.addEventListener("change", () => {
      updateTaskStatus(task.id, isDone ? "todo" : "done");
    });

    const label = document.createElement("button");
    label.type = "button";
    label.className = `card-checklist-label ${isDone ? "is-done" : ""}`;
    label.dataset.taskId = task.id;
    label.textContent = workTaskTitle(task);
    label.addEventListener("click", () =>
      openTaskPanel(task.id, {
        preserveCard: true,
        expectedCardId: cardId,
      }),
    );

    const dateMeta = document.createElement("small");
    dateMeta.className = "card-checklist-date";
    const taskDateValue = String(task.date || "").slice(0, 10);
    const isOverdue = !isDone && !isWaiting && taskDateValue && taskDateValue < today;
    if (taskDateValue) {
      const dateChip = document.createElement("span");
      dateChip.className = `card-checklist-day${isOverdue ? " is-overdue" : ""}`;
      dateChip.textContent = formatCardAnchorLabel(taskDateValue, today);
      if (isOverdue) dateChip.title = `Overdue since ${taskDateValue}`;
      dateMeta.append(dateChip);
    }
    if (isWaiting) {
      const waitingChip = document.createElement("span");
      waitingChip.className = "workflow-card-flag is-info";
      waitingChip.textContent = task.waitingFor
        ? `waiting: ${task.waitingFor}`
        : "waiting";
      dateMeta.replaceChildren(waitingChip);
    }

    if (!isDone && (missingLink || missingFile || missingArtifact)) {
      const badge = document.createElement("span");
      badge.className = "card-checklist-evidence workflow-card-flag is-danger";
      if (missingLink) badge.textContent += `${task.requiredLinkName} missing`;
      if (missingLink && missingFile) badge.textContent += "; ";
      if (missingFile) badge.textContent += "file missing";
      if ((missingLink || missingFile) && missingArtifact)
        badge.textContent += "; ";
      if (missingArtifact) badge.textContent += "artifact review missing";
      dateMeta.append(badge);
    }
    row.append(checkbox, label, dateMeta);
    return row;
  }

  async function navigateTaskToWorkflow(task) {
    if (!task?.cardId) return;
    const card = state.workSnapshot.cardsById?.get(task.cardId);
    const path = isArchivedWorkCard(card) ? "/cards/archive" : "/cards";
    await navigateCanonicalWorkspace(path, {
      cardId: task.cardId,
      taskId: task.id,
    }).ready;
  }

  async function addCardReference(cardId, currentRefs, name, url) {
    if (!url) {
      reportError("URL is required.");
      return;
    }
    const ref = { name: name || url, url };
    const updatedRefs = [...(currentRefs || []), ref];
    try {
      const payload = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ references: updatedRefs }),
        },
      );
      const updatedCard = payload && (payload.card || payload);
      if (updatedCard && detail.activeCardPanelId === cardId) {
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          card: updatedCard,
        };
        renderCardPanel();
      }
    } catch (err) {
      reportError(`Could not add link: ${err.message || "request failed"}`);
    }
  }

  async function updateCardStage(cardId, stage) {
    try {
      const payload = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ stage }),
        },
      );
      const updatedCard = payload && (payload.card || payload);
      if (updatedCard && detail.activeCardPanelId === cardId) {
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          card: updatedCard,
        };
        renderCardPanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not update stage: ${err.message || "request failed"}`);
    }
  }

  async function saveCardLink(cardId, currentLinks, linkName, linkValue) {
    const updatedLinks = (currentLinks || []).map((link) =>
      (link.name || link.label) === linkName
        ? { ...link, url: linkValue }
        : link,
    );
    try {
      const payload = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(cardId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ cardLinks: updatedLinks }),
        },
      );
      const updatedCard = payload && (payload.card || payload);
      if (updatedCard && detail.activeCardPanelId === cardId) {
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          card: updatedCard,
        };
        renderCardPanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not save link: ${err.message || "request failed"}`);
    }
  }

  // ---------- Notification bell ----------

  return {
    hydrateCardPanel,
    navigateTaskToWorkflow,
    openCardPanel,
    renderCardPanel,
    renderEntityLoadingState,
  };
}
