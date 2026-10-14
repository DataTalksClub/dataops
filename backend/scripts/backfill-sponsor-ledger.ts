#!/usr/bin/env node
/**
 * One-off sponsor CRM + finance backfill from a private evidence ledger.
 *
 * Inputs stay outside this repository:
 *   --ledger      sponsor-ledger.json (sponsors -> deals -> invoice, payments, evidence)
 *   --snapshot    crm-snapshot.json   (companies, people, leads, mail activity)
 *   --bookkeeping optional bookkeeping table dump, to verify ledger payment rows offline
 *   --existing    optional sponsor CRM table dump, to diff against what is already stored
 *
 * Dry run is the default: it plans every API call, validates it against the
 * same rules the API applies, prints counts and writes nothing anywhere
 * except an optional private --summary-out file.
 *
 * --write sends the plan through the ordinary API (CRM import in batches,
 * then per-deal finance actions with deterministic idempotency keys). It
 * requires DATAOPS_OPERATOR_SESSION_TOKEN for an admin, an exact
 * --confirm-origin, and SPONSOR_FINANCE_ENABLED on the target.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const PRODUCTION_ORIGIN = 'https://ops.dtcdev.click';
const GRACE = '00000000-0000-0000-0000-000000000001';
const ALEXEY = '00000000-0000-0000-0000-000000000003';
const IMPORT_BATCH = 150;
const FEE_TOLERANCE = 0.02;
const CHANNELS = new Set(['main', 'secondary', 'standalone', 'social', 'podcast', 'webinar', 'workshop', 'course', 'other']);
const PAYMENT_METHODS: Record<string, string> = {
  'bank-report': 'bank-report', 'sponsor-confirmation': 'sponsor-confirmation', processor: 'processor',
};
const WAITING_REASONS = new Set(['billing-details', 'payment-details', 'payment-link', 'vendor-onboarding', 'purchase-order', 'approval', 'invoice', 'other']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Json = Record<string, any>;
type LedgerPayment = { receivedOn: string; amount: string; currency: string; source: string; bookkeepingId?: string | null; ledgerRef?: string | null; note?: string };
type LedgerDeal = Json & {
  key: string; title: string; kind: string; productKind: string; status: 'open' | 'agreed' | 'lost';
  agreementDate: string | null; deliverables: Json[]; amount: string | null; currency: string; amountEur: number | null;
  taxMode: string; invoice: Json; payments: LedgerPayment[]; paymentStatus: string; waitingOn: Json | null;
  nextAction: string | null; evidence: Json[];
};
type Ledger = { asOf: string; sponsors: Array<Json & { key: string; displayName: string; domain: string | null; deals: LedgerDeal[] }> };

export type FinanceStep =
  | { op: 'classify'; body: Json }
  | { op: 'issue'; body: Json; inferred: boolean }
  | { op: 'link-payment'; bookkeepingId: string; amount: string; receivedOn: string }
  | { op: 'record-payment'; body: Json }
  | { op: 'follow-through'; body: Json };

export type DealPlan = {
  sponsor: string; dealKey: string; dealId: string; title: string; status: string; paymentStatus: string;
  steps: FinanceStep[]; issues: string[];
};

export type BackfillPlan = {
  importBatches: Json[];
  counts: Record<string, number>;
  deals: DealPlan[];
  issues: string[];
};

export const deterministicCrmId = (kind: string, sourceKey: string) =>
  createHash('sha256').update(`${kind}:${sourceKey}`).digest('hex');
const idempotency = (dealKey: string, op: string) => `bf-${createHash('sha256').update(`${dealKey}:${op}`).digest('hex').slice(0, 40)}`;
const money = (value: number) => {
  const fixed = value.toFixed(4).replace(/\.?0+$/, '');
  return fixed === '' ? '0' : fixed;
};
const registrable = (value: string | null | undefined) => {
  if (!value) return null;
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return host.includes('.') ? host : null;
};

function nextActionFor(deal: LedgerDeal, asOf: string) {
  const settled = ['paid', 'no-invoice-needed', 'void'].includes(deal.paymentStatus);
  const delivered = deal.deliverables.every((item) => item.delivered !== false);
  if (deal.status === 'lost' || (settled && delivered)) return undefined;
  const type = deal.status === 'open' ? 'follow_up'
    : deal.paymentStatus === 'overdue' ? 'chase_payment'
      : deal.paymentStatus === 'not-invoiced' ? 'send_invoice'
        : 'follow_up';
  const due = deal.paymentStatus === 'invoiced-not-due' && DATE.test(String(deal.invoice?.dueOn)) ? deal.invoice.dueOn
    : !delivered ? (deal.deliverables.map((item) => item.date).filter((date) => DATE.test(String(date)) && date >= asOf).sort()[0] || asOf)
      : asOf;
  return {
    type,
    due,
    owner: deal.status === 'open' ? ALEXEY : GRACE,
    note: String(deal.nextAction || 'Backfilled from the sponsor ledger').slice(0, 500),
  };
}

function evidenceFor(deal: LedgerDeal, extra: Json[]): Json[] {
  const items: Json[] = [...extra];
  for (const entry of deal.evidence || []) {
    if (items.length >= 20) break;
    const on = String(entry.date || '').slice(0, 10);
    const label = String(entry.what || entry.subject || entry.kind || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    if (entry.kind === 'email' || entry.kind === 'accountant-report') {
      if (!entry.threadId && !entry.messageId) continue;
      items.push({
        kind: 'email',
        ref: `gmail:${entry.account || 'unknown'}:${entry.threadId ? `thread/${entry.threadId}` : `message/${entry.messageId}`}`.slice(0, 300),
        ...(label ? { label } : {}),
        ...(DATE.test(on) ? { on } : {}),
      });
    } else if (entry.kind === 'ledger' && (entry.bookkeepingId || entry.ref)) {
      items.push({ kind: 'ledger', ref: String(entry.bookkeepingId || entry.ref).slice(0, 300), ...(entry.ref ? { label: String(entry.ref).slice(0, 160) } : {}) });
    } else if (entry.kind === 'document' && (entry.bookkeepingDocumentId || entry.ref)) {
      items.push({ kind: 'document', ref: String(entry.bookkeepingDocumentId || entry.ref).slice(0, 300), ...(entry.ref ? { label: String(entry.ref).slice(0, 160) } : {}) });
    }
  }
  return items.slice(0, 20);
}

function financePlan(deal: LedgerDeal, bookkeeping: Map<string, Json> | null, asOf: string): { steps: FinanceStep[]; issues: string[] } {
  const steps: FinanceStep[] = [];
  const issues: string[] = [];
  if (deal.status === 'lost') return { steps, issues };
  const invoice = deal.invoice || {};
  if (invoice.required === false) {
    steps.push({ op: 'classify', body: { invoiceRequirement: 'not-required' } });
    if (deal.payments.length) issues.push(`${deal.payments.length} payout(s) stay ledger-only: not-required deals carry no payments`);
  } else {
    if (deal.amount === null || deal.amount === undefined) {
      issues.push('amount unknown: left unclassified (queue shows "Record deal finance")');
      return { steps, issues };
    }
    const received = deal.payments.reduce((sum, item) => sum + Number(item.amount), 0);
    let amountDue = Number(deal.amount);
    const extraEvidence: Json[] = [];
    if (received > amountDue + 1e-9) {
      issues.push(`payments ${money(received)} exceed amount ${deal.amount}: amount raised to received total`);
      amountDue = received;
    } else if (['paid'].includes(deal.paymentStatus) && received < amountDue && (amountDue - received) / amountDue <= FEE_TOLERANCE) {
      extraEvidence.push({ kind: 'note', ref: `Invoiced ${deal.amount} ${deal.currency}; received ${money(received)} after fees`.slice(0, 300) });
      issues.push(`fee shortfall ${money(amountDue - received)} ${deal.currency}: amount due set to received total`);
      amountDue = received;
    }
    const taxMode = ['unknown', 'included', 'added', 'not-applicable'].includes(deal.taxMode) ? deal.taxMode : 'unknown';
    steps.push({ op: 'classify', body: { invoiceRequirement: 'required', amountDue: money(amountDue), currency: deal.currency, taxMode } });
    const firstPayment = deal.payments.map((item) => item.receivedOn).filter((date) => DATE.test(date)).sort()[0];
    let issuedOn = DATE.test(String(invoice.issuedOn)) ? invoice.issuedOn : DATE.test(String(invoice.sentOn)) ? invoice.sentOn : undefined;
    let inferred = false;
    if (!issuedOn && firstPayment) {
      issuedOn = firstPayment;
      inferred = true;
      extraEvidence.push({ kind: 'note', ref: 'Issue and due dates inferred from the first payment' });
    }
    if (issuedOn) {
      let dueOn = DATE.test(String(invoice.dueOn)) ? invoice.dueOn : inferred ? issuedOn : undefined;
      if (!dueOn) {
        const due = new Date(`${issuedOn}T00:00:00Z`);
        due.setUTCDate(due.getUTCDate() + 30);
        dueOn = due.toISOString().slice(0, 10);
        extraEvidence.push({ kind: 'note', ref: 'Due date assumed 30 days after issue' });
      }
      if (dueOn < issuedOn) dueOn = issuedOn;
      const sentOn = DATE.test(String(invoice.sentOn)) && invoice.sentOn >= issuedOn ? invoice.sentOn : undefined;
      const number = typeof invoice.number === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ./_#-]{0,63}$/.test(invoice.number) ? invoice.number : undefined;
      steps.push({ op: 'issue', inferred, body: { ...(number ? { invoiceNumber: number } : {}), issuedOn, dueOn, ...(sentOn ? { sentOn } : {}) } });
      for (const payment of deal.payments) {
        if (payment.currency !== deal.currency) {
          issues.push(`payment ${payment.receivedOn} in ${payment.currency} differs from deal currency ${deal.currency}: skipped`);
          continue;
        }
        if (payment.source === 'ledger' && payment.bookkeepingId) {
          const row = bookkeeping?.get(payment.bookkeepingId);
          if (bookkeeping && (!row || row.currency !== payment.currency || Number(row.amount) !== Number(payment.amount))) {
            issues.push(`ledger row ${payment.bookkeepingId.slice(0, 12)} missing or different in bookkeeping: skipped`);
            continue;
          }
          steps.push({ op: 'link-payment', bookkeepingId: payment.bookkeepingId, amount: payment.amount, receivedOn: payment.receivedOn });
        } else {
          const method = PAYMENT_METHODS[payment.source] || 'other';
          steps.push({
            op: 'record-payment',
            body: {
              receivedOn: payment.receivedOn, amount: money(Number(payment.amount)), currency: payment.currency, method,
              reference: String(payment.note || payment.ledgerRef || payment.source).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || payment.source,
            },
          });
        }
      }
    } else if (deal.payments.length) {
      issues.push('payments without any issue date: skipped');
    }
    const followThrough: Json = {};
    const waiting = deal.waitingOn;
    if (waiting && ['us', 'sponsor'].includes(waiting.party) && DATE.test(String(waiting.since))) {
      followThrough.waitingOn = {
        party: waiting.party,
        reason: WAITING_REASONS.has(waiting.reason) ? waiting.reason : 'other',
        since: waiting.since,
        ...(waiting.note ? { note: String(waiting.note).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) } : {}),
      };
    }
    const evidence = evidenceFor(deal, extraEvidence);
    if (evidence.length) followThrough.evidence = evidence;
    if (Object.keys(followThrough).length && deal.paymentStatus !== 'paid') steps.push({ op: 'follow-through', body: followThrough });
    else if (evidence.length) steps.push({ op: 'follow-through', body: { evidence } });
  }
  void asOf;
  return { steps, issues };
}

export function planBackfill(input: {
  ledger: Ledger; snapshot: Json; bookkeeping?: Json[] | null; existing?: Json[] | null; since?: string;
}): BackfillPlan {
  const { ledger, snapshot } = input;
  const asOf = ledger.asOf;
  const since = input.since || '0000-01-01';
  const issues: string[] = [];
  const bookkeeping = input.bookkeeping
    ? new Map(input.bookkeeping.filter((item) => String(item.PK || '').startsWith('BOOKKEEPING#')).map((item) => [String(item.id), item]))
    : null;
  const existingKeys = new Set((input.existing || []).map((item) => String(item.PK)));

  const companies = new Map<string, Json>();
  for (const company of snapshot.companies || []) {
    const domain = registrable(company.domain);
    companies.set(domain || `name:${String(company.displayName).toLowerCase()}`, company);
  }
  for (const sponsor of ledger.sponsors) {
    const domain = registrable(sponsor.domain);
    if (!domain) { issues.push(`sponsor ${sponsor.key} has no domain`); continue; }
    if (!companies.has(domain)) companies.set(domain, { domain, displayName: sponsor.displayName, relevancy: 'high', sourceKey: `ledger-sponsor:${sponsor.key}` });
  }

  const deals: Json[] = [];
  const dealPlans: DealPlan[] = [];
  for (const sponsor of ledger.sponsors) {
    const domain = registrable(sponsor.domain);
    if (!domain) continue;
    for (const deal of sponsor.deals) {
      const touches = [deal.agreementDate, deal.invoice?.issuedOn, ...deal.payments.map((item) => item.receivedOn), ...deal.deliverables.map((item) => item.date)]
        .some((date) => typeof date === 'string' && date >= since);
      if (input.since && !touches) continue;
      const sourceKey = `ledger-deal:${deal.key}`;
      const nextAction = nextActionFor(deal, asOf);
      deals.push({
        organizationDomain: domain,
        title: String(deal.title || deal.key).slice(0, 200),
        status: deal.status,
        productKind: ['one-off', 'package', 'course'].includes(deal.productKind) ? deal.productKind : 'one-off',
        ...(typeof deal.amountEur === 'number' ? { amountEur: deal.amountEur } : {}),
        ...(DATE.test(String(deal.agreementDate)) ? { agreementDate: deal.agreementDate } : {}),
        ...(nextAction ? { nextAction } : {}),
        sourceKey,
        deliverables: deal.deliverables.map((item, index) => {
          const channel = CHANNELS.has(item.channel) ? item.channel : 'other';
          const date = DATE.test(String(item.date)) ? item.date : undefined;
          return {
            channel,
            ...(date ? { plannedPublicationDate: date } : {}),
            ...(date && item.delivered === true ? { publishedAt: `${date}T12:00:00Z` } : {}),
            ...(item.cardId && ID.test(item.cardId) ? { cardId: item.cardId } : {}),
            ...(item.newsletterSlotId && ID.test(item.newsletterSlotId) ? { scheduleEntryId: item.newsletterSlotId } : {}),
            sourceKey: `${sourceKey}:deliverable:${index}`,
          };
        }),
      });
      const { steps, issues: dealIssues } = financePlan(deal, bookkeeping, asOf);
      const dealId = deterministicCrmId('deal', sourceKey);
      if (existingKeys.has(`SPONSOR_FINANCE#${dealId}`)) dealIssues.push('finance already exists in the target: steps re-checked at write time');
      dealPlans.push({
        sponsor: sponsor.displayName, dealKey: deal.key, dealId, title: deal.title, status: deal.status,
        paymentStatus: deal.paymentStatus, steps, issues: dealIssues,
      });
    }
  }

  const companyList = [...companies.values()];
  const people = (snapshot.people || []).filter((person: Json) => person.email && person.name && person.organizationDomain);
  const leads = snapshot.leads || [];
  const activity = (snapshot.activity || []).filter((entry: Json) => entry.threadId && entry.organizationDomain);
  const chunk = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / IMPORT_BATCH) }, (_, index) => items.slice(index * IMPORT_BATCH, (index + 1) * IMPORT_BATCH));
  const importBatches: Json[] = [
    ...chunk(companyList).map((companiesBatch) => ({ companies: companiesBatch })),
    ...chunk(people).map((peopleBatch) => ({ people: peopleBatch })),
    ...chunk(deals).map((dealsBatch) => ({ deals: dealsBatch })),
    ...chunk(leads).map((leadsBatch) => ({ leads: leadsBatch })),
    ...chunk(activity).map((activityBatch) => ({ activity: activityBatch })),
  ];
  const existingOrganizations = (input.existing || []).filter((item) => String(item.PK).startsWith('ORGANIZATION#')).length;
  const stepCount = (op: FinanceStep['op']) => dealPlans.reduce((sum, plan) => sum + plan.steps.filter((step) => step.op === op).length, 0);
  return {
    importBatches,
    deals: dealPlans,
    issues,
    counts: {
      existingRecords: (input.existing || []).length,
      existingOrganizations,
      companies: companyList.length,
      people: people.length,
      deals: deals.length,
      deliverables: deals.reduce((sum, deal) => sum + deal.deliverables.length, 0),
      leads: leads.length,
      activity: activity.length,
      importRequests: importBatches.length,
      classify: stepCount('classify'),
      issue: stepCount('issue'),
      issueDatesInferred: dealPlans.reduce((sum, plan) => sum + plan.steps.filter((step) => step.op === 'issue' && step.inferred).length, 0),
      linkLedgerPayments: stepCount('link-payment'),
      recordPayments: stepCount('record-payment'),
      followThrough: stepCount('follow-through'),
      dealsWithIssues: dealPlans.filter((plan) => plan.issues.length).length,
    },
  };
}

type Args = {
  ledger?: string; snapshot?: string; bookkeeping?: string; existing?: string; summaryOut?: string;
  since?: string; origin: string; confirmOrigin?: string; write: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { origin: PRODUCTION_ORIGIN, write: false };
  const flags: Record<string, keyof Args> = {
    '--ledger': 'ledger', '--snapshot': 'snapshot', '--bookkeeping': 'bookkeeping', '--existing': 'existing',
    '--summary-out': 'summaryOut', '--since': 'since', '--api-base-url': 'origin', '--confirm-origin': 'confirmOrigin',
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--write') { args.write = true; continue; }
    const name = flags[flag];
    const value = argv[index + 1];
    if (!name || !value) throw new Error(`Unknown or incomplete argument: ${flag}`);
    (args as Json)[name] = ['origin', 'confirmOrigin', 'since'].includes(name) ? value.replace(/\/$/, '') : path.resolve(value);
    index++;
  }
  if (!args.ledger || !args.snapshot) throw new Error('--ledger and --snapshot are required');
  return args;
}

async function api(origin: string, token: string, method: string, route: string, body?: unknown, idempotencyKey?: string) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Json = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
  return { status: response.status, body: parsed };
}

async function findLedgerCandidate(origin: string, token: string, dealId: string, sourceId: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
    const result = await api(origin, token, 'GET', `/api/sponsor-crm/deals/${dealId}/finance/candidates/payments?${query}`);
    if (result.status !== 200) return null;
    const found = (result.body.items || []).find((item: Json) => item.id === sourceId);
    if (found) return found;
    cursor = result.body.nextCursor || undefined;
    if (!cursor) return null;
  }
  return null;
}

async function applyDeal(origin: string, token: string, plan: DealPlan, log: string[]) {
  const finance = (await api(origin, token, 'GET', `/api/sponsor-crm/deals/${plan.dealId}/finance`)).body;
  const deal = (await api(origin, token, 'GET', `/api/sponsor-crm/deals/${plan.dealId}`)).body;
  if (!deal.version) { log.push(`${plan.dealKey}: deal missing after import`); return; }
  let version: number | undefined = finance.finance?.version;
  const haveLedger = new Set((finance.payments || []).filter((item: Json) => item.source === 'ledger').map((item: Json) => item.id));
  const haveRecorded = new Set((finance.payments || []).filter((item: Json) => item.source === 'recorded')
    .map((item: Json) => `${item.effectiveDate}:${item.amount}`));
  for (const step of plan.steps) {
    const base = { dealVersion: deal.version, ...(version !== undefined ? { expectedVersion: version } : {}) };
    let result: { status: number; body: Json } | null = null;
    if (step.op === 'classify') {
      if (finance.classified) continue;
      result = await api(origin, token, 'PUT', `/api/sponsor-crm/deals/${plan.dealId}/finance`, { ...base, ...step.body }, idempotency(plan.dealKey, 'classify'));
    } else if (step.op === 'issue') {
      if (finance.finance?.issuedOn) continue;
      result = await api(origin, token, 'POST', `/api/sponsor-crm/deals/${plan.dealId}/finance/issue`, { ...base, ...step.body }, idempotency(plan.dealKey, 'issue'));
    } else if (step.op === 'link-payment') {
      if (haveLedger.has(step.bookkeepingId)) continue;
      const candidate = await findLedgerCandidate(origin, token, plan.dealId, step.bookkeepingId);
      if (!candidate) { log.push(`${plan.dealKey}: ledger row ${step.bookkeepingId.slice(0, 12)} not linkable`); continue; }
      result = await api(origin, token, 'POST', `/api/sponsor-crm/deals/${plan.dealId}/finance/payments`, {
        ...base, sourceId: step.bookkeepingId, identityToken: candidate.identityToken,
      }, idempotency(plan.dealKey, `link:${step.bookkeepingId}`));
    } else if (step.op === 'record-payment') {
      if (haveRecorded.has(`${step.body.receivedOn}:${step.body.amount}`)) continue;
      result = await api(origin, token, 'POST', `/api/sponsor-crm/deals/${plan.dealId}/finance/recorded-payments`, { ...base, ...step.body },
        idempotency(plan.dealKey, `record:${step.body.receivedOn}:${step.body.amount}`));
    } else if (step.op === 'follow-through') {
      result = await api(origin, token, 'PUT', `/api/sponsor-crm/deals/${plan.dealId}/finance/follow-through`, { ...base, ...step.body },
        idempotency(plan.dealKey, `follow:${version}`));
    }
    if (!result) continue;
    if (result.status !== 200) { log.push(`${plan.dealKey}: ${step.op} -> ${result.status} ${result.body.error || ''}`); return; }
    version = result.body.projection?.finance?.version ?? result.body.result?.financeVersion;
  }
}

function summarize(plan: BackfillPlan): string {
  const lines = ['# Sponsor ledger backfill plan', '', '## Counts', ''];
  for (const [name, value] of Object.entries(plan.counts)) lines.push(`- ${name}: ${value}`);
  lines.push('', '## Deals', '', '| Sponsor | Deal | Status | Finance steps | Issues |', '|---|---|---|---|---|');
  for (const deal of plan.deals) {
    const steps = deal.steps.map((step) => step.op === 'issue' && step.inferred ? 'issue*' : step.op).join(', ') || '-';
    lines.push(`| ${deal.sponsor} | ${deal.dealKey} | ${deal.status}/${deal.paymentStatus} | ${steps} | ${deal.issues.join('; ') || ''} |`);
  }
  if (plan.issues.length) lines.push('', '## Plan issues', '', ...plan.issues.map((issue) => `- ${issue}`));
  lines.push('', '`issue*` = issue and due dates inferred from the first payment.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const read = async (file?: string) => file ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
  const plan = planBackfill({
    ledger: await read(args.ledger), snapshot: await read(args.snapshot),
    bookkeeping: await read(args.bookkeeping), existing: await read(args.existing), since: args.since,
  });
  if (args.summaryOut) await fs.writeFile(args.summaryOut, summarize(plan), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ mode: args.write ? 'write' : 'dry-run', counts: plan.counts, planIssues: plan.issues.length }, null, 2)}\n`);
  if (!args.write) return;
  if (args.confirmOrigin !== args.origin) throw new Error('--confirm-origin must equal the target origin');
  const token = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;
  if (!token) throw new Error('DATAOPS_OPERATOR_SESSION_TOKEN is required for --write');
  const log: string[] = [];
  for (const [index, batch] of plan.importBatches.entries()) {
    const result = await api(args.origin, token, 'POST', '/api/sponsor-crm/imports', batch);
    if (result.status !== 200) throw new Error(`import batch ${index} failed: ${result.status} ${result.body.error || ''}`);
  }
  for (const deal of plan.deals) await applyDeal(args.origin, token, deal, log);
  process.stdout.write(`${JSON.stringify({ applied: plan.deals.length, problems: log }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { process.stderr.write(`${(error as Error).message}\n`); process.exit(1); });
}
