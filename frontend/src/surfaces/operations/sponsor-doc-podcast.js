import {
  dualZoneEventTime,
  formatGuestEventTime,
  guestEventTimeZone,
} from "./sponsor-doc-event-time.js";

const HOST_CONTENT_KEYS = [
  "interviewQuestions",
  "coldOpen",
  "introScript",
  "closingScript",
  "hostNotes",
];

const PROFILE_LINK_FIELDS = [
  ["LinkedIn", "linkedinUrl"],
  ["X", "twitterUrl"],
  ["GitHub", "githubUrl"],
  ["Website", "websiteUrl"],
];

const RUN_SHEET_FIELDS = [
  { key: "coldOpen", label: "Cold Open" },
  { key: "introScript", label: "Intro Script" },
  { key: "interviewQuestions", label: "Interview Questions" },
  { key: "topicsToCover", label: "Guest Topics to Cover" },
  { key: "topicsToAvoid", label: "Topics to Avoid", avoid: true },
  { key: "closingScript", label: "Closing Script" },
  { key: "hostNotes", label: "Host Notes & Follow-ups" },
];

const VALID_PHOTO_RE = /^(?:https?:\/\/|\/api\/public-images\/)/i;
const VALID_HTTP_URL_RE = /^https?:\/\//i;
const VALID_LINK_URL_RE = /^(?:https?:\/\/|\/)/i;

/** Check whether a document uses the canonical two-tab podcast workspace. */
export function isPodcastTwoTabDoc(doc) {
  return doc?.template === "podcast";
}

/** Check whether a two-tab podcast document already has a confirmed recording time. */
export function isConfirmedPodcastRecording(doc) {
  return isPodcastTwoTabDoc(doc) && doc?.eventMetadata?.state === "confirmed";
}

/** Render compact one-line summary bar for an already-confirmed recording slot. */
export function renderConfirmedRecordingTimeBar({
  el,
  actionBtn,
  doc,
  guestZone,
  expanded,
  onToggle,
}) {
  const bar = el("div", "podcast-recording-bar");
  bar.dataset.podcastRecordingSummary = "confirmed";

  const info = el("div", "podcast-recording-bar__info");
  info.append(el("span", "dk-badge dk-badge--success", "Confirmed"));

  const meta = doc?.eventMetadata;
  const berlinTime = meta?.startIso
    ? (formatGuestEventTime(meta.startIso, meta.endIso, "Europe/Berlin", meta.durationMinutes, false)
      || meta.label
      || "")
    : (meta?.label || "");
  info.append(el("span", "podcast-recording-bar__time", berlinTime));

  if (meta?.startIso && guestZone && guestZone !== "Europe/Berlin") {
    const localTime = formatGuestEventTime(
      meta.startIso,
      meta.endIso,
      guestZone,
      meta.durationMinutes,
      false,
    );
    if (localTime) {
      info.append(el("span", "podcast-recording-bar__local", `Your time: ${localTime}`));
    }
  }

  const toggleBtn = actionBtn(
    "dk-button dk-button--secondary dk-button--sm",
    expanded ? "Cancel" : "Change",
    "",
    () => onToggle?.(),
  );
  toggleBtn.dataset.podcastAction = expanded ? "cancel-recording-time" : "change-recording-time";
  bar.append(info, toggleBtn);
  return bar;
}

/** Mount confirmed summary bar (and optional open slot picker) in scheduling section. */
export function mountPodcastSchedulingContainer({
  el,
  actionBtn,
  doc,
  guestZone,
  sectionWrap,
  expanded,
  onToggle,
}) {
  if (!isConfirmedPodcastRecording(doc)) {
    return { collapsed: false, target: sectionWrap };
  }
  sectionWrap.append(renderConfirmedRecordingTimeBar({
    el,
    actionBtn,
    doc,
    guestZone,
    expanded,
    onToggle,
  }));
  if (!expanded) {
    return { collapsed: true, target: sectionWrap };
  }
  const slotPicker = el("div", "podcast-slot-picker");
  slotPicker.dataset.podcastSlotPicker = "open";
  sectionWrap.append(slotPicker);
  return { collapsed: false, target: slotPicker };
}

/** Partition template sections into Guest intake vs Internal Team & Host tabs. */
export function splitPodcastSections(sections) {
  const guestSections = [];
  const internalSections = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section) continue;
    if (section.tab === "internal" || Boolean(section.internal)) {
      internalSections.push(section);
    } else {
      guestSections.push(section);
    }
  }
  return { guestSections, internalSections };
}

/** Check whether host run-sheet or interview-question content already exists. */
export function hasPodcastHostContent(draftContent) {
  return HOST_CONTENT_KEYS.some(
    (key) => String(draftContent?.[key] || "").trim().length > 0,
  );
}

/** Render the top-level dakit tab bar switching Guest intake and Internal prep. */
export function renderPodcastTabBar({ el, activeTab, onSelectTab }) {
  const selected = activeTab === "internal" ? "internal" : "guest";
  const bar = el("div", "podcast-doc-tabs-bar");
  bar.dataset.podcastTabBar = "";

  const tablist = el("div", "dk-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Podcast document tabs");

  const guestTab = el("button", "dk-tab", "Guest intake");
  guestTab.type = "button";
  guestTab.id = "podcast-tab-guest";
  guestTab.setAttribute("role", "tab");
  guestTab.setAttribute("aria-controls", "podcast-panel-guest");
  guestTab.setAttribute("aria-selected", selected === "guest" ? "true" : "false");
  guestTab.dataset.podcastTab = "guest";
  guestTab.addEventListener("click", () => onSelectTab?.("guest"));

  const internalTab = el("button", "dk-tab");
  internalTab.type = "button";
  internalTab.id = "podcast-tab-internal";
  internalTab.setAttribute("role", "tab");
  internalTab.setAttribute("aria-controls", "podcast-panel-internal");
  internalTab.setAttribute("aria-selected", selected === "internal" ? "true" : "false");
  internalTab.dataset.podcastTab = "internal";
  internalTab.append("Internal · Team & Host ", el("span", "dk-count", "Staff"));
  internalTab.addEventListener("click", () => onSelectTab?.("internal"));

  tablist.append(guestTab, internalTab);
  bar.append(tablist);
  globalThis.dakitTabs?.sync?.(tablist);
  return bar;
}

/** Render the compact segmented control inside Internal · Team & Host. */
export function renderPodcastInternalSubBar({ el, internalMode, onSelectMode }) {
  const selected = internalMode === "edit" ? "edit" : "host";
  const sublist = el("div", "dk-tabs dk-tabs--sm");
  sublist.setAttribute("role", "tablist");
  sublist.setAttribute("aria-label", "Internal view mode");

  const hostBtn = el("button", "dk-tab", "Host view (Questions)");
  hostBtn.type = "button";
  hostBtn.id = "podcast-internal-tab-host";
  hostBtn.setAttribute("role", "tab");
  hostBtn.setAttribute("aria-selected", selected === "host" ? "true" : "false");
  hostBtn.dataset.podcastInternalMode = "host";
  hostBtn.addEventListener("click", () => onSelectMode?.("host"));

  const editBtn = el("button", "dk-tab", "Edit prep & research");
  editBtn.type = "button";
  editBtn.id = "podcast-internal-tab-edit";
  editBtn.setAttribute("role", "tab");
  editBtn.setAttribute("aria-selected", selected === "edit" ? "true" : "false");
  editBtn.dataset.podcastInternalMode = "edit";
  editBtn.addEventListener("click", () => onSelectMode?.("edit"));

  sublist.append(hostBtn, editBtn);
  globalThis.dakitTabs?.sync?.(sublist);
  return sublist;
}

function buildGuestSnapshot({ el, doc, draftContent, guestZone }) {
  const snapshot = el("section", "podcast-host-snapshot");
  snapshot.dataset.podcastHostSnapshot = "";

  const guestName = String(draftContent?.guestName || doc?.sponsorName || "").trim();
  const photoUrl = String(draftContent?.photoUrl || "").trim();
  if (VALID_PHOTO_RE.test(photoUrl)) {
    const img = el("img", "podcast-host-snapshot__photo");
    img.src = photoUrl;
    img.alt = guestName ? `${guestName} portrait` : "Guest portrait";
    img.addEventListener("error", () => {
      img.hidden = true;
    });
    snapshot.append(img);
  }

  const body = el("div", "podcast-host-snapshot__body");
  if (guestName) {
    body.append(el("h3", "podcast-host-snapshot__name", guestName));
  }

  const zone = guestZone || guestEventTimeZone(
    draftContent?.guestTimezone || doc?.eventMetadata?.guestTimezone,
  );
  const meta = doc?.eventMetadata;
  const recordingTime = meta?.startIso
    ? (dualZoneEventTime(meta.startIso, meta.endIso, zone, meta.durationMinutes)
      || String(meta.label || "").trim())
    : String(meta?.label || "").trim();
  if (recordingTime) {
    body.append(el("p", "podcast-host-snapshot__time", recordingTime));
  }

  const bio = String(draftContent?.introduction || "").trim();
  if (bio) {
    body.append(el("p", "podcast-host-snapshot__bio", bio));
  }

  const links = PROFILE_LINK_FIELDS
    .map(([label, key]) => [label, String(draftContent?.[key] || "").trim()])
    .filter(([, url]) => VALID_HTTP_URL_RE.test(url));
  if (links.length > 0) {
    const linksWrap = el("div", "podcast-host-links");
    for (const [label, url] of links) {
      const anchor = el("a", "dk-button dk-button--secondary dk-button--sm", label);
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      linksWrap.append(anchor);
    }
    body.append(linksWrap);
  }

  if (!guestName && !recordingTime && !bio && links.length === 0) {
    body.append(el("p", "dk-hint", "Guest profile details have not been filled in yet."));
  }

  snapshot.append(body);
  return snapshot;
}

function buildRunSheetSection({ el, actionBtn, draftContent, onEditPrep, onEditQuestions }) {
  const section = el("section", "podcast-host-runsheet");
  const head = el("div", "podcast-host-runsheet__head");
  const meta = el("div", "podcast-host-runsheet__meta");
  meta.append(
    el("h2", "sponsor-doc-section__title", "Run Sheet & Questions"),
    el("p", "dk-hint", "Rough plan · ~1 hour · Intro 5m · Prepared questions 30–40m · Audience Q&A"),
  );
  const editBtn = actionBtn(
    "dk-button dk-button--secondary dk-button--sm",
    "Edit questions",
    "",
    () => (onEditQuestions ? onEditQuestions() : onEditPrep?.()),
  );
  editBtn.dataset.podcastAction = "edit-questions";
  head.append(meta, editBtn);
  section.append(head);

  let hasAny = false;
  for (const field of RUN_SHEET_FIELDS) {
    const text = String(draftContent?.[field.key] || "").trim();
    if (!text) continue;
    hasAny = true;
    const blockClass = field.avoid
      ? "podcast-host-block podcast-host-avoid"
      : "podcast-host-block";
    const block = el("article", blockClass);
    block.dataset.podcastHostBlock = field.key;
    block.append(
      el("h3", "podcast-host-block__title", field.label),
      el("div", "podcast-host-block__text", text),
    );
    section.append(block);
  }

  if (!hasAny) {
    const empty = el("div", "podcast-host-empty");
    empty.append(el("p", "dk-hint", "No interview questions or run sheet added yet."));
    const addBtn = actionBtn(
      "dk-button dk-button--primary dk-button--sm",
      "Add questions & run sheet",
      "",
      () => onEditPrep?.(),
    );
    addBtn.dataset.podcastAction = "edit-prep";
    empty.append(addBtn);
    section.append(empty);
  }

  return section;
}

function buildQnaLinkRow({ el, label, url }) {
  const row = el("div", "");
  row.append(`${label}: `);
  if (VALID_LINK_URL_RE.test(url)) {
    const anchor = el("a", "", url);
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    row.append(anchor);
  } else {
    row.append(url);
  }
  return row;
}

function buildHostQnaSection({ el, actionBtn, doc, qnaState, onLoadQna }) {
  const qnaWrap = el("section", "podcast-host-qna");
  qnaWrap.dataset.podcastHostQna = "";
  const qna = doc?.hostContext?.qna;

  if (!qna?.url) {
    qnaWrap.append(
      el("h2", "sponsor-doc-section__title", "Audience Q&A"),
      el("p", "dk-hint", "No audience Q&A room linked to this card yet."),
    );
    return qnaWrap;
  }

  const heading = qna.questionsSavedAt
    ? "Audience Q&A (closed, questions saved)"
    : "Audience Q&A";
  qnaWrap.append(el("h2", "sponsor-doc-section__title", heading));

  const links = el("div", "podcast-host-qna__links");
  links.append(buildQnaLinkRow({ el, label: "Audience link", url: qna.url }));
  if (qna.presentUrl && !qna.questionsSavedAt) {
    links.append(buildQnaLinkRow({ el, label: "Presenter view", url: qna.presentUrl }));
  }
  qnaWrap.append(links);

  const loading = Boolean(qnaState?.loading);
  const loaded = Boolean(qnaState?.loaded);
  let btnLabel = "Load live Q&A questions";
  if (loading) btnLabel = "Loading Q&A…";
  else if (loaded) btnLabel = "Refresh Q&A";
  else if (qna.questionsSavedAt && Array.isArray(qna.questions)) {
    btnLabel = `Show saved questions (${qna.questions.length})`;
  }

  const loadBtn = actionBtn(
    "dk-button dk-button--secondary dk-button--sm",
    btnLabel,
    "",
    () => onLoadQna?.(),
    loading,
  );
  loadBtn.dataset.podcastAction = "load-qna";
  const actions = el("div", "podcast-host-qna__actions");
  actions.append(loadBtn);
  qnaWrap.append(actions);

  if (qnaState?.error) {
    const errEl = el("p", "dk-hint podcast-host-qna__error", qnaState.error);
    errEl.setAttribute("role", "alert");
    qnaWrap.append(errEl);
    return qnaWrap;
  }

  if (loading) {
    qnaWrap.append(el("p", "dk-hint", "Loading live audience questions…"));
    return qnaWrap;
  }

  const questions = Array.isArray(qnaState?.questions)
    ? qnaState.questions
    : (qna.questionsSavedAt && Array.isArray(qna.questions) ? qna.questions : null);

  if (Array.isArray(questions)) {
    if (questions.length === 0) {
      qnaWrap.append(el("p", "dk-hint", "No audience questions yet."));
    } else {
      const list = el("ol", "podcast-host-qna__list");
      for (const q of questions) {
        const score = q.score > 1 ? ` (+${q.score})` : "";
        const answered = q.status === "answered" ? " ✓ answered" : "";
        const text = `${q.text || ""} — ${q.authorName || "Anonymous"}${score}${answered}`;
        list.append(el("li", "", text));
      }
      qnaWrap.append(list);
    }
  }

  return qnaWrap;
}

/** Render the host recording view inside Internal · Team & Host. */
export function renderPodcastHostView({
  el,
  actionBtn,
  doc,
  draftContent,
  guestZone,
  qnaState,
  onLoadQna,
  onEditPrep,
  onEditQuestions,
}) {
  const container = el("div", "sponsor-doc-card podcast-host-view");
  container.dataset.podcastQuestionsView = "readonly";
  container.append(
    buildGuestSnapshot({ el, doc, draftContent, guestZone }),
    buildRunSheetSection({ el, actionBtn, draftContent, onEditPrep, onEditQuestions }),
    buildHostQnaSection({ el, actionBtn, doc, qnaState, onLoadQna }),
  );
  return container;
}

/** Render collapsed read-only Markdown export inside the staff Internal tab. */
export function renderPodcastExportDetails({ el, markdownExport, onCopy }) {
  const details = el("details", "sponsor-doc-card podcast-export-details");
  details.dataset.sponsorExport = "";

  const summary = el("summary", "sponsor-doc-details__summary");
  summary.append(
    el("span", "sponsor-doc-field__label", "Read-only Markdown export"),
    el("span", "sponsor-doc-details__hint", "Expand to view or copy"),
  );

  const body = el("div", "podcast-export-details__body");
  const topRow = el("div", "sponsor-doc-title-row");
  const copyBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy Markdown");
  copyBtn.type = "button";
  copyBtn.dataset.sponsorAction = "copy-export";
  copyBtn.addEventListener("click", () => onCopy?.());
  topRow.append(el("span", "dk-hint", "Full staff + guest Markdown export"), copyBtn);

  body.append(topRow, el("pre", "sponsor-doc-export-pre", markdownExport));
  details.append(summary, body);
  return details;
}

/** Parse initial ?tab= / ?view= state when loading a podcast document. */
export function parseInitialPodcastRoute(url) {
  const initialTab = url.searchParams.get("tab");
  const initialView = url.searchParams.get("view");
  if (initialView === "questions") {
    return { activeTab: "internal", internalMode: "host", touched: true, initialTab, initialView };
  }
  if (initialTab === "internal") {
    return { activeTab: "internal", internalMode: "host", touched: false, initialTab, initialView };
  }
  return { activeTab: "guest", internalMode: "host", touched: false, initialTab, initialView };
}

/** Build the URL after stripping ?code= while preserving valid staff tab/view params. */
export function buildStrippedCodePath(docPathPrefix, docId, initialTab, initialView) {
  const keep = new URLSearchParams();
  if (initialTab === "internal") keep.set("tab", "internal");
  if (initialView === "questions") keep.set("view", "questions");
  const qs = keep.toString();
  return `${docPathPrefix}/${encodeURIComponent(docId)}${qs ? `?${qs}` : ""}`;
}

/** Remove any ?tab= / ?view= query params from URL when viewer is a guest. */
export function stripGuestPodcastQueryParams({ locationRef, historyRef, docPathPrefix, docId }) {
  try {
    const curUrl = new URL(locationRef.href);
    if (!curUrl.searchParams.has("tab") && !curUrl.searchParams.has("view")) return;
    curUrl.searchParams.delete("code");
    curUrl.searchParams.delete("tab");
    curUrl.searchParams.delete("view");
    const qs = curUrl.searchParams.toString();
    historyRef?.replaceState?.(
      null,
      "",
      `${docPathPrefix}/${encodeURIComponent(docId)}${qs ? `?${qs}` : ""}`,
    );
  } catch {
    // Ignore malformed locationRef in test doubles
  }
}

/** Sync staff tab and internal mode to URL query params without reloading. */
export function syncPodcastHistoryUrl({ historyRef, docPathPrefix, docId, activeTab, internalMode }) {
  if (!historyRef?.replaceState) return;
  const basePath = `${docPathPrefix}/${encodeURIComponent(docId)}`;
  if (activeTab !== "internal") {
    historyRef.replaceState(null, "", basePath);
    return;
  }
  const params = new URLSearchParams();
  params.set("tab", "internal");
  if (internalMode === "host") params.set("view", "questions");
  historyRef.replaceState(null, "", `${basePath}?${params.toString()}`);
}

/** Fetch live or saved audience Q&A questions for the owning podcast Card. */
export async function fetchPodcastQnaState({ request, doc, currentState }) {
  const cardId = doc?.hostContext?.cardId || doc?.cardId;
  if (!cardId) {
    return { loading: false, loaded: false, questions: null, error: "No card linked to this document." };
  }
  try {
    const payload = await request(`/api/cards/${encodeURIComponent(cardId)}/qna/questions`, { method: "GET" });
    return {
      loading: false,
      loaded: true,
      questions: Array.isArray(payload?.questions) ? payload.questions : [],
      error: "",
    };
  } catch (err) {
    return {
      loading: false,
      loaded: false,
      questions: currentState?.questions ?? null,
      error: `Could not load Q&A questions: ${err?.message || "request failed"}`,
    };
  }
}

/** Render the complete two-tab podcast workspace (guest or staff) into root. */
export function renderPodcastTwoTabWorkspace({
  el,
  actionBtn,
  root,
  doc,
  tDef,
  draftContent,
  guestZone,
  qnaState,
  isStaff,
  activeTab,
  internalMode,
  sections,
  buildFormElement,
  buildIntroCallout,
  onSelectTab,
  onSelectMode,
  onLoadQna,
  onEditPrep,
  onEditQuestions,
  onCopyExport,
}) {
  const { guestSections, internalSections } = splitPodcastSections(sections);
  if (isStaff) {
    root.append(renderPodcastTabBar({ el, activeTab, onSelectTab }));
  }

  if (!isStaff || activeTab !== "internal") {
    const guestPanel = el("div", "sponsor-doc-card sponsor-doc-form-card");
    guestPanel.dataset.podcastPanel = "guest";
    if (isStaff) {
      guestPanel.id = "podcast-panel-guest";
      guestPanel.setAttribute("role", "tabpanel");
      guestPanel.setAttribute("aria-labelledby", "podcast-tab-guest");
      const notice = el(
        "div",
        "podcast-doc-tab-notice",
        "Shared with guest · Guests see and edit only this tab.",
      );
      notice.dataset.podcastTabNotice = "guest";
      guestPanel.append(notice);
    }
    const introCallout = buildIntroCallout(tDef);
    if (introCallout) guestPanel.append(introCallout);
    guestPanel.append(buildFormElement({ sectionsToRender: guestSections }));
    root.append(guestPanel);
    return;
  }

  const internalPanel = el("div", "sponsor-doc-card");
  internalPanel.id = "podcast-panel-internal";
  internalPanel.setAttribute("role", "tabpanel");
  internalPanel.setAttribute("aria-labelledby", "podcast-tab-internal");
  internalPanel.dataset.podcastPanel = "internal";

  const internalHead = el("div", "podcast-internal-head");
  const privacyBanner = el(
    "div",
    "podcast-doc-tab-notice podcast-doc-tab-notice--internal",
    "Staff only · Guests with the access-code link never see or receive this tab.",
  );
  privacyBanner.dataset.podcastTabNotice = "internal";
  const subBar = renderPodcastInternalSubBar({ el, internalMode, onSelectMode });
  internalHead.append(privacyBanner, subBar);
  internalPanel.append(internalHead);

  if (internalMode === "host") {
    internalPanel.append(renderPodcastHostView({
      el,
      actionBtn,
      doc,
      draftContent,
      guestZone,
      qnaState,
      onLoadQna,
      onEditPrep,
      onEditQuestions,
    }));
  } else {
    internalPanel.append(buildFormElement({
      sectionsToRender: internalSections,
      forceExpanded: true,
      internalEdit: true,
    }));
  }
  root.append(internalPanel);

  if (doc.markdownExport) {
    root.append(renderPodcastExportDetails({
      el,
      markdownExport: doc.markdownExport,
      onCopy: onCopyExport,
    }));
  }
}
