import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_CARDS, TABLE_TASKS, TABLE_TEMPLATES } from './tableNames';
import { buildCard, cardKey, getCard } from './cards';
import { usesLocalTransactionEmulation } from './client';
import { compact, type PlannedWrite } from './plannedWrite';
import { createTask, listTasksByCard } from './tasks';
import type { Card, Template, Task } from '../types';
import { resolveTemplateConditionalValidation } from '../cards/conditionalRequired';
import { templateLinkage, templateTaskProjection } from '../templates/cardTemplateProjection';
import { prerequisitesFirst, templateDependencyIssues } from '../templates/taskDependencyGraph';
import { DEFINITION_FIELDS, TemplateDefinitionInvalidError, validateEffectiveDefinition } from '../templates/templateEdits';
import { loadAssignmentPolicy } from './workspaceSettings';

export class TemplateVersionConflictError extends Error {
  constructor() {
    super('Template version conflict');
    this.name = 'TemplateVersionConflictError';
  }
}

/** A `type` claimed by another template; creation and adoption fail closed. */
export class TemplateDuplicateTypeError extends Error {
  readonly templateType: string;

  constructor(type: string) {
    super(`Template type already exists: ${type}`);
    this.name = 'TemplateDuplicateTypeError';
    this.templateType = type;
  }
}

/** The caller proved a stale row identity; nothing was written. */
export class TemplateRevisionConflictError extends Error {
  constructor() {
    super('Template revision mismatch');
    this.name = 'TemplateRevisionConflictError';
  }
}

/** `type` names the template for its lifetime; edits cannot rename it. */
export class TemplateImmutableTypeError extends Error {
  constructor() {
    super('Template type is immutable');
    this.name = 'TemplateImmutableTypeError';
  }
}

export class TemplateEditForbiddenError extends Error {
  readonly code: 'cannot-reset-custom-template' | 'cannot-delete-git-template' | 'template-in-use';

  constructor(code: TemplateEditForbiddenError['code']) {
    super(code);
    this.name = 'TemplateEditForbiddenError';
    this.code = code;
  }
}

/**
 * Atomic `type` ownership for template creation, adoption, and deletion.
 * The guard shares the Templates table so no infrastructure changes, and its
 * `TEMPLATE_TYPE#` prefix matches no existing consumer: `listTemplates` and the
 * portable export scan `begins_with(PK, 'TEMPLATE#')` (`_` sorts away from
 * `#`), while `getTemplate` and every transaction address exact keys. Raw
 * DynamoDB backups carry guard rows as ordinary data and restore them
 * consistently.
 */
function typeGuardKey(type: string) {
  return { PK: `TEMPLATE_TYPE#${type}`, SK: `TEMPLATE_TYPE#${type}` };
}

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Template | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  if (!Number.isInteger(rest.version) || Number(rest.version) < 1) {
    throw new Error(`Template ${String(rest.id || PK || 'unknown')} is not in the canonical versioned shape`);
  }
  return rest as unknown as Template;
}

function templateKey(id: string) {
  return { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` };
}

function taskKey(id: string) {
  return { PK: `TASK#${id}`, SK: `TASK#${id}` };
}

let templateCreationTail: Promise<void> = Promise.resolve();

async function withTemplateCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = templateCreationTail;
  let release!: () => void;
  templateCreationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

type TemplateTransactItem =
  | { Put: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { Delete: { TableName: string; Key: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { ConditionCheck: { TableName: string; Key: Record<string, unknown>; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } };

function splitTopLevel(expression: string, operator: ' AND ' | ' OR '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function evalConditionAtom(
  clause: string,
  item: Record<string, unknown> | undefined,
  names: Record<string, string>,
  values: Record<string, unknown>,
): boolean {
  const exists = clause.match(/^attribute_(not_)?exists\((#\w+|\w+)\)$/);
  if (exists) {
    const attribute = exists[2].startsWith('#') ? (names[exists[2]] || exists[2]) : exists[2];
    const present = item !== undefined && (item as Record<string, unknown>)[attribute] !== undefined;
    return exists[1] ? !present : present;
  }
  const equality = clause.match(/^(#\w+|\w+|:\w+)\s*=\s*(:\w+)$/);
  if (equality) {
    if (equality[1].startsWith(':')) return values[equality[1]] === values[equality[2]];
    const attribute = equality[1].startsWith('#') ? (names[equality[1]] || equality[1]) : equality[1];
    return Boolean(item) && (item as Record<string, unknown>)[attribute] === values[equality[2]];
  }
  throw new Error(`Unsupported template transaction condition: ${clause}`);
}

function evalTransactCondition(
  expression: string,
  item: Record<string, unknown> | undefined,
  condition: { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> },
): boolean {
  let text = expression.trim();
  if (text.startsWith('(')) {
    let depth = 0;
    let outer = true;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') {
        depth -= 1;
        if (depth === 0 && index !== text.length - 1) { outer = false; break; }
      }
    }
    if (outer && depth === 0) text = text.slice(1, -1).trim();
  }
  const names = condition.ExpressionAttributeNames || {};
  const values = condition.ExpressionAttributeValues || {};
  const alternatives = splitTopLevel(text, ' OR ');
  if (alternatives.length > 1) {
    return alternatives.some((branch) => evalTransactCondition(branch, item, condition));
  }
  const clauses = splitTopLevel(text, ' AND ');
  if (clauses.length === 1 && clauses[0] === text) {
    return evalConditionAtom(text, item, names, values);
  }
  return clauses.every((clause) => evalTransactCondition(clause, item, condition));
}

function transactConditionHolds(
  item: Record<string, unknown> | undefined,
  condition: { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> },
): boolean {
  const expression = (condition.ConditionExpression || '').trim();
  if (!expression) return true;
  return evalTransactCondition(expression, item, condition);
}

async function readTransactTarget(
  client: DynamoDBDocumentClient,
  tableName: string,
  key: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
  return result.Item as Record<string, unknown> | undefined;
}

/**
 * Totally-ordered template-identity writes. Production uses a real
 * `TransactWriteCommand`; the local Dynalite emulator (which runs the whole
 * suite with transaction emulation enabled) serializes on the same
 * process-wide lock the card-creation emulation uses and evaluates exactly
 * the conditions this module emits. Anything else fails loudly instead of
 * half-applying.
 */
async function templateTransact(client: DynamoDBDocumentClient, items: TemplateTransactItem[]): Promise<void> {
  if (!usesLocalTransactionEmulation()) {
    try {
      await client.send(new TransactWriteCommand({ TransactItems: items as never }));
    } catch (error) {
      if ((error as Error).name === 'TransactionCanceledException') throw new TemplateVersionConflictError();
      throw error;
    }
    return;
  }
  await withTemplateCreationLock(async () => {
    const snapshots: Array<{ tableName: string; key: Record<string, unknown>; item: Record<string, unknown> | undefined; put: boolean }> = [];
    for (const entry of items) {
      if ('Put' in entry) {
        const current = await readTransactTarget(client, entry.Put.TableName, { PK: entry.Put.Item.PK, SK: entry.Put.Item.SK });
        if (!transactConditionHolds(current, entry.Put)) throw new TemplateVersionConflictError();
        snapshots.push({ tableName: entry.Put.TableName, key: { PK: entry.Put.Item.PK, SK: entry.Put.Item.SK }, item: current, put: true });
      } else if ('Delete' in entry) {
        const current = await readTransactTarget(client, entry.Delete.TableName, entry.Delete.Key);
        if (!transactConditionHolds(current, entry.Delete)) throw new TemplateVersionConflictError();
        snapshots.push({ tableName: entry.Delete.TableName, key: entry.Delete.Key, item: current, put: false });
      } else {
        const current = await readTransactTarget(client, entry.ConditionCheck.TableName, entry.ConditionCheck.Key);
        if (!transactConditionHolds(current, entry.ConditionCheck)) throw new TemplateVersionConflictError();
      }
    }
    let applied = 0;
    try {
      for (const entry of items) {
        if ('Put' in entry) {
          await client.send(new PutCommand({ TableName: entry.Put.TableName, Item: entry.Put.Item as Record<string, unknown> }));
        } else if ('Delete' in entry) {
          await client.send(new DeleteCommand({ TableName: entry.Delete.TableName, Key: entry.Delete.Key }));
        }
        applied += 1;
      }
    } catch (error) {
      for (const snapshot of snapshots.slice(0, applied).reverse()) {
        if (snapshot.item) {
          await client.send(new PutCommand({ TableName: snapshot.tableName, Item: snapshot.item }));
        } else if (snapshot.put) {
          await client.send(new DeleteCommand({ TableName: snapshot.tableName, Key: snapshot.key }));
        }
      }
      throw error;
    }
  });
}

async function emulateTemplateCardCreation(
  client: DynamoDBDocumentClient,
  template: Template,
  card: Card,
  tasks: Task[],
  companions: PlannedWrite[],
): Promise<void> {
  await withTemplateCreationLock(async () => {
    if (process.env.TEMPLATE_CARD_CREATE_TEST_TEMPLATE_RACE === 'true') {
      await client.send(new UpdateCommand({
        TableName: TABLE_TEMPLATES,
        Key: templateKey(template.id),
        UpdateExpression: 'SET #version = :nextVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':nextVersion': template.version + 1 },
      }));
    }
    const currentTemplate = await rawTemplate(client, template.id);
    if (!currentTemplate || currentTemplate.version !== template.version) {
      throw new TemplateVersionConflictError();
    }
    // The fenced counter production applies with `ADD #cardCreateSeq :one`.
    // Local emulation serializes on the same process-wide lock instead, so
    // the delete fence observes the same ordering in tests.
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: { ...currentTemplate, cardCreateSeq: Number(currentTemplate.cardCreateSeq ?? 0) + 1 },
    }));
    const writes = [
      { table: TABLE_CARDS, key: cardKey(card.id), item: { ...cardKey(card.id), ...card } },
      ...tasks.map((task) => ({
        table: TABLE_TASKS,
        key: taskKey(task.id),
        item: { ...taskKey(task.id), ...task },
      })),
    ];
    for (const write of writes) {
      const current = await client.send(new GetCommand({
        TableName: write.table,
        Key: write.key,
        ConsistentRead: true,
      }));
      if (current.Item) throw new Error(`Template Card entity already exists: ${String(write.key.PK)}`);
    }
    const companionRows: Array<Record<string, unknown> | undefined> = [];
    for (const write of companions) {
      const current = (await client.send(new GetCommand({
        TableName: write.tableName,
        Key: write.key,
        ConsistentRead: true,
      }))).Item as Record<string, unknown> | undefined;
      if (!write.holds(current)) {
        const error = new Error('Emulated transaction condition failed');
        error.name = 'TransactionCanceledException';
        throw error;
      }
      companionRows.push(current);
    }

    const applied: typeof writes = [];
    const appliedCompanions: number[] = [];
    try {
      for (const write of writes) {
        await client.send(new PutCommand({
          TableName: write.table,
          Item: compact(write.item) as Record<string, unknown>,
        }));
        applied.push(write);
        if (Number(process.env.TEMPLATE_CARD_CREATE_TEST_FAIL_AFTER || 0) === applied.length) {
          throw new Error('Injected Template Card creation transaction failure');
        }
      }
      for (const [index, write] of companions.entries()) {
        const next = write.after(companionRows[index] || {});
        if (next) await client.send(new PutCommand({ TableName: write.tableName, Item: next }));
        else await client.send(new DeleteCommand({ TableName: write.tableName, Key: write.key }));
        appliedCompanions.push(index);
      }
    } catch (error) {
      for (const index of appliedCompanions.reverse()) {
        const write = companions[index];
        const previous = companionRows[index];
        if (previous) await client.send(new PutCommand({ TableName: write.tableName, Item: previous }));
        else await client.send(new DeleteCommand({ TableName: write.tableName, Key: write.key }));
      }
      for (const write of applied.reverse()) {
        await client.send(new DeleteCommand({ TableName: write.table, Key: write.key }));
      }
      throw error;
    }
  });
}

async function rawTemplate(client: DynamoDBDocumentClient, id: string): Promise<Record<string, unknown> | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id), ConsistentRead: true }));
  return result.Item ? result.Item as Record<string, unknown> : null;
}

/**
 * Create a new template. Generates a UUID, sets createdAt/updatedAt.
 *
 * Test and local-dev fixtures are always written in canonical shape, so
 * production routes (which require `revision` + `expectedVersion`) work on
 * them exactly as on seeded rows: `origin` defaults from Git provenance,
 * `pinned` defaults to false, and Git rows carry `base`/`baseSourceRevision`.
 */
async function createTemplate(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Template> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const origin = typeof data.origin === 'string'
    ? data.origin
    : (data.sourcePath || data.sourceRevision ? 'git' : 'custom');

  const item = {
    PK: `TEMPLATE#${id}`,
    SK: `TEMPLATE#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
    origin,
    pinned: data.pinned ?? false,
    revision: typeof data.revision === 'string' && data.revision ? data.revision : crypto.randomUUID(),
    ...(origin === 'git' && data.base === undefined
      ? {
        base: { ...definitionFieldsOf(data) },
        baseSourceRevision: (data.baseSourceRevision as string | undefined)
          ?? (data.sourceRevision as string | undefined) ?? null,
      }
      : {}),
    version: 1,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: item,
    })
  );

  return cleanItem(item) as Template;
}

/**
 * Get a template by id.
 */
async function getTemplate(client: DynamoDBDocumentClient, id: string): Promise<Template | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` },
      ConsistentRead: true,
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/** Test/local helper. Production definitions are replaced from Git. */
async function updateTemplate(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Template | null> {
  const current = await getTemplate(client, id);
  if (!current) return null;
  const now = new Date().toISOString();
  const expressionParts: string[] = [];
  const names: Record<string, string> = { '#version': 'version' };
  const values: Record<string, unknown> = { ':expectedVersion': current.version, ':one': 1 };
  let index = 0;
  for (const [key, value] of Object.entries({ ...updates, updatedAt: now })) {
    const name = `#field${index}`;
    const token = `:value${index}`;
    names[name] = key;
    values[token] = value;
    expressionParts.push(`${name} = ${token}`);
    index++;
  }
  expressionParts.push('#version = #version + :one');
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_TEMPLATES,
      Key: templateKey(id),
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return cleanItem(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
    throw error;
  }
}

/**
 * Every runtime mutation proves the row's canonical identity in the same
 * conditional write that changes it. Non-canonical rows lacking a matching
 * `(expectedVersion, revision)` pair fail closed with zero writes.
 */
function checkWritePair(
  current: Record<string, unknown>,
  expectedVersion: number,
  revision: string,
): void {
  if (current.version !== expectedVersion) throw new TemplateVersionConflictError();
  if (current.revision !== revision) throw new TemplateRevisionConflictError();
}

function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definitionFieldsOf(item: Record<string, unknown>): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  for (const field of DEFINITION_FIELDS) {
    if (item[field] !== undefined) definition[field] = item[field];
  }
  return definition;
}

/**
 * Build the next stored item with top-level definition fields taken exactly
 * from `definition`. Removed fields must not survive as stale database
 * authority, so nothing outside identity, creation history, the delete
 * fence, and the supplied definition carries over.
 */
function effectiveItemFromDefinition(
  current: Record<string, unknown>,
  definition: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    PK: current.PK,
    SK: current.SK,
    id: current.id,
    createdAt: current.createdAt,
    ...definitionFieldsOf(definition),
    revision: current.revision,
    origin: current.origin,
    updatedAt: new Date().toISOString(),
    version: Number(current.version) + 1,
    ...extra,
  };
  // The row's Git provenance survives pins and resets; only the seed moves it.
  if (item.sourcePath === undefined && current.sourcePath !== undefined) item.sourcePath = current.sourcePath;
  if (item.sourceRevision === undefined && current.sourceRevision !== undefined) {
    item.sourceRevision = current.sourceRevision;
  }
  // An operator pin never discards the Git base it shadows; the seed sets
  // both fields explicitly when they change.
  if (item.base === undefined && current.base !== undefined) item.base = current.base;
  if (item.baseSourceRevision === undefined && current.baseSourceRevision !== undefined) {
    item.baseSourceRevision = current.baseSourceRevision;
  }
  if (current.cardCreateSeq !== undefined) item.cardCreateSeq = current.cardCreateSeq;
  return item;
}

async function conditionalPutTemplate(
  client: DynamoDBDocumentClient,
  item: Record<string, unknown>,
  expectedVersion: number,
): Promise<void> {
  try {
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: item,
      ConditionExpression: 'attribute_exists(#pk) AND #version = :expectedVersion',
      ExpressionAttributeNames: { '#pk': 'PK', '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
    }));
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') throw new TemplateVersionConflictError();
    throw error;
  }
}

/**
 * Ensure the `TEMPLATE_TYPE#` guard for an existing row. The guard claim is
 * fenced on the template row itself, so a guard is never created for a
 * concurrently deleted template, and a guard owned by another row fails
 * loudly instead of silently merging two types.
 */
async function ensureTypeGuard(
  client: DynamoDBDocumentClient,
  type: string,
  templateId: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await templateTransact(client, [
      {
        ConditionCheck: {
          TableName: TABLE_TEMPLATES,
          Key: templateKey(templateId),
          ConditionExpression: 'attribute_exists(PK)',
        },
      },
      {
        Put: {
          TableName: TABLE_TEMPLATES,
          Item: { ...typeGuardKey(type), templateId, createdAt: now },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ]);
  } catch (error) {
    if (!(error instanceof TemplateVersionConflictError)) throw error;
    const result = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES, Key: typeGuardKey(type), ConsistentRead: true,
    }));
    const owner = (result.Item as Record<string, unknown> | undefined)?.templateId;
    if (owner === templateId) return;
    throw new TemplateDuplicateTypeError(type);
  }
}

/** Claim a `type` and store its template atomically; losers fail closed. */
async function createTemplateWithGuard(
  client: DynamoDBDocumentClient,
  fields: Record<string, unknown>,
  type: string,
): Promise<Template> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const item = {
    ...templateKey(id),
    id,
    createdAt: now,
    updatedAt: now,
    ...fields,
    revision: crypto.randomUUID(),
    version: 1,
  };
  const guard = { ...typeGuardKey(type), templateId: id, createdAt: now };
  try {
    await templateTransact(client, [
      { Put: { TableName: TABLE_TEMPLATES, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: TABLE_TEMPLATES, Item: guard, ConditionExpression: 'attribute_not_exists(PK)' } },
    ]);
  } catch (error) {
    if (error instanceof TemplateVersionConflictError) throw new TemplateDuplicateTypeError(type);
    throw error;
  }
  // Least surprise on a failed template write: never leave a guard with no row.
  return cleanItem(item) as Template;
}

/**
 * Create an API-custom template. The `type` must be unused across all
 * existing rows (strongly-consistent scan) before the guard claim
 * serializes concurrent creators.
 */
async function createCustomTemplate(
  client: DynamoDBDocumentClient,
  definition: Record<string, unknown>,
): Promise<Template> {
  const issues = validateEffectiveDefinition(definition);
  if (issues.length > 0) throw new TemplateDefinitionInvalidError(issues);
  const type = String(definition.type);
  const existing = await listTemplates(client);
  if (existing.some((template) => template.type === type)) {
    throw new TemplateDuplicateTypeError(type);
  }
  // Claim guards for any unguarded existing rows before claiming the new type,
  // so an unguarded row can never race this creation into a duplicate effective type.
  for (const row of existing) {
    if (row.type) await ensureTypeGuard(client, row.type, row.id);
  }
  return createTemplateWithGuard(client, { ...definitionFieldsOf(definition), origin: 'custom', pinned: false }, type);
}

/**
 * Pin a whole validated effective definition over a template. Identity
 * (`id`, `type`), seed authority (`origin`, `base`, `sourcePath`,
 * `sourceRevision`) and history survive; everything else is the operator's
 * definition. Single conditional write: concurrent seeds or editors lose
 * with a 409, never interleave.
 */
async function writeTemplateDefinition(
  client: DynamoDBDocumentClient,
  id: string,
  definition: Record<string, unknown>,
  expectedVersion: number,
  revision: string,
): Promise<Template | null> {
  const raw = await rawTemplate(client, id);
  if (!raw) return null;
  checkWritePair(raw, expectedVersion, revision);
  if (definition.type !== raw.type) throw new TemplateImmutableTypeError();
  const issues = validateEffectiveDefinition(definition);
  if (issues.length > 0) throw new TemplateDefinitionInvalidError(issues);
  const item = effectiveItemFromDefinition(raw, definition, {
    pinned: raw.origin === 'git',
  });
  await conditionalPutTemplate(client, item, expectedVersion);
  return cleanItem(item) as Template;
}

/** Seed write: merge server-computed fields over a row in one conditional write. */
async function writeSeedTemplateFields(
  client: DynamoDBDocumentClient,
  id: string,
  patch: Record<string, unknown>,
  expectedVersion: number,
): Promise<Template> {
  const raw = await rawTemplate(client, id);
  if (!raw) throw new TemplateVersionConflictError();
  if (raw.version !== expectedVersion) throw new TemplateVersionConflictError();
  const item = { ...raw, ...patch, updatedAt: new Date().toISOString(), version: expectedVersion + 1 };
  await conditionalPutTemplate(client, item, expectedVersion);
  return cleanItem(item) as Template;
}

/** Seed replace: the unpinned top level becomes exactly the new Git base. */
async function replaceSeedTemplate(
  client: DynamoDBDocumentClient,
  id: string,
  fields: Record<string, unknown>,
  expectedVersion: number,
): Promise<Template> {
  const raw = await rawTemplate(client, id);
  if (!raw) throw new TemplateVersionConflictError();
  if (raw.version !== expectedVersion) throw new TemplateVersionConflictError();
  if (typeof raw.revision !== 'string' || raw.revision.length === 0) {
    throw new TemplateRevisionConflictError();
  }
  const item = effectiveItemFromDefinition(raw, fields, {
    origin: 'git',
    pinned: false,
    base: { ...definitionFieldsOf(fields) },
    baseSourceRevision: (fields.sourceRevision as string | undefined) ?? null,
  });
  await conditionalPutTemplate(client, item, expectedVersion);
  return cleanItem(item) as Template;
}

async function resetTemplateOverride(
  client: DynamoDBDocumentClient,
  id: string,
  expectedVersion: number,
  revision: string,
): Promise<{ template: Template; applied: boolean } | null> {
  const raw = await rawTemplate(client, id);
  if (!raw) return null;
  checkWritePair(raw, expectedVersion, revision);
  if (raw.origin !== 'git' || !isDict(raw.base)) {
    throw new TemplateEditForbiddenError('cannot-reset-custom-template');
  }
  if (!raw.pinned) return { template: cleanItem(raw) as Template, applied: false };
  const base = raw.base as Record<string, unknown>;
  const item = effectiveItemFromDefinition(raw, base, { pinned: false });
  await conditionalPutTemplate(client, item, expectedVersion);
  return { template: cleanItem(item) as Template, applied: true };
}

async function templateInUse(client: DynamoDBDocumentClient, id: string): Promise<boolean> {
  const result = await client.send(new ScanCommand({
    TableName: TABLE_CARDS,
    FilterExpression: 'templateId = :id',
    ExpressionAttributeValues: { ':id': id },
    Limit: 1,
    Select: 'COUNT',
    ConsistentRead: true,
  }));
  return (result.Count || 0) > 0;
}

/**
 * Delete an unused custom template and release its `type` atomically.
 * Only canonical `origin === 'custom'` templates with a matching
 * `(expectedVersion, revision)` pair and zero referencing Cards may be
 * deleted; Git-origin or unclassified rows fail closed.
 */
async function deleteCustomTemplate(
  client: DynamoDBDocumentClient,
  id: string,
  expectedVersion: number,
  revision: string,
): Promise<Template | null> {
  const raw = await rawTemplate(client, id);
  if (!raw) return null;
  const current = raw;
  checkWritePair(current, expectedVersion, revision);
  if (current.origin !== 'custom') {
    throw new TemplateEditForbiddenError('cannot-delete-git-template');
  }
  // Read the fence counter before the in-use scan: a Card created after this
  // read bumps the counter and fails the delete's condition, so the scan and
  // the delete cannot straddle a creation into an orphaned Card.
  const expectedSeq = Number((current.cardCreateSeq as number | undefined) ?? 0);
  if (await templateInUse(client, id)) {
    throw new TemplateEditForbiddenError('template-in-use');
  }
  const revisionFence = '#revision = :expectedRevision';
  const items: TemplateTransactItem[] = [{
    Delete: {
      TableName: TABLE_TEMPLATES,
      Key: templateKey(id),
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion AND ' + revisionFence
        + ' AND (#cardCreateSeq = :expectedSeq OR (attribute_not_exists(#cardCreateSeq) AND :expectedSeq = :zero))',
      ExpressionAttributeNames: { '#version': 'version', '#revision': 'revision', '#cardCreateSeq': 'cardCreateSeq' },
      ExpressionAttributeValues: {
        ':expectedVersion': expectedVersion,
        ':expectedRevision': revision,
        ':expectedSeq': expectedSeq,
        ':zero': 0,
      },
    },
  }];
  if (typeof current.type === 'string' && current.type) {
    const guard = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES, Key: typeGuardKey(current.type), ConsistentRead: true,
    }));
    if ((guard.Item as Record<string, unknown> | undefined)?.templateId === id) {
      items.push({
        Delete: {
          TableName: TABLE_TEMPLATES,
          Key: typeGuardKey(current.type),
          ConditionExpression: 'attribute_exists(PK) AND templateId = :templateId',
          ExpressionAttributeValues: { ':templateId': id },
        },
      });
    }
  }
  try {
    await templateTransact(client, items);
  } catch (error) {
    if (error instanceof TemplateVersionConflictError) {
      const reread = await rawTemplate(client, id);
      if (!reread) return null;
    }
    throw error;
  }
  return cleanItem(current) as Template;
}

/** Test/local cleanup helper. Production template deletion is not a runtime operation. */
async function deleteTemplate(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(new DeleteCommand({ TableName: TABLE_TEMPLATES, Key: templateKey(id) }));
}

/**
 * List all templates by scanning for items where PK begins with "TEMPLATE#".
 */
async function listTemplates(client: DynamoDBDocumentClient): Promise<Template[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_TEMPLATES,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'TEMPLATE#' },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map((item) => cleanItem(item) as Template);
}

/**
 * Keep only the task definitions a Card wants: ungrouped tasks always
 * instantiate, while grouped tasks need their group in the selection.
 */
function selectTaskDefinitions(
  definitions: Template['taskDefinitions'],
  selectedGroups?: string[],
): NonNullable<Template['taskDefinitions']> {
  const all = definitions || [];
  const selected = new Set(selectedGroups || []);
  return all.filter((definition) => !definition.optionalGroup || selected.has(definition.optionalGroup));
}

/**
 * Task ids for a Card's definitions, known before any Task is written so a
 * dependent can name its prerequisites' ids. Invalid dependencies stop the
 * Card here instead of producing Tasks that could never complete.
 */
function taskIdsByRef(
  definitions: NonNullable<Template['taskDefinitions']>,
  idFor: (refId: string) => string,
): Map<string, string> {
  const issues = templateDependencyIssues(definitions);
  if (issues.length > 0) throw new Error(`Template task dependencies are invalid: ${issues.join('; ')}`);
  return new Map(definitions.map((definition) => [definition.refId, idFor(definition.refId)]));
}

/**
 * Instantiate a template: fetch the template, and for each selected
 * taskDefinition create a task with a calculated date (anchorDate +
 * offsetDays). Without an explicit selection the Card's stored selection
 * applies, so recovery never resurrects a deselected group.
 */
async function instantiateTemplate(
  client: DynamoDBDocumentClient,
  templateId: string,
  cardId: string,
  anchorDate: string,
  selectedGroups?: string[],
): Promise<Task[]> {
  const stored = await getTemplate(client, templateId);
  if (!stored) {
    throw new Error(`Template not found: ${templateId}`);
  }
  const template = await resolveTemplateConditionalValidation(client, stored, anchorDate);

  let groups = selectedGroups;
  if (groups === undefined) {
    const card = await getCard(client, cardId);
    groups = card?.selectedOptionalGroups;
  }
  const taskDefinitions = selectTaskDefinitions(template.taskDefinitions, groups);
  const existingTasks = await listTasksByCard(client, cardId);
  const existingRefs = new Set(
    existingTasks
      .filter((task) => task.templateId === templateId && task.templateTaskRef)
      .map((task) => task.templateTaskRef as string)
  );
  const existingIds = new Map(
    existingTasks
      .filter((task) => task.templateId === templateId && task.templateTaskRef)
      .map((task) => [task.templateTaskRef as string, task.id]),
  );
  const idsByRef = taskIdsByRef(taskDefinitions, (ref) => existingIds.get(ref) || crypto.randomUUID());
  const createdTasks: Task[] = [];
  const assignment = await loadAssignmentPolicy(client, taskDefinitions.map(({ assigneeId }) => assigneeId));

  // Prerequisites are written first so each dependent finds them present.
  for (const def of prerequisitesFirst(taskDefinitions)) {
    if (existingRefs.has(def.refId)) {
      continue;
    }

    const order = taskDefinitions.indexOf(def);
    const taskData = {
      id: idsByRef.get(def.refId),
      ...templateTaskProjection(template, def, order, anchorDate, cardId, assignment, idsByRef),
    };

    const task = await createTask(client, taskData);

    existingRefs.add(def.refId);
    createdTasks.push(task);
  }

  return createdTasks;
}

/**
 * Create a Template-backed Card and projected Tasks as one aggregate.
 * `companions` are writes of the record that owns the Card (a newsletter
 * issue), committed in the same transaction so neither exists without the
 * other.
 */
async function createCardFromTemplate(
  client: DynamoDBDocumentClient,
  cardData: Record<string, unknown>,
  template: Template,
  anchorDate: string,
  selectedGroups?: string[],
  companions: (card: Card) => PlannedWrite[] = () => [],
): Promise<{ card: Card; tasks: Task[] }> {
  const resolved = await resolveTemplateConditionalValidation(client, template, anchorDate);
  const definitions = selectTaskDefinitions(resolved.taskDefinitions, selectedGroups);
  Object.assign(cardData, templateLinkage(resolved, selectedGroups || []));
  const card = buildCard(cardData, {
    taskCount: definitions.length,
    openTaskCount: definitions.length,
  });
  const now = card.createdAt;
  const assignment = await loadAssignmentPolicy(client, definitions.map(({ assigneeId }) => assigneeId));
  const idsByRef = taskIdsByRef(definitions, () => crypto.randomUUID());
  const tasks = definitions.map((definition, order) => compact({
    id: idsByRef.get(definition.refId),
    version: 1,
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
    ...templateTaskProjection(resolved, definition, order, anchorDate, card.id, assignment, idsByRef),
  }) as Task);

  const companionWrites = companions(card);
  // Card Put + Template fenced Update + one Put per Task + the owner's writes.
  // The Update both verifies the Template version and bumps its
  // `cardCreateSeq`, so a template delete racing this creation either
  // committed first (and this transaction loses its condition) or loses its
  // own seq fence. Either way exactly one side wins; there is no orphan Card.
  const itemCount = 2 + tasks.length + companionWrites.length;
  if (itemCount > 100) {
    throw new RangeError(`Template Card creation requires ${itemCount} transaction items; maximum is 100`);
  }

  if (usesLocalTransactionEmulation()) {
    await emulateTemplateCardCreation(client, resolved, card, tasks, companionWrites);
    return { card, tasks };
  }

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_CARDS,
            Item: compact({ ...cardKey(card.id), ...card }) as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_TEMPLATES,
            Key: templateKey(template.id),
            UpdateExpression: 'ADD #cardCreateSeq :one',
            ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
            ExpressionAttributeNames: { '#version': 'version', '#cardCreateSeq': 'cardCreateSeq' },
            ExpressionAttributeValues: { ':expectedVersion': template.version, ':one': 1 },
          },
        },
        ...tasks.map((task) => ({
          Put: {
            TableName: TABLE_TASKS,
            Item: compact({ ...taskKey(task.id), ...task }) as Record<string, unknown>,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
        ...companionWrites.map((write) => write.item),
      ],
    }));
  } catch (error) {
    if ((error as Error).name === 'TransactionCanceledException') {
      const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons || [];
      if (reasons[1]?.Code === 'ConditionalCheckFailed') throw new TemplateVersionConflictError();
      const currentTemplate = await rawTemplate(client, template.id);
      if (!currentTemplate || currentTemplate.version !== template.version) {
        throw new TemplateVersionConflictError();
      }
    }
    throw error;
  }
  return { card, tasks };
}

/**
 * Remove a Template-backed Card and its Tasks that were just created and never
 * touched, e.g. when linking the new Card to its owning record fails. Each
 * delete is conditional on the created version, so work done on the Card in
 * the meantime is never discarded.
 */
async function discardCreatedTemplateCard(
  client: DynamoDBDocumentClient,
  card: Card,
  tasks: Task[],
): Promise<void> {
  const deletes = [
    ...tasks.map((task) => ({ table: TABLE_TASKS, key: taskKey(task.id), version: task.version })),
    { table: TABLE_CARDS, key: cardKey(card.id), version: card.version },
  ];
  for (const entry of deletes) {
    await client.send(new DeleteCommand({
      TableName: entry.table,
      Key: entry.key,
      ConditionExpression: '#version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': entry.version },
    }));
  }
}

export {
  createTemplate,
  createCustomTemplate,
  createTemplateWithGuard,
  writeSeedTemplateFields,
  replaceSeedTemplate,
  writeTemplateDefinition,
  resetTemplateOverride,
  ensureTypeGuard,
  templateTransact,
  definitionFieldsOf,
  typeGuardKey,
  discardCreatedTemplateCard,
  getTemplate,
  updateTemplate,
  deleteCustomTemplate,
  deleteTemplate,
  listTemplates,
  instantiateTemplate,
  createCardFromTemplate,
};
