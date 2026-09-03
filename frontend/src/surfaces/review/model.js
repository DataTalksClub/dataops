export const REVIEWABLE_STATUSES = Object.freeze([
  "proposed",
  "draft",
  "review-due",
  "blocked",
]);

export const REVIEW_CHECKLIST_FIELDS = Object.freeze([
  "purpose",
  "procedure",
  "validation",
  "troubleshooting",
  "references",
  "ownership",
]);

export const REVIEW_DECISIONS = Object.freeze([
  "approved",
  "changes_requested",
  "blocked",
  "deferred",
]);

const UNRESOLVED_DECISIONS = new Set([
  "changes_requested",
  "blocked",
  "deferred",
]);
const STATUS_ORDER = new Map([
  ["blocked", 0],
  ["review-due", 1],
  ["proposed", 2],
  ["draft", 3],
  ["active", 4],
]);

function text(value) {
  return String(value || "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusOf(document) {
  return text(document?.status).toLowerCase() || "proposed";
}

function criticalityOrder(document) {
  return text(document?.criticality).toLowerCase() === "core" ? 0 : 1;
}

function isReviewDue(document, now) {
  const nextReview = Date.parse(text(document?.next_review_at));
  return Number.isFinite(nextReview) && nextReview <= now;
}

function isEligible(document, now) {
  const status = statusOf(document);
  return REVIEWABLE_STATUSES.includes(status) ||
    (status === "active" && isReviewDue(document, now));
}

export function reviewNeedsAttention(document, review, now = Date.now()) {
  const status = statusOf(document);
  if (!isEligible(document, now)) return false;
  if (!review) return true;
  if (status === "blocked" || status === "review-due") return true;
  if (isReviewDue(document, now)) return true;
  if (number(document?.updated_at) > number(review.documentUpdatedAt)) return true;
  return UNRESOLVED_DECISIONS.has(text(review.decision));
}

export function reviewReason(document, review, now = Date.now()) {
  const status = statusOf(document);
  if (!review) return "No review evidence recorded";
  if (!reviewNeedsAttention(document, review, now)) return "Review evidence is current";
  if (number(document?.updated_at) > number(review.documentUpdatedAt)) {
    return "Document changed since the last review";
  }
  if (text(review.decision) === "changes_requested") return "Changes requested";
  if (text(review.decision) === "blocked" || status === "blocked") {
    return "Blocked; owner decision is needed";
  }
  if (text(review.decision) === "deferred") return "Review deferred";
  if (status === "review-due" || isReviewDue(document, now)) return "Review cycle is due";
  if (status === "proposed" || status === "draft") return "Ready for owner review";
  return "Review evidence is current";
}

export function reviewStateLabel(document, review, now = Date.now()) {
  if (reviewNeedsAttention(document, review, now)) {
    const decision = text(review?.decision);
    if (decision === "changes_requested") return "Changes requested";
    if (decision === "blocked" || statusOf(document) === "blocked") return "Blocked";
    if (decision === "deferred") return "Deferred";
    return "Needs review";
  }
  if (review) return "Reviewed";
  return isEligible(document, now) ? "Needs review" : "Historical";
}

export function buildReviewQueue(documents, reviews, now = Date.now()) {
  const reviewById = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const id = text(review?.documentId);
    if (!id) continue;
    const existing = reviewById.get(id);
    if (!existing || text(review.updatedAt) > text(existing.updatedAt)) {
      reviewById.set(id, review);
    }
  }

  return (Array.isArray(documents) ? documents : [])
    .filter((document) => document && text(document.id))
    .map((document) => {
      const review = reviewById.get(text(document.id)) || null;
      const needsReview = reviewNeedsAttention(document, review, now);
      return {
        document,
        review,
        id: text(document.id),
        needsReview,
        reason: reviewReason(document, review, now),
        state: reviewStateLabel(document, review, now),
      };
    })
    .sort((left, right) => {
      if (left.needsReview !== right.needsReview) return left.needsReview ? -1 : 1;
      const criticality = criticalityOrder(left.document) - criticalityOrder(right.document);
      if (criticality !== 0) return criticality;
      const status = (STATUS_ORDER.get(statusOf(left.document)) ?? 9) -
        (STATUS_ORDER.get(statusOf(right.document)) ?? 9);
      if (status !== 0) return status;
      const updated = number(left.document.updated_at) - number(right.document.updated_at);
      if (updated !== 0) return updated;
      return text(left.document.title || left.document.id)
        .localeCompare(text(right.document.title || right.document.id));
    });
}

export function reviewSummary(queue) {
  const items = Array.isArray(queue) ? queue : [];
  return {
    total: items.length,
    needsReview: items.filter((item) => item.needsReview).length,
    reviewed: items.filter((item) => item.state === "Reviewed").length,
    changesRequested: items.filter((item) => item.state === "Changes requested").length,
    blocked: items.filter((item) => item.state === "Blocked").length,
  };
}

export function decisionLabel(decision) {
  return {
    approved: "Approved review evidence",
    changes_requested: "Changes requested",
    blocked: "Blocked",
    deferred: "Deferred",
  }[decision] || "Not reviewed";
}
