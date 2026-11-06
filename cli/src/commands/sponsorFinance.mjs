import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { UsageError } from "../errors.mjs";
import { enc, isoDate, jsonData, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";

const CLASSIFICATION = ["invoiceRequirement", "amountDue", "currency", "taxMode", "taxAmount", "requestBy", "expectedInvoiceBy"];
const INVOICE = ["invoiceNumber", "issuedOn", "dueOn", "sentOn"];
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));

function dataFields(data, allowed) {
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new UsageError(`Unknown finance fields: ${unknown.join(", ")}`);
  return data;
}

function version(value, fallback, flag) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (value === true || !Number.isSafeInteger(result) || result < 0) throw new UsageError(`--${flag} must be a nonnegative integer`);
  return result;
}

async function context(args, command) {
  const id = positional(args, 0, `dataops sponsors ${command} <deal-id> --data @record.json [--apply]`);
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`),
    api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  return { id, api, projection, versions: {
    dealVersion: version(args.dealVersion, deal.version, "deal-version"),
    expectedVersion: version(args.expectedVersion, projection.finance?.version || 0, "expected-version"),
  } };
}

async function mutate(args, io, ctx, method, suffix, values) {
  const body = { ...values, ...ctx.versions };
  const idempotencyKey = args.idempotencyKey || randomUUID();
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new UsageError("--idempotency-key must contain 16-128 letters, digits, underscores or hyphens");
  const result = { mode: args.apply ? "apply" : "dry-run", dealId: ctx.id, idempotencyKey, request: body };
  if (args.apply) Object.assign(result, await ctx.api[method](`/api/sponsor-crm/deals/${enc(ctx.id)}/finance${suffix}`, body, {
    headers: { "Idempotency-Key": idempotencyKey },
  }));
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

function dates(values, names) {
  for (const name of names) if (values[name] !== undefined && values[name] !== null && values[name] !== "") values[name] = isoDate(values[name], name);
}

export async function classifyFinance(args, io) {
  const data = dataFields(jsonData(args), CLASSIFICATION);
  const ctx = await context(args, "classify-finance");
  const values = { ...pick(ctx.projection.finance, CLASSIFICATION), ...data };
  if (!["required", "not-required"].includes(values.invoiceRequirement)) throw new UsageError("invoiceRequirement must be required or not-required");
  if (values.invoiceRequirement === "required") {
    for (const key of ["amountDue", "currency", "taxMode"]) if (values[key] === undefined) throw new UsageError(`${key} is required for invoice classification`);
    dates(values, ["requestBy", "expectedInvoiceBy"]);
  }
  return mutate(args, io, ctx, "put", "", values.invoiceRequirement === "not-required" ? { invoiceRequirement: "not-required" } : values);
}

/** Record an already issued invoice; omitted metadata remains unchanged. No PDF is generated or email sent. */
export async function recordInvoice(args, io) {
  const data = dataFields(jsonData(args), INVOICE);
  const ctx = await context(args, "record-invoice");
  if (!ctx.projection.finance) throw new UsageError("Classify finance first with sponsors classify-finance");
  const values = { ...pick(ctx.projection.finance, INVOICE), ...data };
  for (const key of ["issuedOn", "dueOn"]) if (!values[key]) throw new UsageError(`${key} is required to record an invoice`);
  dates(values, ["issuedOn", "dueOn", "sentOn"]);
  if (values.dueOn < values.issuedOn || (values.sentOn && values.sentOn < values.issuedOn)) throw new UsageError("Invoice due/sent dates must not precede its issue date");
  // Empty strings explicitly clear optional metadata; omission preserves it.
  for (const key of ["invoiceNumber", "sentOn"]) if (values[key] === null) values[key] = "";
  return mutate(args, io, ctx, "post", "/issue", values);
}

/**
 * Upload an invoice PDF through verified private storage and resolve it as the
 * deal's finance invoice candidate. Shared by attach-invoice (the original)
 * and correct-invoice (the corrected document that supersedes it).
 */
export async function uploadInvoiceDocument(api, dealId, bytes, sha256) {
  let prepared = await api.post("/api/bookkeeping/documents/prepare", {
    sha256, byteSize: bytes.length, documentType: "invoice", idempotencyKey: `sponsor-invoice-${sha256}`, sourceRef: `sponsor-deal:${dealId}`,
  });
  if (prepared.uploadUrl) {
    const upload = await fetch(prepared.uploadUrl, { method: "PUT", body: bytes, headers: prepared.uploadHeaders });
    if (!upload.ok) {
      const failure = (await upload.text()).slice(0, 8192);
      const code = failure.match(/<Code>([A-Za-z0-9_-]+)<\/Code>/)?.[1] || "UploadRejected";
      throw new Error(`Invoice upload failed (${upload.status}, ${code}); retry the same file`);
    }
    prepared = await api.post(`/api/bookkeeping/documents/${enc(prepared.document.id)}/complete`, { idempotencyKey: `sponsor-invoice-${sha256}` });
  }
  let cursor, candidate;
  do {
    const page = await api.get(`/api/sponsor-crm/deals/${enc(dealId)}/finance/candidates/invoices`, { query: { limit: 50, cursor } });
    candidate = (page.items || []).find((item) => item.id === prepared.document.id);
    cursor = page.nextCursor;
  } while (!candidate && cursor);
  if (!candidate) throw new UsageError("Uploaded invoice is not an available candidate; check whether another deal already claims it.");
  return { candidate, sha256 };
}

/**
 * Correct an issued invoice with a required reason and the corrected metadata;
 * optional corrected PDF (issued in Finom's UI first) supersedes the linked
 * original in one audited step. No PDF is generated and no email is sent.
 */
export async function correctInvoice(args, io) {
  const id = positional(args, 0, "dataops sponsors correct-invoice <deal-id> --data @correction.json [--file corrected.pdf] [--apply]");
  const data = dataFields(jsonData(args), ["reason", ...INVOICE]);
  if (typeof data.reason !== "string" || !data.reason.trim()) throw new UsageError("A nonempty correction reason is required");
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`),
    api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance) throw new UsageError("Classify finance first with sponsors classify-finance");
  const versions = {
    dealVersion: version(args.dealVersion, deal.version, "deal-version"),
    expectedVersion: version(args.expectedVersion, projection.finance.version || 0, "expected-version"),
  };
  const values = { ...pick(projection.finance, INVOICE), ...data, reason: data.reason.trim() };
  for (const key of ["issuedOn", "dueOn"]) if (!values[key]) throw new UsageError(`${key} is required; record the issued invoice with sponsors record-invoice first`);
  dates(values, ["issuedOn", "dueOn", "sentOn"]);
  if (values.dueOn < values.issuedOn || (values.sentOn && values.sentOn < values.issuedOn)) throw new UsageError("Invoice due/sent dates must not precede its issue date");
  // Empty strings explicitly clear optional metadata; omission preserves it.
  for (const key of ["invoiceNumber", "sentOn"]) if (values[key] === null) values[key] = "";
  let bytes, sha256;
  if (args.file !== undefined) {
    if (typeof args.file !== "string" || !args.file) throw new UsageError("--file must name the corrected invoice PDF");
    bytes = await readFile(args.file);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new UsageError("--file must contain a PDF");
    sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const idempotencyKey = args.idempotencyKey || randomUUID();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new UsageError("--idempotency-key must contain 16-128 letters, digits, underscores or hyphens");
  const result = { mode: args.apply ? "apply" : "dry-run", dealId: id, idempotencyKey,
    ...(sha256 ? { correctedDocument: { sha256, byteSize: bytes.length } } : {}),
    request: { ...values, ...versions } };
  if (args.apply) {
    let document = {};
    if (bytes) {
      const { candidate } = await uploadInvoiceDocument(api, id, bytes, sha256);
      document = { sourceId: candidate.id, identityToken: candidate.identityToken };
    }
    result.request = { ...values, ...document, ...versions };
    Object.assign(result, await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/invoice-correction`, result.request, {
      headers: { "Idempotency-Key": idempotencyKey },
    }));
  }
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function addEvidence(args, io) {
  const data = dataFields(jsonData(args), ["kind", "ref", "label", "on"]);
  if (!["email", "document", "ledger", "url", "note"].includes(data.kind) || typeof data.ref !== "string" || !data.ref.trim()) throw new UsageError("Evidence requires a valid kind and nonempty ref");
  dates(data, ["on"]);
  const ctx = await context(args, "add-evidence");
  if (!ctx.projection.finance) throw new UsageError("Classify finance first with sponsors classify-finance");
  const existing = ctx.projection.finance.evidence || [];
  const found = existing.findIndex((entry) => entry.kind === data.kind && entry.ref === data.ref);
  const evidence = found < 0 ? [...existing, data] : existing.map((entry, index) => index === found ? { ...entry, ...data } : entry);
  return mutate(args, io, ctx, "put", "/follow-through", { evidence });
}

export async function setWaiting(args, io) {
  if (args.clear && args.data !== undefined) throw new UsageError("Use either --data or --clear, not both");
  const waitingOn = args.clear ? null : dataFields(jsonData(args), ["party", "reason", "since", "note"]);
  if (waitingOn) {
    if (!["us", "sponsor"].includes(waitingOn.party) || !waitingOn.reason || !waitingOn.since) throw new UsageError("Waiting state requires party (us|sponsor), reason and since");
    dates(waitingOn, ["since"]);
  }
  const ctx = await context(args, "set-waiting");
  if (!ctx.projection.finance) throw new UsageError("Classify finance first with sponsors classify-finance");
  return mutate(args, io, ctx, "put", "/follow-through", { waitingOn });
}
