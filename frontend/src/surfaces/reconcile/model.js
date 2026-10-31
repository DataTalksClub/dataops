// Month-end bank reconciliation: pure helpers shared by the markup and the
// surface controller. Periods, row sides, filters and the exact request
// bodies the /api/reconcile/months/:period/* actions take live here so the
// tests exercise them without a DOM.

export const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
export const RECONCILE_BASE_PATH = "/finance/reconcile";

/** The month before `today` (YYYY-MM-DD): month-end work is about last month. */
export function previousMonth(today) {
  return shiftMonth(String(today).slice(0, 7), -1);
}

export function shiftMonth(period, delta) {
  const [year, month] = period.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The period named in /finance/reconcile/YYYY-MM, or null for the bare path or a bad month. */
export function periodFromPath(pathname) {
  const match = String(pathname || "").match(/^\/finance\/reconcile\/([^/?#]+)\/?$/);
  const value = match ? decodeURIComponent(match[1]) : "";
  return PERIOD.test(value) ? value : null;
}

export const reconcilePath = (period) => `${RECONCILE_BASE_PATH}/${period}`;

export function monthLabel(period) {
  return new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const STATUS_META = Object.freeze({
  "no-invoice": { label: "No invoice", tone: "danger" },
  "payment-proof-missing": { label: "No payment proof", tone: "danger" },
  "amount-mismatch": { label: "Amount mismatch", tone: "warning" },
  "needs-review": { label: "Needs review", tone: "warning" },
  matched: { label: "Matched", tone: "success" },
});

// Non-matched rows sort first, the most actionable status leading.
const STATUS_ORDER = ["no-invoice", "payment-proof-missing", "amount-mismatch", "needs-review", "matched"];

export const FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "open", label: "Not matched" },
  ...STATUS_ORDER.map((status) => ({ id: status, label: STATUS_META[status].label })),
  { id: "exceptions", label: "Exceptions" },
]);

export const FILTER_IDS = FILTERS.map((filter) => filter.id);

export function rowMatchesFilter(row, filter) {
  if (filter === "all") return true;
  if (filter === "open") return row.status !== "matched";
  if (filter === "exceptions") return Boolean(row.exception);
  return row.status === filter;
}

export function filterCounts(rows) {
  return Object.fromEntries(FILTER_IDS.map((id) => [id, rows.filter((row) => rowMatchesFilter(row, id)).length]));
}

/** Rows for a filter: not-matched first by status, then by date within a status. */
export function visibleRows(rows, filter) {
  const rank = (row) => STATUS_ORDER.indexOf(row.status);
  return rows
    .filter((row) => rowMatchesFilter(row, filter))
    .sort((left, right) => rank(left) - rank(right) || String(left.date).localeCompare(String(right.date)) || left.id.localeCompare(right.id));
}

/** Which sides the row has, and the id of each side the actions need. */
export function rowSides(row) {
  return {
    bankKey: row.bank?.key || null,
    transactionId: row.ledger?.id || null,
    kind: row.bank && row.ledger ? "paired" : row.bank ? "bank" : "ledger",
  };
}

/** The actions a row offers while the month is open, in display order. */
export function rowActions(row, { open = true } = {}) {
  if (!open) return [];
  const { kind } = rowSides(row);
  const actions = [];
  if (kind === "bank") actions.push("attach-invoice", "create-ledger", "match");
  if (kind === "ledger") {
    if (!row.paymentProof) actions.push("attach-proof");
    if (!row.documents?.length) actions.push("attach-invoice");
    actions.push("match");
  }
  if (kind === "paired") {
    if (!row.documents?.length) actions.push("attach-invoice");
    if (row.pairBasis !== "manual" && ["amount-mismatch", "needs-review"].includes(row.status)) actions.push("confirm-pair");
    actions.push("unmatch");
  }
  actions.push(row.exception?.recorded ? "clear-exception" : "exception");
  return actions;
}

const note = (value) => {
  const text = String(value ?? "").trim();
  return text ? { note: text } : {};
};

// ---- request bodies -------------------------------------------------------
// Each returns [action, body] for POST /api/reconcile/months/:period/:action.

export function pairRequest(bankKey, transactionId, noteText) {
  return ["pair", { bankKey, transactionId, ...note(noteText) }];
}

export function unpairRequest(row, noteText) {
  const { bankKey, transactionId } = rowSides(row);
  return ["unpair", { bankKey, transactionId, ...note(noteText) }];
}

/** Match a one-sided row with the other side's id (a bank key or a ledger row id). */
export function matchRequest(row, otherId, noteText) {
  const { bankKey, transactionId } = rowSides(row);
  return bankKey ? pairRequest(bankKey, otherId, noteText) : pairRequest(otherId, transactionId, noteText);
}

export function exceptionRequest(row, { kind, proof, note: noteText } = {}) {
  const evidence = String(proof ?? "").trim();
  return ["exception", { row: row.id, kind, ...(evidence ? { proof: evidence } : {}), ...note(noteText) }];
}

export const clearExceptionRequest = (row) => ["clear-exception", { row: row.id }];

export function proofRequest(row, documentId) {
  return ["proof", { transactionId: rowSides(row).transactionId, documentId }];
}

/**
 * An invoice/receipt for the row. A ledger row gets a document link; a
 * bank-only row has no ledger row yet, so the ledger row is created from the
 * bank row with the document attached.
 */
export function invoiceRequest(row, documentId) {
  const { transactionId } = rowSides(row);
  return transactionId ? ["document", { transactionId, documentId }] : ledgerRequest(row, { documentId });
}

export function ledgerRequest(row, { category, description, documentId } = {}) {
  const trimmed = (value) => String(value ?? "").trim();
  return ["ledger", {
    bankKey: rowSides(row).bankKey,
    ...(trimmed(category) ? { category: trimmed(category) } : {}),
    ...(trimmed(description) ? { description: trimmed(description) } : {}),
    ...(documentId ? { documentId } : {}),
  }];
}

/** Rows on the other side a one-sided row can pair with: its candidates first, then every unpaired row. */
export function matchOptions(month, row) {
  const { kind } = rowSides(row);
  if (kind === "paired") return [];
  const wantBank = kind === "ledger";
  const others = month.rows.filter((other) => other !== row && (wantBank ? other.bank && !other.ledger : other.ledger && !other.bank));
  const idOf = (other) => (wantBank ? other.bank.key : other.ledger.id);
  const scored = new Map((row.candidates || []).map((candidate) => [wantBank ? candidate.bankKey : candidate.transactionId, candidate.score]));
  const options = others.map((other) => ({ id: idOf(other), row: other, score: scored.get(idOf(other)) }));
  // A candidate may already be paired elsewhere or sit in another month: still offer it by id.
  for (const [id, score] of scored) if (id && !options.some((option) => option.id === id)) options.push({ id, row: null, score });
  return options.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
}

// ---- documents --------------------------------------------------------------

async function sha256Hex(bytes, cryptoRef) {
  const digest = await cryptoRef.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Stores a PDF through the bookkeeping document flow (prepare, PUT to the
 * signed URL, complete), the same three calls the bookkeeping evidence
 * upload and `dataops reconcile upload` make. Returns the document id.
 */
export async function uploadBookkeepingDocument(file, { request, workApiUrl, fetchImpl = globalThis.fetch, cryptoRef = globalThis.crypto, documentType = "receipt" }) {
  if (file.type && file.type !== "application/pdf") throw new Error("Only PDF documents can be attached");
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes, cryptoRef);
  const ownership = { idempotencyKey: `reconcile-${sha256.slice(0, 40)}` };
  const prepared = await request(workApiUrl("/api/bookkeeping/documents/prepare"), {
    method: "POST",
    body: JSON.stringify({ sha256, byteSize: file.size, documentType, ...ownership, sourceRef: `portal-${sha256.slice(0, 24)}` }),
  });
  if (prepared.outcome === "existing") return prepared.document.id;
  const uploaded = await fetchImpl(prepared.uploadUrl, {
    method: "PUT",
    headers: prepared.uploadHeaders || { "content-type": "application/pdf" },
    body: file,
  });
  if (!uploaded.ok) throw new Error("Upload failed; retry the same file");
  const completed = await request(workApiUrl(`/api/bookkeeping/documents/${encodeURIComponent(prepared.document.id)}/complete`), {
    method: "POST",
    body: JSON.stringify(ownership),
  });
  return completed.document.id;
}
