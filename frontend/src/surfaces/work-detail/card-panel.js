import { isCanonicalWorkTask } from "../../core/workspace.js";
import { createCardActions } from "./card-actions.js";

export function createCardPanel(context) {
  const {
    cardAnchorTone,
    closeCardPanel,
    createTaskActionButton,
    detail,
    formatCardAnchorLabel,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken = () => 0,
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
    renderTaskPanel,
    reloadTaskIntent,
    retryTaskIntent,
    discardTaskIntent,
    reviewLatestTask,
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

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
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
      let templateUpdate = null;
      let templateUpdateError = "";
      if (card?.templateId) {
        try {
          const updatePayload = await request(
            workApiUrl(`/api/cards/${encodeURIComponent(cardId)}/template-update`),
          );
          templateUpdate = updatePayload?.preview || updatePayload;
        } catch (error) {
          templateUpdateError = error.message || "Template update status is unavailable.";
        }
      }
      if (
        isWorkspaceRouteFresh(token) &&
        detail.activeCardPanelId === cardId
      ) {
        detail.activeCardPanelData = {
          card,
          tasks,
          artifacts,
          templateUpdate,
          templateUpdateError,
        };
        renderCardPanel();
        if (detail.activeTaskPanelTask?.cardId === cardId)
          renderTaskPanel({ preserveDrafts: true });
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

  function renderCardPanelFeedback(feedback) {
    if (!feedback) return null;
    const isTaskIntent = feedback.intent?.entity === "task";
    const phase = feedback.phase === "success" ? "success" :
      feedback.phase === "pending" ? "pending" : "error";
    const section = document.createElement("section");
    section.className = `card-mutation-feedback is-${phase}`;
    section.dataset.cardMutationFeedback = phase;
    section.setAttribute("role", phase === "error" ? "alert" : "status");
    section.setAttribute(
      "aria-live",
      phase === "error" ? "assertive" : "polite",
    );
    section.setAttribute("aria-atomic", "true");
    section.tabIndex = -1;

    const message = document.createElement("p");
    message.className = "card-mutation-feedback-message";
    message.textContent = String(feedback.message || "");
    section.append(message);

    if (phase === "error") {
      const controls = document.createElement("div");
      controls.className = "card-mutation-feedback-controls";
      const retry = typeof feedback.retry === "function"
        ? feedback.retry
        : isTaskIntent
          ? retryTaskIntent
          : feedback.intent
            ? retryCardIntent
            : null;
      if (retry) {
        const retryButton = createTaskActionButton("Retry change", retry);
        retryButton.classList.add("is-primary");
        retryButton.dataset.cardMutationRetry = "true";
        controls.append(retryButton);
      }
      const reload = createTaskActionButton(
        "Reload current Card",
        isTaskIntent ? reloadTaskIntent : reloadCardIntent,
      );
      reload.dataset.cardMutationReload = "true";
      controls.append(reload);
      const discard = createTaskActionButton(
        "Discard change",
        feedback.discard ||
          (isTaskIntent ? discardTaskIntent : discardCardIntent),
      );
      discard.dataset.cardMutationDiscard = "true";
      controls.append(discard);
      section.append(controls);
    }
    return section;
  }

  function renderCardPanel(options = {}) {
    const preserveDrafts = options.preserveDrafts === true;
    const capturedDrafts = preserveDrafts
      ? captureCardPanelDrafts()
      : new Map();
    const data = detail.activeCardPanelData;
    const card = data?.card;
    const tasks = data?.tasks || [];
    const artifacts = data?.artifacts || [];
    cardPanelTitle.replaceChildren();
    appendBreakableText(cardPanelTitle, card ? workCardTitle(card) : "Card");
    cardPanelBody.replaceChildren();
    if (!card) return;

    const today = todayIsoDate();
    const panelMutationBusy = detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy;
    const progress = summarizeCardProgress(card, tasks, today);
    const layout = document.createElement("div");
    layout.className = "workflow-modal-layout";
    const main = document.createElement("div");
    main.className = "workflow-modal-main";
    layout.append(main);
    cardPanelBody.append(layout);

    let conflictClaimedFocus = false;
    let feedbackClaimedFocus = false;

    if (detail.activeTaskPanelConflict?.owner === "card" && detail.activeTaskPanelDraft) {
      const conflict = detail.activeTaskPanelConflict;
      const latest = conflict.currentTask;
      const recovery = document.createElement("section");
      recovery.className = "task-version-conflict card-task-version-conflict";
      recovery.setAttribute("role", "alert");
      recovery.setAttribute("aria-live", "assertive");
      recovery.tabIndex = -1;
      const heading = document.createElement("strong");
      heading.textContent = conflict.code === "card_lifecycle_conflict"
        ? "This Card or its Tasks changed elsewhere. Review the latest work or retry your change."
        : "This Task changed elsewhere. Review the latest Task or retry your change.";
      const latestState = document.createElement("p");
      latestState.textContent = `Latest server state: version ${latest.version}, status ${latest.status}.`;
      const currentCard = conflict.currentCard || conflict.currentCards?.[0];
      if (currentCard) {
        latestState.textContent += ` Card version ${currentCard.version}, ${labelizeWorkValue(currentCard.stage)}.`;
      }
      const retained = document.createElement("p");
      retained.className = "task-conflict-draft";
      retained.textContent = `Your retained change: ${detail.activeTaskPanelDraft.label}`;
      const controls = document.createElement("div");
      controls.className = "task-conflict-controls";
      const review = createTaskActionButton("Review latest", reviewLatestTask);
      const retry = createTaskActionButton("Retry my change", retryTaskIntent);
      retry.classList.add("is-primary");
      const discard = createTaskActionButton("Discard my change", discardTaskIntent);
      for (const button of [review, retry, discard]) {
        button.disabled = panelMutationBusy;
      }
      controls.append(review, retry, discard);
      recovery.append(heading, latestState, retained, controls);
      main.append(recovery);
      recovery.focus();
      conflictClaimedFocus = true;
    }

    if (detail.activeCardPanelConflict && detail.activeCardPanelDraft) {
      const conflict = detail.activeCardPanelConflict;
      const latest = conflict.currentCard;
      const recovery = document.createElement("section");
      recovery.className = "task-version-conflict card-version-conflict";
      recovery.setAttribute("role", "alert");
      recovery.setAttribute("aria-live", "assertive");
      recovery.tabIndex = -1;
      const heading = document.createElement("strong");
      heading.textContent =
        "This Card changed elsewhere. Review the latest Card or retry your change.";
      const latestState = document.createElement("p");
      latestState.textContent = `Latest server state: version ${latest.version}, ${labelizeWorkValue(latest.stage)}.`;
      const retained = document.createElement("p");
      retained.className = "task-conflict-draft";
      appendBreakableText(
        retained,
        `Your retained change: ${detail.activeCardPanelDraft.label}`,
      );
      const controls = document.createElement("div");
      controls.className = "task-conflict-controls";
      const review = createTaskActionButton("Review latest", reviewLatestCard);
      const retry = createTaskActionButton("Retry my change", retryCardIntent);
      retry.classList.add("is-primary");
      const discard = createTaskActionButton("Discard my change", discardCardIntent);
      for (const button of [review, retry, discard]) {
        button.disabled = panelMutationBusy;
      }
      controls.append(review, retry, discard);
      recovery.append(heading, latestState, retained, controls);
      main.append(recovery);
      recovery.focus();
      conflictClaimedFocus = true;
    }

    if (!conflictClaimedFocus && detail.activeCardPanelFeedback) {
      const feedback = renderCardPanelFeedback(detail.activeCardPanelFeedback);
      main.append(feedback);
      const focusSelector = detail.activeCardPanelFeedback.focusSelector;
      const focusTarget = focusSelector
        ? main.querySelector(focusSelector)
        : null;
      if (focusTarget) {
        focusTarget.setAttribute("aria-invalid", "true");
        focusTarget.focus();
      } else {
        feedback.focus();
      }
      feedbackClaimedFocus = true;
    }

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
      const completion = document.createElement("span");
      completion.className = "card-completion-meta";
      const actor = state.workSnapshot.usersById?.get(card.completedBy);
      const completedBy = actor?.name || card.completedBy;
      completion.textContent = `${String(card.completedAt).slice(0, 16).replace("T", " ")} · ${completedBy} · from ${labelizeWorkValue(card.activeStageBeforeCompletion)}`;
      stageLabel.append(completion);
    } else {
      stageLabel.textContent = "Stage ";
      const stageSelect = document.createElement("select");
      stageSelect.className = "card-stage-select";
      for (const stage of ["preparation", "announced", "after-event"]) {
        const opt = document.createElement("option");
        opt.value = stage;
        opt.textContent = labelizeWorkValue(stage);
        const displayedStage = detail.activeCardPanelDraft?.kind === "stage"
          ? detail.activeCardPanelDraft.payload.stage
          : card.stage;
        if (displayedStage === stage) opt.selected = true;
        stageSelect.append(opt);
      }
      stageSelect.disabled =
        detail.activeCardMutationBusy ||
        detail.activeTaskMutationBusy ||
        detail.activeCardTemplateBusy;
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
      const nextText = nextDate
        ? `${workTaskTitle(progress.nextDueTask)} · ${formatCardAnchorLabel(nextDate, today)}`
        : workTaskTitle(progress.nextDueTask);
      appendBreakableText(nextValue, nextText);
      nextRow.append(nextLabel, nextValue);
      meta.append(nextRow);
    }

    if (card.description) {
      const descRow = document.createElement("div");
      descRow.className = "workflow-description";
      appendBreakableText(descRow, card.description);
      meta.append(descRow);
    }
    main.append(meta);
    const templateUpdate = renderCardTemplateUpdate(card, data);
    if (templateUpdate) main.append(templateUpdate);

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
        appendBreakableText(name, linkName);
        const input = document.createElement("input");
        input.type = "url";
        input.className = "card-link-input";
        input.dataset.cardDraftKey = `template-link:${linkName}`;
        const draftLinks = detail.activeCardPanelDraft?.kind === "card-link"
          ? detail.activeCardPanelDraft.payload.cardLinks
          : null;
        input.value = draftLinks?.find(
          (value) => (value.name || value.label) === linkName,
        )?.url ?? linkUrl;
        input.placeholder = "https://...";
        input.disabled =
          detail.activeCardMutationBusy ||
          detail.activeTaskMutationBusy ||
          detail.activeCardTemplateBusy;
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
        appendBreakableText(link, refName);
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
        appendBreakableText(link, refName);
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
    nameInput.dataset.cardDraftKey = "new-reference-name";
    if (detail.activeCardPanelDraft?.kind === "reference") {
      nameInput.value = detail.activeCardPanelDraft.form?.name || "";
    }
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    urlInput.className = "card-ref-url";
    urlInput.dataset.cardDraftKey = "new-reference-url";
    if (detail.activeCardPanelDraft?.kind === "reference") {
      urlInput.value = detail.activeCardPanelDraft.form?.url || "";
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Add";
    nameInput.disabled =
      detail.activeCardMutationBusy ||
      detail.activeTaskMutationBusy ||
      detail.activeCardTemplateBusy;
    urlInput.disabled =
      detail.activeCardMutationBusy ||
      detail.activeTaskMutationBusy ||
      detail.activeCardTemplateBusy;
    addBtn.disabled =
      detail.activeCardMutationBusy ||
      detail.activeTaskMutationBusy ||
      detail.activeCardTemplateBusy;
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
          const token = getActiveWorkspaceRouteToken();
          if (!routeIsFresh(token) || detail.activeCardPanelId !== card.id) {
            return false;
          }
          const refreshedArtifacts = await loadArtifactsForCard(card.id);
          if (!routeIsFresh(token) || detail.activeCardPanelId !== card.id) {
            return false;
          }
          detail.activeCardPanelData = {
            ...detail.activeCardPanelData,
            artifacts: refreshedArtifacts,
          };
          renderCardPanel({ preserveDrafts: true });
          return refreshedArtifacts;
        },
      }),
    );
    main.append(refsSection);
    if (preserveDrafts) restoreCardPanelDrafts(capturedDrafts);
    if (feedbackClaimedFocus && detail.activeCardPanelFeedback?.focusSelector) {
      const focusTarget = main.querySelector(
        detail.activeCardPanelFeedback.focusSelector,
      );
      if (focusTarget) {
        focusTarget.setAttribute("aria-invalid", "true");
        focusTarget.focus();
      }
    }
  }

  function renderCardChecklistItem(task, cardId, today) {
    if (!isCanonicalWorkTask(task)) {
      throw new Error("Task payload is not in the canonical versioned shape");
    }
    const row = document.createElement("div");
    row.className = "card-checklist-item";
    const status = task.status;
    const isDone = status === "done" || status === "archived";
    const isArchived = status === "archived";
    const isWaiting = status === "waiting";
    const cardArtifacts = detail.activeCardPanelData?.artifacts || [];
    const pendingStatus = detail.activeTaskMutationBusy &&
      detail.activeTaskPanelDraft?.taskId === task.id &&
      detail.activeTaskPanelDraft?.kind === "status"
      ? detail.activeTaskPanelDraft.payload?.status
      : null;

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
      `${isArchived ? "Retired" : isDone ? "Reopen" : "Complete"} ${workTaskTitle(task)}`,
    );
    // Preserve the native checkbox state while the change handler is awaiting
    // the server. The pending rerender must not make Playwright/keyboard users
    // observe an unchecked replacement after they just checked it.
    checkbox.checked = pendingStatus ? pendingStatus === "done" : isDone;
    checkbox.disabled =
      detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy ||
      isArchived || isWaiting || missingLink || missingFile || missingArtifact;
    if (checkbox.disabled && !isDone) {
      const reasons = [];
      if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
      if (missingFile) reasons.push("Upload required file");
      if (missingArtifact) reasons.push("Approve an attached artifact");
      if (isWaiting) reasons.push("Waiting task");
      if (isArchived) reasons.push("Retired task");
      checkbox.title = reasons.join("; ");
    }
    checkbox.addEventListener("change", () => {
      updateTaskStatus(task.id, isDone ? "todo" : "done", task.version);
    });

    const label = document.createElement("button");
    label.type = "button";
    label.className = `card-checklist-label ${isDone ? "is-done" : ""}`;
    label.dataset.taskId = task.id;
    appendBreakableText(label, workTaskTitle(task));
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

  function templateUpdateSummary(preview) {
    const counts = preview?.counts || {};
    const parts = [
      [counts.added, "added"],
      [counts.updated, "updated"],
      [counts.archived, "archived"],
      [counts.retainedCompleted, "completed retained"],
      [counts.cardFields, "Card fields"],
    ].filter(([count]) => Number(count) > 0)
      .map(([count, label]) => `${count} ${label}`);
    return parts.length ? parts.join(" · ") : "Definition provenance only";
  }

  function taskUpdateLabel(change) {
    const label = change.targetLabel || change.currentLabel || change.taskRef;
    if (change.action === "add") return `Add ${label}`;
    if (change.action === "archive-removed") return `Archive removed task: ${label}`;
    if (change.action === "retain-completed") return `Retain completed task: ${label}`;
    if (change.action === "refresh-provenance") return `Refresh provenance: ${label}`;
    const fields = (change.changes || []).map(({ field }) => field).join(", ");
    return `Update ${label}${fields ? `: ${fields}` : ""}`;
  }

  function renderCardTemplateUpdate(card, data) {
    if (!card.templateId) return null;
    const preview = data.templateUpdate;
    const section = document.createElement("section");
    section.className = "card-template-update workflow-detail-section";
    const heading = document.createElement("div");
    heading.className = "card-template-update-heading";
    const title = document.createElement("strong");
    title.textContent = "Template definition";
    heading.append(title);
    section.append(heading);

    if (!preview) {
      const unavailable = document.createElement("p");
      unavailable.className = "card-template-update-message is-error";
      unavailable.textContent = data.templateUpdateError || "Template update status is unavailable.";
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "task-action-btn";
      reload.textContent = "Reload template status";
      reload.addEventListener("click", () => reloadCardTemplateUpdate(card.id));
      section.append(unavailable, reload);
      return section;
    }

    const status = document.createElement("p");
    status.className = `card-template-update-status is-${preview.state}`;
    if (preview.state === "current") {
      status.textContent = `Current at Template v${preview.targetTemplateVersion}.`;
      section.append(status);
      return section;
    }
    status.textContent = `Update available: Template v${preview.sourceTemplateVersion} → v${preview.targetTemplateVersion}.`;
    const summary = document.createElement("p");
    summary.className = "card-template-update-summary";
    summary.textContent = templateUpdateSummary(preview);
    section.append(status, summary);

    if (!detail.activeCardTemplateReviewOpen) {
      const review = document.createElement("button");
      review.type = "button";
      review.className = "primary-button card-template-review-button";
      review.textContent = "Review template update";
      review.addEventListener("click", () => {
        detail.activeCardTemplateReviewOpen = true;
        detail.activeCardTemplateMessage = "";
        renderCardPanel();
      });
      section.append(review);
      return section;
    }

    const review = document.createElement("div");
    review.className = "card-template-review";
    const guidance = document.createElement("p");
    guidance.textContent = [
      "Applying this reviewed definition keeps task IDs, live status, notes,",
      "waiting state, links, files, artifacts, and history.",
      "Removed incomplete tasks are archived; completed tasks are retained.",
    ].join(" ");
    review.append(guidance);
    if (Number(preview.counts?.operatorOverrides) > 0) {
      const warning = document.createElement("p");
      warning.className = "card-template-update-message is-warning";
      const plural = preview.counts.operatorOverrides === 1 ? "" : "s";
      warning.textContent = [
        `${preview.counts.operatorOverrides} operator override field${plural}`,
        "will take the reviewed Template value.",
      ].join(" ");
      review.append(warning);
    }
    const list = document.createElement("ul");
    list.className = "card-template-change-list";
    for (const change of preview.cardChanges || []) {
      const item = document.createElement("li");
      item.textContent = `Update Card field: ${change.field}${change.operatorOverride ? " (operator override)" : ""}`;
      list.append(item);
    }
    for (const change of preview.taskChanges || []) {
      const item = document.createElement("li");
      item.textContent = taskUpdateLabel(change);
      if ((change.operatorOverrideFields || []).length > 0) {
        item.textContent += ` (operator override: ${change.operatorOverrideFields.join(", ")})`;
      }
      list.append(item);
    }
    if (!list.children.length) {
      const item = document.createElement("li");
      item.textContent = "Refresh the reviewed Template provenance.";
      list.append(item);
    }
    review.append(list);
    if (detail.activeCardTemplateMessage) {
      const message = document.createElement("p");
      message.className = "card-template-update-message";
      message.setAttribute("role", "status");
      message.textContent = detail.activeCardTemplateMessage;
      review.append(message);
    }
    const actions = document.createElement("div");
    actions.className = "card-template-update-actions";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary-button";
    apply.textContent = detail.activeCardTemplateBusy ? "Applying…" : "Apply reviewed update";
    apply.disabled = detail.activeCardTemplateBusy ||
      detail.activeCardMutationBusy || detail.activeTaskMutationBusy;
    apply.addEventListener("click", () => applyCardTemplateUpdate(card.id, preview.previewToken));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "task-action-btn";
    cancel.textContent = "Cancel";
    cancel.disabled = detail.activeCardTemplateBusy ||
      detail.activeCardMutationBusy || detail.activeTaskMutationBusy;
    cancel.addEventListener("click", () => {
      detail.activeCardTemplateReviewOpen = false;
      detail.activeCardTemplateMessage = "";
      renderCardPanel();
    });
    actions.append(apply, cancel);
    if (detail.activeCardTemplateMessage.includes("changed after preview")) {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "task-action-btn";
      reload.textContent = "Reload latest preview";
      reload.addEventListener("click", () => reloadCardTemplateUpdate(card.id));
      actions.append(reload);
    }
    review.append(actions);
    section.append(review);
    return section;
  }

  function captureCardPanelDrafts() {
    return new Map(
      [...cardPanelBody.querySelectorAll("[data-card-draft-key]")]
        .map((input) => [input.dataset.cardDraftKey, input.value]),
    );
  }

  function restoreCardPanelDrafts(drafts) {
    for (const input of cardPanelBody.querySelectorAll("[data-card-draft-key]")) {
      if (drafts.has(input.dataset.cardDraftKey)) {
        input.value = drafts.get(input.dataset.cardDraftKey);
      }
    }
  }

  function renderCardPanelRetainingDrafts(drafts) {
    renderCardPanel();
    restoreCardPanelDrafts(drafts);
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

  // Keep long operator-provided values breakable in the narrow Card modal
  // without changing the value that is saved or the accessible text.
  function appendBreakableText(element, value) {
    const text = String(value ?? "");
    if (text.length <= 40) {
      element.textContent = text;
      return;
    }
    let chunk = "";
    for (const character of text) {
      chunk += character;
      if (/[/?#&=._:-]/.test(character) || chunk.length >= 24) {
        element.append(document.createTextNode(chunk));
        element.append(document.createElement("wbr"));
        chunk = "";
      }
    }
    if (chunk) element.append(document.createTextNode(chunk));
  }

  const {
    addCardReference,
    applyCardTemplateUpdate,
    discardCardIntent,
    reloadCardIntent,
    reloadCardTemplateUpdate,
    retryCardIntent,
    reviewLatestCard,
    saveCardLink,
    updateCardStage,
  } = createCardActions({
    ...context,
    captureCardPanelDrafts,
    detail,
    renderCardPanel,
    renderCardPanelRetainingDrafts,
  });

  // ---------- Notification bell ----------

  return {
    hydrateCardPanel,
    navigateTaskToWorkflow,
    openCardPanel,
    reloadCardIntent,
    renderCardPanel,
    renderEntityLoadingState,
  };
}
