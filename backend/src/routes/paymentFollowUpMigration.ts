/**
 * One-off migration: the sponsor finance "chase" became the payment follow-up.
 *
 * - finance rows: `chaseTaskIds` becomes `paymentFollowUpTaskIds`;
 * - finance history: event codes `chase-task-created` / `chase-task-linked`
 *   become `payment-follow-up-task-created` / `payment-follow-up-task-linked`;
 * - finance receipts: operation `chase-task` becomes `payment-follow-up-task`;
 * - Tasks: tag `payment-chase` becomes `payment-follow-up`, and descriptions
 *   the feature generated ("Chase payment from …") read "Follow up on the
 *   payment from …".
 *
 * `POST /api/admin/payment-follow-up-migration` with `{ "apply": false }`
 * reports the plan; `{ "apply": true }` writes it, each row conditioned on the
 * value it was planned from. Admin only.
 * Delete this file and its router line once the migration has run.
 */
import {
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type ScanCommandOutput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_SPONSOR_CRM, TABLE_TASKS } from '../db/tableNames';
import { listAllTasks } from '../db/tasks';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';

const ROUTE = '/api/admin/payment-follow-up-migration';
const EVENT_CODES: Record<string, string> = {
  'chase-task-created': 'payment-follow-up-task-created',
  'chase-task-linked': 'payment-follow-up-task-linked',
};
const OLD_TAG = 'payment-chase';
const NEW_TAG = 'payment-follow-up';

type Dict = Record<string, unknown>;
type Plan = {
  kind: 'finance' | 'history' | 'receipt' | 'task';
  key: { PK: string; SK: string };
  id: string;
  update: Omit<UpdateCommandInput, 'TableName' | 'Key'>;
  table: string;
  change: Dict;
};

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The feature's generated description in its new wording, or null when it is not one. */
export function renamedDescription(description: string): string | null {
  if (!description.startsWith('Chase payment from ')) return null;
  return `Follow up on the payment from ${description.slice('Chase payment from '.length)}`
    .replace(' before chasing — ', ' before following up — ')
    .slice(0, 500);
}

async function scanCrm(client: DynamoDBDocumentClient): Promise<Dict[]> {
  const items: Dict[] = [];
  let cursor: Dict | undefined;
  do {
    const page: ScanCommandOutput = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      FilterExpression: 'recordType IN (:finance, :history, :receipt)',
      ExpressionAttributeValues: {
        ':finance': 'sponsor-finance', ':history': 'sponsor-finance-history', ':receipt': 'sponsor-finance-receipt',
      },
      ExclusiveStartKey: cursor,
    }));
    items.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return items;
}

export async function planMigration(client: DynamoDBDocumentClient): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const item of await scanCrm(client)) {
    const key = { PK: String(item.PK), SK: String(item.SK) };
    if (item.recordType === 'sponsor-finance' && item.chaseTaskIds !== undefined) {
      plans.push({
        kind: 'finance', key, id: String(item.dealId), table: TABLE_SPONSOR_CRM,
        change: { paymentFollowUpTaskIds: item.chaseTaskIds },
        update: {
          UpdateExpression: 'SET paymentFollowUpTaskIds = chaseTaskIds REMOVE chaseTaskIds',
          ConditionExpression: 'attribute_exists(chaseTaskIds) AND #version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':version': item.version },
        },
      });
    }
    if (item.recordType === 'sponsor-finance-history' && EVENT_CODES[String(item.eventCode)]) {
      plans.push({
        kind: 'history', key, id: `${item.dealId}/${item.id}`, table: TABLE_SPONSOR_CRM,
        change: { eventCode: EVENT_CODES[String(item.eventCode)] },
        update: {
          UpdateExpression: 'SET eventCode = :next',
          ConditionExpression: 'eventCode = :previous',
          ExpressionAttributeValues: { ':next': EVENT_CODES[String(item.eventCode)], ':previous': item.eventCode },
        },
      });
    }
    if (item.recordType === 'sponsor-finance-receipt' && item.operation === 'chase-task') {
      plans.push({
        kind: 'receipt', key, id: `${item.dealId}/${item.id}`, table: TABLE_SPONSOR_CRM,
        change: { operation: 'payment-follow-up-task' },
        update: {
          UpdateExpression: 'SET #operation = :next',
          ConditionExpression: '#operation = :previous',
          ExpressionAttributeNames: { '#operation': 'operation' },
          ExpressionAttributeValues: { ':next': 'payment-follow-up-task', ':previous': 'chase-task' },
        },
      });
    }
  }
  for (const task of await listAllTasks(client)) {
    const change: Dict = {};
    if (Array.isArray(task.tags) && task.tags.includes(OLD_TAG)) {
      change.tags = [...new Set(task.tags.map((tag) => (tag === OLD_TAG ? NEW_TAG : tag)))];
    }
    const description = task.source === 'sponsor-finance' ? renamedDescription(String(task.description || '')) : null;
    if (description) change.description = description;
    if (!Object.keys(change).length) continue;
    const names: Record<string, string> = { '#version': 'version' };
    const values: Dict = { ':expected': task.version, ':one': 1 };
    const sets = ['#version = #version + :one'];
    Object.entries(change).forEach(([field, value], index) => {
      names[`#f${index}`] = field;
      values[`:v${index}`] = value;
      sets.push(`#f${index} = :v${index}`);
    });
    plans.push({
      kind: 'task', key: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}` }, id: task.id, table: TABLE_TASKS, change,
      update: {
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
  }
  return plans.sort((left, right) => `${left.kind}${left.id}`.localeCompare(`${right.kind}${right.id}`));
}

export async function handlePaymentFollowUpMigration(
  path: string,
  method: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== ROUTE) return null;
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolution = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolution.ok) return resolution.response;
  if (!resolution.actor.isAdmin) return workAdminForbidden('The payment follow-up migration requires an admin');
  let body: Dict;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (typeof body.apply !== 'boolean') return json(400, { error: 'apply must be a boolean' });

  const plans = await planMigration(client);
  const counts: Record<string, number> = {};
  for (const plan of plans) counts[plan.kind] = (counts[plan.kind] || 0) + 1;
  const planned = plans.map(({ kind, id, change }) => ({ kind, id, change }));
  if (!body.apply) return json(200, { apply: false, counts, plans: planned });

  const results = [];
  for (const plan of plans) {
    try {
      await client.send(new UpdateCommand({ TableName: plan.table, Key: plan.key, ...plan.update }));
      results.push({ kind: plan.kind, id: plan.id, status: 'applied' });
    } catch (error) {
      results.push({ kind: plan.kind, id: plan.id, status: 'failed', error: (error as Error).name });
    }
  }
  return json(results.some(({ status }) => status === 'failed') ? 207 : 200, { apply: true, counts, results });
}
