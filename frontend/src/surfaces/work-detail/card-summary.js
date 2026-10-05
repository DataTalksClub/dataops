// The compact summary head of the Card detail modal: stage control, date and
// flag chips on one row, the progress bar, the next-up line, and the clamped
// Card description.
export const cardDescriptionClampLimit = 220;

// Migration provenance is import bookkeeping, not operator content — keep it
// out of the rendered Card detail without touching the stored description.
export function displayCardDescription(value) {
  return String(value ?? "")
    .replace(/\s*Migration provenance:[\s\S]*$/, "")
    .trim();
}

// Keep long operator-provided values breakable in the narrow Card modal
// without changing the value that is saved or the accessible text.
export function appendBreakableText(element, value) {
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

export function createCardSummary(context) {
  const {
    card,
    cardAnchorTone,
    detail,
    formatCardAnchorLabel,
    isArchivedWorkCard,
    labelizeWorkValue,
    progress,
    state,
    today,
    updateCardStage,
    workTaskTitle,
  } = context;

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
  summaryTop.append(countRow);
  if (flagRow.children.length > 0) summaryTop.append(flagRow);
  summaryTop.append(stageLabel);
  meta.append(summaryTop);

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
    nextValue.title = nextText;
    nextRow.append(nextLabel, nextValue);
    meta.append(nextRow);
  }

  const description = displayCardDescription(card.description);
  if (description) {
    const descRow = document.createElement("div");
    descRow.className = "workflow-description";
    const descText = document.createElement("p");
    descText.className = "workflow-description-text";
    appendBreakableText(descText, description);
    descRow.append(descText);
    if (description.length > cardDescriptionClampLimit) {
      descRow.classList.add("is-clamped");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "workflow-description-toggle";
      toggle.textContent = "Show more";
      toggle.addEventListener("click", () => {
        const clamped = descRow.classList.toggle("is-clamped");
        toggle.textContent = clamped ? "Show more" : "Show less";
      });
      meta.append(descRow, toggle);
    } else {
      meta.append(descRow);
    }
  }
  return meta;
}
