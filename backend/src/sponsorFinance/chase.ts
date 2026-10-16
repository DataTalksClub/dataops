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
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { getCrmRecord } from '../db/sponsorCrm';
import { getTask } from '../db/tasks';
import { TABLE_SPONSOR_CRM, TABLE_TASKS } from '../db/tableNames';
import {
  berlinDate,
  financeKey,
  realDate,
} from './core';
import {
  adminCheck,
  dealCheck,
  executeMutation,
  getFinanceState,
  projectFinance,
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

/** Use the same coherent transaction snapshot and claim checks as the finance view. */
export async function deriveChaseDecision(
  client: DynamoDBDocumentClient,
  state: FinanceState,
  dealStatus: string,
  today: string,
): Promise<ChaseDecision> {
  const projection = await projectFinance(client, state.dealId, 'admin', { dealStatus, today });
  if (projection.finance?.version !== state.version) throw safeConflict();
  return {
    invoiceState: projection.invoiceState,
    paymentState: projection.paymentState,
    timingState: projection.timingState,
    followUp: projection.followUp,
    coherent: projection.reconciliationStatus === 'coherent',
    ...(projection.outstanding !== undefined ? { outstanding: projection.outstanding } : {}),
    ...(projection.daysOverdue !== undefined ? { daysOverdue: projection.daysOverdue } : {}),
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
    version: task.version,
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
  const existing = (await relatedDealTasks(client, state.dealId)).filter((task) => !open.some((chase) => chase.id === task.id));
  return { ...projection, chase: { tasks: open.map(chaseTaskView), existingTasks: existing.map(chaseTaskView) } };
}

/** Current related work, read consistently before creating another follow-up. */
export async function relatedDealTasks(client: DynamoDBDocumentClient, dealId: string): Promise<Task[]> {
  const result: Task[] = [];
  let key: Record<string, any> | undefined;
  let evaluated = 0;
  let pages = 0;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_TASKS, ConsistentRead: true, Limit: 200,
      ...(key ? { ExclusiveStartKey: key } : {}),
      ProjectionExpression: 'id, #version, description, #date, #status, subject, assigneeId, followUpAt',
      ExpressionAttributeNames: { '#version': 'version', '#date': 'date', '#status': 'status' },
    }));
    evaluated += page.ScannedCount || 0;
    if (evaluated > 5000 || ++pages > 50) throw Object.assign(new Error('Open task review exceeded its read limit'), { statusCode: 503 });
    for (const item of page.Items || []) {
      const task = item as Task;
      if (task.subject?.type === 'sponsor-deal' && task.subject.id === dealId && OPEN_STATUSES.has(task.status)) result.push(task);
    }
    key = page.LastEvaluatedKey;
  } while (key);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function reviewedTaskReferences(value: unknown): Array<{ id: string; version: number }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 80 || value.some((item) =>
    !item || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.version) || item.version < 1,
  ) || new Set(value.map((item) => item.id)).size !== value.length) {
    throw Object.assign(new Error('reviewedOpenTasks must contain distinct Task ids and positive versions'), { statusCode: 400 });
  }
  return value.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id));
}

export async function createChaseTask(
  client: DynamoDBDocumentClient,
  input: {
    actorId: string; dealId: string; dealVersion: number; expectedVersion: number;
    idempotencyKey: string; date?: unknown; today?: string; existingTaskId?: unknown; reviewedOpenTasks?: unknown;
  },
): Promise<{ task: Task; replayed: boolean }> {
  const reviewed = reviewedTaskReferences(input.reviewedOpenTasks);
  const request = {
    dealVersion: input.dealVersion,
    expectedVersion: input.expectedVersion,
    ...(input.date !== undefined ? { date: String(input.date) } : {}),
    ...(input.existingTaskId !== undefined ? { existingTaskId: input.existingTaskId } : {}),
    ...(reviewed !== undefined ? { reviewedOpenTasks: reviewed } : {}),
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
  const related = await relatedDealTasks(client, input.dealId);
  const existing = input.existingTaskId === undefined ? undefined
    : related.find((task) => task.id === input.existingTaskId);
  if (input.existingTaskId !== undefined && (!existing || input.date !== undefined)) {
    throw Object.assign(new Error('Select an open Task on this deal; its date is preserved'), { statusCode: 400 });
  }
  const references = related.map(({ id, version }) => ({ id, version }));
  if (!existing && related.length && JSON.stringify(reviewed) !== JSON.stringify(references)) {
    throw Object.assign(new Error('Review existing deal Tasks before creating a separate payment follow-up, or link one of them'), { statusCode: 409 });
  }
  if (references.length > 80) throw Object.assign(new Error('Too many open deal Tasks; consolidate before adding a follow-up'), { statusCode: 422 });
  const organization = await getCrmRecord(client, 'organization', String(deal.organizationId || ''));
  const today = input.today || berlinDate();
  const taskId = existing?.id || randomUUID();
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
  const transaction = [
    adminCheck(input.actorId),
    dealCheck(input.dealId, input.dealVersion),
    ...references.map(({ id, version }) => ({ ConditionCheck: {
      TableName: TABLE_TASKS, Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
      ConditionExpression: '#version = :version AND (#status = :todo OR #status = :waiting)',
      ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
      ExpressionAttributeValues: { ':version': version, ':todo': 'todo', ':waiting': 'waiting' },
    } })),
    ...(existing ? [] : [{ Put: {
      TableName: TABLE_TASKS, Item: item, ConditionExpression: 'attribute_not_exists(PK)',
    } }]),
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
  await executeMutation(client, {
    actorId: input.actorId, operation: 'chase-task', dealId: input.dealId, idempotencyKey: input.idempotencyKey,
    request,
    financeVersion: nextVersion, recordId: taskId, eventCode: existing ? 'chase-task-linked' : 'chase-task-created',
    transactItems: transaction,
  });
  const created = await getTask(client, taskId);
  if (!created) throw safeConflict();
  return { task: created, replayed: false };
}
