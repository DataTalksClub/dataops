import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UsageError } from "./errors.mjs";
import { enc } from "./format.mjs";

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
};

function contentTypeFor(file) {
  const suffix = String(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const contentType = CONTENT_TYPES[suffix];
  if (!contentType) throw new UsageError("Document uploads accept PDF files only (.pdf) — bank statements also accept CSV (.csv)");
  return contentType;
}

function requirePdfBytes(file, bytes) {
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new UsageError(`${file}: document uploads accept PDF files only`);
  }
}

/** Bank statements may be CSV exports: readable text, not a PDF or binary file renamed to .csv. */
function requireStatementBytes(file, bytes, contentType) {
  if (contentType === "application/pdf") return requirePdfBytes(file, bytes);
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-" || bytes.includes(0)) {
    throw new UsageError(`${file}: not a readable CSV statement export`);
  }
}

export { contentTypeFor, requirePdfBytes, requireStatementBytes, originalFilename };

function originalFilename(file) {
  return String(file).split(/[\\/]/).at(-1) || "document.pdf";
}

/** Upload one PDF (or a bank-statement CSV) through prepare/PUT/complete; a file already stored comes back as reused. */
export async function storeDocument(api, file, { documentType, accountId, statementMonth, sourceRef }) {
  const contentType = contentTypeFor(file);
  const statement = ["bank-statement", "private-account-statement"].includes(documentType);
  if (!statement && contentType !== "application/pdf") throw new UsageError("invoices, receipts and proof screenshots must be PDF files");
  const bytes = await readFile(String(file));
  if (statement) requireStatementBytes(file, bytes, contentType);
  else requirePdfBytes(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const idempotencyKey = `${documentType}-${sha256}`.slice(0, 120);
  let prepared = await api.post("/api/bookkeeping/documents/prepare", {
    sha256, byteSize: bytes.length, documentType, idempotencyKey, sourceRef,
    originalFilename: originalFilename(file),
    ...(statement ? { accountId, statementMonth, contentType } : {}),
  });
  if (prepared.uploadUrl) {
    const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", body: bytes, headers: prepared.uploadHeaders });
    if (!uploaded.ok) throw new Error(`Document upload failed (${uploaded.status}); retry the same file`);
    prepared = await api.post(`/api/bookkeeping/documents/${enc(prepared.document.id)}/complete`, { idempotencyKey });
  }
  return { documentId: prepared.document.id, sha256, reused: prepared.outcome === "existing" };
}

/** Link stored documents to a ledger row as its evidence; the same link twice is a no-op. */
export async function linkEvidence(api, transactionId, documentIds) {
  const links = [];
  for (const documentId of documentIds) {
    const result = await api.post("/api/bookkeeping/links", { documentId, transactionId, coverageType: "evidence" });
    links.push({ documentId, outcome: result.outcome || "created", id: result.id });
  }
  return links;
}
