// The compact summary head of the Card detail modal: stage control, date and
// flag chips on one row, the progress bar, the next-up line, and the clamped
// Card description.
export const cardDescriptionClampLimit = 450;

// Migration provenance is import bookkeeping, not operator content — keep it
// out of the rendered Card detail without touching the stored description.
export function displayCardDescription(value) {
  return String(value ?? "")
    .replace(/\s*Migration provenance:[\s\S]*$/, "")
    .trim();
}

const cardLinkPattern = /\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/;
const cardLinkPatternGlobal = /\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

function appendInlineLinks(lineEl, lineContent) {
  let lastIndex = 0;
  cardLinkPatternGlobal.lastIndex = 0;
  let match;
  while ((match = cardLinkPatternGlobal.exec(lineContent)) !== null) {
    if (match.index > lastIndex) {
      appendBreakableText(lineEl, lineContent.slice(lastIndex, match.index));
    }
    const label = match[1];
    const rawUrl = match[2];
    const cleanUrl = rawUrl.replace(/[\s"'\u200c\u200b]+$/, "").replace(/^["']/, "").trim();
    const a = document.createElement("a");
    a.className = "card-inline-link";
    a.setAttribute("href", cleanUrl);
    a.target = "_blank";
    a.rel = "noopener";
    appendBreakableText(a, label);
    lineEl.append(a);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < lineContent.length) {
    appendBreakableText(lineEl, lineContent.slice(lastIndex));
  }
}

export function renderFormattedDescription(container, description) {
  if (!cardLinkPattern.test(description)) {
    const p = document.createElement("p");
    p.className = "workflow-description-text";
    appendBreakableText(p, description);
    container.append(p);
    return;
  }

  const lines = description.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed && i > 0 && !lines[i - 1].trim()) continue;
    if (!/^[-*]\s+/.test(trimmed) && trimmed.includes(":-") && cardLinkPattern.test(trimmed)) {
      // Template-generated "Label:- item - item" dump: split into a
      // subheading plus bulleted items with real links. A "Label:" trailing
      // a link ("[Newsletter](url) Links:") starts its own segment, and
      // "Label:- item" normalizes to a heading plus items.
      const pieces = trimmed.split(/(?<=\) )(?=[A-Z][a-z]+:)/);
      for (const piece of pieces) {
        const normalized = piece.replaceAll(":- ", ": - ");
        for (const segment of normalized.split(" - ")) {
          const text = segment.trim();
          if (!text) continue;
          if (text.endsWith(":")) {
            const heading = document.createElement("div");
            heading.className = "workflow-description-subtitle";
            appendBreakableText(heading, text);
            container.append(heading);
            continue;
          }
          const bullet = document.createElement("div");
          bullet.className = "workflow-description-bullet";
          appendInlineLinks(bullet, text);
          if (bullet.textContent || bullet.children.length > 0) {
            container.append(bullet);
          }
        }
      }
      continue;
    }
    const isBullet = /^[-*]\s+/.test(trimmed);
    const lineContent = isBullet ? trimmed.replace(/^[-*]\s+/, "") : rawLine;
    const lineEl = document.createElement(isBullet ? "div" : "p");
    lineEl.className = isBullet ? "workflow-description-bullet" : "workflow-description-text";
    appendInlineLinks(lineEl, lineContent);
    if (lineEl.textContent || lineEl.children.length > 0) {
      container.append(lineEl);
    }
  }
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
  let nonSpaceCount = 0;
  for (const character of text) {
    chunk += character;
    if (/\s/.test(character)) {
      nonSpaceCount = 0;
    } else {
      nonSpaceCount++;
    }
    if (/[/?#&=._:-]/.test(character) || nonSpaceCount >= 24) {
      element.append(document.createTextNode(chunk));
      element.append(document.createElement("wbr"));
      chunk = "";
      nonSpaceCount = 0;
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
    const descSection = document.createElement("div");
    descSection.className = "workflow-detail-section workflow-description-section";
    const descLabel = document.createElement("div");
    descLabel.className = "task-history-label";
    descLabel.textContent = "Description";
    descSection.append(descLabel);

    const descRow = document.createElement("div");
    descRow.className = "workflow-description";
    renderFormattedDescription(descRow, description);
    descSection.append(descRow);

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
      descSection.append(toggle);
    }
    meta.append(descSection);
  }
  return meta;
}
