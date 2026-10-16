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
 *   the same transaction as the issue row;
 * - retemplate: a Card built from the wrong Template is replaced by a new Card
 *   from the Template of the issue's kind. Each old Task maps onto a new
 *   template Task (by `taskMap`, else by equal ref) and carries its resolved
 *   state and evidence there; an unmapped Task that is not skipped moves to
 *   the new Card with its history; filled links move; the old Card is deleted.
 * Kept Cards get the issue's slot groups selected and its facts pushed. The
 * old slot rows are deleted. An issue row that already exists is skipped, so
 * a rerun finishes an interrupted migration.
 */
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { cardBlockingReferences, deleteCardCascade } from '../db/cardDeletion';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import {
  buildNewsletterIssue,
  createIssueWrite,
  getNewsletterIssue,
  newsletterIssueId,
  type NewsletterIssue,
} from '../db/newsletterIssues';
import { TABLE_FILES, TABLE_NEWSLETTER_SLOTS, TABLE_SPONSOR_CRM } from '../db/tableNames';
import { createTask, listTasksByCardConsistent, updateTask } from '../db/tasks';
import { getTemplate } from '../db/templates';
import { loadAssignmentPolicy } from '../db/workspaceSettings';
import { resolveInteractiveActor } from '../identity/actor';
import { templateTaskProjection } from '../templates/cardTemplateProjection';
import type { Card, LambdaEvent, LambdaResponse, Task } from '../types';
import { createIssueCard, issueTaskGroups, issueTemplate, pushIssueToCard } from '../newsletter/issueCard';

type PlannedIssue = {
  slotIds: string[];
  issue: Omit<NewsletterIssue, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'timeZone' | 'cardId'>;
  card:
    | { action: 'keep'; cardId: string }
    | { action: 'merge'; cardId: string; mergeCardId: string }
    | { action: 'create' }
    | { action: 'retemplate'; cardId: string; taskMap?: Record<string, string | null> };
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

const EVIDENCE_FIELDS = ['link', 'comment', 'externalStatus', 'completedAt', 'completedBy', 'skipReason', 'skippedAt', 'skippedBy'];

/** Copy a resolved Task's state and evidence onto an open target Task. */
async function carryResolvedTask(client: DynamoDBDocumentClient, source: Task, target: Task) {
  const patch: Record<string, unknown> = { status: source.status };
  const fields = source as unknown as Record<string, unknown>;
  for (const field of EVIDENCE_FIELDS) {
    if (fields[field] !== undefined) patch[field] = fields[field];
  }
  await updateTask(client, target.id, { expectedVersion: target.version, patch: patch as any });
}

type TaskFate = { kind: 'map'; ref: string } | { kind: 'drop' } | { kind: 'move' };

/** Where each old Task goes: onto a new template Task, onto the new Card, or nowhere. */
function retemplateFate(source: Task, taskMap: Record<string, string | null>, refs: Set<string>): TaskFate {
  const ref = Object.hasOwn(taskMap, source.id)
    ? taskMap[source.id]
    : (source.templateTaskRef && refs.has(source.templateTaskRef) ? source.templateTaskRef : undefined);
  if (ref === null) return { kind: 'drop' };
  if (ref !== undefined) {
    if (!refs.has(ref)) throw new Error(`Task ${source.id} maps to unknown ref ${ref}`);
    return { kind: 'map', ref };
  }
  return source.status === 'skipped' ? { kind: 'drop' } : { kind: 'move' };
}

/**
 * References a re-templated Card would leave behind. Files on a mapped Task
 * follow it to its target, files on a moved Task stay with it, and sponsor
 * deliverables follow the Card; a file on a dropped Task, or a calendar item
 * or another issue pointing at the Card, blocks the change.
 */
async function retemplateBlockers(client: DynamoDBDocumentClient, oldCard: Card, taskMap: Record<string, string | null>, refs: Set<string>) {
  const tasks = await listTasksByCardConsistent(client, oldCard.id);
  const dropped = tasks.filter((task) => retemplateFate(task, taskMap, refs).kind === 'drop');
  const blockers = await cardBlockingReferences(client, oldCard, dropped);
  const files = await scanRows(client, TABLE_FILES, 'FILE#');
  const droppedIds = new Set(dropped.map((task) => task.id));
  return {
    ...blockers,
    files: files.filter((row) => typeof row.taskId === 'string' && droppedIds.has(row.taskId)).map((row) => String(row.id)),
    sponsorDeliverables: [],
  };
}

async function scanRows(client: DynamoDBDocumentClient, tableName: string, prefix: string) {
  const rows: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': prefix },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    rows.push(...((page.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

/** Point files and sponsor deliverables of the old Card at the new one. */
async function repointReferences(client: DynamoDBDocumentClient, oldCard: Card, newCardId: string, taskTargets: Map<string, string>) {
  const oldTaskIds = new Set((await listTasksByCardConsistent(client, oldCard.id)).map((task) => task.id));
  const repointed: string[] = [];
  for (const row of await scanRows(client, TABLE_FILES, 'FILE#')) {
    const taskId = typeof row.taskId === 'string' ? row.taskId : null;
    const target = taskId ? taskTargets.get(taskId) : undefined;
    if (row.cardId !== oldCard.id && !target) continue;
    if (taskId && oldTaskIds.has(taskId) && !target) continue; // dropped: blocked earlier
    await client.send(new UpdateCommand({
      TableName: TABLE_FILES,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: target ? 'SET cardId = :card, taskId = :task' : 'SET cardId = :card',
      ExpressionAttributeValues: { ':card': newCardId, ...(target ? { ':task': target } : {}) },
    }));
    repointed.push(`file ${row.id}${target ? ` -> task ${target}` : ''}`);
  }
  for (const row of await scanRows(client, TABLE_SPONSOR_CRM, 'DELIVERABLE#')) {
    if (row.cardId !== oldCard.id) continue;
    await client.send(new UpdateCommand({
      TableName: TABLE_SPONSOR_CRM,
      Key: { PK: row.PK, SK: row.SK },
      UpdateExpression: 'SET cardId = :card',
      ExpressionAttributeValues: { ':card': newCardId },
    }));
    repointed.push(`deliverable ${row.id}`);
  }
  return repointed;
}

/** Replace a Card built from the wrong Template with the issue's new Card. */
async function retemplateCard(
  client: DynamoDBDocumentClient,
  oldCard: Card,
  newCard: Card,
  taskMap: Record<string, string | null>,
  actorId: string,
) {
  const newTasks = await listTasksByCardConsistent(client, newCard.id);
  const byRef = new Map(newTasks.filter((task) => task.templateTaskRef).map((task) => [task.templateTaskRef!, task]));
  const refs = new Set(byRef.keys());
  const carried: string[] = [];
  const moved: string[] = [];
  const dropped: string[] = [];
  const taskTargets = new Map<string, string>();
  // Carries run in dependency order: a target Task can only resolve once its
  // prerequisites have. A carry whose prerequisite never resolves moves the
  // old Task onto the new Card instead, so its evidence is kept.
  const pending: { source: Task; ref: string }[] = [];
  const toMove: Task[] = [];
  for (const source of await listTasksByCardConsistent(client, oldCard.id)) {
    const fate = retemplateFate(source, taskMap, refs);
    if (fate.kind === 'drop') {
      dropped.push(`${source.id} (${source.status})`);
    } else if (fate.kind === 'map') {
      taskTargets.set(source.id, byRef.get(fate.ref)!.id);
      if (['done', 'skipped'].includes(source.status)) pending.push({ source, ref: fate.ref });
      else dropped.push(`${source.id} -> ${fate.ref} (${source.status})`);
    } else {
      toMove.push(source);
    }
  }
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    const current = new Map((await listTasksByCardConsistent(client, newCard.id)).map((task) => [task.id, task]));
    const resolved = (id: string) => ['done', 'skipped'].includes(current.get(id)?.status || 'done');
    for (const item of [...pending]) {
      const target = current.get(byRef.get(item.ref)!.id)!;
      if (target.status !== 'todo') {
        pending.splice(pending.indexOf(item), 1);
        taskTargets.set(item.source.id, target.id);
        dropped.push(`${item.source.id} -> ${item.ref} (${item.source.status}, target ${target.status})`);
        progressed = true;
        continue;
      }
      if (!(target.dependsOn || []).every(resolved)) continue;
      await carryResolvedTask(client, item.source, target);
      carried.push(`${item.source.id} -> ${item.ref} (${item.source.status})`);
      pending.splice(pending.indexOf(item), 1);
      progressed = true;
    }
  }
  for (const item of pending) {
    taskTargets.delete(item.source.id);
    toMove.push(item.source);
  }
  // Prerequisite edges are per Card and the old Card is going away: clear
  // them before moving, as a Task with edges cannot change Card.
  for (const task of await listTasksByCardConsistent(client, oldCard.id)) {
    if (task.dependsOn?.length) {
      await updateTask(client, task.id, { expectedVersion: task.version, patch: { dependsOn: null } as any });
    }
  }
  const versions = new Map((await listTasksByCardConsistent(client, oldCard.id)).map((task) => [task.id, task.version]));
  for (const source of toMove) {
    await updateTask(client, source.id, { expectedVersion: versions.get(source.id)!, patch: { cardId: newCard.id } as any });
    moved.push(`${source.id} (${source.status})`);
  }
  const links = (oldCard.cardLinks || []).filter((link) => link.url);
  if (links.length) {
    await updateCardAdditive(client, (await getCardConsistent(client, newCard.id))!, (current) => {
      const next = [...(current.cardLinks || [])];
      for (const link of links) {
        const index = next.findIndex((entry) => entry.name === link.name);
        if (index >= 0 && next[index].url) continue;
        if (index >= 0) next[index] = { ...next[index], url: link.url };
        else next.push({ name: link.name, url: link.url });
      }
      return { cardLinks: next };
    });
  }
  const repointed = await repointReferences(client, oldCard, newCard.id, taskTargets);
  const current = (await getCardConsistent(client, oldCard.id))!;
  await deleteCardCascade(client, oldCard.id, current.version, actorId);
  return { carried, moved, dropped, repointed, movedLinks: links.map((link) => link.name), deletedCardId: oldCard.id };
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
  const existing = await getNewsletterIssue(client, id);
  if (existing) {
    // An interrupted retemplate: the issue and its new Card exist, the old Card is still there.
    if (planned.card.action !== 'retemplate' || !existing.cardId) return { id, outcome: 'exists' };
    const oldCard = await getCardConsistent(client, planned.card.cardId);
    if (!oldCard) return { id, outcome: 'exists' };
    const newCard = await getCardConsistent(client, existing.cardId);
    if (!newCard) throw new Error(`Issue ${id} Card ${existing.cardId} is missing`);
    if (dryRun) return { id, sourceKey, action: 'retemplate', outcome: 'resume-planned' };
    const retemplate = await retemplateCard(client, oldCard, newCard, planned.card.taskMap || {}, actor.id || 'system');
    for (const slotId of planned.slotIds) {
      await client.send(new DeleteCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: slotKey(slotId) }));
    }
    return { id, sourceKey, action: 'retemplate', cardId: newCard.id, retemplate, outcome: 'resumed' };
  }
  for (const slotId of planned.slotIds) {
    const row = (await client.send(new GetCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: slotKey(slotId) }))).Item;
    if (!row) throw new Error(`Slot row ${slotId} is missing`);
  }
  const issue = buildNewsletterIssue({ ...planned.issue } as any, id);
  const report: Record<string, unknown> = { id, sourceKey, action: planned.card.action };
  // A Card this issue deletes must have nothing else pointing at it; check
  // before writing anything so a blocked issue is left untouched.
  const doomedCardId = planned.card.action === 'merge'
    ? planned.card.mergeCardId
    : planned.card.action === 'retemplate' ? planned.card.cardId : null;
  if (doomedCardId) {
    const doomed = await getCardConsistent(client, doomedCardId);
    if (!doomed) throw new Error(`Card ${doomedCardId} is missing`);
    let blockers;
    if (planned.card.action === 'retemplate') {
      const template = await issueTemplate(client, { kind: planned.issue.kind });
      if (!template) throw new Error(`No ${planned.issue.kind} Template`);
      const refs = new Set((template.taskDefinitions || []).map((definition) => definition.refId));
      blockers = await retemplateBlockers(client, doomed, planned.card.taskMap || {}, refs);
    } else {
      blockers = await cardBlockingReferences(client, doomed, await listTasksByCardConsistent(client, doomed.id));
    }
    if (Object.values(blockers).some((ids) => ids.length > 0)) {
      throw new Error(`Card ${doomedCardId} is still referenced: ${JSON.stringify(blockers)}`);
    }
  }
  if (dryRun) return { ...report, outcome: 'planned' };

  if (planned.card.action === 'retemplate') {
    const oldCard = await getCardConsistent(client, planned.card.cardId);
    if (!oldCard) throw new Error(`Card ${planned.card.cardId} is missing`);
    const created = await createIssueCard(client, actor, issue);
    if (!created.ok) throw new Error(`Card for ${sourceKey}: ${created.response.body}`);
    report.cardId = created.card.id;
    report.retemplate = await retemplateCard(client, oldCard, created.card, planned.card.taskMap || {}, actor.id || 'system');
  } else if (planned.card.action === 'create') {
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
