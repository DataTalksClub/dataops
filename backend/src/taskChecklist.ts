import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createTask, getTaskConsistent } from './db/tasks';
import {
  ContentRootUnavailableError,
  createKnowledgeStore,
  KnowledgeStore,
  knowledgeStoreConfigFromEnv,
} from './docs/knowledgeStore';
import { buildRegistry, LookupError, resolveReference } from './docs/docRegistry';
import { parse, splitFrontmatter } from './docs/sop';
import type { Task, TaskChecklistItem } from './types';
import { berlinToday } from './relativeDates';

export const EVENT_RESCHEDULE_CHECKLIST_ID =
  'checklist.events.rescheduling.checklist-document-for-rescheduling-events';

const MAX_CHECKLIST_ITEMS = 100;
const MAX_CHECKLIST_ITEM_LENGTH = 1000;

export interface ChecklistItemSource {
  id: string;
  text: string;
  instructionDocId?: string;
  instructionStepId?: string;
  sourceStepId: string;
}

export interface ChecklistDefinition {
  id: string;
  title: string;
  path: string;
  items: ChecklistItemSource[];
}

export class TaskChecklistSourceError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'TaskChecklistSourceError';
  }
}

let checklistStore: KnowledgeStore | null = null;

/** Test seam for a private knowledge corpus; production uses the Lambda role and configured bucket. */
export function configureTaskChecklistStore(store: KnowledgeStore | null): void {
  checklistStore = store;
}

function sourceStore(): KnowledgeStore {
  checklistStore ||= createKnowledgeStore(knowledgeStoreConfigFromEnv());
  return checklistStore;
}

function procedureSteps(content: string, definition: ChecklistDefinition): Array<{ id: string; body: string; attrs: Record<string, unknown> }> {
  let parsed;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new TaskChecklistSourceError(
      `Checklist ${definition.id} could not be parsed: ${error instanceof Error ? error.message : 'invalid document'}`,
      422,
    );
  }

  const procedure = parsed.sections.procedure;
  if (procedure && 'groups' in procedure && !procedure.raw) {
    const steps = [
      ...procedure.groups.flatMap((group) => group.steps),
      ...procedure.flat_steps,
    ];
    if (steps.length) {
      return steps.map((step) => ({
        id: String(step.id),
        body: step.body_md,
        attrs: step.attrs as Record<string, unknown>,
      }));
    }
  }

  // Legacy checklist documents may not have SOP boundary markers yet. Keep
  // their ordered Markdown list usable until the corpus has migrated.
  const [, body] = splitFrontmatter(content);
  const rows = body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:[-*+]\s+\[[ xX]\]\s+|\d+[.)]\s+)(.+?)\s*$/);
    return match ? [match[1]] : [];
  });
  return rows.map((text, index) => ({ id: String(index + 1), body: text, attrs: {} }));
}

function markdownTargets(body: string): Array<{ ref: string; stepId?: string }> {
  const targets: Array<{ ref: string; stepId?: string }> = [];
  for (const match of body.matchAll(/\[\[(?:doc:)?([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    targets.push({ ref: match[1].trim() });
  }
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    const hashIndex = target.indexOf('#');
    const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';
    target = target.split(/[?#]/, 1)[0];
    if (!target) continue;
    targets.push({ ref: target, ...(fragment ? { stepId: fragment } : {}) });
  }
  return targets;
}

function docReference(registry: ReturnType<typeof buildRegistry>, sourcePath: string, ref: string) {
  const clean = ref.trim();
  const resolvedPath = clean.endsWith('.md')
    ? clean.startsWith('/')
      ? clean.slice(1)
      : posix.normalize(posix.join(posix.dirname(sourcePath), clean))
    : clean;
  try {
    return resolveReference(registry, resolvedPath);
  } catch (error) {
    if (error instanceof LookupError) return null;
    throw error;
  }
}

function instructionForStep(
  registry: ReturnType<typeof buildRegistry>,
  checklistPath: string,
  body: string,
  attrs: Record<string, unknown>,
): { instructionDocId?: string; instructionStepId?: string } {
  const attrRef = [attrs.instructionDocId, attrs.instruction_doc_id, attrs.sop, attrs.doc]
    .find((value) => typeof value === 'string' && value.trim());
  const candidates = [
    ...(typeof attrRef === 'string' ? [{ ref: attrRef }] : []),
    ...markdownTargets(body),
  ];
  for (const target of candidates) {
    const doc = docReference(registry, checklistPath, target.ref);
    if (!doc || !['sop', 'checklist'].includes(doc.doc_type)) continue;
    const instructionStepId = target.stepId || (typeof attrs.instructionStepId === 'string'
      ? attrs.instructionStepId
      : typeof attrs.instruction_step_id === 'string'
        ? attrs.instruction_step_id
        : undefined);
    return {
      instructionDocId: doc.id,
      ...(instructionStepId ? { instructionStepId } : {}),
    };
  }
  return {};
}

function checklistItemText(body: string): string {
  return body
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/[\*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadTaskChecklistDefinition(reference: string): Promise<ChecklistDefinition> {
  const ref = reference.trim();
  if (!ref) throw new TaskChecklistSourceError('checklistDocId must be a non-empty KB checklist id');

  const store = sourceStore();
  await store.sync();
  if (!existsSync(store.contentRoot)) throw new ContentRootUnavailableError(store.contentRoot);

  let record;
  try {
    record = resolveReference(buildRegistry(store.contentRoot), ref);
  } catch (error) {
    if (error instanceof LookupError) throw new TaskChecklistSourceError(error.message, 404);
    throw error;
  }
  if (record.doc_type !== 'checklist') {
    throw new TaskChecklistSourceError(`Document ${record.id} is ${record.doc_type}, not a checklist`);
  }

  const definition = { id: record.id, title: record.title, path: record.path, items: [] } satisfies ChecklistDefinition;
  const content = await store.readFile(record.path);
  const registry = buildRegistry(store.contentRoot);
  const items = procedureSteps(content, definition).map((step) => {
    const text = checklistItemText(step.body);
    if (!text) return null;
    if (text.length > MAX_CHECKLIST_ITEM_LENGTH) {
      throw new TaskChecklistSourceError(`Checklist ${record.id} item ${step.id} exceeds ${MAX_CHECKLIST_ITEM_LENGTH} characters`);
    }
    return {
      id: `kb-${step.id}`,
      text,
      sourceStepId: step.id,
      ...instructionForStep(registry, record.path, step.body, step.attrs),
    } satisfies ChecklistItemSource;
  }).filter((item): item is ChecklistItemSource => item !== null);
  if (!items.length) throw new TaskChecklistSourceError(`Checklist ${record.id} has no actionable items`, 422);
  if (items.length > MAX_CHECKLIST_ITEMS) {
    throw new TaskChecklistSourceError(`Checklist ${record.id} has more than ${MAX_CHECKLIST_ITEMS} items`);
  }
  return { ...definition, items };
}

export function makeInlineChecklistItems(values: unknown): TaskChecklistItem[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TaskChecklistSourceError('inlineChecklistItems must be an array of text');
  if (values.length > MAX_CHECKLIST_ITEMS) throw new TaskChecklistSourceError(`A Task checklist can have at most ${MAX_CHECKLIST_ITEMS} items`);
  return values.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TaskChecklistSourceError(`inlineChecklistItems[${index}] must be non-empty text`);
    }
    const text = value.trim();
    if (text.length > MAX_CHECKLIST_ITEM_LENGTH) {
      throw new TaskChecklistSourceError(`inlineChecklistItems[${index}] exceeds ${MAX_CHECKLIST_ITEM_LENGTH} characters`);
    }
    return { id: `inline-${index + 1}`, text, checked: false };
  });
}

export function taskChecklistItems(
  definition: ChecklistDefinition | null,
  inlineItems: TaskChecklistItem[] = [],
): TaskChecklistItem[] {
  const copied = definition?.items.map((item) => ({ ...item, checked: false })) || [];
  const items = [...copied, ...inlineItems];
  if (items.length > MAX_CHECKLIST_ITEMS) {
    throw new TaskChecklistSourceError(`A Task checklist can have at most ${MAX_CHECKLIST_ITEMS} items`);
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new TaskChecklistSourceError('Checklist item ids must be unique');
  }
  return items;
}

function deterministicTaskId(sourceKey: string): string {
  const bytes = createHash('sha256').update(`dataops-task:${sourceKey}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureEventRescheduleTask(
  client: DynamoDBDocumentClient,
  input: {
    sourceKey: string;
    title: string;
    date: string;
    actorId?: string;
    checklist?: ChecklistDefinition;
  },
): Promise<Task> {
  const source = `event-reschedule:${input.sourceKey}`;
  const id = deterministicTaskId(source);
  const existing = await getTaskConsistent(client, id);
  if (existing) {
    if (existing.source !== source) throw new Error(`Task id collision for event reschedule ${input.sourceKey}`);
    return existing;
  }

  const definition = input.checklist || await loadTaskChecklistDefinition(EVENT_RESCHEDULE_CHECKLIST_ID);
  const items = taskChecklistItems(definition);
  const sourceDocIds = [...new Set([
    definition.id,
    ...items.map((item) => item.instructionDocId).filter((docId): docId is string => Boolean(docId)),
  ])];
  const taskData = {
    id,
    description: `Complete the reschedule checklist for ${input.title || 'this event'}`,
    date: berlinToday(),
    status: 'todo',
    source,
    checklistDocId: definition.id,
    checklistItems: items,
    sourceDocIds,
    ...(input.actorId ? { assigneeId: input.actorId, createdBy: input.actorId } : {}),
    comment: `Event rescheduled to ${input.date}.`,
  };
  try {
    return await createTask(client, taskData);
  } catch (error) {
    const concurrent = await getTaskConsistent(client, id);
    if (concurrent?.source === source) return concurrent;
    throw error;
  }
}
