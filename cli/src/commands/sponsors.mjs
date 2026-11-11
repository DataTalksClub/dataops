import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { UsageError } from "../errors.mjs";
import { ApiError } from "../api.mjs";
import { berlinToday, enc, fields, integer, isoDate, jsonData, optionalString, positional, required, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { classifyFinance, recordInvoice, correctInvoice, addEvidence, setWaiting, uploadInvoiceDocument } from "./sponsorFinance.mjs";
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
  dataops sponsors delete deals <id> --with-deliverables [--yes|--apply] [--expected-version N]
      Preview by default. With --yes or --apply, permanently delete the deal and all its deliverables,
      retaining an audit snapshot (admin only). Finance links are detached and their source records stay;
      newsletter issue slots stay booked without a deliverable link.
  dataops sponsors messages <organization-id>          Communications with an organization
  dataops sponsors history <deal-id>                   A deal's change history
  dataops sponsors cold [--days N] [--remind]          Orgs/contacts with no contact for N days (defaults per relationship stage)
  dataops sponsors touch <organization|contact> <id> --channel email [--note TEXT] [--date YYYY-MM-DD]
      Log an outreach and update lastOutbound, so the contact stops counting as cold
  dataops sponsors finance <deal-id> [history|candidates/invoices|candidates/payments]
  dataops sponsors classify-finance <deal-id> --data @classification.json [--apply]
      invoiceRequirement required|not-required; when required: amountDue, currency, taxMode.
      Optional taxAmount, requestBy, expectedInvoiceBy. Omitted existing fields are preserved.
  dataops sponsors record-invoice <deal-id> --data @invoice.json [--apply]
      Record an already issued invoice: invoiceNumber, issuedOn, dueOn, sentOn.
      Issue/due dates required on first recording. Omitted metadata stays unchanged;
      null clears optional invoiceNumber/sentOn. Does not generate a PDF or send email.
  dataops sponsors add-evidence <deal-id> --data @evidence.json [--apply]
      Add/update one {kind,ref,label?,on?}, preserving all unrelated evidence.
  dataops sponsors set-waiting <deal-id> --data @waiting.json [--apply]
      {party: us|sponsor, reason, since, note?}; --clear instead of --data clears it.
      These finance writes preview by default and send Idempotency-Key on --apply.
      --expected-version N and --deal-version N pin reviewed versions (0 allowed for new finance).
      For an exact retry use the same --idempotency-key, pinned versions and input.
  dataops sponsors payment-mail <list|poll|ingest|confirm|dismiss> [ID] [--status candidate|unmatched|already-paid|confirmed|dismissed] [--days N] [--data @mails.json] [--apply]
      Poll the existing Orin Gmail connection through Dapier, or ingest mails from an existing mailbox trigger.
      Mail notifications are stored idempotently by message ID and matched as review candidates; nothing is paid until Orin confirms.
  dataops sponsors clear-proposal-classification <deal-id> --data @correction.json [--apply]
      Correct an unaccepted open quote imported as debt. Required: reason,evidence.
      Refuses any invoice request, issued invoice, receipt/report or settlement; retains an audit snapshot.
  dataops sponsors follow-up <deal-id> [--date YYYY-MM-DD]  Queue the next finance action (classification, invoice, verification or payment)
      [--task ID | --review-existing]  Link an existing deal Task, or confirm review before adding separate work
  dataops sponsors attach-invoice <deal-id> --file original.pdf [--issued-on D --due-on D] [--apply]
      Attach an original issued invoice through verified private storage; no payment is created.
      Before uploading, record the issued invoice or supply its verified issue/due dates.
  dataops sponsors correct-invoice <deal-id> --data @correction.json [--file corrected.pdf] [--apply]
      Correct an issued invoice: required reason, corrected invoiceNumber/issuedOn/dueOn/sentOn
      (omitted metadata stays unchanged; null clears optional number/sent date), and optionally
      the corrected PDF issued in Finom's UI, which supersedes the linked original in one audited
      step. The original document is retained; nothing is generated or emailed.
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
      Use reference in JSON; statementRef is an internal ledger field, not a receipt input.
      Creates and links bookkeeping atomically. Optional: amountEur, category, replacesPaymentId.
      Link an existing ledger row instead of recreating it. Use --idempotency-key KEY for safe retries.
      On success prints the thank-you next step: send it from orin@ as a reply in the invoice
      thread using the template (no draft; template exists, so no Alexey approval needed).
  dataops sponsors correct-payment <deal-id> <transaction-id> --data @receipt.json [--apply]
      Correct actual amount/date, optional amountEur/category; retain the original bank transaction reference.
      The nominal invoice stays unchanged. Missing replacement FX value is cleared when foreign cash changes.
  dataops sponsors link-payment <deal-id> <transaction-id> [--apply]
      Link a bookkeeping transaction to the deal as its payment. A payment the deal
      recorded before the row existed (same amount, within 14 days) is replaced by
      the link. Prints what it would do unless --apply is given.
  dataops sponsors record-thank-you <deal-id> --ref THREAD_REF [--label TEXT] [--date YYYY-MM-DD] [--apply]
  dataops sponsors contract create --deal-id ID --data @terms.json
      Required terms fields: company, legalPayer, payerCountry (ISO two-letter), scope, priceEur,
      startDate, endDate. Optional: currency (EUR default), signingOrder (sponsor-first default or
      counter-first). Validates a minimum one month lead time before startDate.
  dataops sponsors contract send <contract-id> [--expires-days N]
      Mints expiring signing links, emails the sponsor signer from orin@datatalks.club and prints
      both links once (the counter-sign link is handed to DataTalks.Club staff, not emailed).
      resend mints fresh links for unsigned signers.
  dataops sponsors contract status <contract-id>
  dataops sponsors contract audit <contract-id>
      Per-event signing audit trail: sent, viewed, signed, declined, completed, with IP and agent.
  dataops sponsors contract verify <contract-id>
      Recomputes the SHA-256 of the stored signed PDF and compares it with the stored hash.
      Idempotently record the sent payment-received thank-you email reference
      on the deal's Finance evidence (sent from orin@ as a reply in the invoice thread, no draft;
      template exists, so no Alexey approval needed).

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
  if (kind !== "deals") throw new UsageError("Permanent deletion is supported for deals only: dataops sponsors delete deals <id> --with-deliverables [--yes|--apply]");
  const id = positional(args, 1, "dataops sponsors delete deals <id> --with-deliverables [--yes|--apply]");
  if (args.withDeliverables !== true) throw new UsageError("Pass --with-deliverables to allow deletion of deal deliverables.");
  const expectedVersion = integer(optionalString(args, "expectedVersion"), "expected-version");
  if (expectedVersion !== undefined && !Number.isSafeInteger(expectedVersion)) throw new UsageError("expected-version must be a safe positive integer.");
  const apply = args.yes === true || args.apply === true;
  const result = await apiFor(args).post(`/api/sponsor-crm/deals/${enc(id)}/delete`, {
    withDeliverables: true,
    ...(apply ? { apply: true } : {}),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });
  if (!args.json) {
    if (apply) io.print(`Deleted deal ${id}; audit snapshot retained.`);
    else io.print(`Dry run: deal ${id} can be deleted with ${result.deletedDeliverableIds?.length || 0} deliverable(s); ` +
      `finance links to ${result.detachedFinanceSourceIds?.length || 0} source(s) will be detached; ` +
      `${result.retainedNewsletterSlotIds?.length || 0} newsletter slot(s) will remain booked. Add --yes to apply.`);
  }
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
  let result;
  try {
    result = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/follow-up`, body, {
      headers: { "Idempotency-Key": randomUUID() },
    });
  } catch (error) {
    // The finance endpoint returns the existing Task on a duplicate conflict;
    // rereading versions cannot make a second open follow-up valid.
    if (error instanceof ApiError && error.status === 409 && typeof error.body?.taskId === "string" && error.body.taskId) {
      throw new ApiError(error.status, {
        ...error.body,
        error: `An open payment follow-up Task already exists for this deal: ${error.body.taskId}. Work it in the task pool: dataops tasks show ${error.body.taskId}`,
      }, error.url);
    }
    throw error;
  }
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
  if (projection.finance.invoiceRequirement === "not-required") throw new UsageError("This deal is classified as invoice not required; review its classification before uploading.");
  if (projection.invoice) throw new UsageError("An invoice original is already attached; replace it with sponsors correct-invoice.");
  const issuedOn = isoDate(args.issuedOn, "issued-on"), dueOn = isoDate(args.dueOn, "due-on");
  if (Boolean(issuedOn) !== Boolean(dueOn)) throw new UsageError("Supply both --issued-on and --due-on");
  if (issuedOn && dueOn < issuedOn) throw new UsageError("Invoice due date must not precede its issue date");
  if (!projection.finance.issuedOn && !issuedOn) throw new UsageError("Record the issued invoice with sponsors record-invoice first, or supply verified --issued-on and --due-on; nothing was uploaded.");
  const invoiceDates = issuedOn ? { issuedOn, dueOn } : {};
  const result = { mode: args.apply ? "apply" : "dry-run", dealId: id, sha256, byteSize: bytes.length, ...invoiceDates };
  if (args.apply) {
    const { candidate } = await uploadInvoiceDocument(api, id, bytes, sha256);
    const linked = await api.post(`/api/sponsor-crm/deals/${enc(id)}/finance/invoice`, {
      dealVersion: deal.version, expectedVersion: projection.finance.version,
      sourceId: candidate.id, identityToken: candidate.identityToken,
      ...invoiceDates,
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
  if (Object.hasOwn(data, "statementRef")) throw new UsageError("Use reference in receipt JSON; statementRef is an internal ledger field.");
  if (typeof data.reference !== "string" || !data.reference.trim()) throw new UsageError("Receipt reference is required (bank/account + unique transaction ID).");
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
  const on = isoDate(args.date, "date") || berlinToday();
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

export async function contract(args, io) {
  const action = positional(args, 0, "dataops sponsors contract <create|send|resend|status|audit|verify> [contract-id]");
  const api = apiFor(args);
  if (action === "create") {
    const dealId = required(args, "dealId", "deal-id");
    const terms = jsonData(args);
    const result = await api.post("/api/sponsor-crm/contracts", { dealId, terms });
    if (!args.json) {
      io.print("Created contract " + result.id + " for deal " + dealId + " (status " + result.status + ").");
      fields(io, [[
        ["id", result.id],
        ["status", result.status],
        ["signing order", result.terms?.signingOrder],
        ["start", result.terms?.startDate],
        ["fee", result.terms ? result.terms.priceEur + " " + result.terms.currency : undefined],
        ["signers", (result.signers || []).map((s) => s.role + ":" + s.email).join(", ")],
      ]]);
    }
    return result;
  }
  const id = positional(args, 1, "dataops sponsors contract " + action + " <contract-id>");
  if (action === "send" || action === "resend") {
    const body = {};
    const days = optionalString(args, "expiresDays");
    if (days !== undefined) {
      body.expiresDays = Number(days);
      if (!Number.isInteger(body.expiresDays) || body.expiresDays < 1 || body.expiresDays > 60) throw new UsageError("--expires-days must be a whole number from 1 to 60.");
    }
    const result = await api.post("/api/sponsor-crm/contracts/" + enc(id) + "/" + action, body);
    if (!args.json) {
      const delivery = result.emailDelivery || {};
      io.print("Contract " + id + ": " + (result.contract?.status || "sent") + ". Email " + (delivery.state || "unknown") + (delivery.reason ? " (" + delivery.reason + ")" : "") + (delivery.to ? " to " + delivery.to : "") + ".");
      const urls = result.signingUrls || {};
      if (urls.sponsor) io.print("Sponsor link: " + urls.sponsor);
      if (urls.counter) io.print("Counter-sign link: " + urls.counter);
      if (delivery.state && delivery.state !== "sent" && delivery.message) io.print(delivery.message);
    }
    return result;
  }
  if (action === "status") {
    const result = await api.get("/api/sponsor-crm/contracts/" + enc(id));
    if (!args.json) {
      fields(io, [[
        ["id", result.id],
        ["status", result.status],
        ["deal", result.dealId],
        ["signing order", result.terms?.signingOrder],
        ["signed pdf sha256", result.signedPdf?.sha256],
        ["signers", (result.signers || []).map((s) => s.role + ":" + s.email + (s.signedAt ? " signed " + s.signedAt : s.viewedAt ? " viewed" : "")).join(", ")],
        ["updated", result.updatedAt],
      ]]);
    }
    return result;
  }
  if (action === "audit") {
    const result = await api.get("/api/sponsor-crm/contracts/" + enc(id) + "/audit");
    if (!args.json) {
      table(io, result.items || [], [[
        ["at", (item) => item.createdAt || ""],
        ["action", (item) => item.action || ""],
        ["role", (item) => item.role || ""],
        ["detail", (item) => item.detail || ""],
        ["ip", (item) => item.ip || ""],
      ]], "No audit events yet.");
    }
    return result;
  }
  if (action === "verify") {
    const result = await api.post("/api/sponsor-crm/contracts/" + enc(id) + "/verify");
    if (!args.json) {
      io.print(result.intact ? "Contract " + id + ": signed PDF intact (sha256 " + result.expected + ")." : "Contract " + id + ": TAMPER DETECTED (stored " + result.expected + ", actual " + result.actual + ").");
    }
    return result;
  }
  throw new UsageError("Unknown contract action: " + action + ". Use create, send, resend, status, audit or verify.");
}

export async function paymentMail(args, io) {
  const usage = "dataops sponsors payment-mail <list|poll|ingest|confirm|dismiss> [ID]";
  const action = positional(args, 0, usage);
  if (!["list", "poll", "ingest", "confirm", "dismiss"].includes(action)) throw new UsageError(usage);
  const api = apiFor(args);
  const base = "/api/sponsor-crm/finance/payment-mail";
  const show = (candidate) => io.print(`${candidate.id}  ${candidate.status.padEnd(12)} ${candidate.provider}  ${candidate.receivedOn}  ${candidate.invoiceNumber ? `#${candidate.invoiceNumber}` : "(no invoice no.)"}  ${candidate.amount || "?"} ${candidate.currency || ""}  ${candidate.payer || ""}${candidate.match ? `  -> ${candidate.match.organizationName} (deal ${candidate.match.dealId}, ${candidate.match.confidence}: ${candidate.match.reasons.join("+")})` : ""}`);

  if (action === "list") {
    const status = optionalString(args, "status");
    const result = await api.get(base, { query: status ? { status } : {} });
    if (!args.json) {
      for (const candidate of result.items || []) show(candidate);
      if (!(result.items || []).length) io.print("No payment mail candidates.");
    }
    return result;
  }
  if (action === "poll") {
    const days = integer(args.days, "days");
    if (days !== undefined && days > 60) throw new UsageError("--days must be from 1 to 60.");
    const result = await api.post(`${base}/poll`, days !== undefined ? { days } : {});
    if (!args.json) io.print(result.state === "ok"
      ? `Scanned ${result.scanned} mails: ${result.results.filter((item) => item.outcome === "created").length} new, ${result.results.filter((item) => item.outcome === "duplicate").length} already seen, ${result.results.filter((item) => item.outcome === "ignored").length} ignored.`
      : `Deferred (${result.reason}): ${result.message}`);
    return result;
  }
  if (action === "ingest") {
    const data = jsonData(args);
    const result = await api.post(`${base}/ingest`, Array.isArray(data) ? { mails: data } : data);
    if (!args.json) for (const item of result.results || []) io.print(`${item.outcome}  ${item.messageId}${item.candidate ? `  ${item.candidate.id} ${item.candidate.status}` : ""}`);
    return result;
  }

  const id = positional(args, 1, usage);
  if (action === "dismiss") {
    const result = await api.post(`${base}/${enc(id)}/dismissed`, {});
    if (!args.json) io.print(`dismissed ${id}`);
    return result;
  }
  const candidate = await api.get(`${base}/${enc(id)}`);
  if (candidate.status !== "candidate" || !candidate.match?.dealId) {
    throw new UsageError(`Candidate ${id} is ${candidate.status}; only a matched candidate can be confirmed.`);
  }
  if (!candidate.amount || !candidate.currency) {
    throw new UsageError(`Candidate ${id} has no parsed amount/currency; record it with receive-payment by hand.`);
  }
  const dealId = candidate.match.dealId;
  const [deal, projection] = await Promise.all([
    api.get(`/api/sponsor-crm/deals/${enc(dealId)}`),
    api.get(`/api/sponsor-crm/deals/${enc(dealId)}/finance`),
  ]);
  if (!projection?.finance) throw new UsageError(`Deal ${dealId} has no finance record.`);
  const body = {
    dealVersion: deal.version, expectedVersion: projection.finance.version,
    receivedOn: candidate.receivedOn, amount: candidate.amount, currency: candidate.currency,
    counterparty: candidate.payer || candidate.match.organizationName,
    reference: `mail:${candidate.provider}:${candidate.invoiceNumber || candidate.id}`.slice(0, 200),
  };
  let result = { mode: args.apply ? "apply" : "dry-run", candidateId: id, dealId, plan: `${body.receivedOn} ${body.amount} ${body.currency} from ${body.counterparty}` };
  if (args.apply) {
    const response = await api.post(`/api/sponsor-crm/deals/${enc(dealId)}/finance/receipts`, body, {
      headers: { "Idempotency-Key": `pmail-${id}`.slice(0, 128).padEnd(16, "0") },
    });
    await api.post(`${base}/${enc(id)}/confirmed`, {});
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
    invoiceNumber: candidate.invoiceNumber,
    amount: candidate.amount,
    currency: candidate.currency,
    receivedOn: candidate.receivedOn,
  });
  if (!args.json) {
    io.print(`${result.mode}: receive ${result.plan}${result.paymentState ? ` (deal is now ${result.paymentState})` : ""}`);
    printThankYouHint(io, result.thankYou);
  }
  return result;
}

export const commands = { "classify-finance": classifyFinance, "record-invoice": recordInvoice, "correct-invoice": correctInvoice, "add-evidence": addEvidence, "set-waiting": setWaiting, "payment-mail": paymentMail, pipeline, contact, list, show, create, update, delete: remove, messages, history, finance, cold, touch, "follow-up": followUp, "link-payment": linkPayment, "attach-invoice": attachInvoice, "receive-payment": receivePayment, "correct-payment": correctPayment, "attach-payment-evidence": attachPaymentEvidence, "approve-settlement": approveSettlement, "reverse-settlement": reverseSettlement, "clear-proposal-classification": clearProposalClassification, "record-thank-you": recordThankYou, contract };
