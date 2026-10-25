import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiFor } from "../session.mjs";

const base = "/api/bookkeeping/invoices";
const fieldNames = ["transactionDate", "paidDate", "counterparty", "description", "amount", "currency", "amountEur", "statementRef", "quantity", "subtype", "period", "category", "paymentEvidence", "accountContext", "invoiceNumber", "vatId", "archiveRequired", "archiveExceptionReason", "comment"];
const client = apiFor;

export const summary = "Bookkeeping invoice drafts: review, verify, publish";

export const help = `dataops invoices - invoice drafts (automatic publication after field verification)

Usage
  dataops invoices list | readiness
  dataops invoices detail <id> | document <id>
  dataops invoices edit <id> --revision N [--paid-date YYYY-MM-DD] [--amount-eur N]
    [--payment-evidence NOTE] [--counterparty NAME] [--invoice-number REF]
    [--account-context CONTEXT] [--archive-required true|false] [--verified]
    Other fields: transaction-date, description, amount, currency, statement-ref,
    quantity, subtype, period, category, comment, vat-id, archive-exception-reason.
  dataops invoices verify <id> --revision N   Verify invoice/payment values and publish automatically
  dataops invoices confirm <id> --revision N  Existing explicit verification action
  dataops invoices reject <id> --revision N [--reason NOTE]
  dataops invoices retry <id> --revision N
  dataops invoices reextract <id> --revision N  Re-run extraction on an untouched draft
  dataops invoices replace-document <id> --file <pdf> --revision N [--reextract]
    Replace a pending draft PDF (up to 4 MiB); retain the old document in audit.
    Fields stay unchanged unless --reextract is supplied (includes VAT-ID).
  dataops invoices process --intake-item-id ID

\`document\` returns a short-lived private PDF URL; treat it as sensitive.
`;
function id(args) {
  if (!args._[0]) throw new Error("Invoice ID is required.");
  return encodeURIComponent(args._[0]);
}
function revision(args) {
  const n = typeof args.revision === "string" ? Number(args.revision) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new Error("--revision must be the current reviewed revision (a positive integer).");
  return n;
}
function show(result, args, io) {
  if (args.json) return result;
  if (result.items) {
    for (const record of result.items) io.print(`${record.id}  revision ${record.revision}  ${record.status}  ${record.fields?.counterparty || "(provider not extracted)"}  ${record.publicationStatus}`);
    if (!result.items.length) io.print("No invoice drafts.");
    for (const issue of result.issues || []) io.print(`Needs attention: ${issue}`);
  } else io.print(JSON.stringify(result, null, 2));
  return result;
}
export async function list(args, io) { return show(await client(args).get(base), args, io); }
export async function detail(args, io) { return show(await client(args).get(`${base}/${id(args)}`), args, io); }
export async function document(args, io) { return show(await client(args).get(`${base}/${id(args)}/document`), args, io); }
export async function readiness(args, io) { return show(await client(args).get(`${base}/readiness`), args, io); }
export async function processIntake(args, io) {
  if (!args.intakeItemId) throw new Error("--intake-item-id is required.");
  return show(await client(args).post(`${base}/process`, { intakeItemId: String(args.intakeItemId) }), args, io);
}
export async function edit(args, io) {
  const fields = {};
  for (const name of fieldNames) if (args[name] !== undefined) {
    let value = args[name];
    if (["amount", "amountEur"].includes(name)) {
      if (typeof value !== "string") throw new Error(`--${name} needs a decimal amount.`);
      value = value.trim() || null;
    } else if (name === "quantity") {
      value = value === "" ? null : typeof value === "string" ? Number(value) : NaN;
      if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`--${name} must be a positive integer.`);
    } else if (name === "archiveRequired") {
      if (![true, "true", "false"].includes(value)) throw new Error("--archive-required must be true or false.");
      value = value === true || value === "true";
    } else value = String(value);
    fields[name] = value;
  }
  if (!Object.keys(fields).length) throw new Error("Pass at least one invoice field to correct.");
  if (args.verified !== undefined && ![true, "true", "false"].includes(args.verified))
    throw new Error("--verified must be true or false.");
  const verified = args.verified === true || args.verified === "true";
  return show(await client(args).put(`${base}/${id(args)}`, { revision: revision(args), fields, ...(verified ? { verified: true } : {}) }), args, io);
}
async function action(name, args, io) {
  return show(await client(args).post(`${base}/${id(args)}/${name}`, { revision: revision(args), ...(args.reason ? { reason: String(args.reason) } : {}) }), args, io);
}
export const verify = (args, io) => action("verify", args, io);
export const confirm = (args, io) => action("confirm", args, io);
export const reject = (args, io) => action("reject", args, io);
export const retry = (args, io) => action("retry", args, io);
export const reextract = (args, io) => action("reextract", args, io);

export async function replaceDocument(args, io) {
  const invoiceId = id(args);
  const reviewedRevision = revision(args);
  if (typeof args.file !== "string" || !args.file) throw new Error("--file must name a PDF.");
  if (args.reextract !== undefined && ![true, "true", "false"].includes(args.reextract))
    throw new Error("--reextract must be true or false.");
  const bytes = await readFile(args.file);
  if (bytes.length > 4 * 1024 * 1024) throw new Error("PDF exceeds the 4 MiB upload limit.");
  if (path.extname(args.file).toLowerCase() !== ".pdf" || bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("--file must contain a PDF.");
  return show(await client(args).post(`${base}/${invoiceId}/replace-document`, {
    revision: reviewedRevision,
    filename: path.basename(args.file),
    contentType: "application/pdf",
    contentBase64: bytes.toString("base64"),
    reextract: args.reextract === true || args.reextract === "true",
  }), args, io);
}
