/**
 * The one piece of bookkeeping a verified payment still owes: marking the
 * invoice paid in Finom. When `receivePayment` or `linkPayment` records cash,
 * the same transaction creates — or adopts — the deal's single open
 * "Mark invoice <number> paid in Finom" Task, so the follow-through can never
 * be forgotten the way a separate manual step can.
 *
 * The Task is ordinary cardless work with a `sponsor-deal` subject: it shows in
 * the regular queue, the deal's openTasks, and follows the ordinary Task
 * lifecycle from there. Its dependency on the payment/receipt step is
 * structural: `Task.dependsOn` is Card-only, and this Task exists if and only
 * if the payment link committed — the finance history event names the Task.
 *
 * Exactly one stays open per deal: a second receipt (a partial payment's
 * remainder) adopts the open Task instead of creating parallel work; only a
 * resolved Task lets the next receipt create a fresh one.
 */
import {
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from '../db/tableNames';
import { berlinDate, digest } from './core';
import { relatedDealTasks } from './paymentFollowUp';
import type { Task } from '../types';

export const FINOM_PAID_TASK_SOURCE = 'sponsor-finom';
export const FINOM_PAID_TASK_TAG = 'finom-invoice-paid';
export const FINOM_PAID_INSTRUCTION_DOC_ID = 'sop.finance.bookkeeping.marking-invoice-as-paid-in-finom';

const isFinomPaidTask = (task: Task) =>
  task.source === FINOM_PAID_TASK_SOURCE || task.tags?.includes(FINOM_PAID_TASK_TAG);

/** What the Task says: the exact work, naming the invoice when the finance state knows it. */
export function finomPaidTaskDescription(invoiceNumber?: string): string {
  return invoiceNumber ? `Mark invoice ${invoiceNumber} paid in Finom` : 'Mark the invoice paid in Finom';
}

/**
 * The transaction actions that leave exactly one open Finom Task on the deal:
 * a pinned adoption of the open Task when one exists, a fresh Task otherwise.
 * Read with the same consistent deal-task review the follow-up creation uses,
 * so the decision is made on the state that is alive when the payment commits.
 */
export async function finomPaidTaskActions(
  client: DynamoDBDocumentClient,
  input: { actorId: string; dealId: string; sourceId: string; invoiceNumber?: string },
): Promise<{ taskId: string; created: boolean; actions: Record<string, unknown>[] }> {
  const open = (await relatedDealTasks(client, input.dealId)).filter(isFinomPaidTask);
  const now = new Date().toISOString();
  const adopted = open[0];
  if (adopted) {
    return {
      taskId: adopted.id,
      created: false,
      actions: [{
        ConditionCheck: {
          TableName: TABLE_TASKS,
          Key: { PK: `TASK#${adopted.id}`, SK: `TASK#${adopted.id}` },
          ConditionExpression: '#version = :version AND (#status = :todo OR #status = :waiting)',
          ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
          ExpressionAttributeValues: { ':version': adopted.version, ':todo': 'todo', ':waiting': 'waiting' },
        },
      }],
    };
  }
  // The receipt is part of the identity: after an installment's Task is resolved,
  // the next receipt's Task must be a fresh row, not a collision with the old one.
  const taskId = `finance-${digest({ dealId: input.dealId, sourceId: input.sourceId, finom: 'invoice-paid' }).slice(0, 32)}`;
  const item: Record<string, unknown> = {
    PK: `TASK#${taskId}`,
    SK: `TASK#${taskId}`,
    id: taskId,
    version: 1,
    description: finomPaidTaskDescription(input.invoiceNumber),
    date: berlinDate(),
    status: 'todo',
    source: FINOM_PAID_TASK_SOURCE,
    tags: [FINOM_PAID_TASK_TAG],
    subject: { type: 'sponsor-deal', id: input.dealId },
    instructionDocId: FINOM_PAID_INSTRUCTION_DOC_ID,
    assigneeId: input.actorId,
    createdBy: input.actorId,
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    taskId,
    created: true,
    actions: [{ Put: { TableName: TABLE_TASKS, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }],
  };
}
