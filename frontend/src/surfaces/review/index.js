import { SPLIT_BACK_ICON } from "../split-back-icon.js";
import { createPageHeader } from "../operations-overview.js";
import {
  buildReviewQueue,
  decisionLabel,
  REVIEW_CHECKLIST_FIELDS,
} from "./model.js";

const CHECKLIST_LABELS = Object.freeze({
  purpose: "Purpose and outcome are clear",
  procedure: "Procedure is executable",
  validation: "Validation proves the outcome",
  troubleshooting: "Troubleshooting covers likely failures",
  references: "References identify the source of truth",
  ownership: "Ownership and tool metadata are correct",
});

const CHECKLIST_OPTIONS = Object.freeze([
  ["unreviewed", "Not reviewed"],
  ["pass", "Pass"],
  ["needs_work", "Needs work"],
  ["na", "Not applicable"],
]);

const FILTER_OPTIONS = Object.freeze([
  ["needs-review", "Needs review"],
  ["all", "All documents"],
  ["changes", "Changes requested"],
  ["reviewed", "Reviewed"],
]);

const DECISION_BUTTONS = Object.freeze([
  ["approved", "Approve review evidence", "primary-button"],
  ["changes_requested", "Request changes", "quiet-button"],
  ["blocked", "Block", "quiet-button"],
  ["deferred", "Defer", "quiet-button"],
]);

function text(value, fallback = "") {
  const result = String(value || "").trim();
  return result || fallback;
}

function createElement(documentRef, tag, className = "") {
  const element = documentRef.createElement(tag);
  if (className) element.className = className;
  return element;
}

function appendText(documentRef, parent, tag, className, value) {
  const element = createElement(documentRef, tag, className);
  element.textContent = value;
  parent.append(element);
  return element;
}

function formatDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatDocumentUpdatedAt(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown";
  return formatDate(timestamp * 1000);
}

function labelize(value) {
  return text(value, "Not set")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function elidePath(path) {
  const value = String(path || "");
  const segments = value.split("/").filter(Boolean);
  if (segments.length <= 2) return value;
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}

function makeStatusBadge(documentRef, value, className = "") {
  const badge = createElement(documentRef, "span", `review-badge ${className}`.trim());
  badge.textContent = labelize(value);
  return badge;
}

function makeMetaItem(documentRef, label, value) {
  const item = createElement(documentRef, "div", "review-meta-item");
  appendText(documentRef, item, "dt", "review-meta-label", label);
  appendText(documentRef, item, "dd", "review-meta-value", value);
  return item;
}

function createEmptyState(documentRef, title, body) {
  const state = createElement(documentRef, "div", "review-empty-state");
  appendText(documentRef, state, "strong", "", title);
  appendText(documentRef, state, "span", "", body);
  return state;
}

function createSplitEmpty(documentRef, title, body) {
  const holder = createElement(documentRef, "div", "dk-split__empty");
  const state = createElement(documentRef, "div", "dk-empty");
  appendText(documentRef, state, "p", "dk-empty__title", title);
  appendText(documentRef, state, "p", "dk-empty__desc", body);
  holder.append(state);
  return holder;
}

function createReviewSnapshot() {
  return { loaded: false, reviews: [], errors: [], updatedAt: null };
}

export function createReviewSurface(context) {
  const {
    apiUrl,
    documentList,
    documentRef = globalThis.document,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    getDocsAvailability,
    navigateCanonicalWorkspace,
    openDocument,
    refreshDocuments,
    renderHonestState,
    request,
    reviewState,
    setRouteTitle,
  } = context;

  let filter = "needs-review";
  let query = "";
  let selectedId = "";
  let previewRequestId = 0;
  let historyRequestId = 0;
  let lastDocuments = [];
  let notice = "";

  function snapshot() {
    return reviewState.reviewSnapshot || createReviewSnapshot();
  }

  async function refreshReviewSnapshot(options = {}) {
    const next = createReviewSnapshot();
    try {
      const payload = await request(apiUrl("/api/document-reviews"));
      next.loaded = true;
      next.reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
      next.updatedAt = new Date().toISOString();
    } catch (error) {
      next.errors = [error?.message || "Document review API request failed"];
    }
    reviewState.reviewSnapshot = next;
    if (
      options.rerender &&
      getActiveWorkspaceView() === "review" &&
      typeof refreshDocuments === "function"
    ) {
      refreshDocuments();
    }
    return next;
  }

  function activeRouteDocumentId() {
    return getActiveWorkspaceRoute()?.params?.get("documentId") || "";
  }

  function selectDocument(item) {
    selectedId = item.id;
    navigateCanonicalWorkspace("/review", { documentId: item.id });
  }

  function filteredItems(queue) {
    const normalizedQuery = query.trim().toLowerCase();
    return queue.filter((item) => {
      if (filter === "needs-review" && !item.needsReview) return false;
      if (filter === "changes" && item.state !== "Changes requested") return false;
      if (filter === "reviewed" && item.state !== "Reviewed") return false;
      if (!normalizedQuery) return true;
      const document = item.document;
      return [
        document.title,
        document.id,
        document.path,
        document.department,
        document.business_system,
        document.owner_role,
        document.summary,
      ].some((value) => text(value).toLowerCase().includes(normalizedQuery));
    });
  }

  // Refresh acts on the review queue, so it sits in the queue's toolbar (or
  // in the unavailable state it recovers from), not in the page header.
  function refreshButton(label) {
    const refresh = createElement(documentRef, "button", "quiet-button review-refresh");
    refresh.type = "button";
    refresh.textContent = label;
    refresh.setAttribute("aria-label", "Refresh review data");
    refresh.addEventListener("click", () => refreshReviewSnapshot({ rerender: true }));
    return refresh;
  }

  function renderHeader(root) {
    const header = createPageHeader({
      title: "Document review",
      subtitle: "Turn the audit backlog into review evidence, feedback, and a clear next action.",
      className: "review-header",
      documentRef,
    });
    // No status tiles: the queue below is ordered needs-review first and its
    // heading carries the one count (dakit principle 4, no vanity metrics).
    root.append(header);
  }

  function renderFilterBar(root) {
    const controls = createElement(documentRef, "section", "review-controls");
    const filterLabel = createElement(documentRef, "label", "review-filter-control");
    appendText(documentRef, filterLabel, "span", "review-control-label", "Show");
    const filterSelect = createElement(documentRef, "select");
    filterSelect.name = "review-filter";
    for (const [value, label] of FILTER_OPTIONS) {
      const option = createElement(documentRef, "option");
      option.value = value;
      option.textContent = label;
      option.selected = value === filter;
      filterSelect.append(option);
    }
    filterSelect.value = filter;
    filterSelect.addEventListener("change", () => {
      filter = filterSelect.value;
      renderReviewSurface(lastDocuments);
    });
    filterLabel.append(filterSelect);

    const searchLabel = createElement(documentRef, "label", "review-search-control");
    searchLabel.setAttribute("aria-label", "Search review queue");
    const search = createElement(documentRef, "input");
    search.type = "search";
    search.placeholder = "Search title, owner, system, or path";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value;
      renderReviewSurface(lastDocuments);
      const nextSearch = documentList.querySelector(".review-search-control input");
      nextSearch?.focus();
      if (nextSearch) nextSearch.selectionStart = nextSearch.selectionEnd = query.length;
    });
    searchLabel.append(search);

    controls.append(filterLabel, searchLabel, refreshButton("Refresh"));
    root.append(controls);
  }

  function renderQueuePanel(items, selectedItem) {
    const panel = createElement(documentRef, "section", "dk-split__list");
    panel.setAttribute("aria-labelledby", "review-queue-title");
    const heading = createElement(documentRef, "header", "dk-split__head");
    appendText(documentRef, heading, "h2", "dk-split__title", "Review queue").id = "review-queue-title";
    appendText(
      documentRef,
      heading,
      "span",
      "dk-split__count",
      `${items.length} ${items.length === 1 ? "document" : "documents"}`,
    );
    panel.append(heading);
    const list = createElement(documentRef, "div", "dk-split__scroll");
    if (items.length === 0) {
      list.append(
        createEmptyState(
          documentRef,
          filter === "needs-review" ? "Queue is clear" : "No matching documents",
          filter === "needs-review"
            ? "Every eligible document has current review evidence."
            : "Try a different status or search term.",
        ),
      );
    }
    for (const item of items) {
      const button = createElement(documentRef, "button", "dk-split__item");
      button.type = "button";
      button.dataset.documentId = item.id;
      if (item.id === selectedItem?.id) button.setAttribute("aria-current", "true");
      const title = createElement(documentRef, "span", "dk-split__name");
      title.textContent = text(item.document.title, item.id);
      const meta = createElement(documentRef, "span", "review-queue-meta");
      meta.textContent = `${labelize(item.document.criticality)} · ${labelize(item.document.status)}`;
      const reason = createElement(documentRef, "span", "review-queue-reason");
      reason.textContent = item.reason;
      const path = createElement(documentRef, "small", "review-queue-path");
      path.textContent = elidePath(item.document.path);
      path.title = item.document.path;
      button.append(title, meta, reason, path);
      button.addEventListener("click", () => selectDocument(item));
      list.append(button);
    }
    panel.append(list);
    return panel;
  }

  function renderDocumentHeader(parent, item) {
    const document = item.document;
    const header = createElement(documentRef, "header", "dk-split__head");
    const back = createElement(documentRef, "button", "dk-split__back");
    back.type = "button";
    back.setAttribute("aria-label", "Back to Review queue");
    back.innerHTML = `${SPLIT_BACK_ICON}Review queue`;
    back.addEventListener("click", () => {
      navigateCanonicalWorkspace("/review", {}, { restoreFocus: { kind: "split-list" } });
    });
    const title = appendText(documentRef, header, "h2", "dk-split__title", text(document.title, item.id));
    title.tabIndex = -1;
    header.prepend(back);
    const badges = createElement(documentRef, "div", "review-document-badges");
    badges.append(
      makeStatusBadge(documentRef, document.status, "review-badge-lifecycle"),
      makeStatusBadge(documentRef, item.state, item.needsReview ? "review-badge-attention" : "review-badge-complete"),
    );
    const open = createElement(documentRef, "button", "quiet-button");
    open.type = "button";
    open.textContent = "Open in editor";
    open.addEventListener("click", () => openDocument(document.path));
    header.append(badges, open);
    parent.append(header);
  }

  function renderMetadata(parent, item) {
    const document = item.document;
    const section = createElement(documentRef, "section", "review-metadata");
    appendText(documentRef, section, "h4", "review-section-title", "Governance metadata");
    const grid = createElement(documentRef, "dl", "review-meta-grid");
    const tools = Array.isArray(document.tools) && document.tools.length > 0
      ? document.tools.join(", ")
      : "Not set";
    for (const [label, value] of [
      ["Department", document.department],
      ["Business system", document.business_system],
      ["Owner role", document.owner_role],
      ["Criticality", document.criticality],
      ["Tools", tools],
      ["Last content update", formatDocumentUpdatedAt(document.updated_at)],
    ]) {
      grid.append(makeMetaItem(documentRef, label, labelize(value)));
    }
    section.append(grid);
    parent.append(section);
  }

  async function loadPreview(item, preview) {
    const requestId = ++previewRequestId;
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", item.document.path);
      const payload = await request(url);
      if (requestId !== previewRequestId || !preview.isConnected) return;
      preview.textContent = payload.content || "The document has no Markdown content.";
    } catch (error) {
      if (requestId !== previewRequestId || !preview.isConnected) return;
      preview.textContent = `Document preview unavailable: ${error?.message || "request failed"}`;
    }
  }

  function renderPreview(parent, item) {
    const section = createElement(documentRef, "section", "review-preview");
    const heading = createElement(documentRef, "header", "review-section-heading");
    appendText(documentRef, heading, "h4", "review-section-title", "Current document");
    appendText(documentRef, heading, "span", "review-preview-note", "Read-only preview");
    const preview = createElement(documentRef, "pre", "review-markdown-preview");
    preview.textContent = "Loading current Markdown…";
    section.append(heading, preview);
    parent.append(section);
    loadPreview(item, preview);
  }

  function renderHistoryItems(container, history) {
    container.replaceChildren();
    if (!history.length) {
      container.append(
        createEmptyState(
          documentRef,
          "No review history",
          "This document has not received review evidence yet.",
        ),
      );
      return;
    }
    for (const review of history) {
      const item = createElement(documentRef, "article", "review-history-item");
      const header = createElement(documentRef, "header", "review-history-header");
      appendText(documentRef, header, "strong", "", decisionLabel(review.decision));
      appendText(documentRef, header, "time", "review-history-date", formatDate(review.reviewedAt));
      appendText(documentRef, item, "p", "review-history-byline", `Reviewed by ${text(review.reviewerId, "unknown operator")}`);
      if (review.feedback) appendText(documentRef, item, "p", "review-history-feedback", review.feedback);
      item.append(header);
      container.append(item);
    }
  }

  async function loadHistory(item, container) {
    const requestId = ++historyRequestId;
    if (!item.review) {
      renderHistoryItems(container, []);
      return;
    }
    try {
      const url = apiUrl(`/api/document-reviews/${encodeURIComponent(item.id)}`);
      const payload = await request(url);
      if (requestId !== historyRequestId || !container.isConnected) return;
      renderHistoryItems(container, Array.isArray(payload?.history) ? payload.history : [payload.review]);
    } catch (error) {
      if (requestId !== historyRequestId || !container.isConnected) return;
      container.replaceChildren(createEmptyState(documentRef, "History unavailable", error?.message || "Review history could not be loaded."));
    }
  }

  function reviewFormValue(form, name) {
    return form.querySelector(`[name="${name}"]`)?.value || "unreviewed";
  }

  async function submitReview(item, form, decision, status) {
    const buttons = form.querySelectorAll("button");
    for (const button of buttons) button.disabled = true;
    status.hidden = false;
    status.className = "review-form-status";
    status.textContent = "Saving review evidence…";
    const checklist = {};
    for (const field of REVIEW_CHECKLIST_FIELDS) {
      checklist[field] = reviewFormValue(form, `check-${field}`);
    }
    const feedback = form.querySelector('[name="feedback"]')?.value || "";
    try {
      await request(apiUrl("/api/document-reviews"), {
        method: "POST",
        body: JSON.stringify({
          documentId: item.id,
          documentPath: item.document.path,
          documentUpdatedAt: Number(item.document.updated_at) || 0,
          decision,
          checklist,
          feedback,
        }),
      });
      notice = "Review evidence saved. The document lifecycle remains unchanged.";
      await refreshReviewSnapshot({ rerender: false });
      renderReviewSurface(lastDocuments);
    } catch (error) {
      status.className = "review-form-status is-error";
      status.textContent = error?.message || "Review could not be saved.";
      for (const button of buttons) button.disabled = false;
    }
  }

  function renderReviewForm(parent, item) {
    const section = createElement(documentRef, "section", "review-form-section");
    appendText(documentRef, section, "h4", "review-section-title", "Record review evidence");
    appendText(
      documentRef,
      section,
      "p",
      "review-form-guidance",
      "This records your review and feedback. It does not promote the document to active.",
    );
    const form = createElement(documentRef, "form", "review-form");
    const checklist = createElement(documentRef, "fieldset", "review-checklist");
    appendText(documentRef, checklist, "legend", "", "Review checklist");
    for (const field of REVIEW_CHECKLIST_FIELDS) {
      const label = createElement(documentRef, "label", "review-check-item");
      appendText(documentRef, label, "span", "", CHECKLIST_LABELS[field]);
      const select = createElement(documentRef, "select");
      select.name = `check-${field}`;
      const current = item.review?.checklist?.[field] || "unreviewed";
      for (const [value, optionLabel] of CHECKLIST_OPTIONS) {
        const option = createElement(documentRef, "option");
        option.value = value;
        option.textContent = optionLabel;
        option.selected = value === current;
        select.append(option);
      }
      select.value = current;
      label.append(select);
      checklist.append(label);
    }
    const feedbackLabel = createElement(documentRef, "label", "review-feedback-field");
    appendText(documentRef, feedbackLabel, "span", "", "Feedback");
    const feedback = createElement(documentRef, "textarea");
    feedback.name = "feedback";
    feedback.rows = 4;
    feedback.maxLength = 4000;
    feedback.placeholder = "Capture the evidence, change needed, or reason for blocking…";
    feedback.value = item.review?.feedback || "";
    feedbackLabel.append(feedback);
    const status = createElement(documentRef, "p", "review-form-status");
    status.hidden = true;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const actions = createElement(documentRef, "div", "review-decision-actions");
    for (const [decision, label, className] of DECISION_BUTTONS) {
      const button = createElement(documentRef, "button", className);
      button.type = "button";
      button.dataset.reviewDecision = decision;
      button.textContent = label;
      button.addEventListener("click", () => submitReview(item, form, decision, status));
      actions.append(button);
    }
    form.append(checklist, feedbackLabel, status, actions);
    section.append(form);
    parent.append(section);
  }

  function renderDetail(pane, item) {
    if (!item) {
      pane.append(
        createSplitEmpty(
          documentRef,
          "Select a document",
          "Choose a document from the queue to read it and record review evidence.",
        ),
      );
      return;
    }
    renderDocumentHeader(pane, item);
    const parent = createElement(documentRef, "div", "dk-split__scroll dk-split__scroll--flush review-detail");
    pane.append(parent);
    appendText(documentRef, parent, "p", "review-document-path", item.document.path);
    renderMetadata(parent, item);
    renderPreview(parent, item);
    const historySection = createElement(documentRef, "section", "review-history");
    const heading = createElement(documentRef, "header", "review-section-heading");
    appendText(documentRef, heading, "h4", "review-section-title", "Review history");
    appendText(documentRef, heading, "span", "review-preview-note", "Newest first");
    const history = createElement(documentRef, "div", "review-history-list");
    history.append(createEmptyState(documentRef, "Loading history…", ""));
    historySection.append(heading, history);
    parent.append(historySection);
    loadHistory(item, history);
    renderReviewForm(parent, item);
  }

  function renderReviewSurface(documents) {
    lastDocuments = Array.isArray(documents) ? documents : [];
    const reviewSnapshot = snapshot();
    const queue = reviewSnapshot.loaded
      ? buildReviewQueue(lastDocuments, reviewSnapshot.reviews)
      : [];
    const items = filteredItems(queue);
    const routeId = activeRouteDocumentId();
    const selectedItem = queue.find((item) => item.id === routeId) ||
      queue.find((item) => item.id === selectedId) ||
      items[0] ||
      queue[0] ||
      null;
    if (selectedItem) selectedId = selectedItem.id;

    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    documentList.classList.add("is-review-surface");
    setRouteTitle("Review");
    const root = createElement(documentRef, "div", "review-surface dk-fill");
    renderHeader(root);
    if (notice) {
      const saved = createElement(documentRef, "p", "review-notice");
      saved.setAttribute("role", "status");
      saved.textContent = notice;
      root.append(saved);
      notice = "";
    }
    if (!reviewSnapshot.loaded) {
      root.append(
        renderHonestState?.(
          reviewSnapshot.errors?.length ? "Review data unavailable" : "Loading review evidence",
          reviewSnapshot.errors?.join(" ") || "Saved review decisions are loading before the queue is built.",
        ) || createEmptyState(
          documentRef,
          reviewSnapshot.errors?.length ? "Review data unavailable" : "Loading review evidence",
          reviewSnapshot.errors?.join(" ") || "Saved review decisions are loading before the queue is built.",
        ),
      );
      if (reviewSnapshot.errors?.length) root.append(refreshButton("Try again"));
      documentList.replaceChildren(root);
      return;
    }
    renderFilterBar(root);
    // The route decides which pane a phone shows; desktop shows both and
    // still opens the first document when the route names none.
    const layout = createElement(documentRef, "div", "dk-split");
    layout.dataset.view = routeId && selectedItem?.id === routeId ? "detail" : "list";
    layout.append(renderQueuePanel(items, selectedItem));
    const detail = createElement(documentRef, "section", "dk-split__detail");
    detail.setAttribute("aria-label", "Selected document review");
    renderDetail(detail, selectedItem);
    layout.append(detail);
    root.append(layout);

    const availability = getDocsAvailability?.();
    if (availability?.state === "unavailable") {
      const state = renderHonestState?.(
        "Document catalog is unavailable",
        availability.error || "The review queue cannot be derived until the docs service recovers.",
      ) || createEmptyState(documentRef, "Document catalog is unavailable", availability.error || "Retry the docs service.");
      root.append(state);
    }
    documentList.replaceChildren(root);
  }

  return { refreshReviewSnapshot, renderReviewSurface };
}
