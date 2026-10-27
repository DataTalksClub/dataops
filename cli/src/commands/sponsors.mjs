import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { UsageError } from "../errors.mjs";
import { enc, integer, isoDate, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import {
  THANK_YOU_EVIDENCE_LABEL,
  attachThankYouResult,
  findThankYouEvidence,
  printThankYouHint,
} from "../thank-you.mjs";

export const summary = "Sponsor CRM: organizations, contacts, deals, deliverables, leads, finance";

const KINDS = ["organizations", "contacts", "deals", "deliverables", "leads", "newsletters"];

export const help = `dataops sponsors - the sponsor CRM (the web Finance > Sponsors views)

Usage
  dataops sponsors pipeline [--view actionable|active|all|closed|unscheduled|early|overdue|reply] [--stage open|agreed|invoiced|running|closed|lost]
      [--search TEXT] [--company ID] [--owner ID] [--sort next-action|recent] [--limit N] [--cursor N]
      [--next-action-from YYYY-MM-DD] [--next-action-before YYYY-MM-DD]  Inclusive bounds
  dataops sponsors contact <list|add|update> [ID] --company ID [--data @person.json]
      Fields: name, role, emails, linkedin, telegram, primary, notes, lastContactedAt.
  dataops sponsors list <kind> [--limit N] [--source TEXT] [--content-type TEXT] [--channel TEXT] [--deal-id ID]
                                                      kind: ${KINDS.join(", ")}; deliverables filter by Airtable Content source
  dataops sponsors show <kind> <id>
  dataops sponsors create <kind> --data '{...}'        Fields as the web form sends them
  dataops sponsors create leads --data '{"source":"newsletter","url":"https://…","summary":"…","observedAt":"ISO"}'
      Record one outbound lead sighting. source: newsletter|social|influencer|paid;
      optional organizationId links a known company. Never creates a deal:
      a deal only exists once a sale closes.
  dataops sponsors update <kind> <id> --data '{...}'
  dataops sponsors update leads <id> --data '{"status":"ignored","version":N}' [--reason TEXT]
  dataops sponsors delete deals <id> --yes [--expected-version N]
      Permanently delete a deal and its history, notes and Tasks (admin only). Refused with exit 5 when it
      has a booked newsletter slot, a deliverable or finance (invoice, payment, settlement); exit 4 = not found.
  dataops sponsors messages <organization-id>          Communications with an organization
  dataops sponsors history <deal-id>                   A deal's change history
  dataops sponsors cold [--days N] [--remind]          Orgs/contacts with no contact for N days (defaults per relationship stage)
  dataops sponsors touch <organization|contact> <id> --channel email [--note TEXT] [--date YYYY-MM-DD]
      Log an outreach and update lastOutbound, so the contact stops counting as cold
  dataops sponsors finance <deal-id> [history|candidates/invoices|candidates/payments]
  dataops sponsors clear-proposal-classification <deal-id> --data @correction.json [--apply]
      Correct an unaccepted open quote imported as debt. Required: reason,evidence.
      Refuses any invoice request, issued invoice, receipt/report or settlement; retains an audit snapshot.
  dataops sponsors follow-up <deal-id> [--date YYYY-MM-DD]  Queue the next finance action (classification, invoice, verification or payment)
      [--task ID | --review-existing]  Link an existing deal Task, or confirm review before adding separate work
  dataops sponsors attach-invoice <deal-id> --file original.pdf [--apply]
      Attach an original issued invoice through verified private storage; no payment is created.
  dataops sponsors approve-settlement <deal-id> --data @approval.json [--apply]
      Explicit owner-approved noncash reduction; creates no bookkeeping income.
      Required: amount,currency,reason,approvedBy,approvedOn,evidence. Optional replacesPaymentId.
      For a wrong imported nominal total: restoredInvoiceAmountDue + originalInvoiceDocumentId (already attached).
  dataops sponsors reverse-settlement <deal-id> --reason TEXT [--apply]
      Reverse the noncash adjustment; preserve its audit and all actual receipts.
  dataops sponsors attach-payment-evidence <deal-id> <transaction-id> [--apply]
      Link the reviewed invoice to an existing allocated receipt for bookkeeping and reports.
      New verified receipts include attached originals automatically; use this for late or repaired evidence.
  dataops sponsors receive-payment <deal-id> --data @receipt.json [--apply]
      Required: receivedOn, amount, currency, counterparty, reference (bank/account + unique transaction ID).
      Creates and links bookkeeping atomically. Optional: amountEur, category, replacesPaymentId.
      Link an existing ledger row instead of recreating it. Use --idempotency-key KEY for safe retries.
  dataops sponsors correct-payment <deal-id> <transaction-id> --data @receipt.json [--apply]
      Correct actual amount/date, optional amountEur/category; retain the original bank transaction reference.
      The nominal invoice stays unchanged. Missing replacement FX value is cleared when foreign cash changes.
  dataops sponsors link-payment <deal-id> <transaction-id> [--apply]
      Link a bookkeeping transaction to the deal as its payment. A payment the deal
      recorded before the row existed (same amount, within 14 days) is replaced by
      the link. Prints what it would do unless --apply is given.
  dataops sponsors record-thank-you <deal-id> --ref THREAD_REF [--label TEXT] [--date YYYY-MM-DD] [--apply]
      Idempotently record the drafted/sent payment-received thank-you email reference
      on the deal's Finance evidence (draft-only policy: Alexey reviews and sends).

Invoice drafts: use dataops invoices. To find invoice evidence for a sponsor deal,
use dataops sponsors finance <deal-id> candidates/invoices.

--data takes a JSON object, @file.json, or - for stdin. The API validates every field
exactly as it does for the web; a 400/422 names what is wrong. Use --json to see the
current record shape before writing one.

Examples
  dataops sponsors list deals --json | jq '.items[] | {id, status}'
  dataops sponsors update deals 1f2e... --data '{"status":"agreed","version":3}'
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
  const max = integer(args.limit, "limit") ?? Infinity;
  if (max <= 0) throw new UsageError("limit must be positive");
  const items = [];
  let cursor;
  let last;
  do {
    last = await api.get(`/api/sponsor-crm/${kind}`, { query: {
      cursor, limit: Math.min(100, max - items.length),
      organizationId: args.company || args.organizationId,
      search: args.search, status: args.status, active: args.active,
      dealId: args["deal-id"] || args.dealId,
      promotionSource: args.source || args["promotion-source"] || args.promotionSource,
      contentType: args["content-type"] || args.contentType,
      channel: args.channel,
    } });
    items.push(...itemsOf(last));
    cursor = last?.nextCursor;
  } while (cursor && items.length < max);
  const result = { kind, items: items.slice(0, max), nextCursor: cursor || null, complete: !cursor };
  if (args.json) return result;
  table(io, result.items, [
    ["ID", (item) => item.id],
    ["STATUS", (item) => item.status || item.stage || ""],
    ["NAME", label],
  ], `No ${kind}.`);
  return result;
}

/** Read exactly one bounded pipeline page, matching the web default. */
export async function pipeline(args, io) {
  const result = await apiFor(args).get('/api/sponsor-crm/pipeline', { query: {
    view: args.view || 'actionable', stage: args.stage, search: args.search,
    organizationId: args.company, owner: args.owner, sort: args.sort || 'next-action',
    nextActionFrom: args.nextActionFrom, nextActionBefore: args.nextActionBefore,
    limit: integer(args.limit, 'limit') ?? 30, cursor: args.cursor,
  } });
  if (!args.json) {
    table(io, result.items, [['COMPANY', (item) => item.organizationName], ['STAGE', (item) => item.stage],
      ['CONTACT', (item) => item.primaryContact?.name || ''], ['NEXT', (item) => item.replyReview && (!item.nextTask || item.nextTask.deferred) ? 'Review newer inbound (inferred)' : item.nextTask ? `${item.nextTask.deferred ? 'Deferred: ' : ''}${item.nextTask.description}` : ''],
      ['DUE', (item) => item.nextTask?.date || '']], 'No matching deals.');
    io.print(`${result.total} matches.${result.nextCursor ? ` Next: --cursor ${result.nextCursor}` : ''}`);
  }
  return result;
}

export async function contact(args, io) {
  const action = positional(args, 0, 'dataops sponsors contact <list|add|update> [ID] --company ID');
  const organizationId = optionalString(args, 'company');
  if (action === 'list') {
    if (!organizationId) throw new UsageError('--company is required');
    return list({ ...args, _: ['contacts'] }, io);
  }
  if (!['add', 'update'].includes(action)) throw new UsageError('contact expects list, add or update');
  const api = apiFor(args), data = jsonData(args);
  if (organizationId) data.organizationId = organizationId;
  const id = action === 'update' ? positional(args, 1, 'dataops sponsors contact update ID --data @person.json') : null;
  if (id && data.version === undefined) data.version = (await api.get(`/api/sponsor-crm/contacts/${enc(id)}`)).version;
  const result = id ? await api.put(`/api/sponsor-crm/contacts/${enc(id)}`, data) : await api.post('/api/sponsor-crm/contacts', data);
  if (!args.json) io.print(`${id ? 'Updated' : 'Created'} contact ${result.id}.`);
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

export async function remove(args, io) {
  const kind = kindOf(args);
  if (kind !== "deals") throw new UsageError("Permanent deletion is supported for deals only: dataops sponsors delete deals <id> --yes [--expected-version N]");
  const id = positional(args, 1, "dataops sponsors delete deals <id> --yes [--expected-version N]");
  if (args.yes !== true) throw new UsageError("Permanent deletion requires --yes. Read the deal before deleting it.");
  const expectedVersion = integer(optionalString(args, "expectedVersion"), "expected-version");
  if (expectedVersion !== undefined && !Number.isSafeInteger(expectedVersion)) throw new UsageError("expected-version must be a safe positive integer.");
  const result = await apiFor(args).delete(`/api/sponsor-crm/deals/${enc(id)}`, undefined, {
    query: { hard: "true", expectedVersion },
  });
  if (!args.json) io.print(`Deleted deal ${id}.`);
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

export async function cold(args, io) {
  const api = apiFor(args);
  const days = integer(args.days, "days");
  if (days !== undefined && days > 365) throw new UsageError("--days must be a whole number of days from 1 to 365.");
  const result = await api.get("/api/sponsor-crm/cold", { query: { ...(days !== undefined ? { days: String(days) } : {}) } });
  let reminded;
  if (args.remind) {
    reminded = await api.post("/api/sponsor-crm/cold/remind", { ...(days !== undefined ? { days } : {}) });
  }
  const output = reminded ? { ...result, reminded } : result;
  if (args.json) return output;
  table(io, result.items || [], [
    ["KIND", (item) => item.kind],
    ["NAME", (item) => item.name],
    ["REL", (item) => item.relationship],
    ["QUIET", (item) => item.daysSince === null ? "never" : `${item.daysSince}d`],
    ["LAST", (item) => String(item.lastInboundAt || item.lastOutboundAt || "—").slice(0, 10)],
    ["LIMIT", (item) => `${item.threshold}d`],
  ], "No cold contacts. Everyone has been talked to recently.");
  if (reminded) {
    for (const { organizationId, taskId } of reminded.created || []) {
      io.print(`Reminder Task ${taskId} for ${organizationId}.`);
    }
    for (const organizationId of reminded.skipped || []) {
      io.print(`Already reminded: ${organizationId} has an open cold-contact Task.`);
    }
  }
  return output;
}

export async function touch(args, io) {
  const usage = "dataops sponsors touch <organization|contact> <id> --channel email [--note TEXT] [--date YYYY-MM-DD]";
  const kind = positional(args, 0, usage);
  if (kind !== "organization" && kind !== "contact") throw new UsageError(`First argument must be "organization" or "contact". Usage: ${usage}`);
  const id = positional(args, 1, usage);
  const channel = optionalString(args, "channel");
  if (!channel) throw new UsageError("--channel is required: email, call, meeting, linkedin or other.");
  if (!["email", "call", "meeting", "linkedin", "other"].includes(channel)) {
    throw new UsageError("--channel must be one of: email, call, meeting, linkedin, other.");
  }
  const note = optionalString(args, "note");
  const date = isoDate(args.date, "date");
  const result = await apiFor(args).post("/api/sponsor-crm/touches", {
    targetType: kind,
    targetId: id,
    channel,
    ...(note !== undefined ? { note } : {}),
    ...(date !== undefined ? { touchedAt: date } : {}),
  });
  if (!args.json) io.print(`Logged ${channel} outreach to ${kind} ${id}.`);
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
  let afterProjection;
  if (args.apply) {
    const response = await api.post(`/api/sponsor-crm/deals/${enc(dealId)}/finance/payments`, body, {
      headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() },
    });
    afterProjection = response?.projection;
    result.paymentState = afterProjection?.paymentState;
    if (afterProjection) result.projection = afterProjection;
  }
  attachThankYouResult(result, {
    projection: afterProjection,
    beforeProjection: projection,
    fallbackPaymentState: args.apply ? undefined : "paid",
    dealTitle: deal?.title,
    amount: candidate.amount,
    currency: candidate.currency,
    receivedOn: candidate.effectiveDate,
  });
  if (!args.json) {
    io.print(`${result.mode}: link ${plan}${result.paymentState ? ` (deal is now ${result.paymentState})` : ""}`);
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

/**
 * Create the deal's payment follow-up Task in the main task pool. The Task is
 * ordinary work from here on: `dataops tasks` owns waiting, follow-ups and
 * resolution; this only writes the finance-side record once.
 */
export async function followUp(args, io) {
  const id = positional(args, 0, "dataops sponsors follow-up <deal-id> [--date YYYY-MM-DD]");
  const api = apiFor(args);
  const [deal, finance] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`),
    api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  const body = { dealVersion: deal.version, expectedVersion: finance.finance?.version || 0 };
  const date = isoDate(args.date, "date");
  if (date) body.date = date;
  if (args.task) body.existingTaskId = String(args.task);
  if (args.reviewExisting) body.reviewedOpenTasks = (finance.paymentFollowUp?.existingTasks || [])
    .map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id));
  const result = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/follow-up`, body, {
    headers: { "Idempotency-Key": randomUUID() },
  });
  if (!args.json) {
    const task = result.task || {};
    io.print(`${args.task ? "Linked existing" : "Created"} payment follow-up Task ${task.id} for deal ${id} (due ${task.date}).`);
    io.print(`Work it in the task pool: dataops tasks show ${task.id}`);
  }
  return result;
}

export async function attachInvoice(args, io) {
  const id = positional(args, 0, "dataops sponsors attach-invoice <deal-id> --file invoice.pdf [--apply]");
  if (!args.file) throw new UsageError("--file must name the original invoice PDF");
  const bytes = await readFile(String(args.file));
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new UsageError("The invoice must be a PDF");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance) throw new UsageError("Classify the invoice amount and currency first.");
  if (projection.invoice) throw new UsageError("An invoice original is already attached; review it before replacing evidence.");
  const result = { mode: args.apply ? "apply" : "dry-run", dealId: id, sha256, byteSize: bytes.length };
  if (args.apply) {
    const idempotencyKey = `sponsor-invoice-${sha256}`;
    let prepared = await api.post("/api/bookkeeping/documents/prepare", {
      sha256, byteSize: bytes.length, documentType: "invoice", idempotencyKey, sourceRef: `sponsor-deal:${id}`,
    });
    if (prepared.uploadUrl) {
      const upload = await fetch(prepared.uploadUrl, { method: "PUT", body: bytes, headers: prepared.uploadHeaders });
      if (!upload.ok) {
        const failure = (await upload.text()).slice(0, 8192);
        const code = failure.match(/<Code>([A-Za-z0-9_-]+)<\/Code>/)?.[1] || "UploadRejected";
        throw new Error(`Invoice upload failed (${upload.status}, ${code}); retry the same file`);
      }
      prepared = await api.post(`/api/bookkeeping/documents/${enc(prepared.document.id)}/complete`, { idempotencyKey });
    }
    let cursor, candidate;
    do {
      const page = await api.get(`/api/sponsor-crm/deals/${enc(id)}/finance/candidates/invoices`, { query: { limit: 50, cursor } });
      candidate = (page.items || []).find((item) => item.id === prepared.document.id);
      cursor = page.nextCursor;
    } while (!candidate && cursor);
    if (!candidate) throw new UsageError("Uploaded invoice is not an available candidate; check whether another deal already claims it.");
    const linked = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/invoice`, {
      dealVersion: deal.version, expectedVersion: projection.finance.version,
      sourceId: candidate.id, identityToken: candidate.identityToken,
    }, { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } });
    result.documentId = candidate.id;
    result.invoiceState = linked.projection?.invoiceState;
  }
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function approveSettlement(args, io) {
  const id = positional(args, 0, "dataops sponsors approve-settlement <deal-id> --data @approval.json [--apply]");
  const api = apiFor(args), data = jsonData(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance) throw new UsageError("An issued invoice and verified receipt are required.");
  const body = { ...data, dealVersion: deal.version, expectedVersion: projection.finance.version };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, noncashAdjustment: body };
  if (args.apply) result = { ...result, ...await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/settlement-adjustment`, body,
    { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } }) };
  attachThankYouResult(result, {
    projection: result.projection,
    beforeProjection: projection,
    fallbackPaymentState: args.apply ? undefined : "paid",
    dealTitle: deal?.title,
    amount: data.amount,
    currency: data.currency,
    receivedOn: data.approvedOn,
  });
  if (!args.json) {
    io.print(JSON.stringify(result, null, 2));
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

export async function clearProposalClassification(args, io) {
  const id = positional(args, 0, "dataops sponsors clear-proposal-classification <deal-id> --data @correction.json [--apply]");
  const api = apiFor(args), data = jsonData(args);
  if (!data.reason || !Array.isArray(data.evidence) || !data.evidence.length) throw new UsageError("reason and nonempty evidence are required.");
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (deal.status !== "open" || !projection.finance) throw new UsageError("Select an open proposal with an incorrect finance classification.");
  const body = { ...data, dealVersion: deal.version, expectedVersion: projection.finance.version };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, correction: body };
  if (args.apply) result = { ...result, ...await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/clear-proposal-classification`, body,
    { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } }) };
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function reverseSettlement(args, io) {
  const id = positional(args, 0, "dataops sponsors reverse-settlement <deal-id> --reason TEXT [--apply]");
  if (!args.reason) throw new UsageError("--reason must explain the approved adjustment reversal.");
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance?.settlementAdjustment) throw new UsageError("No active noncash adjustment exists.");
  const body = { reason: String(args.reason), dealVersion: deal.version, expectedVersion: projection.finance.version };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, reversal: body };
  if (args.apply) result = { ...result, ...await api.delete(`/api/sponsor-crm/deals/${enc(id)}/finance/settlement-adjustment`, body,
    { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } }) };
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function attachPaymentEvidence(args, io) {
  const id = positional(args, 0, "dataops sponsors attach-payment-evidence <deal-id> <transaction-id> [--apply]");
  const transactionId = positional(args, 1, "dataops sponsors attach-payment-evidence <deal-id> <transaction-id> [--apply]");
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance || !projection.invoice) throw new UsageError("Attach and review the correct invoice original first.");
  if (!(projection.payments || []).some((payment) => payment.source === "ledger" && payment.id === transactionId))
    throw new UsageError("Select a bookkeeping receipt already allocated to this deal.");
  const body = { dealVersion: deal.version, expectedVersion: projection.finance.version,
    documentId: projection.invoice.id, transactionIds: [transactionId] };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, documentId: body.documentId, transactionIds: body.transactionIds };
  if (args.apply) result = { ...result, ...await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/payment-evidence`, body,
    { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } }) };
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function receivePayment(args, io) {
  const id = positional(args, 0, "dataops sponsors receive-payment <deal-id> --data @receipt.json [--apply]");
  const api = apiFor(args), data = jsonData(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance) throw new UsageError("Classify and issue the invoice before recording a receipt.");
  const body = { ...data, dealVersion: deal.version, expectedVersion: projection.finance.version };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, receipt: body };
  if (args.apply) {
    const response = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/receipts`, body,
      { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } });
    result = { ...result, ...response };
    if (response?.projection?.paymentState && !result.paymentState) {
      result.paymentState = response.projection.paymentState;
    }
  }
  attachThankYouResult(result, {
    projection: result.projection,
    beforeProjection: projection,
    fallbackPaymentState: args.apply ? undefined : "paid",
    dealTitle: deal?.title,
    amount: data.amount,
    currency: data.currency,
    receivedOn: data.receivedOn,
  });
  if (!args.json) {
    io.print(JSON.stringify(result, null, 2));
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

export async function correctPayment(args, io) {
  const id = positional(args, 0, "dataops sponsors correct-payment <deal-id> <transaction-id> --data @receipt.json [--apply]");
  const sourceId = positional(args, 1, "dataops sponsors correct-payment <deal-id> <transaction-id> --data @receipt.json [--apply]");
  const api = apiFor(args), data = jsonData(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`), api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection.finance) throw new UsageError("No finance record exists.");
  const body = { ...data, dealVersion: deal.version, expectedVersion: projection.finance.version };
  let result = { mode: args.apply ? "apply" : "dry-run", dealId: id, transactionId: sourceId, correction: body };
  if (args.apply) {
    const response = await api.put(`/api/sponsor-crm/deals/${enc(id)}/finance/receipts/${enc(sourceId)}`, body,
      { headers: { "Idempotency-Key": args.idempotencyKey || randomUUID() } });
    result = { ...result, ...response };
    if (response?.projection?.paymentState && !result.paymentState) {
      result.paymentState = response.projection.paymentState;
    }
  }
  attachThankYouResult(result, {
    projection: result.projection,
    beforeProjection: projection,
    fallbackPaymentState: args.apply ? undefined : "paid",
    dealTitle: deal?.title,
    amount: data.amount,
    currency: data.currency,
    receivedOn: data.receivedOn,
  });
  if (!args.json) {
    io.print(JSON.stringify(result, null, 2));
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

export async function recordThankYou(args, io) {
  const usage = "dataops sponsors record-thank-you <deal-id> --ref THREAD_REF [--label TEXT] [--date YYYY-MM-DD] [--apply]";
  const id = positional(args, 0, usage);
  const ref = optionalString(args, "ref");
  if (!ref) throw new UsageError(`--ref is required. Usage: ${usage}`);
  const label = optionalString(args, "label") || THANK_YOU_EVIDENCE_LABEL;
  const on = isoDate(args.date, "date") || new Date().toISOString().slice(0, 10);
  const api = apiFor(args);
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(id)}`),
    api.get(`/api/sponsor-crm/deals/${enc(id)}/finance`),
  ]);
  if (!projection?.finance) throw new UsageError(`Deal ${id} has no finance record.`);
  const existingEvidence = Array.isArray(projection.finance.evidence) ? projection.finance.evidence : [];
  const existingThankYou = existingEvidence.find((item) => item.kind === "email" && item.ref === ref)
    || findThankYouEvidence(existingEvidence, projection.lastPaymentOn);
  const entry = existingThankYou || { kind: "email", ref, label, on };
  const nextEvidence = existingThankYou ? existingEvidence : [...existingEvidence, entry];
  let result = {
    mode: args.apply ? "apply" : "dry-run",
    dealId: id,
    alreadyRecorded: Boolean(existingThankYou),
    evidenceEntry: entry,
  };
  let afterProjection = projection;
  if (args.apply && !existingThankYou) {
    const response = await api.put(`/api/sponsor-crm/deals/${enc(id)}/finance/follow-through`, {
      dealVersion: deal.version,
      expectedVersion: projection.finance.version,
      evidence: nextEvidence,
    }, {
      headers: { "Idempotency-Key": args.idempotencyKey || `thank-you-${id}-${createHash("sha256").update(ref).digest("hex").slice(0, 24)}` },
    });
    result = { ...result, ...response };
    afterProjection = response?.projection || {
      ...projection,
      finance: { ...projection.finance, evidence: nextEvidence },
    };
  } else if (!existingThankYou) {
    afterProjection = {
      ...projection,
      finance: { ...projection.finance, evidence: nextEvidence },
    };
  }
  attachThankYouResult(result, {
    projection: afterProjection,
    beforeProjection: projection,
    fallbackPaymentState: afterProjection?.paymentState || "paid",
    dealTitle: deal?.title,
  });
  if (!args.json) {
    io.print(`${result.mode}: ${result.alreadyRecorded ? "thank-you email already recorded" : "record thank-you email draft/thread"} ${entry.ref}`);
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

export const commands = { pipeline, contact, list, show, create, update, delete: remove, messages, history, finance, cold, touch, "follow-up": followUp, "link-payment": linkPayment, "attach-invoice": attachInvoice, "receive-payment": receivePayment, "correct-payment": correctPayment, "attach-payment-evidence": attachPaymentEvidence, "approve-settlement": approveSettlement, "reverse-settlement": reverseSettlement, "clear-proposal-classification": clearProposalClassification, "record-thank-you": recordThankYou };
