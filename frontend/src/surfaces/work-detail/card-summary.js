import { escapeHtml } from "../../core/html.js";
import { renderIcon } from "../../core/icons.js";
import { opensInNewTab } from "../../core/links.js";
import { taskTitleParts } from "../../core/task-display.js";
import { attachSlotControls, issueSlotsMarkup, issueStatsSummaryMarkup } from "../planning-newsletter-slots.js";

// The compact summary head of the Card detail modal: stage control, date and
// flag chips on one row, the progress bar, the next-up line, and the clamped
// Card description.
export const cardDescriptionClampLimit = 450;

// Template display names ride with the runtime template listing, not the
// Card payload. One cached fetch per Template keeps the detail panel honest
// without refetching on every open.
const templateLinkCache = new Map();

export function renderCardTemplateLink(
  { navigateCanonicalWorkspace, request, workApiUrl },
  templateId,
) {
  const row = document.createElement("div");
  row.className = "card-template-link-row";
  const link = document.createElement("button");
  link.type = "button";
  link.className = "card-template-link";
  const fill = (cached) => {
    link.replaceChildren(
      renderIcon(cached?.icon || "card", { size: 16 }),
      document.createTextNode(cached ? `Template: ${cached.name} · View template` : "Template · View template"),
    );
  };
  fill(templateLinkCache.get(templateId));
  link.title = "View template in Templates";
  link.addEventListener("click", () =>
    navigateCanonicalWorkspace("/templates", { templateId }),
  );
  row.append(link);
  if (!templateLinkCache.has(templateId)) {
    request(workApiUrl(`/api/templates/${encodeURIComponent(templateId)}`)).then(
      (payload) => {
        const template = payload?.template || payload || {};
        templateLinkCache.set(templateId, {
          name: String(template.name || template.title || "Template"),
          icon: String(template.icon || ""),
        });
        if (link.isConnected) fill(templateLinkCache.get(templateId));
      },
      () => {},
    );
  }
  return row;
}

// A newsletter Card executes exactly one issue; the issue owns the link
// (issue.cardId), its date and its sponsor slots. The section appears only
// when an issue owns this Card. Ticking a slot here adds its sponsor Tasks to
// this Card (unticking skips the open ones), the same as in the planner.
// Re-renders within a short window reuse the last answer instead of
// refetching on every stage or task mutation.
const newsletterIssueCache = new Map();
const newsletterIssueFreshMs = 30_000;

function formatIssueDate(iso) {
  const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? String(iso || "")
    : new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed);
}

export function renderCardNewsletterIssue(
  { request, workApiUrl, reload },
  card,
) {
  const section = document.createElement("div");
  section.className = "workflow-detail-section card-newsletter-slot";
  section.dataset.cardNewsletterIssue = "";

  let shownIssues = [];
  const slotError = document.createElement("p");
  slotError.className = "card-newsletter-slot__error";
  slotError.setAttribute("role", "alert");
  attachSlotControls(section, {
    findIssue: (id) => shownIssues.find((issue) => issue.id === id),
    request,
    workApiUrl,
    onChanged: async () => {
      newsletterIssueCache.delete(card.id);
      await reload?.();
    },
    onError: (message) => {
      slotError.textContent = message;
      section.append(slotError);
    },
  });

  const fill = (issues) => {
    shownIssues = issues;
    section.replaceChildren();
    section.hidden = issues.length === 0;
    if (!issues.length) return;
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.textContent = "Newsletter issue";
    section.append(label);
    for (const issue of issues) {
      const row = document.createElement("p");
      row.className = "card-newsletter-slot__row";
      const link = document.createElement("a");
      link.href = `/newsletter?issueId=${encodeURIComponent(issue.id)}`;
      link.textContent = `${issue.label || "Newsletter issue"} · ${formatIssueDate(issue.publicationDate)}`;
      opensInNewTab(link);
      const status = document.createElement("span");
      status.className = "card-newsletter-slot__status";
      status.textContent = String(issue.status || "").replaceAll("-", " ");
      row.append(link, status);
      const anchor = String(card.anchorDate || "").slice(0, 10);
      if (anchor && issue.publicationDate && anchor !== issue.publicationDate) {
        const warning = document.createElement("span");
        warning.className = "dk-badge dk-badge--warning";
        warning.dataset.cardDateMismatch = "";
        warning.textContent = "Card date differs from the issue; the issue's date wins";
        row.append(warning);
      }
      section.append(row);
      const slots = document.createElement("div");
      slots.innerHTML = `${issueSlotsMarkup(issue, escapeHtml)}${issueStatsSummaryMarkup(issue, escapeHtml)}`;
      section.append(...slots.children);
    }
  };
  const cached = newsletterIssueCache.get(card.id);
  fill(cached?.issues || []);
  if (cached && Date.now() - cached.at < newsletterIssueFreshMs) return section;
  request(workApiUrl(`/api/newsletter-issues?cardId=${encodeURIComponent(card.id)}`)).then(
    (payload) => {
      const issues = Array.isArray(payload?.items) ? payload.items : [];
      newsletterIssueCache.set(card.id, { issues, at: Date.now() });
      fill(issues);
    },
    // A failed load is not "no issue": say so instead of hiding the section.
    (error) => {
      section.hidden = false;
      slotError.textContent = `Could not load the newsletter issue: ${error?.message || "request failed"}`;
      section.append(slotError);
    },
  );
  return section;
}

// Public page and fallback name for each event or sponsorship document type.
const DOC_KINDS = {
  workshop: { path: "workshop-docs", label: "Workshop materials" },
  webinar: { path: "webinar-docs", label: "Speaker materials" },
  podcast: { path: "podcast-docs", label: "Guest materials" },
};

function docKind(doc) {
  return DOC_KINDS[String(doc.template || "")] || { path: "sponsor-docs", label: "Sponsor document" };
}

export function renderCardSponsorDocsSection(card) {
  const docs = Array.isArray(card?.sponsorDocs) ? card.sponsorDocs : [];
  if (!docs.length) return null;
  const section = document.createElement("div");
  section.className = "task-history workflow-detail-section card-sponsor-docs-section";
  section.dataset.cardSponsorDocs = "";

  const allGuestMaterials = docs.every((doc) => String(doc.template || "") === "podcast");
  const heading = document.createElement("div");
  heading.className = "task-history-label";
  if (docs.every((doc) => doc.template === "workshop")) {
    heading.textContent = "Workshop materials";
  } else if (docs.every((doc) => doc.template === "webinar")) {
    heading.textContent = "Speaker materials";
  } else if (allGuestMaterials) {
    heading.textContent = "Guest materials";
  } else {
    heading.textContent = docs.length === 1 ? "Sponsorship document" : "Sponsorship documents";
  }
  section.append(heading);

  const list = document.createElement("div");
  list.className = "task-history-list";
  for (const doc of docs) {
    const item = document.createElement("div");
    item.className = "task-history-event card-sponsor-doc-row";
    item.dataset.sponsorDocId = doc.id;

    const topRow = document.createElement("div");
    topRow.className = "card-newsletter-slot__row";

    const openLink = document.createElement("a");
    openLink.href = `/${docKind(doc).path}/${encodeURIComponent(doc.id)}`;
    openLink.textContent = doc.title || doc.sponsorName || docKind(doc).label;
    opensInNewTab(openLink);

    const statusBadge = document.createElement("span");
    const isSubmitted = doc.status === "submitted";
    statusBadge.className = isSubmitted ? "dk-badge dk-badge--success" : "dk-badge";
    statusBadge.dataset.sponsorDocStatus = doc.status;
    statusBadge.textContent = isSubmitted ? "Submitted / Ready" : "Draft";

    const exportLink = document.createElement("a");
    exportLink.href = `/api/sponsor-docs/${encodeURIComponent(doc.id)}/export?format=markdown`;
    exportLink.className = "task-instruction-doc-link";
    exportLink.textContent = "Markdown export";
    opensInNewTab(exportLink);

    topRow.append(openLink, statusBadge, exportLink);

    const metaLine = document.createElement("small");
    metaLine.className = "card-checklist-note";
    metaLine.dataset.sponsorDocEdited = "";
    const editedTime = doc.lastEditedAt
      ? String(doc.lastEditedAt).slice(0, 16).replace("T", " ")
      : "";
    const editedBy = doc.lastEditedBy || "staff";
    metaLine.textContent = editedTime
      ? `${doc.template} · Last edited ${editedTime} by ${editedBy}`
      : `${doc.template} · Not edited yet`;

    item.append(topRow, metaLine);
    list.append(item);
  }
  section.append(list);
  return section;
}

// Migration provenance and legacy Overview docs / Links TODO boilerplate are
// import bookkeeping, not operator content — keep them out of the rendered
// Card detail since links and process references are structured fields.
export function displayCardDescription(value) {
  return String(value ?? "")
    .replace(/\s*Migration provenance:[\s\S]*$/, "")
    .replace(/(?:^|\n)\s*Overview docs:\s*[\s\S]*$/i, "")
    .replace(/(?:^|\n)\s*Links:\s*(?:-|\n\s*-)[\s\S]*$/i, "")
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
    appendBreakableText(a, label);
    opensInNewTab(a);
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
    deleteCardPanel,
    detail,
    formatCardAnchorLabel,
    getCurrentOperator,
    isArchivedWorkCard,
    isParkedWorkCard,
    labelizeWorkValue,
    parkCardPanel,
    progress,
    resumeCardPanel,
    state,
    today,
    updateCardStage,
    workCardIssueNumber,
    workCardSubtitle,
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
  } else {
    // An event Card created as a course slot has no date until `cards time` sets it.
    const anchor = document.createElement("span");
    anchor.className = "workflow-card-anchor is-upcoming";
    anchor.dataset.anchorDate = "";
    anchor.setAttribute("aria-label", "Card date to be decided");
    anchor.textContent = "Date TBD";
    summaryTop.append(anchor);
  }
  const issueNumber = typeof workCardIssueNumber === "function"
    ? workCardIssueNumber(card)
    : (card.issueNumber ? String(card.issueNumber).replace(/^/, "") : "");
  if (issueNumber) {
    const issue = document.createElement("span");
    issue.className = "workflow-card-issue";
    issue.textContent = `#${issueNumber}`;
    issue.title = `Issue #${issueNumber}`;
    summaryTop.append(issue);
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
  const sponsorDocs = Array.isArray(card.sponsorDocs) ? card.sponsorDocs : [];
  for (const sdoc of sponsorDocs) {
    const chip = document.createElement("small");
    const isSubmitted = sdoc.status === "submitted";
    chip.className = `workflow-card-flag is-${isSubmitted ? "success" : "info"}`;
    chip.dataset.cardSponsorDocStatus = sdoc.status;
    const kindLabel = DOC_KINDS[String(sdoc.template || "")]?.label || "Sponsor doc";
    chip.textContent = isSubmitted ? `${kindLabel}: Submitted / Ready` : `${kindLabel}: Draft`;
    flagRow.append(chip);
  }
  summaryTop.append(countRow);
  if (flagRow.children.length > 0) summaryTop.append(flagRow);
  summaryTop.append(stageLabel);
  // Parking moves an active Card to the parked Archive category keeping its
  // stage and Tasks; resume returns it to the board. Done Cards stay put.
  const mutationBusy =
    detail.activeCardMutationBusy ||
    detail.activeTaskMutationBusy ||
    detail.activeCardTemplateBusy;
  if (isParkedWorkCard?.(card)) {
    const parkedChip = document.createElement("span");
    parkedChip.className = "workflow-card-flag is-info";
    parkedChip.textContent = "Parked";
    summaryTop.append(parkedChip);
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "quiet-button";
    resume.textContent = detail.activeCardPanelDraft?.kind === "resume" ? "Resuming…" : "Resume";
    resume.disabled = mutationBusy;
    resume.addEventListener("click", () => resumeCardPanel?.(card.id));
    summaryTop.append(resume);
  } else if (!isArchivedWorkCard(card)) {
    const park = document.createElement("button");
    park.type = "button";
    park.className = "quiet-button";
    park.textContent = detail.activeCardPanelDraft?.kind === "park" ? "Parking…" : "Park";
    park.title = "Move to the parked Archive category";
    park.disabled = mutationBusy;
    park.addEventListener("click", () => parkCardPanel?.(card.id));
    summaryTop.append(park);
  }
  const overflow = deleteCardPanel && getCurrentOperator
    ? renderCardOverflowMenu(card, mutationBusy, deleteCardPanel, getCurrentOperator)
    : null;
  if (overflow) summaryTop.append(overflow);
  meta.append(summaryTop);

  const subtitle = typeof workCardSubtitle === "function" ? workCardSubtitle(card) : "";
  const people = Array.isArray(card.people)
    ? card.people.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  if (subtitle) {
    const byline = document.createElement("p");
    byline.className = "workflow-next-task";
    const bylineLabel = document.createElement("span");
    bylineLabel.textContent = people.length > 0 ? "People" : "Sponsor";
    const bylineValue = document.createElement("strong");
    appendBreakableText(bylineValue, subtitle);
    bylineValue.title = subtitle;
    byline.append(bylineLabel, bylineValue);
    meta.append(byline);
  }

  if (progress.nextDueTask) {
    const nextRow = document.createElement("p");
    nextRow.className = "workflow-next-task";
    const nextLabel = document.createElement("span");
    nextLabel.textContent = "Next up";
    const nextValue = document.createElement("strong");
    const nextDate = String(progress.nextDueTask.date || "").slice(0, 10);
    const nextTitle = taskTitleParts(
      workTaskTitle(progress.nextDueTask),
      progress.nextDueTask?.tags,
    ).title;
    const nextText = nextDate
      ? `${nextTitle} · ${formatCardAnchorLabel(nextDate, today)}`
      : nextTitle;
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

// The Card's overflow menu: actions an admin rarely needs and must not hit by
// accident. Delete opens a confirm that names what goes with the Card.
// A deep link can render the Card before the signed-in identity arrives, so
// the menu stays hidden until the identity is known and shows only for an
// admin; the server enforces the same rule.
function renderCardOverflowMenu(card, busy, deleteCardPanel, getCurrentOperator) {
  const known = getCurrentOperator();
  if (known && known.role !== "admin") return null;
  const wrap = document.createElement("div");
  wrap.className = "card-overflow";
  if (!known) {
    wrap.hidden = true;
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      const operator = getCurrentOperator();
      if (operator?.role === "admin") wrap.hidden = false;
      else if (operator) wrap.remove();
      if (operator || !wrap.isConnected || checks > 120) clearInterval(timer);
    }, 250);
  }
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "quiet-button card-overflow-trigger";
  trigger.textContent = "⋯";
  trigger.setAttribute("aria-label", "More card actions");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.disabled = busy;
  const menu = document.createElement("div");
  menu.className = "dk-menu card-overflow-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "dk-menu__item dk-menu__item--danger";
  remove.setAttribute("role", "menuitem");
  remove.textContent = "Delete card…";
  menu.append(remove);

  const onOutside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
  }
  trigger.addEventListener("click", () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    remove.focus();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
    trigger.focus();
  });
  remove.addEventListener("click", () => {
    close();
    deleteCardPanel(card.id, trigger);
  });
  wrap.append(trigger, menu);
  return wrap;
}

// Delivery receipts are evidence: a queued job or a sent status without its
// provider receipt must never be presented as an invitation delivered.
export function renderCardGuestInvitation({ request, workApiUrl, reload, watch = true, schedule = setTimeout, cancel = clearTimeout }, card) {
  const intake = card?.guestIntake;
  if (!intake) return null;
  const section = document.createElement("section");
  section.className = "workflow-detail-section";
  section.dataset.guestInvitation = "";
  const heading = document.createElement("strong");
  const sent = intake.status === "sent" && Boolean(intake.messageId);
  heading.textContent = sent ? "Invitation sent"
    : intake.status === "skipped" ? "Invitation not sent"
    : intake.status === "paused" ? "Invitation paused"
    : intake.status === "cancelled" ? "Invitation cancelled"
    : intake.status === "contact-pending" ? "Guest contact details needed"
    : intake.status === "failed" ? "Invitation could not be sent" : "Invitation preparing";
  section.append(heading);
  if (intake.recipient) {
    const recipient = document.createElement("p");
    recipient.textContent = `Guest: ${intake.recipient}`;
    section.append(recipient);
  }
  if (intake.startIso) {
    const time = document.createElement("p");
    const parsed = new Date(intake.startIso);
    time.textContent = `Proposed time: ${Number.isNaN(parsed.getTime()) ? intake.startIso : new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full", timeStyle: "short", timeZone: "Europe/Berlin",
    }).format(parsed)} (Berlin)`;
    section.append(time);
  }
  if (sent && intake.sentAt) {
    const delivered = document.createElement("p");
    const timestamp = new Date(intake.sentAt);
    delivered.dataset.invitationSentAt = "";
    delivered.textContent = `Sent at: ${Number.isNaN(timestamp.getTime()) ? intake.sentAt : new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin",
    }).format(timestamp)} (Berlin)`;
    section.append(delivered);
  }
  if (sent) {
    const mail = document.createElement("a");
    mail.href = `https://mail.google.com/mail/u/orin@datatalks.club/#all/${encodeURIComponent(intake.messageId)}`;
    mail.textContent = "View sent invitation";
    opensInNewTab(mail);
    section.append(mail);
  }
  if (intake.status === "failed" || intake.status === "contact-pending") {
    if (intake.error) {
      const message = document.createElement("p");
      message.textContent = typeof intake.error === "string" ? intake.error : intake.error.message || "Check the linked task for details.";
      section.append(message);
    }
    if (intake.taskId) {
      const task = document.createElement("a");
      task.href = `/tasks?taskId=${encodeURIComponent(intake.taskId)}`;
      task.textContent = "Open invitation task";
      section.append(task);
    }
  }
  if (intake.status === "skipped") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-action-btn";
    button.textContent = "Send invitation";
    const feedback = document.createElement("p");
    feedback.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      feedback.textContent = "Preparing invitation…";
      try {
        await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}/guest-intake/send`), { method: "POST", body: "{}" });
        button.remove();
        heading.textContent = "Invitation preparing";
        feedback.textContent = "";
        await reload?.();
      } catch (error) {
        feedback.textContent = `Could not prepare invitation: ${error.message || "request failed"}`;
        button.disabled = false;
      }
    });
    section.append(button, feedback);
  }
  const needsRefresh = value => ["queued", "preparing"].includes(value?.guestIntake?.status)
    || (value?.guestIntake?.status === "paused" && value.status === "active");
  if (watch && needsRefresh(card)) {
    let timer;
    let attempts = 0;
    let stopped = false;
    let observer;
    const stop = () => { stopped = true; if (timer) cancel(timer); observer?.disconnect(); };
    const poll = async () => {
      if (stopped || !section.isConnected || ++attempts > 40) { stop(); return; }
      try {
        const payload = await request(workApiUrl(`/api/cards/${encodeURIComponent(card.id)}`));
        if (stopped || !section.isConnected) { stop(); return; }
        const next = payload?.card || payload;
        if (next?.guestIntake) {
          const receipt = renderCardGuestInvitation({ request, workApiUrl, reload, watch: false }, next);
          section.replaceChildren(...receipt.childNodes);
          if (!needsRefresh(next)) { stop(); return; }
        }
      } catch { /* Retain the last actual receipt and try within the bounded window. */ }
      if (!stopped) { timer = schedule(poll, 3000); timer?.unref?.(); }
    };
    timer = schedule(poll, 3000);
    timer?.unref?.();
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => { if (!section.isConnected) stop(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  return section;
}
