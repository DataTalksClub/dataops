/**
 * One-off backfill: give existing Tasks and recurring configs `requires`, and
 * drop the free-form `systems` field it replaces.
 *
 * For each Task:
 * - a Task linked to a template step (`templateId` + `templateTaskRef`) takes
 *   the step's `requires` from the authored workflow template YAML in the
 *   private knowledge checkout; its `templateDefinitionSnapshot` gets the same
 *   value so a later template update does not read it as an operator override;
 * - any other Task (Trello imports, ad hoc, recurring) is inferred from its
 *   description and instruction document id. A recurring Task also keeps the
 *   known resource ids from its old `systems`, which came from its config.
 * Recurring configs keep their known `systems` ids plus inferred ones.
 * `systems` is removed everywhere, including inside the snapshot.
 *
 * Dry run against a production snapshot directory (tasks.json + templates.json,
 * as written by the read-only prod export); never writes:
 *   tsx scripts/backfill-task-requires.ts --snapshot ~/prod/dataops/<ts>
 *
 * Dry run / apply against a live table (AWS credentials, explicit table names):
 *   DATAOPS_TASKS_TABLE=dataops-v1-tasks DATAOPS_TEMPLATES_TABLE=dataops-v1-templates \
 *     tsx scripts/backfill-task-requires.ts [--apply]
 *
 * Options: `--templates-root <dir>` (authored workflow-templates; defaults to
 * DATAOPS_WORKFLOW_TEMPLATES_ROOT or ../dataops-knowledge/workflow-templates),
 * `--plan <file>` (write every planned change as JSON lines). The default is a
 * dry run; `--apply` writes with a per-item version/updatedAt condition.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import yaml from 'js-yaml';

import { listCards } from '../src/db/cards';
import { getClient } from '../src/db/client';
import { TABLE_TASKS } from '../src/db/tableNames';
import { listTemplates } from '../src/db/templates';
import { REQUIRED_RESOURCE_IDS } from '../src/resources/vocabulary';
import { findAuthoredTemplatesRoot } from '../src/templates/authoredTemplates';
import { inferRequires } from './required-resource-inference';

type Item = Record<string, any>;

export type RequiresSource = 'template' | 'template-name' | 'inferred' | 'existing';

export interface PlannedRequiresChange {
  pk: string;
  kind: 'task' | 'recurring-config';
  description: string;
  source: RequiresSource;
  from: { requires?: string[]; systems?: unknown };
  requires: string[];
  /** Template-linked Tasks also rewrite the definition snapshot. */
  snapshot: boolean;
}

/** Authored steps per template type: `requires` by task ref id and by normalised name. */
export interface AuthoredSteps {
  byRef: Map<string, string[]>;
  byName: Map<string, string[]>;
}
export type AuthoredRequires = Map<string, AuthoredSteps>;

/**
 * Normalise a task title for matching an imported Task to the template step it
 * was copied from: drop the `[Checklist]` tag, link and parenthetical noise,
 * `**– Owner**` hints and TODO markers.
 */
export function normaliseStepName(value: string): string {
  return value
    .replace(/^\s*\[[^\]]{1,60}\]\s*/, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\*\*[^*]*\*\*/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\btodo\b.*$/i, ' ')
    .replace(/\s+-\s+(update|one|two)\b.*$/i, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stepByName(steps: AuthoredSteps, description: unknown): string[] | undefined {
  const name = normaliseStepName(String(description || ''));
  if (name.length < 8) return undefined;
  const exact = steps.byName.get(name);
  if (exact) return exact;
  // A Trello item often extends or trims the authored name; accept a
  // whole-word prefix either way when it is long enough to be specific.
  for (const [authored, requires] of steps.byName) {
    const [shorter, longer] = authored.length <= name.length ? [authored, name] : [name, authored];
    if (shorter.length >= 15 && longer.startsWith(`${shorter} `)) return requires;
  }
  return undefined;
}

function knownIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => REQUIRED_RESOURCE_IDS.has(id)) : [];
}

function merge(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

function sameList(left: unknown, right: string[]): boolean {
  const current = Array.isArray(left) ? left : [];
  return current.length === right.length && current.every((value, index) => value === right[index]);
}

/**
 * Plan the backfill for raw table items (tasks table: TASK# and RECURRING#
 * rows) given each runtime template id's type and the authored requirements.
 */
export function planRequiresBackfill(
  items: Item[],
  templateTypes: Map<string, string>,
  authored: AuthoredRequires,
  cardTypes: Map<string, string> = new Map(),
): { changes: PlannedRequiresChange[]; scanned: { tasks: number; recurringConfigs: number }; unlinkedTemplateRefs: number } {
  const changes: PlannedRequiresChange[] = [];
  const scanned = { tasks: 0, recurringConfigs: 0 };
  let unlinkedTemplateRefs = 0;

  for (const item of items) {
    const pk = String(item.PK || '');
    const isTask = pk.startsWith('TASK#');
    const isConfig = pk.startsWith('RECURRING#');
    if (!isTask && !isConfig) continue;
    if (isTask) scanned.tasks += 1;
    else scanned.recurringConfigs += 1;

    let source: RequiresSource = 'inferred';
    let requires: string[];
    const type = isTask && item.templateId ? templateTypes.get(String(item.templateId)) : undefined;
    const step = type ? authored.get(type)?.byRef.get(String(item.templateTaskRef || '')) : undefined;
    const cardType = isTask && !step && item.cardId ? cardTypes.get(String(item.cardId)) : undefined;
    const cardSteps = cardType ? authored.get(cardType) : undefined;
    const named = cardSteps ? stepByName(cardSteps, item.description) : undefined;
    if (Array.isArray(item.requires)) {
      // Set since the field existed (template instantiation or an operator
      // edit): it is already authoritative. Only `systems` still goes.
      source = step ? 'template' : 'existing';
      requires = item.requires;
    } else if (step) {
      source = 'template';
      requires = step;
    } else if (named) {
      source = 'template-name';
      requires = named;
    } else {
      if (isTask && item.templateId) unlinkedTemplateRefs += 1;
      const inferred = inferRequires(item.description, item.instructionDocId);
      // Config `systems` (and the recurring Tasks generated from them) were
      // entered by hand; imported Task `systems` were card-wide and are noise.
      const kept = isConfig || item.source === 'recurring' ? knownIds(item.systems) : [];
      requires = merge(kept, inferred);
    }

    const snapshot = Boolean(isTask && step && item.templateDefinitionSnapshot);
    const snapshotStale = snapshot && (
      item.templateDefinitionSnapshot.systems !== undefined
      || !sameList(item.templateDefinitionSnapshot.requires, requires)
    );
    if (item.systems === undefined && sameList(item.requires, requires) && !snapshotStale) continue;
    changes.push({
      pk,
      kind: isTask ? 'task' : 'recurring-config',
      description: String(item.description || ''),
      source,
      from: {
        ...(item.requires !== undefined ? { requires: item.requires } : {}),
        ...(item.systems !== undefined ? { systems: item.systems } : {}),
      },
      requires,
      snapshot,
    });
  }
  return { changes, scanned, unlinkedTemplateRefs };
}

export function summarize(
  plan: ReturnType<typeof planRequiresBackfill>,
): Record<string, unknown> {
  const bySource: Record<string, number> = {};
  const byResource: Record<string, Record<RequiresSource, number>> = {};
  let empty = 0;
  let removesSystems = 0;
  for (const change of plan.changes) {
    bySource[`${change.kind}:${change.source}`] = (bySource[`${change.kind}:${change.source}`] || 0) + 1;
    if (change.requires.length === 0) empty += 1;
    if (change.from.systems !== undefined) removesSystems += 1;
    for (const id of change.requires) {
      byResource[id] ||= { template: 0, 'template-name': 0, inferred: 0, existing: 0 };
      byResource[id][change.source] += 1;
    }
  }
  const sortedResources = Object.fromEntries(
    Object.entries(byResource)
      .map(([id, counts]) => [id, { total: Object.values(counts).reduce((sum, count) => sum + count, 0), ...counts }] as const)
      .sort(([, a], [, b]) => b.total - a.total),
  );
  return {
    scanned: plan.scanned,
    planned: plan.changes.length,
    withRequires: plan.changes.length - empty,
    withoutRequires: empty,
    removesSystems,
    templateIdWithoutAuthoredStep: plan.unlinkedTemplateRefs,
    bySource,
    byResource: sortedResources,
  };
}

/**
 * Read each authored template's task `requires` straight from the YAML. Only
 * the type, task ids and `requires` matter here, so this does not depend on
 * the rest of the template schema the deploy validates.
 */
function authoredRequires(root: string): AuthoredRequires {
  const result: AuthoredRequires = new Map();
  for (const name of readdirSync(root).filter((file) => /\.ya?ml$/i.test(file)).sort()) {
    const doc = yaml.load(readFileSync(join(root, name), 'utf8'), { schema: yaml.JSON_SCHEMA }) as Item;
    const steps: AuthoredSteps = { byRef: new Map(), byName: new Map() };
    for (const task of (doc.tasks as Item[] | undefined) || []) {
      const requires = Array.isArray(task.requires) ? task.requires : [];
      const unknown = requires.filter((id: unknown) => !REQUIRED_RESOURCE_IDS.has(String(id)));
      if (unknown.length > 0) throw new Error(`${name}: task '${task.id}' requires unknown ${unknown.join(', ')}`);
      steps.byRef.set(String(task.id), requires);
      steps.byName.set(normaliseStepName(String(task.name || '')), requires);
    }
    result.set(String(doc.type), steps);
  }
  return result;
}

async function scanTaskTable(client: DynamoDBDocumentClient): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: 'begins_with(PK, :task) OR begins_with(PK, :recurring)',
      ExpressionAttributeValues: { ':task': 'TASK#', ':recurring': 'RECURRING#' },
      ExclusiveStartKey: start,
    }));
    items.push(...(page.Items || []));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return items;
}

async function applyChange(client: DynamoDBDocumentClient, change: PlannedRequiresChange, item: Item): Promise<void> {
  const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#systems': 'systems', '#requires': 'requires' };
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };
  const set = ['#updatedAt = :now'];
  const remove = ['#systems'];
  if (change.requires.length > 0) {
    set.push('#requires = :requires');
    values[':requires'] = change.requires;
  } else {
    remove.push('#requires');
  }
  if (change.snapshot) {
    names['#snapshot'] = 'templateDefinitionSnapshot';
    remove.push('#snapshot.#systems');
    if (change.requires.length > 0) set.push('#snapshot.#requires = :requires');
    else remove.push('#snapshot.#requires');
  }
  let condition: string;
  if (typeof item.version === 'number') {
    names['#version'] = 'version';
    values[':expected'] = item.version;
    values[':next'] = item.version + 1;
    set.push('#version = :next');
    condition = '#version = :expected';
  } else {
    values[':previousUpdatedAt'] = item.updatedAt;
    condition = '#updatedAt = :previousUpdatedAt';
  }
  await client.send(new UpdateCommand({
    TableName: TABLE_TASKS,
    Key: { PK: item.PK, SK: item.SK },
    UpdateExpression: `SET ${set.join(', ')} REMOVE ${remove.join(', ')}`,
    ConditionExpression: `attribute_exists(PK) AND ${condition}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

/**
 * The authored template type each Card was made from: its `templateId` when
 * it has one, else the type slug a Trello import put in its tags.
 */
export function cardTemplateTypes(
  cards: Item[],
  templateTypes: Map<string, string>,
  authored: AuthoredRequires,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const card of cards) {
    const fromTemplate = card.templateId ? templateTypes.get(String(card.templateId)) : undefined;
    const fromTags = Array.isArray(card.tags)
      ? card.tags.map(String).find((tag: string) => authored.has(tag))
      : undefined;
    const type = fromTemplate || fromTags;
    if (type && authored.has(type)) result.set(String(card.id), type);
  }
  return result;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const snapshotDir = option(args, '--snapshot');
  const planPath = option(args, '--plan');
  if (apply && snapshotDir) throw new Error('--apply writes the live table; it cannot be combined with --snapshot');

  const templatesRoot = option(args, '--templates-root') || findAuthoredTemplatesRoot(resolve(__dirname, '..', '..'));
  const authored = authoredRequires(templatesRoot);

  let items: Item[];
  let templates: Item[];
  let cards: Item[];
  let client: DynamoDBDocumentClient | null = null;
  if (snapshotDir) {
    items = JSON.parse(readFileSync(join(snapshotDir, 'tasks.json'), 'utf8'));
    templates = JSON.parse(readFileSync(join(snapshotDir, 'templates.json'), 'utf8'));
    cards = JSON.parse(readFileSync(join(snapshotDir, 'cards.json'), 'utf8'));
  } else {
    client = await getClient();
    items = await scanTaskTable(client);
    templates = await listTemplates(client) as unknown as Item[];
    cards = await listCards(client) as unknown as Item[];
  }
  const templateTypes = new Map(templates.map((template) => [String(template.id), String(template.type)]));

  const plan = planRequiresBackfill(items, templateTypes, authored, cardTemplateTypes(cards, templateTypes, authored));
  if (planPath) writeFileSync(planPath, plan.changes.map((change) => JSON.stringify(change)).join('\n') + '\n');
  const summary = summarize(plan);

  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', source: snapshotDir || TABLE_TASKS, ...summary }, null, 2));
    return;
  }

  const byPk = new Map(items.map((item) => [String(item.PK), item]));
  let applied = 0;
  const failed: string[] = [];
  for (const change of plan.changes) {
    try {
      await applyChange(client!, change, byPk.get(change.pk)!);
      applied += 1;
    } catch (error) {
      failed.push(`${change.pk}: ${(error as Error).name || 'error'}`);
    }
  }
  console.log(JSON.stringify({ mode: 'applied', ...summary, applied, failed }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
