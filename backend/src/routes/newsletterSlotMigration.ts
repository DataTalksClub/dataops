/**
 * ONE-OFF: turn the imported newsletter slot rows into issues, each owning
 * exactly one Card. Delete this module and its route once it has run in
 * production.
 *
 * POST /api/newsletter-issues/migrations/from-slots (admin)
 * body: { dryRun: boolean, plan: PlannedIssue[] }
 *
 * The plan is computed outside from the schedule sheet (which row IDs make up
 * which issue) and names, per issue, the old slot rows it replaces and what
 * happens to the Card:
 * - keep: an existing Card becomes the issue's Card;
 * - merge: the primary slot's Card is kept, the secondary slot's Card is
 *   folded into its secondary-slot Tasks (resolved state and links carried
 *   over) and deleted;
 * - create: a new Card is created from the Template of the issue's kind, in
 *   the same transaction as the issue row.
 * Kept Cards get the issue's slot groups selected and its facts pushed. The
 * old slot rows are deleted. An issue row that already exists is skipped, so
 * a rerun finishes an interrupted migration.
 */
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { deleteCardCascade } from '../db/cardDeletion';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import {
  buildNewsletterIssue,
  createIssueWrite,
  getNewsletterIssue,
  newsletterIssueId,
  type NewsletterIssue,
} from '../db/newsletterIssues';
import { TABLE_NEWSLETTER_SLOTS } from '../db/tableNames';
import { createTask, listTasksByCardConsistent, updateTask } from '../db/tasks';
import { getTemplate } from '../db/templates';
import { loadAssignmentPolicy } from '../db/workspaceSettings';
import { resolveInteractiveActor } from '../identity/actor';
import { templateTaskProjection } from '../templates/cardTemplateProjection';
import type { Card, LambdaEvent, LambdaResponse } from '../types';
import { createIssueCard, issueTaskGroups, pushIssueToCard } from '../newsletter/issueCard';

type PlannedIssue = {
  slotIds: string[];
  issue: Omit<NewsletterIssue, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'timeZone' | 'cardId'>;
  card:
    | { action: 'keep'; cardId: string }
    | { action: 'merge'; cardId: string; mergeCardId: string }
    | { action: 'create' };
};

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const slotKey = (id: string) => ({ PK: `SLOT#${id}`, SK: `SLOT#${id}` });

/** Add Tasks for refs of `groups` the Card does not have yet. */
async function addGroupTasks(client: DynamoDBDocumentClient, card: Card, groups: string[]) {
  const template = card.templateId ? await getTemplate(client, card.templateId) : null;
  if (!template || !card.anchorDate) return [];
  const existing = new Set((await listTasksByCardConsistent(client, card.id)).map((task) => task.templateTaskRef));
  const definitions = (template.taskDefinitions || []).filter(
    (definition) => definition.optionalGroup && groups.includes(definition.optionalGroup) && !existing.has(definition.refId),
  );
  const assignee = await loadAssignmentPolicy(client, definitions.map(({ assigneeId }) => assigneeId));
  const ids = new Map(definitions.map((definition) => [definition.refId, crypto.randomUUID()]));
  const created = [];
  for (const definition of definitions) {
    const order = (template.taskDefinitions || []).indexOf(definition);
    created.push(await createTask(client, {
      id: ids.get(definition.refId),
      ...templateTaskProjection(template, definition, order, card.anchorDate, card.id, assignee, ids),
    }));
  }
  return created;
}

/** Fold a secondary slot's Card into the kept Card's secondary-slot Tasks. */
async function foldSecondaryCard(client: DynamoDBDocumentClient, kept: Card, folded: Card, actorId: string) {
  const keptTasks = await listTasksByCardConsistent(client, kept.id);
  const foldedTasks = await listTasksByCardConsistent(client, folded.id);
  const carried: string[] = [];
  for (const source of foldedTasks) {
    if (!['done', 'skipped'].includes(source.status) || !source.templateTaskRef) continue;
    const target = keptTasks.find((task) => task.templateTaskRef === `secondary-${source.templateTaskRef}`);
    if (!target || target.status !== 'todo') continue;
    const patch: Record<string, unknown> = { status: source.status };
    const fields = source as unknown as Record<string, unknown>;
    for (const field of ['link', 'comment', 'externalStatus', 'completedAt', 'completedBy', 'skipReason', 'skippedAt']) {
      if (fields[field] !== undefined) patch[field] = fields[field];
    }
    await updateTask(client, target.id, { expectedVersion: target.version, patch: patch as any });
    carried.push(`${source.templateTaskRef} -> ${target.templateTaskRef} (${source.status})`);
  }
  const links = (folded.cardLinks || []).filter((link) => link.url);
  const movedLinks: string[] = [];
  if (links.length) {
    await updateCardAdditive(client, (await getCardConsistent(client, kept.id))!, (current) => {
      const next = [...(current.cardLinks || [])];
      for (const link of links) {
        const name = link.name === 'Sponsorship document' ? 'Secondary sponsorship document' : String(link.name);
        const index = next.findIndex((entry) => entry.name === name);
        if (index >= 0 && next[index].url) continue;
        if (index >= 0) next[index] = { ...next[index], url: link.url };
        else next.push({ name, url: link.url });
        movedLinks.push(`${link.name} -> ${name}`);
      }
      return { cardLinks: next };
    });
  }
  const current = (await getCardConsistent(client, folded.id))!;
  await deleteCardCascade(client, folded.id, current.version, actorId);
  return { carried, movedLinks, deletedCardId: folded.id };
}

async function migrateIssue(
  client: DynamoDBDocumentClient,
  actor: Parameters<typeof createIssueCard>[1],
  planned: PlannedIssue,
  dryRun: boolean,
) {
  const sourceKey = String(planned.issue.sourceKey || '');
  const id = newsletterIssueId(sourceKey);
  if (planned.slotIds[0] !== id) throw new Error(`Issue ${sourceKey} id does not match its primary slot row`);
  if (await getNewsletterIssue(client, id)) return { id, outcome: 'exists' };
  for (const slotId of planned.slotIds) {
    const row = (await client.send(new GetCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: slotKey(slotId) }))).Item;
    if (!row) throw new Error(`Slot row ${slotId} is missing`);
  }
  const issue = buildNewsletterIssue({ ...planned.issue } as any, id);
  const report: Record<string, unknown> = { id, sourceKey, action: planned.card.action };
  if (dryRun) return { ...report, outcome: 'planned' };

  if (planned.card.action === 'create') {
    if (issue.status === 'cancelled') {
      await client.send(new PutCommand(createIssueWrite(issue).item.Put as any));
    } else {
      const created = await createIssueCard(client, actor, issue);
      if (!created.ok) throw new Error(`Card for ${sourceKey}: ${created.response.body}`);
      report.cardId = created.card.id;
    }
  } else {
    const card = await getCardConsistent(client, planned.card.cardId);
    if (!card) throw new Error(`Card ${planned.card.cardId} is missing`);
    const groups = issueTaskGroups(issue);
    report.cardId = card.id;
    if (planned.card.action === 'merge') {
      report.addedTasks = (await addGroupTasks(client, card, groups)).map((task) => task.templateTaskRef);
      const folded = await getCardConsistent(client, planned.card.mergeCardId);
      if (!folded) throw new Error(`Card ${planned.card.mergeCardId} is missing`);
      report.fold = await foldSecondaryCard(client, (await getCardConsistent(client, card.id))!, folded, actor.id || 'system');
    }
    if (issue.kind === 'weekly') {
      await updateCardAdditive(client, (await getCardConsistent(client, card.id))!, () => ({ selectedOptionalGroups: groups }));
    }
    await client.send(new PutCommand(createIssueWrite({ ...issue, cardId: card.id }).item.Put as any));
    await pushIssueToCard(client, { ...issue, cardId: card.id });
  }
  for (const slotId of planned.slotIds) {
    await client.send(new DeleteCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: slotKey(slotId) }));
  }
  return { ...report, outcome: 'migrated' };
}

export async function handleNewsletterSlotMigration(event: LambdaEvent, client: DynamoDBDocumentClient) {
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  if (!resolved.actor.isAdmin) return json(403, { error: 'The newsletter migration requires an admin' });
  let body: { dryRun?: unknown; plan?: unknown };
  try {
    body = JSON.parse(String(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (typeof body.dryRun !== 'boolean' || !Array.isArray(body.plan)) {
    return json(400, { error: 'dryRun (boolean) and plan (array) are required' });
  }
  const results = [];
  for (const planned of body.plan as PlannedIssue[]) {
    try {
      results.push(await migrateIssue(client, resolved.actor, planned, body.dryRun));
    } catch (error) {
      results.push({ sourceKey: planned?.issue?.sourceKey, outcome: 'failed', error: (error as Error).message });
      if (!body.dryRun) break;
    }
  }
  return json(200, { dryRun: body.dryRun, results });
}
