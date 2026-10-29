import { renderCardDocumentSections } from './card-documents.js';
import { documentHref, opensInNewTab } from "../../core/links.js";
import { afterText, blockedReason, blockingPrerequisites, prerequisiteStatusLabel } from "../../core/task-dependencies.js";
import { taskTitleParts } from "../../core/task-display.js";
import { cardLinkUrlForTask, describeMissingProof, hasLinkedCalendarInvite, isCanonicalWorkTask, taskProofState, taskRequiresCalendarInvite } from "../../core/workspace.js";
import { appendChecklistOptionality } from "./task-completion.js";
import { createCardActions } from "./card-actions.js";
import { renderCardTemplateUpdate } from "./card-template-review.js";
import { humanLinkName, ownerAvatar, resolveChecklistOwner } from "./card-display.js";
import { renderCardLinkedFrom, renderChecklistLinkedCard } from "./task-linked-card.js";
import {
  appendBreakableText,
  createCardSummary,
  renderCardNewsletterIssue,
  renderCardTemplateLink,
} from "./card-summary.js";
import { renderCardEventTime, renderCardInvitesSection } from "./card-invites.js";
import { renderWebinarMaterialsAction } from "./webinar-materials.js";
import { renderLinkRow, renderLinkList } from "./link-rows.js";

export function createCardPanel(context) {
  const {
    cardAnchorTone,
    closeCardPanel,
    closeTaskPanel,
    createTaskActionButton,
    detail,
    formatCardAnchorLabel,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken = () => 0,
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkCard,
    isParkedWorkCard,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    loadArtifactsForCard,
    localDocPathFromHref,
    navigateCanonicalWorkspace,
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
    resolveDocReference = () => null,
    settledPayload,
    state,
    summarizeCardProgress,
    taskRequiresApprovedArtifact,
    tasksFromWorkPayload,
    todayIsoDate,
    updateTaskStatus,
    workApiUrl,
    workCardIssueNumber,
    workCardSubtitle,
    workCardTitle,
    workTaskTitle,
    workflowTaskGroups,
    cardPanelBody,
    cardPanelTitle,
  } = context;
  // Link rows whose editor is open, so an unsaved edit survives a rerender.
  const openLinkEditors = new Set();
  const openTaskLinkPrompts = new Set();

  // A Card opens as a dialog over the page showing (`?card=`), which stays
  // as it was underneath. On the Cards pages, and outside any workspace page,
  // it opens at its own address.
  function openCardPanel(cardId) {
    const route = getActiveWorkspaceRoute();
    if (!route || route.invalid || route.cardParam === "cardId") {
      const card = state.workSnapshot.cardsById?.get(cardId);
      const path = isArchivedWorkCard(card) || isParkedWorkCard(card) ? "/cards/archive" : "/cards";
      return navigateCanonicalWorkspace(path, { cardId }).ready;
    }
    const params = new URLSearchParams(route.params);
    params.delete("taskId");
    params.set(route.cardParam, cardId);
    return navigateCanonicalWorkspace(route.path, params).ready;
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
      try {
        const updatePayload = await request(
          workApiUrl(`/api/cards/${encodeURIComponent(cardId)}/template-update`),
        );
        templateUpdate = updatePayload?.preview || updatePayload;
      } catch (error) {
        templateUpdateError = error.message || "Template update status is unavailable.";
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
              { history: "none", reload: true },
            ),
          returnToList: () => closeCardPanel(),
        });
      }
    }
  }

  function renderEntityLoadingState(container, kind, id) {
    if (kind === "card") {
      const skeleton = document.createElement("div");
      skeleton.className = "card-loading-skeleton";
      skeleton.setAttribute("role", "status");
      skeleton.setAttribute("aria-label", "Loading card");
      const title = document.createElement("div");
      title.className = "card-loading-block card-loading-title";
      title.setAttribute("aria-hidden", "true");
      const chips = document.createElement("div");
      chips.className = "card-loading-row";
      chips.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i++) {
        const chip = document.createElement("div");
        chip.className = "card-loading-block card-loading-chip";
        chips.append(chip);
      }
      const rows = document.createElement("div");
      rows.className = "card-loading-rows";
      rows.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 4; i++) {
        const row = document.createElement("div");
        row.className = "card-loading-block card-loading-line";
        rows.append(row);
      }
      skeleton.append(title, chips, rows);
      container.replaceChildren(skeleton);
      return;
    }
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

    // Stage, flags, progress, next-up, and description (shared with
    // card-summary.js to keep this module under the size contract).
    const meta = createCardSummary({
      ...context,
      card,
      deleteCardPanel,
      parkCardPanel,
      progress,
      resumeCardPanel,
      today,
      updateCardStage,
    });
    // The board badge replaces the legacy `[Tag]` title prefix; the detail
    // panel carries the same Template link as a real button, above the
    // stage/date summary.
    main.append(
      renderCardTemplateLink(
        { navigateCanonicalWorkspace, request, workApiUrl },
        card.templateId,
      ),
    );
    main.append(meta);
    main.append(renderCardNewsletterIssue({ request, workApiUrl, reload: reloadCardIntent }, card));
    const materialsAction = renderWebinarMaterialsAction({ request, workApiUrl, reload: reloadCardIntent }, card, state.workSnapshot.templates);
    if (materialsAction) main.append(materialsAction);
    main.append(...renderCardDocumentSections({ card, request, workApiUrl }));
    const templateUpdate = renderCardTemplateUpdate(card, data, {
      detail,
      reloadCardTemplateUpdate,
      applyCardTemplateUpdate,
      renderCardPanel,
    });
    if (templateUpdate) main.append(templateUpdate);

    main.append(...renderCardLinkedFrom(card));
    if (Array.isArray(card.cardLinks) && card.cardLinks.length > 0) main.append(renderCardLinksSection(card));
    if (card.eventTime || card.calendarInvites?.length || tasks.some(taskRequiresCalendarInvite)) {
      main.append(renderCardEventTime({ request, workApiUrl, reload: reloadCardIntent }, card));
    }
    if (Array.isArray(card.calendarInvites) && card.calendarInvites.length > 0) main.append(renderCardInvitesSection(card));

    {
      const artifactsSection = document.createElement("div");
      artifactsSection.className =
        "task-history workflow-detail-section workflow-artifacts-section";
      artifactsSection.append(
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
      main.append(artifactsSection);
    }

    if (tasks.length > 0) {
      const checklistSection = document.createElement("div");
      checklistSection.className =
        "task-history workflow-detail-section workflow-checklist-section";
      const checklistHeader = document.createElement("div");
      checklistHeader.className = "card-checklist-header";
      const checklistLabel = document.createElement("div");
      checklistLabel.className = "task-history-label";
      checklistLabel.textContent = "Tasks";
      checklistHeader.append(checklistLabel);
      if (progress.total > 0 && progress.percent > 0) {
        const percent = document.createElement("span");
        percent.className = "card-checklist-percent";
        percent.textContent = `${progress.percent}%`;
        percent.title = "Done and skipped Tasks count as resolved";
        checklistHeader.append(percent);
      }
      checklistSection.append(checklistHeader);

      if (progress.total > 0 && progress.percent > 0) {
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
        checklistSection.append(bar);
      }

      const list = document.createElement("div");
      list.className = "task-history-list";
      // Completed Tasks stay in place, struck through, instead of jumping to
      // a Done section: sortCardChecklistTasks already orders done last, so
      // the open and done groups concatenate back into stable global order.
      // Only Waiting keeps its own titled group.
      const allGroups = workflowTaskGroups(tasks, today);
      const waitingGroup = allGroups.find(
        (group) => group.title === "Waiting / follow-up",
      );
      const mainTasks = allGroups
        .filter((group) => group !== waitingGroup)
        .flatMap((group) => group.tasks);
      const displayGroups = [
        { title: "", tasks: mainTasks },
        ...(waitingGroup && waitingGroup.tasks.length > 0 ? [waitingGroup] : []),
      ].filter((group) => group.tasks.length > 0);
      for (const group of displayGroups) {
        if (displayGroups.length > 1 && group.title) {
          const groupTitle = document.createElement("div");
          groupTitle.className = "card-task-group-title";
          groupTitle.textContent = `${group.title} (${group.tasks.length})`;
          list.append(groupTitle);
        }
        for (const task of group.tasks)
          list.append(renderCardChecklistItem(task, card.id, today));
      }
      checklistSection.append(list);
      main.append(checklistSection);
    }

    const refsList = document.createElement("div");
    refsList.className = "task-history-list";
    const seenRefs = new Set();
    const appendReferenceItem = (refName, refUrl, isProcessDoc = false) => {
      if (!refUrl && !refName) return;
      const docPath = refUrl ? localDocPathFromHref(refUrl) : "";
      const href = docPath ? documentHref(docPath) : refUrl ? String(refUrl) : "";
      const dedupeKey = href || `label:${refName}`;
      if (seenRefs.has(dedupeKey)) return;
      seenRefs.add(dedupeKey);
      const item = document.createElement("div");
      item.className = "task-history-event";
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        if (docPath || isProcessDoc) link.className = "task-instruction-doc-link";
        appendBreakableText(link, refName || refUrl);
        opensInNewTab(link);
        item.append(link);
      } else {
        appendBreakableText(item, refName);
      }
      refsList.append(item);
    };
    const sourceDocIds = Array.isArray(card.sourceDocIds) ? card.sourceDocIds : [];
    for (const docId of sourceDocIds) {
      if (!docId) continue;
      const doc = resolveDocReference(docId);
      const docUrl = doc?.path || (localDocPathFromHref(docId) ? docId : "");
      const docLabel =
        doc?.title ||
        String(docId).split(".").pop()?.replace(/[-_]+/g, " ") ||
        String(docId);
      appendReferenceItem(docLabel, docUrl, true);
    }
    const existingRefs = Array.isArray(card.references)
      ? card.references
      : [];
    for (const ref of existingRefs) {
      const refUrl = typeof ref === "string" ? ref : ref.url || ref.link || "";
      const refName =
        typeof ref === "string" ? ref : ref.name || ref.title || refUrl;
      if (!refUrl) continue;
      appendReferenceItem(refName, refUrl, false);
    }
    if (refsList.children.length > 0) {
      const refsSection = document.createElement("div");
      refsSection.className =
        "task-history workflow-detail-section workflow-references-section";
      const refsLabel = document.createElement("div");
      refsLabel.className = "task-history-label";
      refsLabel.textContent = "Process references";
      refsSection.append(refsLabel, refsList);
      main.append(refsSection);
    }
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

  // Card links as a dense list: the filled links first (they are what an
  // operator opens), then the missing ones, each one "Add" away. Missing links
  // stay visible rather than folded away: they are the gaps the Card's
  // "missing proof" count is about.
  function renderCardLinksSection(card) {
    const section = document.createElement("div");
    section.className =
      "task-history workflow-detail-section workflow-links-section";
    const header = document.createElement("div");
    header.className = "workflow-links-header";
    const heading = document.createElement("div");
    heading.className = "task-history-label";
    heading.textContent = "Links";
    header.append(heading);
    section.append(header);
    const busy =
      detail.activeCardMutationBusy ||
      detail.activeTaskMutationBusy ||
      detail.activeCardTemplateBusy;
    const draftLinks = detail.activeCardPanelDraft?.kind === "card-link"
      ? detail.activeCardPanelDraft.payload.cardLinks
      : null;
    const filled = [];
    const missing = [];
    const seenUrls = new Set();
    for (const link of card.cardLinks) {
      const linkName = link.name || link.label || "Link";
      const rawUrl = link.url || "";
      const linkUrl = String(rawUrl)
        .replace(/[\s"'\u200c\u200b]+$/, "")
        .replace(/^["']/, "")
        .trim();
      // If a named link already displayed this exact URL, skip the duplicate raw-url item
      if (
        linkUrl &&
        seenUrls.has(linkUrl) &&
        (linkName === rawUrl || linkName === linkUrl || /^https?:\/\//i.test(linkName))
      ) {
        continue;
      }
      if (linkUrl) seenUrls.add(linkUrl);
      const editorKey = `${card.id}\u0000${linkName}`;
      const draftValue = draftLinks?.find(
        (value) => (value.name || value.label) === linkName,
      )?.url;
      const hasDraft = draftValue !== undefined && draftValue !== linkUrl;
      const row = renderLinkRow({
        label: humanLinkName(linkName),
        value: linkUrl,
        disabled: busy,
        editing: openLinkEditors.has(editorKey) || hasDraft,
        draftKey: `template-link:${linkName}`,
        draftValue: hasDraft ? draftValue : undefined,
        onEditingChange: (open) => {
          if (open) openLinkEditors.add(editorKey);
          else openLinkEditors.delete(editorKey);
        },
        onSave: (value) =>
          saveCardLink(card.id, card.cardLinks, linkName, value),
      });
      (linkUrl ? filled : missing).push(row);
    }
    if (missing.length) {
      const count = document.createElement("span");
      count.className = "workflow-links-missing";
      count.textContent = `${missing.length} missing`;
      header.append(count);
    }
    section.append(renderLinkList([...filled, ...missing], "Card links"));
    return section;
  }

  function renderCardChecklistItem(task, cardId, today) {
    if (!isCanonicalWorkTask(task)) {
      throw new Error("Task payload is not in the canonical versioned shape");
    }
    const row = document.createElement("div");
    row.className = "card-checklist-item";
    const status = task.status;
    const isDone = status === "done" || status === "skipped";
    const isSkipped = status === "skipped";
    const isWaiting = status === "waiting";
    const cardArtifacts = detail.activeCardPanelData?.artifacts || [];
    const pendingStatus = detail.activeTaskMutationBusy &&
      detail.activeTaskPanelDraft?.taskId === task.id &&
      detail.activeTaskPanelDraft?.kind === "status"
      ? detail.activeTaskPanelDraft.payload?.status
      : null;

    const activeCard = detail.activeCardPanelData?.card || null;
    const resolvedTaskLink = cardLinkUrlForTask(activeCard, task);
    const missingLink = !isDone && Boolean(task.requiredLinkName) && !resolvedTaskLink;
    const missingFile =
      !isDone && task.requiresFile && !hasTaskFileEvidence(task);
    const missingInvite = !isDone && taskRequiresCalendarInvite(task) && !hasLinkedCalendarInvite(activeCard);
    const missingArtifact =
      !isDone &&
      taskRequiresApprovedArtifact(task) &&
      !hasApprovedArtifactEvidence(task, cardArtifacts);
    // Proof the task panel collects (url/comment/external-status/file): the
    // checkbox stays off until it exists, and the row names it, so Done from
    // here is never a dead click that fails server-side.
    const missingProof = !isDone
      ? taskProofState(task, activeCard).missing.filter(
        (entry) => entry !== task.requiredLinkName && entry !== "required file" && entry !== "approved artifact" && entry !== "calendar invite",
      )
      : [];

    const siblingTasks = detail.activeCardPanelData?.tasks || [];
    const blockedBy = blockedReason(task, siblingTasks);
    const blocking = blockingPrerequisites(task, siblingTasks);
    const isBlocked = blocking.length > 0;
    const cleanTitle = taskTitleParts(workTaskTitle(task), task?.tags).title;
    const mutationBusy =
      detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy;
    const canInlineCompleteWithLink =
      !isDone &&
      !isWaiting &&
      !isBlocked &&
      missingLink &&
      !missingInvite &&
      !missingFile &&
      !missingArtifact &&
      missingProof.length === 0;

    // A skipped Task is resolved without being done: a dash mark instead of
    // a checked box, a muted title that is not struck through, and its reason
    // on a muted line underneath.
    let control;
    if (isSkipped) {
      control = document.createElement("span");
      control.className = "card-checklist-skip";
      control.setAttribute("role", "img");
      control.setAttribute("aria-label", "Skipped");
      control.title = "Skipped: unskip it from the task";
    } else {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute(
        "aria-label",
        `${isDone ? "Reopen" : "Complete"} ${cleanTitle}`,
      );
      // Preserve the native checkbox state while the change handler is awaiting
      // the server. The pending rerender must not make Playwright/keyboard users
      // observe an unchecked replacement after they just checked it.
      checkbox.checked = pendingStatus ? pendingStatus === "done" : isDone;
      checkbox.disabled =
        mutationBusy ||
        isWaiting || Boolean(blockedBy) ||
        missingLink || missingFile || missingInvite || missingArtifact || missingProof.length > 0;
      if (checkbox.disabled && !isDone) {
        const reasons = [];
        if (blockedBy) reasons.push(blockedBy);
        if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
        if (missingFile) reasons.push("Upload required file"); if (missingInvite) reasons.push("Set the event time on the card");
        if (missingArtifact) reasons.push("Approve an attached artifact");
        for (const entry of missingProof) reasons.push(describeMissingProof(entry));
        if (isWaiting) reasons.push("Waiting task");
        checkbox.title = reasons.join("; ");
      }
      checkbox.addEventListener("change", () => {
        updateTaskStatus(task.id, isDone ? "todo" : "done", task.version);
      });
      control = checkbox;
    }

    const body = document.createElement("div");
    body.className = "card-checklist-body";
    const label = document.createElement("button");
    label.type = "button";
    label.className = `card-checklist-label${isSkipped ? " is-skipped" : isDone ? " is-done" : ""}`;
    label.dataset.taskId = task.id;
    appendBreakableText(label, cleanTitle);
    label.addEventListener("click", () => openTaskPanel(task.id));
    body.append(label);

    // One muted line under the title: why it is skipped or what it waits
    // for. It never widens the row; the full text is in its title.
    const noteText = isSkipped
      ? task.skipReason || "Not applicable"
      : isWaiting && task.waitingFor ? task.waitingFor : "";
    if (isSkipped || isWaiting) {
      const note = document.createElement("small");
      note.className = `card-checklist-note${isSkipped ? " card-checklist-skipped" : ""}`;
      const kind = document.createElement("span");
      kind.className = "card-checklist-note-kind";
      kind.textContent = isSkipped ? "Skipped" : "Waiting";
      note.append(kind);
      if (noteText) note.append(document.createTextNode(` · ${noteText}`));
      note.title = `${kind.textContent}${noteText ? `: ${noteText}` : ""}`;
      body.append(note);
    }

    body.append(...renderChecklistLinkedCard(task));

    // Unlock condition: name the blocking steps and how to free this checkbox.
    // "after A" alone was opaque when the top step looked done but dependents stayed grey.
    if (isBlocked) {
      const after = document.createElement("small");
      after.className = "card-checklist-after";
      after.id = `card-checklist-after-${task.id}`;
      const unlock = blockedBy || afterText(blocking);
      after.title = unlock;
      const kind = document.createElement("span");
      kind.className = "card-checklist-after-kind";
      kind.textContent = "Blocked until you complete or skip";
      after.append(kind);
      after.append(" ");
      blocking.forEach((entry, index) => {
        if (index > 0) after.append(index === blocking.length - 1 ? " and " : ", ");
        const entryTitle = taskTitleParts(entry.description || "", []).title;
        if (entry.status === "missing") {
          after.append(entryTitle);
          return;
        }
        const link = document.createElement("a");
        link.className = "card-checklist-after-link";
        link.href = `/cards?cardId=${encodeURIComponent(cardId)}&taskId=${encodeURIComponent(entry.id)}`;
        link.textContent = entryTitle;
        link.title = `Open to complete or skip · currently ${prerequisiteStatusLabel?.(entry.status) || entry.status || "open"}`;
        link.addEventListener("click", (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          openTaskPanel(entry.id);
        });
        after.append(link);
      });
      body.append(after);
      if (control.tagName === "INPUT") control.setAttribute("aria-describedby", after.id);
    }

    // Required-vs-optional from the Template config, in the row's voice.
    if (!isDone && !isWaiting) appendChecklistOptionality(body, task);

    if (canInlineCompleteWithLink) {
      const promptKey = `${cardId}\u0000${task.id}`;
      const isEditingLink = openTaskLinkPrompts.has(promptKey);
      if (isEditingLink) {
        const editor = document.createElement("div");
        editor.className = "card-checklist-link-editor";
        const input = document.createElement("input");
        input.type = "url";
        input.className = "dk-input card-checklist-link-input";
        input.placeholder = `${task.requiredLinkName} URL (https://…)`;
        input.setAttribute("aria-label", `${task.requiredLinkName} link`);
        input.dataset.cardDraftKey = `task-link:${task.id}`;
        input.disabled = mutationBusy;
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "dk-button dk-button--primary dk-button--sm card-checklist-link-save";
        submit.textContent = "Complete";
        submit.disabled = mutationBusy;
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "dk-button dk-button--sm card-checklist-link-cancel";
        cancel.textContent = "Cancel";
        const commit = async () => {
          const nextUrl = input.value.trim();
          if (!nextUrl) {
            input.focus();
            return;
          }
          openTaskLinkPrompts.delete(promptKey);
          await updateTaskStatus(task.id, "done", task.version, { link: nextUrl });
        };
        submit.addEventListener("click", commit);
        cancel.addEventListener("click", () => {
          openTaskLinkPrompts.delete(promptKey);
          renderCardPanel({ preserveDrafts: true });
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            openTaskLinkPrompts.delete(promptKey);
            renderCardPanel({ preserveDrafts: true });
          }
        });
        editor.append(input, submit, cancel);
        body.append(editor);
      } else if (task.requiredLinkName !== "Completion proof") {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "card-checklist-link-trigger";
        trigger.disabled = mutationBusy;
        trigger.textContent = `+ Provide ${task.requiredLinkName}`;
        trigger.addEventListener("click", () => {
          openTaskLinkPrompts.add(promptKey);
          renderCardPanel({ preserveDrafts: true });
          const input = cardPanelBody.querySelector(
            `[data-card-draft-key="task-link:${task.id}"]`,
          );
          input?.focus?.();
        });
        body.append(trigger);
      }
    } else if (!isDone && !isBlocked && !isWaiting && (missingFile || missingInvite || missingArtifact || missingProof.length > 0)) {
      const flags = document.createElement("div");
      flags.className = "card-checklist-flags";
      const missing = [];
      if (missingLink && task.requiredLinkName !== "Completion proof") {
        missing.push(`Needs ${task.requiredLinkName}`);
      }
      if (missingFile) missing.push("Needs file"); if (missingInvite) missing.push("Needs calendar invite");
      if (missingArtifact) missing.push("Needs artifact");
      for (const entry of missingProof) {
        if (entry === "external status" || entry.endsWith("(external status)")) missing.push("Needs external status");
        else if (entry === "comment" || entry.endsWith("(comment)")) missing.push("Needs comment");
        else if (entry === "proof link" || entry.endsWith("(link)")) missing.push("Needs proof link");
        else missing.push(`Needs ${entry}`);
      }
      if (missing.length > 0) {
        const badge = document.createElement("span");
        badge.className = "card-checklist-evidence workflow-card-flag";
        badge.textContent = missing.join(" · ");
        flags.append(badge);
        body.append(flags);
      }
    }

    const dateMeta = document.createElement("small");
    dateMeta.className = "card-checklist-date";
    const taskDateValue = String(task.date || "").slice(0, 10);
    // A task still waiting on a prerequisite is not late yet: its
    // prerequisite is, and that row carries the colour.
    const isOverdue = !isDone && !isWaiting && !isBlocked && taskDateValue && taskDateValue < today;
    if (taskDateValue) {
      const dateChip = document.createElement("span");
      dateChip.className = `card-checklist-day${isOverdue ? " is-overdue" : ""}`;
      dateChip.textContent = formatCardAnchorLabel(taskDateValue, today);
      if (isOverdue) dateChip.title = `Overdue since ${taskDateValue}`;
      dateMeta.append(dateChip);
    }

    // Every row keeps an owner slot so avatars line up in one column.
    const owner = document.createElement("span");
    owner.className = "card-checklist-owner";
    const person = resolveChecklistOwner(task, state.workSnapshot.usersById);
    if (person) owner.append(ownerAvatar(person));

    row.classList.toggle("is-skipped", isSkipped);
    row.classList.toggle("is-done", isDone && !isSkipped);
    row.classList.toggle("is-blocked", isBlocked);
    row.dataset.taskId = task.id;
    // Hovering a waiting row tints the rows it waits on.
    if (isBlocked) {
      const ids = new Set(blocking.map((entry) => entry.id));
      const linked = () => [...(row.parentElement?.children || [])]
        .filter((other) => ids.has(other.dataset?.taskId));
      const tint = (on) => { for (const other of linked()) other.classList.toggle("is-linked", on); };
      row.addEventListener("mouseenter", () => tint(true));
      row.addEventListener("mouseleave", () => tint(false));
    }
    row.append(control, body, dateMeta, owner);
    return row;
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
        if (input.value) {
          const form = input.closest?.("details");
          if (form) form.open = true;
        }
      }
    }
  }

  function renderCardPanelRetainingDrafts(drafts) {
    renderCardPanel();
    restoreCardPanelDrafts(drafts);
  }

  // The Task dialog's Card row: back to the Card when the Task was opened
  // from it, otherwise the Card in place of the Task.
  async function navigateTaskToWorkflow(task) {
    if (!task?.cardId) return;
    if (getActiveWorkspaceRoute()?.modalCardId === task.cardId) {
      await closeTaskPanel();
      return;
    }
    await openCardPanel(task.cardId);
  }

  const {
    applyCardTemplateUpdate,
    deleteCardPanel,
    discardCardIntent,
    parkCardPanel,
    reloadCardIntent,
    reloadCardTemplateUpdate,
    resumeCardPanel,
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
