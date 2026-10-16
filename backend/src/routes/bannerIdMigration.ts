/**
 * One-off migration: rename the leftover Figma ids on stored Cards and Tasks
 * after Banner Generator replaced Figma in the knowledge repository.
 *
 * - SOP id `sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners`
 *   becomes `sop.media.covers.create-an-event-cover`;
 * - template step id `create-banner-figma` becomes `create-banner`;
 * - required-resource id `figma` in definition snapshots becomes
 *   `banner-generator`, the id the live field was already renamed to.
 *
 * Template rows are reconciled from Git at deploy and are not touched here.
 * `POST /api/admin/banner-id-migration` with `{ "apply": false }` reports the
 * plan, including every remaining string that still mentions Figma (URLs and
 * prose, which are history, not ids); `{ "apply": true }` writes it,
 * version-conditioned per row. Admin only.
 * Delete this file and its router line once the migration has run.
 */
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listCards } from '../db/cards';
import { TABLE_CARDS, TABLE_TASKS } from '../db/tableNames';
import { listAllTasks } from '../db/tasks';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';

const ROUTE = '/api/admin/banner-id-migration';

export const DOC_RENAME = ['sop.sales.sponsorship.how-to-use-figma-for-creating-event-banners', 'sop.media.covers.create-an-event-cover'] as const;
export const STEP_RENAME = ['create-banner-figma', 'create-banner'] as const;
export const RESOURCE_RENAME = ['figma', 'banner-generator'] as const;

type Dict = Record<string, unknown>;
type Rename = readonly [string, string];

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renameValue(value: unknown, [from, to]: Rename): unknown {
  return value === from ? to : value;
}

function renameList(value: unknown, rename: Rename): unknown {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map((item) => renameValue(item, rename)))];
}

/** Field rules: top-level fields and fields of `templateDefinitionSnapshot`. */
const TASK_FIELDS: Record<string, (value: unknown) => unknown> = {
  instructionDocId: (value) => renameValue(value, DOC_RENAME),
  sourceDocIds: (value) => renameList(value, DOC_RENAME),
  templateTaskRef: (value) => renameValue(value, STEP_RENAME),
  requires: (value) => renameList(value, RESOURCE_RENAME),
};
const TASK_SNAPSHOT_FIELDS: Record<string, (value: unknown) => unknown> = {
  instructionDocId: (value) => renameValue(value, DOC_RENAME),
  sourceDocIds: (value) => renameList(value, DOC_RENAME),
  dependsOnRefs: (value) => renameList(value, STEP_RENAME),
  requires: (value) => renameList(value, RESOURCE_RENAME),
};
const CARD_FIELDS: Record<string, (value: unknown) => unknown> = {
  sourceDocIds: (value) => renameList(value, DOC_RENAME),
};
const CARD_SNAPSHOT_FIELDS: Record<string, (value: unknown) => unknown> = {
  sourceDocIds: (value) => renameList(value, DOC_RENAME),
  taskRefs: (value) => renameList(value, STEP_RENAME),
};

function applyRules(item: Dict, rules: Record<string, (value: unknown) => unknown>): Dict {
  const changes: Dict = {};
  for (const [field, rule] of Object.entries(rules)) {
    if (item[field] === undefined) continue;
    const next = rule(item[field]);
    if (JSON.stringify(next) !== JSON.stringify(item[field])) changes[field] = next;
  }
  return changes;
}

/** The top-level fields to rewrite (a changed snapshot is rewritten whole). */
export function planRow(
  item: Dict,
  rules: Record<string, (value: unknown) => unknown>,
  snapshotRules: Record<string, (value: unknown) => unknown>,
): Dict {
  const fields = applyRules(item, rules);
  const snapshot = item.templateDefinitionSnapshot;
  if (isDict(snapshot)) {
    const snapshotChanges = applyRules(snapshot, snapshotRules);
    if (Object.keys(snapshotChanges).length > 0) {
      fields.templateDefinitionSnapshot = { ...snapshot, ...snapshotChanges };
    }
  }
  return fields;
}

function figmaMentions(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (/figma/i.test(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item) => figmaMentions(item, `${path}[]`, out));
  } else if (isDict(value)) {
    for (const [key, item] of Object.entries(value)) figmaMentions(item, path ? `${path}.${key}` : key, out);
  }
}

interface RowPlan {
  kind: 'card' | 'task';
  id: string;
  version: number;
  fields: Dict;
}

async function writeRow(client: DynamoDBDocumentClient, plan: RowPlan): Promise<number> {
  const prefix = plan.kind === 'card' ? 'CARD' : 'TASK';
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = { ':expected': plan.version, ':one': 1 };
  const sets = ['#version = #version + :one'];
  for (const [index, [field, value]] of Object.entries(plan.fields).entries()) {
    names[`#f${index}`] = field;
    values[`:v${index}`] = value;
    sets.push(`#f${index} = :v${index}`);
  }
  const result = await client.send(new UpdateCommand({
    TableName: plan.kind === 'card' ? TABLE_CARDS : TABLE_TASKS,
    Key: { PK: `${prefix}#${plan.id}`, SK: `${prefix}#${plan.id}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return Number(result.Attributes?.version);
}

export async function handleBannerIdMigration(
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
  if (!resolution.actor.isAdmin) return workAdminForbidden('The banner id migration requires an admin');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (typeof body.apply !== 'boolean') return json(400, { error: 'apply must be a boolean' });

  const [cards, tasks] = await Promise.all([listCards(client), listAllTasks(client)]);
  const rows: Array<{ kind: 'card' | 'task'; item: Dict }> = [
    ...cards.map((item) => ({ kind: 'card' as const, item: item as unknown as Dict })),
    ...tasks.map((item) => ({ kind: 'task' as const, item: item as unknown as Dict })),
  ];
  const plans: RowPlan[] = [];
  const remaining: Record<string, number> = {};
  for (const { kind, item } of rows) {
    const fields = kind === 'card'
      ? planRow(item, CARD_FIELDS, CARD_SNAPSHOT_FIELDS)
      : planRow(item, TASK_FIELDS, TASK_SNAPSHOT_FIELDS);
    if (Object.keys(fields).length > 0) {
      plans.push({ kind, id: String(item.id), version: Number(item.version), fields });
    }
    const mentions: string[] = [];
    figmaMentions({ ...item, ...fields }, '', mentions);
    for (const mention of mentions) {
      const key = `${kind}.${mention}`;
      remaining[key] = (remaining[key] || 0) + 1;
    }
  }
  plans.sort((left, right) => `${left.kind}${left.id}`.localeCompare(`${right.kind}${right.id}`));
  const summary = {
    cardCount: cards.length,
    taskCount: tasks.length,
    cardsToRewrite: plans.filter(({ kind }) => kind === 'card').length,
    tasksToRewrite: plans.filter(({ kind }) => kind === 'task').length,
    remainingFigmaMentions: remaining,
  };
  if (!body.apply) return json(200, { apply: false, ...summary, plans });

  const results = [];
  for (const plan of plans) {
    try {
      const version = await writeRow(client, plan);
      results.push({ kind: plan.kind, id: plan.id, status: 'applied', version });
    } catch (error) {
      results.push({ kind: plan.kind, id: plan.id, status: 'failed', error: (error as Error).name });
    }
  }
  return json(results.some(({ status }) => status === 'failed') ? 207 : 200, { apply: true, ...summary, results });
}
