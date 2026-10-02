import { createClient } from "../api.mjs";
import { resolveProfile } from "../config.mjs";

const base = "/api/bookkeeping/invoices";
const fieldNames = ["transactionDate", "paidDate", "counterparty", "description", "amount", "currency", "amountEur", "statementRef", "quantity", "subtype", "period", "category", "paymentEvidence", "accountContext", "invoiceNumber", "archiveRequired", "archiveExceptionReason", "comment"];
function client(args) {
  const profile = resolveProfile(args);
  if (!profile.token) throw new Error("Not signed in. Run `dataops login`.");
  return createClient(profile);
}
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
    for (const record of result.items) io.print(`${record.id}  revision ${record.revision}  ${record.status}  ${record.fields?.counterparty || "Unidentified provider"}  ${record.publicationStatus}`);
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
  return show(await client(args).put(`${base}/${id(args)}`, { revision: revision(args), fields }), args, io);
}
async function action(name, args, io) {
  return show(await client(args).post(`${base}/${id(args)}/${name}`, { revision: revision(args), ...(args.reason ? { reason: String(args.reason) } : {}) }), args, io);
}
export const confirm = (args, io) => action("confirm", args, io);
export const reject = (args, io) => action("reject", args, io);
export const retry = (args, io) => action("retry", args, io);
