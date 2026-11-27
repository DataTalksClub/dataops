/**
 * The deal's invoice action: once a sponsor deal is agreed and needs an
 * invoice, exactly one open Task saying "issue and send the invoice" sits in
 * the main queue (Active) until the invoice has actually been sent.
 *
 * The Task is the canonical cardless Task (`sponsor-deal` subject), so it uses
 * the regular queue, assignee and proof rules. This module only decides
 * whether the deal owes one, keeps its description current with the billing
 * prerequisites, and resolves it when the invoice is sent or no longer owed.
 * It never issues, sends or emails anything.
 *
 * One per deal, across retries, concurrent writes, every invoice-requiring
 * deliverable and Tasks people created by hand: a claim row
 * (`SPONSOR_INVOICE_TASK#<dealId>`) is written in the same transaction that
 * creates the Task, or that adopts the deal's existing open invoice Task, and
 * the write is conditional on the claim not existing yet.
 */
import { GetCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';

import { getCrmRecord } from '../db/sponsorCrm';
import { getTaskConsistent, updateTask } from '../db/tasks';
import { TABLE_SPONSOR_CRM, TABLE_TASKS } from '../db/tableNames';
import { makeTaskHistoryEvent } from '../routes/taskValidation';
import { berlinDate, digest, INVOICE_TASK_SOURCE, INVOICE_TASK_TAG } from './core';
import { dealProjectionContext, deliveredOn } from './context';
import { resolveDealOwnerId } from './finomPaidTask';
import { PAYMENT_FOLLOW_UP_TAG } from './paymentFollowUp';
import { financeEnabled, getFinanceState, projectFinance, type ProjectionContext } from './repository';
import type { FinanceProjection, FinanceState } from './types';
import type { Task } from '../types';

export { INVOICE_TASK_SOURCE, INVOICE_TASK_TAG };
export const INVOICE_TASK_ACTOR = 'system:sponsor-invoice';
export const INVOICE_TASK_INSTRUCTION_DOC_ID = 'sop.finance.bookkeeping.creating-invoices-in-finom';
const OPEN = new Set(['todo', 'waiting']);

export const invoiceTaskClaimKey = (dealId: string) => `SPONSOR_INVOICE_TASK#${dealId}`;
export const invoiceTaskId = (dealId: string) => `finance-invoice-${digest({ dealId, action: 'invoice' }).slice(0, 32)}`;

export const isInvoiceTask = (task: Pick<Task, 'source' | 'tags'>) =>
  task.source === INVOICE_TASK_SOURCE || Boolean(task.tags?.includes(INVOICE_TASK_TAG));

/**
 * An open hand-made deal Task that already asks for the invoice. Payment and
 * Finom follow-through Tasks are about money after the invoice; they are not it.
 */
export function isManualInvoiceTask(task: Pick<Task, 'description' | 'source' | 'tags'>): boolean {
  const text = String(task.description || '');
  if (task.tags?.includes('finom-invoice-paid') || /paid in finom/i.test(text)) return false;
  if (task.source === 'sponsor-finance' || task.tags?.includes(PAYMENT_FOLLOW_UP_TAG)) {
    // Payment follow-ups created for the invoice step ask for the invoice itself.
    return /^(Verify or send the invoice|Record invoice amount)/.test(text);
  }
  // The Task must ask for the invoice itself ("Issue and send the … invoice"),
  // not for something around it ("await … invoice instructions").
  return /\b(issue|send|create|prepare|raise|draft|make)\b.{0,60}\binvoice\b|(выставить|отправить|сделать).{0,60}(инвойс|сч[её]т)/i.test(text)
    && !/\bpayment\b|\bpaid\b|reminder/i.test(text);
}

export type InvoiceTaskDecision =
  | { kind: 'owed'; date: string; description: string }
  | { kind: 'sent'; note: string }
  | { kind: 'not-owed'; reason: string }
  /** Issued (or otherwise past the point of creation): never open new work, keep what exists. */
  | { kind: 'leave'; description?: string };

type DealFacts = Record<string, unknown>;

function money(amount?: string | number, currency?: string): string {
  if (amount === undefined || amount === '') return '';
  return currency ? `${amount} ${currency}` : String(amount);
}

/** The prerequisites the invoice still depends on, kept apart from payment. */
export function billingPrerequisites(state: FinanceState | null, projection: FinanceProjection, deal: DealFacts): string[] {
  const items: string[] = [];
  if (!state) {
    const value = typeof deal.amountEur === 'number' ? ` (deal value ${deal.amountEur} EUR)` : '';
    items.push(`invoice terms not recorded — record amount, currency and tax mode in Finance${value}`);
  } else {
    const tax = state.taxMode && state.taxMode !== 'unknown' ? `, tax ${state.taxMode}` : ', tax mode unknown';
    items.push(`amount ${money(state.amountDue, state.currency)}${tax}`);
  }
  const waiting = state?.waitingOn;
  if (waiting?.party === 'sponsor') {
    items.push(`waiting on sponsor for ${waiting.reason.replace(/-/g, ' ')} since ${waiting.since}${waiting.note ? ` (${waiting.note.slice(0, 80)})` : ''}`);
  } else if (waiting?.party === 'us') {
    items.push(`blocked on us: ${waiting.reason.replace(/-/g, ' ')} since ${waiting.since}${waiting.note ? ` (${waiting.note.slice(0, 80)})` : ''}`);
  } else if (state) {
    items.push(state.evidence?.length
      ? `billing details: no open blocker, ${state.evidence.length} evidence item${state.evidence.length === 1 ? '' : 's'} on file`
      : 'billing details: no open blocker recorded');
  }
  if (projection.vat?.blocking) items.push(`VAT ID blocks the invoice: ${projection.vat.blocking.message}`);
  else if (projection.vat?.check?.status === 'valid') items.push(`VAT ID ${projection.vat.vatId || ''} verified`.replace(/\s+/g, ' '));
  else if (projection.vat?.warning) items.push(`VAT ID: ${projection.vat.warning.message}`);
  else if (projection.vat?.required) items.push('VAT ID not verified yet');
  const deadline = [state?.requestBy, state?.expectedInvoiceBy].filter(Boolean).sort()[0];
  if (deadline) items.push(`invoice due by ${deadline}`);
  if (state?.invoiceRequestedAt) items.push(`invoice requested ${state.invoiceRequestedAt.slice(0, 10)}`);
  return items;
}

/** What the Task says: the action, the deal, the billing prerequisites, and that payment is separate. */
export function invoiceTaskDescription(input: {
  organizationName: string; dealTitle?: string; issued?: { invoiceNumber?: string; issuedOn?: string };
  prerequisites: string[];
}): string {
  const subject = input.dealTitle ? `${input.organizationName} — ${input.dealTitle}` : input.organizationName;
  const action = input.issued
    ? `Send the issued invoice${input.issued.invoiceNumber ? ` ${input.issued.invoiceNumber}` : ''} for`
    : 'Issue and send the invoice for';
  const prerequisites = input.prerequisites.length ? ` Billing prerequisites: ${input.prerequisites.join('; ')}.` : '';
  return `${action} ${subject}.${prerequisites} Payment is tracked separately once the invoice is sent.`.slice(0, 700);
}

/**
 * Whether the deal owes the invoice action right now. Only an agreed, live
 * deal whose invoice is required (or not classified yet) and not yet issued
 * gets one; an issued-but-unsent invoice keeps the existing Task open.
 */
export function decideInvoiceTask(input: {
  deal: DealFacts | null; state: FinanceState | null; projection: FinanceProjection | null;
  organizationName: string; chasedOn?: string; today: string;
}): InvoiceTaskDecision {
  const { deal, state, projection } = input;
  if (!deal || deal.archivedAt || deal.active === false) return { kind: 'not-owed', reason: 'The deal was archived' };
  if (deal.status === 'lost') return { kind: 'not-owed', reason: 'The deal was lost' };
  if (state?.voidedAt) return { kind: 'not-owed', reason: 'The deal\'s finance record was voided' };
  if (state?.invoiceRequirement === 'not-required') return { kind: 'not-owed', reason: 'The deal does not need an invoice' };
  // Before Finance classifies the deal, a recorded deal value is what says an invoice is owed.
  if (!state && !(typeof deal.amountEur === 'number' && deal.amountEur > 0)) return { kind: 'not-owed', reason: 'The deal has no invoiceable amount' };
  if (state?.issuedOn && (state.sentOn || input.chasedOn)) {
    return { kind: 'sent', note: `Invoice ${state.invoiceNumber || ''} sent ${state.sentOn || `(sponsor chased ${input.chasedOn})`}; payment is tracked in Finance.`.replace(/\s+/g, ' ') };
  }
  if (projection?.paymentState === 'paid') return { kind: 'sent', note: 'The invoice is paid; payment is tracked in Finance.' };
  if (deal.status !== 'agreed') return { kind: 'leave' };
  if (!projection) return { kind: 'leave' };
  const description = invoiceTaskDescription({
    organizationName: input.organizationName,
    ...(typeof deal.title === 'string' && deal.title ? { dealTitle: deal.title } : {}),
    ...(state?.issuedOn ? { issued: { ...(state.invoiceNumber ? { invoiceNumber: state.invoiceNumber } : {}), issuedOn: state.issuedOn } } : {}),
    prerequisites: billingPrerequisites(state, projection, deal),
  });
  if (state?.issuedOn) return { kind: 'leave', description };
  // Due today, so it is in Active now; only an invoice date Finance scheduled later
  // (request-by / expected-by, with nothing owed yet) parks it until then.
  const deadline = [state?.requestBy, state?.expectedInvoiceBy].filter((value): value is string => Boolean(value)).sort()[0];
  const later = projection.followUp.code === 'invoice-later' && deadline && deadline > input.today;
  return { kind: 'owed', date: later ? deadline : input.today, description };
}

export type InvoiceTaskOutcome = 'created' | 'adopted' | 'updated' | 'unchanged' | 'resolved' | 'skipped' | 'none';

async function readClaim(client: DynamoDBDocumentClient, dealId: string): Promise<string | undefined> {
  const key = invoiceTaskClaimKey(dealId);
  const item = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: key, SK: key }, ConsistentRead: true }))).Item;
  return typeof item?.taskId === 'string' ? item.taskId : undefined;
}

const conditionFailed = (error: unknown) => {
  const name = (error as Error)?.name || '';
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
};

/**
 * Bring the deal's invoice action in line with its finance state. Idempotent:
 * safe to run after every deal or finance write and from the daily sweep.
 * `tasks` lets the sweep pass the deal's open Tasks it already read.
 */
export async function syncDealInvoiceTask(
  client: DynamoDBDocumentClient,
  dealId: string,
  options: { actorId?: string; today?: string; tasks?: Task[]; context?: ProjectionContext } = {},
): Promise<{ outcome: InvoiceTaskOutcome; taskId?: string }> {
  if (!financeEnabled()) return { outcome: 'none' };
  const today = options.today || berlinDate();
  const deal = await getCrmRecord(client, 'deal', dealId);
  const state = await getFinanceState(client, dealId);
  const context = options.context || await dealProjectionContext(client, dealId);
  const live = Boolean(deal && !deal.archivedAt && deal.active !== false);
  const projection = live ? await projectFinance(client, dealId, 'operator', { ...context, today }) : null;
  const organization = deal?.organizationId ? await getCrmRecord(client, 'organization', String(deal.organizationId)) : null;
  const decision = decideInvoiceTask({
    deal, state, projection, today,
    organizationName: String(organization?.displayName || organization?.name || 'Sponsor'),
    ...(context.chasedOn ? { chasedOn: context.chasedOn } : {}),
  });
  const claimed = await readClaim(client, dealId);
  if (claimed) return reconcileClaimedTask(client, claimed, decision);
  if (decision.kind !== 'owed') return { outcome: 'none' };

  const open = (options.tasks || (await openDealTasks(client, dealId)).get(dealId) || [])
    .filter((task) => task.subject?.type === 'sponsor-deal' && task.subject.id === dealId && OPEN.has(String(task.status)));
  const adopt = open.find(isInvoiceTask)
    || open.filter(isManualInvoiceTask).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id))[0];
  const now = new Date().toISOString();
  const claimKey = invoiceTaskClaimKey(dealId);
  const taskId = adopt?.id || invoiceTaskId(dealId);
  const claim = { Put: {
    TableName: TABLE_SPONSOR_CRM,
    Item: { PK: claimKey, SK: claimKey, recordType: 'sponsor-invoice-task-claim', dealId, taskId, createdAt: now },
    ConditionExpression: 'attribute_not_exists(PK)',
  } };
  try {
    if (adopt) {
      // Adopt the open hand-made Task: it becomes the canonical action, pulled into
      // Active if it was parked in the future; its original wording stays in history.
      const date = String(adopt.date || '') > today && adopt.status === 'todo' ? decision.date : adopt.date;
      const tags = [...new Set([...(adopt.tags || []), INVOICE_TASK_TAG])];
      const event = makeTaskHistoryEvent('noted', adopt, {
        actorId: INVOICE_TASK_ACTOR,
        note: `Linked as the deal's invoice action${date !== adopt.date ? `; moved from ${adopt.date} to ${date}` : ''}. Previous description: ${adopt.description}`.slice(0, 1000),
      });
      await client.send(new TransactWriteCommand({ TransactItems: [claim, { Update: {
        TableName: TABLE_TASKS, Key: { PK: `TASK#${adopt.id}`, SK: `TASK#${adopt.id}` },
        UpdateExpression: 'SET tags = :tags, description = :description, #date = :date, #version = :next, updatedAt = :now, taskHistory = list_append(if_not_exists(taskHistory, :empty), :event)'
          + (adopt.instructionDocId ? '' : ', instructionDocId = :doc'),
        ConditionExpression: '#version = :version AND (#status = :todo OR #status = :waiting)',
        ExpressionAttributeNames: { '#version': 'version', '#status': 'status', '#date': 'date' },
        ExpressionAttributeValues: {
          ':tags': tags, ':description': decision.description, ':date': date, ':next': adopt.version + 1, ':version': adopt.version,
          ':now': now, ':event': [event], ':empty': [], ':todo': 'todo', ':waiting': 'waiting',
          ...(adopt.instructionDocId ? {} : { ':doc': INVOICE_TASK_INSTRUCTION_DOC_ID }),
        },
      } }] }));
      return { outcome: 'adopted', taskId };
    }
    const assigneeId = await resolveDealOwnerId(client, dealId, options.actorId || INVOICE_TASK_ACTOR);
    const item = {
      PK: `TASK#${taskId}`, SK: `TASK#${taskId}`, id: taskId, version: 1,
      description: decision.description,
      date: decision.date,
      status: 'todo',
      source: INVOICE_TASK_SOURCE,
      tags: [INVOICE_TASK_TAG],
      subject: { type: 'sponsor-deal', id: dealId },
      instructionDocId: INVOICE_TASK_INSTRUCTION_DOC_ID,
      proofRequirement: { type: 'comment', required: true, label: 'Invoice number and the date it was sent' },
      ...(assigneeId && !assigneeId.startsWith('system:') ? { assigneeId } : {}),
      createdBy: options.actorId || INVOICE_TASK_ACTOR,
      taskHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    await client.send(new TransactWriteCommand({ TransactItems: [claim, {
      Put: { TableName: TABLE_TASKS, Item: item, ConditionExpression: 'attribute_not_exists(PK)' },
    }] }));
    return { outcome: 'created', taskId };
  } catch (error) {
    if (!conditionFailed(error)) throw error;
    // A concurrent run claimed the deal (or the adopted Task moved): reconcile with what won.
    const winner = await readClaim(client, dealId);
    if (winner) return reconcileClaimedTask(client, winner, decision);
    throw error;
  }
}

async function reconcileClaimedTask(
  client: DynamoDBDocumentClient,
  taskId: string,
  decision: InvoiceTaskDecision,
): Promise<{ outcome: InvoiceTaskOutcome; taskId?: string }> {
  const task = await getTaskConsistent(client, taskId);
  // A resolved or deleted action is never reopened: people closed it on purpose.
  if (!task || !OPEN.has(String(task.status))) return { outcome: 'none', taskId };
  if (decision.kind === 'sent' || decision.kind === 'not-owed') {
    const done = decision.kind === 'sent';
    const now = new Date().toISOString();
    const note = done ? decision.note : decision.reason;
    await updateTask(client, task.id, {
      currentTask: task,
      expectedVersion: task.version,
      patch: done
        ? { status: 'done', completedAt: now, completedBy: INVOICE_TASK_ACTOR, comment: note }
        : { status: 'skipped', skippedAt: now, skippedBy: INVOICE_TASK_ACTOR, skipReason: note },
      historyEvents: [makeTaskHistoryEvent(done ? 'completed' : 'skipped', task, { actorId: INVOICE_TASK_ACTOR, note })],
      actorId: INVOICE_TASK_ACTOR,
      triggerKind: done ? 'task-completed' : 'task-skipped',
    });
    return { outcome: done ? 'resolved' : 'skipped', taskId };
  }
  const description = decision.description;
  if (!description || description === task.description) return { outcome: 'unchanged', taskId };
  await updateTask(client, task.id, {
    currentTask: task,
    expectedVersion: task.version,
    patch: { description },
    actorId: INVOICE_TASK_ACTOR,
  });
  return { outcome: 'updated', taskId };
}

/** Run the sync after a committed write; the write already succeeded, so a sync failure only logs (the daily sweep retries). */
export async function syncDealInvoiceTaskAfterWrite(
  client: DynamoDBDocumentClient,
  dealId: string,
  actorId?: string,
): Promise<void> {
  try {
    await syncDealInvoiceTask(client, dealId, { ...(actorId ? { actorId } : {}) });
  } catch (error) {
    console.error(`Invoice action sync failed for deal ${dealId}: ${(error as Error)?.message || 'unknown error'}`);
  }
}

/** How far back the daily sweep retries a confirmation whose post-write sync did not land. */
export const INVOICE_TASK_SWEEP_DAYS = 14;

/**
 * Daily backstop: retry recent confirmations and keep every claimed action in
 * line (refresh prerequisites, resolve once sent). Older deals catch up on
 * their next deal or finance write, so a deploy never floods Active with backlog.
 */
export async function sweepInvoiceTasks(
  client: DynamoDBDocumentClient,
  input: {
    deals: Record<string, unknown>[];
    deliverables: Record<string, unknown>[];
    chased: Map<string, string>;
    today: string;
  },
): Promise<{ invoiceTasksCreated: number; invoiceTasksAdopted: number; invoiceTasksResolved: number; invoiceTaskFailures: number }> {
  const counts = { invoiceTasksCreated: 0, invoiceTasksAdopted: 0, invoiceTasksResolved: 0, invoiceTaskFailures: 0 };
  if (!financeEnabled()) return counts;
  const claimed = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    // Eventually consistent: claims are written by earlier sweeps, not this
    // one, and each sync re-reads its claim consistently before writing.
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'SPONSOR_INVOICE_TASK#' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) claimed.add(String(item.dealId));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const since = shiftDate(input.today, -INVOICE_TASK_SWEEP_DAYS);
  const recent = (deal: Record<string, unknown>) => deal.status === 'agreed' && !deal.archivedAt && deal.active !== false
    && [deal.agreementDate, String(deal.updatedAt || '').slice(0, 10)].some((date) => typeof date === 'string' && date >= since);
  const due = input.deals.filter((deal) => claimed.has(String(deal.id)) || recent(deal));
  if (!due.length) return counts;
  const openByDeal = await openDealTasks(client);
  for (const deal of due) {
    const dealId = String(deal.id);
    const delivered = deliveredOn(input.deliverables.filter((item) => item.dealId === dealId));
    try {
      const { outcome } = await syncDealInvoiceTask(client, dealId, {
        today: input.today,
        tasks: openByDeal.get(dealId) || [],
        context: {
          dealStatus: String(deal.status),
          ...(delivered ? { deliveredOn: delivered } : {}),
          ...(input.chased.has(dealId) ? { chasedOn: input.chased.get(dealId) } : {}),
        },
      });
      if (outcome === 'created') counts.invoiceTasksCreated++;
      if (outcome === 'adopted') counts.invoiceTasksAdopted++;
      if (outcome === 'resolved' || outcome === 'skipped') counts.invoiceTasksResolved++;
    } catch (error) {
      counts.invoiceTaskFailures++;
      console.error(`Invoice action sweep failed for deal ${dealId}: ${(error as Error)?.message || 'unknown error'}`);
    }
  }
  return counts;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Open Tasks about sponsor deals (or one deal), grouped by deal, in one filtered
 * scan. Unlike the capped review scan, it reads the whole Tasks table: missing a
 * hand-made invoice Task would mean a duplicate, and it runs once per deal.
 */
async function openDealTasks(client: DynamoDBDocumentClient, dealId?: string): Promise<Map<string, Task[]>> {
  const byDeal = new Map<string, Task[]>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_TASKS, ConsistentRead: true,
      FilterExpression: `subject.#type = :deal AND (#status = :todo OR #status = :waiting)${dealId ? ' AND subject.#id = :id' : ''}`,
      ExpressionAttributeNames: { '#type': 'type', '#status': 'status', ...(dealId ? { '#id': 'id' } : {}) },
      ExpressionAttributeValues: { ':deal': 'sponsor-deal', ':todo': 'todo', ':waiting': 'waiting', ...(dealId ? { ':id': dealId } : {}) },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) {
      const task = item as unknown as Task;
      const dealId = String(task.subject?.id || '');
      byDeal.set(dealId, [...(byDeal.get(dealId) || []), task]);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return byDeal;
}
