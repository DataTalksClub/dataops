/**
 * Every overdue unpaid invoice has to be on someone's queue. The daily finance
 * alert pass calls this for each such deal: an open payment follow-up Task is
 * left alone, a closed one is reopened, and a deal with none gets a new one.
 * Ids are deterministic and writes conditional, so concurrent runs never
 * duplicate the Task.
 */
import { ScanCommand, type DynamoDBDocumentClient, type ScanCommandOutput } from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from '../db/tableNames';
import { createTask, updateTask } from '../db/tasks';
import { makeTaskHistoryEvent } from '../routes/taskValidation';
import { digest } from './core';
import { PAYMENT_FOLLOW_UP_SOURCE, PAYMENT_FOLLOW_UP_TAG, paymentFollowUpTaskDescription } from './paymentFollowUp';
import type { Task } from '../types';

const OPEN = new Set(['todo', 'waiting']);
export const OVERDUE_ACTOR = 'system:sponsor-finance-alerts';

/** Payment follow-up Tasks of every deal, in one scan (no read cap: the Tasks table is large). */
export async function paymentTasksByDeal(client: DynamoDBDocumentClient): Promise<Map<string, Task[]>> {
  const byDeal = new Map<string, Task[]>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: 'subject.#type = :deal AND (#source = :source OR contains(tags, :tag))',
      ExpressionAttributeNames: { '#type': 'type', '#source': 'source' },
      ExpressionAttributeValues: { ':deal': 'sponsor-deal', ':source': PAYMENT_FOLLOW_UP_SOURCE, ':tag': PAYMENT_FOLLOW_UP_TAG },
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

export type OverdueInvoice = {
  dealId: string;
  organizationName: string;
  dealTitle?: string;
  invoiceNumber?: string;
  amountDue?: string;
  currency?: string;
  dueOn: string;
  outstanding?: string;
  daysOverdue?: number;
  assigneeId?: string | null;
};

export async function ensurePaymentFollowUpTask(
  client: DynamoDBDocumentClient,
  existing: Task[],
  invoice: OverdueInvoice,
  today: string,
): Promise<'created' | 'reopened' | 'existing'> {
  if (existing.some((task) => OPEN.has(String(task.status)))) return 'existing';
  const closed = existing.filter((task) => task.status === 'done')
    .sort((a, b) => String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt)))[0];
  if (closed) {
    await updateTask(client, closed.id, {
      currentTask: closed,
      expectedVersion: closed.version,
      patch: { status: 'todo', date: today, completedAt: null, completedBy: null, followUpAt: null, waitingFor: null },
      historyEvents: [makeTaskHistoryEvent('reopened', closed, {
        actorId: OVERDUE_ACTOR,
        note: `Invoice ${invoice.invoiceNumber || ''} is still unpaid ${invoice.daysOverdue ?? ''} days after its due date`.replace(/\s+/g, ' '),
      })],
      actorId: OVERDUE_ACTOR,
      triggerKind: 'task-reopened',
    });
    return 'reopened';
  }
  const id = `finance-overdue-${digest({ dealId: invoice.dealId }).slice(0, 32)}`;
  try {
    await createTask(client, {
      id,
      description: paymentFollowUpTaskDescription({
        organizationName: invoice.organizationName,
        action: 'payment-follow-up',
        ...(invoice.dealTitle ? { dealTitle: invoice.dealTitle } : {}),
        ...(invoice.invoiceNumber ? { invoiceNumber: invoice.invoiceNumber } : {}),
        ...(invoice.outstanding ? { outstanding: invoice.outstanding } : {}),
        ...(invoice.amountDue ? { amountDue: invoice.amountDue } : {}),
        ...(invoice.currency ? { currency: invoice.currency } : {}),
        dueOn: invoice.dueOn,
        ...(invoice.daysOverdue !== undefined ? { daysOverdue: invoice.daysOverdue } : {}),
      }),
      date: today,
      status: 'todo',
      source: PAYMENT_FOLLOW_UP_SOURCE,
      tags: [PAYMENT_FOLLOW_UP_TAG],
      subject: { type: 'sponsor-deal', id: invoice.dealId },
      proofRequirement: { type: 'comment', required: true, label: 'Payment verification and outcome' },
      ...(invoice.assigneeId ? { assigneeId: invoice.assigneeId } : {}),
      createdBy: OVERDUE_ACTOR,
    }, { actorId: OVERDUE_ACTOR, triggerKind: 'sponsor-finance-overdue' });
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    return 'existing';
  }
  return 'created';
}
