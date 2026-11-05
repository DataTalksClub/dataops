import { randomUUID } from "node:crypto";
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
