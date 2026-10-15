/**
 * One-off migration: give every stored Card the Template linkage that
 * instantiation records (templateId, templateVersion, definition snapshot with
 * task refs, selected optional groups).
 *
 * Cards imported from Trello carry only a title tag such as `[Podcast]`; the
 * read path used to infer their Template from it, so the portal showed a
 * Template while the stored Card had none. Template-instantiated Cards lack
 * the snapshot's `taskRefs`. Existing Tasks are never touched.
 *
 * `POST /api/admin/card-template-linkage` with `{ "apply": false }` reports the
 * plan; `{ "apply": true }` writes it, version-conditioned per Card. Admin only.
 * Delete this file and its router line once the migration has run.
 */
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { parseCardTitle } from '../cards/cardTitleStructure';
import { listCards } from '../db/cards';
import { TABLE_CARDS } from '../db/tableNames';
import { listAllTasks } from '../db/tasks';
import { listTemplates } from '../db/templates';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { templateLinkage } from '../templates/cardTemplateProjection';
import type { Card, LambdaEvent, LambdaResponse, Task, Template } from '../types';

const ROUTE = '/api/admin/card-template-linkage';

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function linkageView(card: Card) {
  const snapshot = card.templateDefinitionSnapshot as (Card['templateDefinitionSnapshot'] & { taskRefs?: string[] }) | undefined;
  return {
    version: card.version,
    templateId: card.templateId ?? null,
    templateVersion: card.templateVersion ?? null,
    templateSourceRevision: card.templateSourceRevision ?? null,
    hasSnapshot: Boolean(snapshot),
    taskRefs: snapshot?.taskRefs ?? null,
    selectedOptionalGroups: card.selectedOptionalGroups ?? null,
  };
}

type Action = 'link-to-template' | 'record-task-refs' | 'none' | 'unmapped';

interface CardPlan {
  cardId: string;
  title: string;
  status: Card['status'];
  action: Action;
  reason: string;
  templateId: string | null;
  templateType: string | null;
  before: ReturnType<typeof linkageView>;
  fields: Record<string, unknown> | null;
}

function planCard(card: Card, tasks: Task[], templates: Template[]): CardPlan {
  const base = {
    cardId: card.id,
    title: String(card.title || ''),
    status: card.status,
    before: linkageView(card),
  };
  const snapshot = card.templateDefinitionSnapshot as (Card['templateDefinitionSnapshot'] & { taskRefs?: string[] }) | undefined;
  const linked = Boolean(card.templateId)
    && Number.isInteger(card.templateVersion)
    && Number(card.templateVersion) >= 1
    && Boolean(snapshot);

  if (linked) {
    const template = templates.find(({ id }) => id === card.templateId) || null;
    if (Array.isArray(snapshot!.taskRefs) && Array.isArray(card.selectedOptionalGroups)) {
      return { ...base, action: 'none', reason: 'already linked', templateId: card.templateId!, templateType: template?.type ?? null, fields: null };
    }
    // An instantiated Card accounts for exactly the Template Tasks it holds.
    const taskRefs = [...new Set(tasks
      .filter((task) => task.templateId === card.templateId && typeof task.templateTaskRef === 'string' && task.templateTaskRef)
      .map((task) => task.templateTaskRef as string))].sort();
    return {
      ...base,
      action: 'record-task-refs',
      reason: 'instantiated Card without snapshot taskRefs',
      templateId: card.templateId!,
      templateType: template?.type ?? null,
      fields: {
        templateDefinitionSnapshot: { ...snapshot!, taskRefs },
        selectedOptionalGroups: card.selectedOptionalGroups ?? [],
      },
    };
  }

  let template: Template | null = null;
  let reason: string;
  if (card.templateId) {
    template = templates.find(({ id }) => id === card.templateId) || null;
    reason = template
      ? `stored templateId without instantiation record`
      : `stored templateId ${card.templateId} has no Template`;
  } else {
    const type = parseCardTitle(base.title).templateType;
    const matches = type ? templates.filter((candidate) => candidate.type === type) : [];
    if (matches.length === 1) template = matches[0];
    reason = !type
      ? 'no templateId and no Template tag in the title'
      : matches.length === 1
        ? `title tag names Template type ${type}`
        : `title tag names Template type ${type}, which matches ${matches.length} Templates`;
  }
  if (!template) {
    return { ...base, action: 'unmapped', reason, templateId: null, templateType: null, fields: null };
  }
  // The Card's existing Tasks did not come from this Template; the Card
  // accounts for every definition at the current version, so a later Template
  // update adds only definitions that are new by then.
  return {
    ...base,
    action: 'link-to-template',
    reason,
    templateId: template.id,
    templateType: template.type ?? null,
    fields: templateLinkage(template, card.selectedOptionalGroups || []),
  };
}

async function writePlan(client: DynamoDBDocumentClient, plan: CardPlan): Promise<number> {
  const fields = plan.fields!;
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = { ':expected': plan.before.version, ':one': 1 };
  const sets = ['#version = #version + :one'];
  for (const [index, [field, value]] of Object.entries(fields).entries()) {
    names[`#f${index}`] = field;
    values[`:v${index}`] = value;
    sets.push(`#f${index} = :v${index}`);
  }
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_CARDS,
    Key: { PK: `CARD#${plan.cardId}`, SK: `CARD#${plan.cardId}` },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: 'attribute_exists(PK) AND #version = :expected',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return Number(result.Attributes?.version);
}

export async function handleCardTemplateLinkageMigration(
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
  if (!resolution.actor.isAdmin) return workAdminForbidden('The Card Template linkage migration requires an admin');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (typeof body.apply !== 'boolean') return json(400, { error: 'apply must be a boolean' });

  const [cards, tasks, templates] = await Promise.all([listCards(client), listAllTasks(client), listTemplates(client)]);
  const tasksByCard = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.cardId) continue;
    tasksByCard.set(task.cardId, [...(tasksByCard.get(task.cardId) || []), task]);
  }
  const plans = cards
    .map((card) => planCard(card, tasksByCard.get(card.id) || [], templates))
    .sort((left, right) => left.cardId.localeCompare(right.cardId));
  const unmapped = plans.filter(({ action }) => action === 'unmapped');
  const counts = Object.fromEntries(
    (['link-to-template', 'record-task-refs', 'none', 'unmapped'] as Action[])
      .map((action) => [action, plans.filter((plan) => plan.action === action).length]),
  );

  if (!body.apply) return json(200, { apply: false, cardCount: cards.length, counts, plans });
  // All or nothing at the plan level: a Card that maps to no Template needs
  // an operator decision before any Card is rewritten.
  if (unmapped.length > 0) {
    return json(409, { error: 'Some Cards map to no Template', code: 'unmapped-cards', unmapped });
  }
  const results = [];
  for (const plan of plans) {
    if (!plan.fields) continue;
    try {
      const version = await writePlan(client, plan);
      results.push({ cardId: plan.cardId, action: plan.action, status: 'applied', version });
    } catch (error) {
      results.push({ cardId: plan.cardId, action: plan.action, status: 'failed', error: (error as Error).name });
    }
  }
  return json(results.some(({ status }) => status === 'failed') ? 207 : 200, {
    apply: true,
    cardCount: cards.length,
    counts,
    plans,
    results,
  });
}
