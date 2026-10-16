import { randomUUID } from "node:crypto";
import { UsageError } from "../errors.mjs";
import { enc, integer, isoDate, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Sponsor CRM: organizations, contacts, deals, deliverables, leads, finance";

const KINDS = ["organizations", "contacts", "deals", "deliverables", "leads", "newsletters"];

export const help = `dataops sponsors - the sponsor CRM (the web Finance > Sponsors views)

Usage
  dataops sponsors list <kind> [--limit N]             kind: ${KINDS.join(", ")}
  dataops sponsors show <kind> <id>
  dataops sponsors create <kind> --data '{...}'        Fields as the web form sends them
  dataops sponsors update <kind> <id> --data '{...}'
  dataops sponsors update leads <id> --data '{"status":"ignored","version":N}' [--reason TEXT]
  dataops sponsors messages <organization-id>          Communications with an organization
  dataops sponsors history <deal-id>                   A deal's change history
  dataops sponsors finance <deal-id> [history|candidates/invoices|candidates/payments]
  dataops sponsors chase <deal-id> [--date YYYY-MM-DD]  Create a main-pool payment follow-up
  dataops sponsors link-payment <deal-id> <transaction-id> [--apply]
      Link a bookkeeping transaction to the deal as its payment. A payment the deal
      recorded before the row existed (same amount, within 14 days) is replaced by
      the link. Prints what it would do unless --apply is given.

Invoice drafts: use dataops invoices. To find invoice evidence for a sponsor deal,
use dataops sponsors finance <deal-id> candidates/invoices.

--data takes a JSON object, @file.json, or - for stdin. The API validates every field
exactly as it does for the web; a 400/422 names what is wrong. Use --json to see the
current record shape before writing one.

Examples
  dataops sponsors list deals --json | jq '.items[] | {id, status}'
  dataops sponsors update deals 1f2e... --data '{"status":"won","version":3}'
  dataops sponsors update leads 9a8b... --data '{"status":"ignored","version":1}' --reason "House ad"

--reason (leads only) says why the lead has its status; a status change without one
clears the previous reason.
`;

function kindOf(args, index = 0) {
  const kind = positional(args, index, `dataops sponsors <list|show> <${KINDS.join("|")}>`);
  if (kind === "invoices") throw new UsageError("Invoice drafts use `dataops invoices`. For sponsor invoice evidence, use `dataops sponsors finance <deal-id> candidates/invoices`.");
  if (!KINDS.includes(kind)) throw new UsageError(`Unknown kind "${kind}". One of: ${KINDS.join(", ")}.`);
  return kind;
}

function itemsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["items", "organizations", "contacts", "deals", "deliverables", "leads", "newsletters"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function label(item) {
  return item.name || item.title || item.organizationName || item.email || item.subject || item.campaignLabel || "";
}

export async function list(args, io) {
  const kind = kindOf(args);
  const api = apiFor(args);
  const max = integer(args.limit, "limit") ?? 200;
  const items = [];
  let cursor;
  let last;
  do {
    last = await api.get(`/api/sponsor-crm/${kind}`, { query: { cursor } });
    items.push(...itemsOf(last));
    cursor = last?.nextCursor;
  } while (cursor && items.length < max);
  const result = { kind, items: items.slice(0, max) };
  if (args.json) return result;
  table(io, result.items, [
    ["ID", (item) => item.id],
    ["STATUS", (item) => item.status || item.stage || ""],
    ["NAME", label],
  ], `No ${kind}.`);
  return result;
}

export async function show(args, io) {
  const kind = kindOf(args);
  const id = positional(args, 1, "dataops sponsors show <kind> <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/${kind}/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function create(args, io) {
  const kind = kindOf(args);
  const result = await apiFor(args).post(`/api/sponsor-crm/${kind}`, jsonData(args));
  if (!args.json) io.print(`Created ${kind.replace(/s$/, "")} ${result?.id || result?.item?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function update(args, io) {
  const kind = kindOf(args);
  const id = positional(args, 1, "dataops sponsors update <kind> <id> --data '{...}'");
  const verb = kind === "leads" ? "patch" : "put";
  const data = jsonData(args);
  const reason = optionalString(args, "reason");
  if (reason !== undefined) {
    if (kind !== "leads") throw new UsageError("--reason applies to leads only.");
    data.statusReason = reason;
  }
  const result = await apiFor(args)[verb](`/api/sponsor-crm/${kind}/${enc(id)}`, data);
  if (!args.json) io.print(`Updated ${kind.replace(/s$/, "")} ${id}.`);
  return result;
}

export async function messages(args, io) {
  const id = positional(args, 0, "dataops sponsors messages <organization-id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/organizations/${enc(id)}/messages`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function history(args, io) {
  const id = positional(args, 0, "dataops sponsors history <deal-id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}/history`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function finance(args, io) {
  const id = positional(args, 0, "dataops sponsors finance <deal-id> [view]");
  const view = optionalString({ view: args._[1] }, "view");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}/finance${view ? `/${view}` : ""}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

const DAY = 86_400_000;

/** The recorded (pre-bookkeeping) payment a transaction confirms, if one fits. */
export function replaceablePayment(payments, candidate) {
  const date = Date.parse(String(candidate.effectiveDate || ""));
  return (payments || []).find(
    (payment) =>
      payment.source === "recorded" &&
      Number(payment.amount) === Number(candidate.amount) &&
      Number.isFinite(date) &&
      Math.abs(Date.parse(String(payment.effectiveDate)) - date) <= 14 * DAY,
  );
}

async function paymentCandidate(api, dealId, transactionId) {
  let cursor;
  do {
    const page = await api.get(`/api/sponsor-crm/deals/${enc(dealId)}/finance/candidates/payments`, { query: { limit: 50, cursor } });
    const found = (page?.items || []).find((item) => item.id === transactionId);
    if (found) return found;
    cursor = page?.nextCursor;
  } while (cursor);
  return null;
}

export async function linkPayment(args, io) {
  const usage = "dataops sponsors link-payment <deal-id> <transaction-id> [--apply]";
  const dealId = positional(args, 0, usage);
  const transactionId = positional(args, 1, usage);
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(dealId)}`),
    api.get(`/api/sponsor-crm/deals/${enc(dealId)}/finance`),
  ]);
  if (!projection?.finance) throw new UsageError(`Deal ${dealId} has no finance record to link a payment to.`);
  const candidate = await paymentCandidate(api, dealId, transactionId);
  if (!candidate)
    throw new UsageError(`Transaction ${transactionId} is not an unclaimed ${projection.finance.currency || ""} payment candidate for this deal.`.replace("  ", " "));
  const replaced = replaceablePayment(projection.payments, candidate);
  const body = {
    dealVersion: deal.version,
    expectedVersion: projection.finance.version,
    sourceId: candidate.id,
    identityToken: candidate.identityToken,
    ...(replaced ? { replacesPaymentId: replaced.id } : {}),
  };
  const plan = `${candidate.effectiveDate} ${candidate.amount} ${candidate.currency}${replaced ? `, replacing the payment recorded on ${replaced.effectiveDate}` : ""}`;
  const result = { mode: args.apply ? "apply" : "dry-run", dealId, transactionId, replacesPaymentId: replaced?.id || null };
  if (args.apply) {
    const response = await api.post(`/api/sponsor-crm/deals/${enc(dealId)}/finance/payments`, body, {
      headers: { "Idempotency-Key": randomUUID() },
    });
    result.paymentState = response?.projection?.paymentState;
  }
  if (!args.json) io.print(`${result.mode}: link ${plan}${result.paymentState ? ` (deal is now ${result.paymentState})` : ""}`);
  return result;
}

/**
 * Create the deal's payment chase Task in the main task pool. The Task is
 * ordinary work from here on: `dataops tasks` owns waiting, follow-ups and
 * resolution; this only writes the finance-side record once.
 */
export async function chase(args, io) {
  const id = positional(args, 0, "dataops sponsors chase <deal-id> [--date YYYY-MM-DD]");
  const api = apiFor(args);
  const [deal, finance] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`),
    api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  const body = { dealVersion: deal.version, expectedVersion: finance.finance.version };
  const date = isoDate(args.date, "date");
  if (date) body.date = date;
  const result = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/chase`, body, {
    headers: { "Idempotency-Key": randomUUID() },
  });
  if (!args.json) {
    const task = result.task || {};
    io.print(`Created payment chase Task ${task.id} for deal ${id} (due ${task.date}).`);
    io.print(`Work it in the task pool: dataops tasks show ${task.id}`);
  }
  return result;
}

export const commands = { list, show, create, update, messages, history, finance, chase, "link-payment": linkPayment };
