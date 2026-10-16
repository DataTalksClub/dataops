/**
 * Payment chasing: the one piece of sponsor finance that becomes actionable
 * work in the main task pool.
 *
 * A chase is an ordinary Task with a `sponsor-deal` subject — the canonical
 * cardless Task shape — so it appears in the regular queue with the regular
 * filters, assignee rules, waiting lifecycle, and proof semantics. This module
 * only decides *whether* the money is chaseable, *what* the Task says, and
 * keeps `FinanceState.chaseTaskIds` as the finance-side record of the chases
 * it created; every later update (waiting, follow-ups, resolution) goes
 * through the ordinary Task routes, which this module never bypasses.
 */
import { randomUUID } from 'crypto';
import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { usesLocalTransactionEmulation } from '../db/client';
import { getCrmRecord } from '../db/sponsorCrm';
import { getTask } from '../db/tasks';
import { TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_TASKS, TABLE_USERS } from '../db/tableNames';
import {
  berlinDate,
  displayMoney,
  financeKey,
  realDate,
  scaledMoney,
  sourceKey,
} from './core';
import { daysBetween, deriveFollowUp, deriveStates } from './followUp';
import {
  adminCheck,
  dealCheck,
  executeMutation,
  financeMutationTail,
  getFinanceState,
  replayMutation,
  safeConflict,
} from './repository';
import type {
  ChaseTaskView,
  FinanceProjection,
  FinanceState,
  FollowUp,
  InvoiceState,
  PaymentState,
  RecordedPayment,
  TimingState,
} from './types';
import type { Task } from '../types';

const singleton = (key: string) => ({ PK: key, SK: key });
const nowIso = () => new Date().toISOString();
const OPEN_STATUSES = new Set(['todo', 'waiting']);

export const CHASE_SOURCE = 'sponsor-finance';
export const CHASE_TAG = 'payment-chase';

/** The facts a chase decision is made from, derived with the canonical derivation code. */
export type ChaseDecision = {
  invoiceState: InvoiceState;
  paymentState: PaymentState;
  timingState: TimingState;
  followUp: FollowUp;
  coherent: boolean;
  outstanding?: string;
  daysOverdue?: number;
};

/**
 * Why the money is not chaseable yet, or null when it is. Only an issued,
 * overdue, unsettled, coherent invoice whose next step is ours to take may be
 * chased — the same conditions that derive the `chase-payment` next step.
 */
export function chaseBlocker(decision: ChaseDecision): string | null {
  if (decision.followUp.code === 'chase-payment') return null;
  if (decision.paymentState === 'paid') return 'Payment is already settled';
  if (!decision.coherent) return 'Payment evidence must be reconciled before chasing';
  if (decision.followUp.code === 'unblock') return 'The sponsor is waiting on us; unblock first';
  if (decision.invoiceState !== 'issued') return 'The invoice has not been issued yet';
  if (decision.timingState !== 'overdue') return 'The invoice is not overdue yet';
  return 'The money is not in a state that needs chasing';
}

/**
 * Derive the chase decision from the stored finance state with plain reads.
 * This mirrors the portfolio ledger's per-deal coherence (sources present,
 * currency matching, total not over the amount due) and uses the same
 * `deriveStates`/`deriveFollowUp` code as every other view, so the decision
 * matches the ledger `chase` row that asked for the chase in the first place.
 * The deal projection remains the authoritative deep check (claim identities);
 * a mismatch surfaces there as `reconciliation-required` and the cron alert.
 */
export async function deriveChaseDecision(
  client: DynamoDBDocumentClient,
  state: FinanceState,
  dealStatus: string,
  today: string,
): Promise<ChaseDecision> {
  let coherent = true;
  let total = 0n;
  for (const linkId of state.paymentLinkIds) {
    const sourceId = linkId.split('#').at(-1)!;
    const found = await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING, Key: singleton(sourceKey('transaction', sourceId)),
    }));
    const source = found.Item as Record<string, unknown> | undefined;
    if (!source || source.currency !== state.currency) { coherent = false; continue; }
    try { total += scaledMoney(String(source.amount)); } catch { coherent = false; }
  }
  for (const id of state.recordedPaymentIds || []) {
    const found = await client.send(new GetCommand({
      TableName: TABLE_SPONSOR_CRM, Key: singleton(id),
    }));
    const record = found.Item as RecordedPayment | undefined;
    if (!record || record.currency !== state.currency) { coherent = false; continue; }
    try { total += scaledMoney(record.amount); } catch { coherent = false; }
  }
  const due = state.amountDue ? scaledMoney(state.amountDue) : undefined;
  if (due !== undefined && total > due) coherent = false;
  const states = deriveStates(state, total, due, coherent, today);
  const followUp = deriveFollowUp({
    dealStatus,
    ...states,
    requestBy: state.invoiceRequestedAt ? undefined : state.requestBy,
    expectedInvoiceBy: state.expectedInvoiceBy,
    dueOn: state.dueOn,
    waitingOn: state.waitingOn,
  }, today);
  return {
    ...states,
    followUp,
    coherent,
    ...(due !== undefined && coherent ? { outstanding: displayMoney(due - total) } : {}),
    ...(states.timingState === 'overdue' && state.dueOn ? { daysOverdue: daysBetween(state.dueOn, today) } : {}),
  };
}

/** The Task's due date: the day the chase should happen. */
function chaseDate(value: unknown, today: string): string {
  if (value === undefined) return today;
  if (typeof value !== 'string' || !realDate(value)) {
    throw Object.assign(new Error('date must be a YYYY-MM-DD date'), { statusCode: 400 });
  }
  return value;
}

/** What the chase Task says: the sponsor, the deal, the invoice facts, and the verification rule. */
export function chaseTaskDescription(input: {
  organizationName: string;
  dealTitle?: string;
  invoiceNumber?: string;
  amountDue?: string;
  outstanding?: string;
  currency?: string;
  dueOn?: string;
  daysOverdue?: number;
}): string {
  const subject = input.dealTitle ? `${input.organizationName} — ${input.dealTitle}` : input.organizationName;
  const facts: string[] = [];
  if (input.invoiceNumber) facts.push(`invoice ${input.invoiceNumber}`);
  if (input.outstanding && input.currency) {
    facts.push(`${input.outstanding} ${input.currency} outstanding`);
    if (input.amountDue && input.amountDue !== input.outstanding) facts.push(`${input.amountDue} ${input.currency} invoiced (partially paid)`);
  } else if (input.amountDue && input.currency) {
    facts.push(`${input.amountDue} ${input.currency} invoiced`);
  }
  if (input.dueOn) {
    facts.push(input.daysOverdue !== undefined && input.daysOverdue > 0
      ? `was due ${input.dueOn} (${input.daysOverdue} days ago)`
      : `due ${input.dueOn}`);
  }
  const detail = facts.length ? ` ${facts.join(', ')}.` : '';
  return `Chase payment from ${subject}.${detail} Check the linked payment evidence and the ledger for anything already received before chasing — record what you verified and the outcome before resolving this Task.`.slice(0, 500);
}

/** Open chase Tasks recorded on the finance state, earliest first. */
export async function openChaseTasks(client: DynamoDBDocumentClient, state: FinanceState): Promise<Task[]> {
  const found = await Promise.all((state.chaseTaskIds || []).map((id) => getTask(client, id)));
  return found
    .filter((task): task is Task => Boolean(task) && OPEN_STATUSES.has(String(task!.status)))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)) || left.id.localeCompare(right.id));
}

/** The projection's public view of an open chase Task. */
export function chaseTaskView(task: Task): ChaseTaskView {
  return {
    id: task.id,
    description: task.description,
    date: task.date,
    status: task.status as ChaseTaskView['status'],
    ...(task.followUpAt ? { followUpAt: task.followUpAt } : {}),
    ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
  };
}

/** Attach the deal's open chase work to a finance projection. */
export async function withChaseTasks(
  client: DynamoDBDocumentClient,
  projection: FinanceProjection,
  state: FinanceState | null,
): Promise<FinanceProjection> {
  if (!state) return projection;
  const open = await openChaseTasks(client, state);
  if (open.length === 0) return projection;
  return { ...projection, chase: { tasks: open.map(chaseTaskView) } };
}

interface ChasePlannedWrite {
  tableName: string;
  key: Record<string, unknown>;
  holds: (current: Record<string, unknown> | undefined) => boolean;
  /** The full row after the write. */
  after: (current: Record<string, unknown> | undefined) => Record<string, unknown>;
}

/**
 * Dynalite has no TransactWriteItems: check every condition first, then apply
 * in order and undo on failure — the same local emulation the other modules
 * use. The conditions mirror the real transaction's ConditionExpressions.
 */
async function emulateChaseTransaction(client: DynamoDBDocumentClient, writes: ChasePlannedWrite[]): Promise<void> {
  const snapshots: Array<{ write: ChasePlannedWrite; current: Record<string, unknown> | undefined }> = [];
  for (const write of writes) {
    const current = (await client.send(new GetCommand({ TableName: write.tableName, Key: write.key, ConsistentRead: true }))).Item as Record<string, unknown> | undefined;
    if (!write.holds(current)) throw safeConflict();
    snapshots.push({ write, current });
  }
  const applied: typeof snapshots = [];
  try {
    for (const snapshot of snapshots) {
      await client.send(new PutCommand({ TableName: snapshot.write.tableName, Item: snapshot.write.after(snapshot.current) }));
      applied.push(snapshot);
    }
  } catch (error) {
    for (const { write, current } of applied.reverse()) {
      if (current) await client.send(new PutCommand({ TableName: write.tableName, Item: current }));
      else await client.send(new PutCommand({ TableName: write.tableName, Item: write.key }));
    }
    throw error;
  }
}

export async function createChaseTask(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    idempotencyKey: string; date?: unknown; today?: string;
  },
): Promise<{ task: Task; replayed: boolean }> {
  const request = {
    dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion,
    ...(input.date !== undefined ? { date: String(input.date) } : {}),
  };
  const replay = await replayMutation(client, {
    actorId: input.actorId, operation: 'chase-task', dealId: input.dealId, idempotencyKey: input.idempotencyKey, request,
  });
  if (replay) {
    const task = await getTask(client, replay.recordId);
    if (!task) throw safeConflict();
    return { task, replayed: true };
  }
  const state = await getFinanceState(client, input.dealId);
  if (!state || state.version !== input.expectedVersion || state.voidedAt) throw safeConflict();
  const deal = await getCrmRecord(client, 'deal', input.dealId);
  if (!deal || deal.archivedAt) throw safeConflict();
  const decision = await deriveChaseDecision(client, state, String(deal.status || ''), input.today || berlinDate());
  const blocker = chaseBlocker(decision);
  if (blocker) throw Object.assign(new Error(blocker), { statusCode: 422 });
  const open = await openChaseTasks(client, state);
  if (open.length > 0) {
    throw Object.assign(
      new Error('An open payment chase Task already exists for this deal'),
      { statusCode: 409, taskId: open[0].id },
    );
  }
  const organization = await getCrmRecord(client, 'organization', String(deal.organizationId || ''));
  const today = input.today || berlinDate();
  const taskId = randomUUID();
  const now = nowIso();
  const item: Record<string, unknown> = {
    PK: `TASK#${taskId}`,
    SK: `TASK#${taskId}`,
    id: taskId,
    version: 1,
    description: chaseTaskDescription({
      organizationName: String(organization?.displayName || 'Unknown sponsor'),
      ...(typeof deal.title === 'string' && deal.title ? { dealTitle: deal.title } : {}),
      ...(state.invoiceNumber ? { invoiceNumber: state.invoiceNumber } : {}),
      ...(decision.outstanding ? { outstanding: decision.outstanding } : {}),
      ...(state.amountDue ? { amountDue: state.amountDue } : {}),
      ...(state.currency ? { currency: state.currency } : {}),
      ...(state.dueOn ? { dueOn: state.dueOn } : {}),
      ...(decision.daysOverdue !== undefined ? { daysOverdue: decision.daysOverdue } : {}),
    }),
    date: chaseDate(input.date, today),
    status: 'todo',
    source: CHASE_SOURCE,
    tags: [CHASE_TAG],
    subject: { type: 'sponsor-deal', id: input.dealId },
    proofRequirement: { type: 'comment', required: true, label: 'Payment verification and outcome' },
    assigneeId: input.actorId,
    createdBy: input.actorId,
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  const nextVersion = state.version + 1;
  const financeRow = singleton(financeKey(input.dealId));
  const tail = financeMutationTail({
    actorId: input.actorId, operation: 'chase-task', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request, financeVersion: nextVersion, recordId: taskId, eventCode: 'chase-task-created',
  });
  const transaction = [
    adminCheck(input.actorId),
    dealCheck(input.dealId, input.dealVersion),
    {
      Put: {
        TableName: TABLE_TASKS,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    },
    {
      Update: {
        TableName: TABLE_SPONSOR_CRM,
        Key: financeRow,
        UpdateExpression: 'SET chaseTaskIds = :ids, updatedAt = :now, actorId = :actor, #version = #version + :one',
        ConditionExpression: '#version = :version AND attribute_not_exists(voidedAt)',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':ids': [...(state.chaseTaskIds || []), taskId], ':now': now, ':actor': input.actorId, ':one': 1, ':version': state.version,
        },
      },
    },
  ];
  if (usesLocalTransactionEmulation()) {
    await emulateChaseTransaction(client, [
      {
        // adminCheck: the actor is still an enabled admin at write time.
        tableName: TABLE_USERS,
        key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
        holds: (current) => Boolean(current) && current!.role === 'admin' && current!.disabled !== true,
        after: (current) => current!,
      },
      {
        // dealCheck: the deal is still live at the version the caller read.
        tableName: TABLE_SPONSOR_CRM,
        key: { PK: `DEAL#${input.dealId}`, SK: `DEAL#${input.dealId}` },
        holds: (current) => Boolean(current) && current!.version === input.dealVersion
          && !current!.archivedAt && current!.active === true && current!.status !== 'lost',
        after: (current) => current!,
      },
      {
        tableName: TABLE_TASKS,
        key: { PK: item.PK, SK: item.SK },
        holds: (current) => !current,
        after: () => item,
      },
      {
        tableName: TABLE_SPONSOR_CRM,
        key: financeRow,
        holds: (current) => Boolean(current) && current!.version === state.version && !current!.voidedAt,
        after: (current) => ({
          ...current!,
          chaseTaskIds: [...((current!.chaseTaskIds as string[]) || []), taskId],
          updatedAt: now,
          actorId: input.actorId,
          version: nextVersion,
        }),
      },
      {
        tableName: TABLE_SPONSOR_CRM,
        key: singleton(tail.key),
        holds: (current) => !current,
        after: () => tail.receipt,
      },
      {
        tableName: TABLE_SPONSOR_CRM,
        key: { PK: tail.history.PK, SK: tail.history.SK },
        holds: () => true,
        after: () => tail.history,
      },
    ]);
    return { task: { ...item, PK: undefined, SK: undefined } as unknown as Task, replayed: false };
  }
  await executeMutation(client, {
    actorId: input.actorId, operation: 'chase-task', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: taskId, eventCode: 'chase-task-created',
    transactItems: transaction,
  });
  const created = await getTask(client, taskId);
  if (!created) throw safeConflict();
  return { task: created, replayed: false };
}
