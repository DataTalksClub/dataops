import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getArtifact, listArtifacts } from '../db/artifacts';
import { getCard } from '../db/cards';
import { listFilesByTask } from '../db/files';
import type { ArtifactRef, Task, TaskHistoryAction, TaskHistoryEvent, TaskStatus } from '../types';

/**
 * Task write-path validation: allowed update fields, status/waiting gates,
 * proof requirements, and the `validation.skipClosure` suppression rules.
 *
 * Extracted verbatim from `src/router.ts` when the task routes moved to
 * `./tasks.ts`.
 */

export const ALLOWED_UPDATE_FIELDS = [
  'description',
  'date',
  'comment',
  'status',
  'cardId',
  'source',
  'waitingFor',
  'followUpAt',
  'followUpChannel',
  'proofRequirement',
  'externalStatus',
  'instructionsUrl',
  'instructionDocId',
  'instructionStepId',
  'phase',
  'systems',
  'validation',
  'link',
  'requiredLinkName',
  'requiresFile',
  'assigneeId',
  'tags',
  'templateId',
  'sourceDocIds',
  'artifactRefs',
  'assistantJobRefs',
  'intakeRefs',
  'auditEventRefs',
];
const VALID_TASK_STATUSES = new Set<TaskStatus>(['todo', 'waiting', 'done', 'archived']);
const VALID_PROOF_REQUIREMENT_TYPES = new Set(['url', 'file', 'artifact', 'comment', 'external-status']);
export const WAITING_FIELDS_ERROR = 'Waiting tasks require waitingFor, followUpAt, and comment';
export const WAITING_COMPLETION_ERROR = 'Waiting tasks must be resolved with the follow-up resolve action before completion';
export const WAITING_TODO_ERROR = 'Waiting tasks must use the response received or unblocked action before returning to todo';
const UNSAFE_NOTE_PATTERN = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=|api[_-]?key=|authorization:|bearer\s+\S+)/i;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && VALID_TASK_STATUSES.has(value as TaskStatus);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function expectedVersionError(body: Record<string, unknown>): string | null {
  if (Object.hasOwn(body, 'version')) return 'version is response-only; use expectedVersion';
  if (!Object.hasOwn(body, 'expectedVersion')) return 'expectedVersion is required';
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    return 'expectedVersion must be an integer greater than or equal to 1';
  }
  return null;
}

export function validateDateOrTimestampValue(value: unknown, fieldName: string): string | null {
  if (!isNonEmptyString(value)) return `${fieldName} is required`;
  const text = value.trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
    ) {
      return null;
    }
  }
  return Number.isNaN(Date.parse(text)) ? `${fieldName} must be a valid date or timestamp` : null;
}

export function validateActionNote(value: unknown, fieldName = 'note'): string | null {
  const note = trimmedString(value);
  if (!note) return `${fieldName} is required`;
  if (note.length > 500) return `${fieldName} must be 500 characters or fewer`;
  if (UNSAFE_NOTE_PATTERN.test(note)) return `${fieldName} must not contain tokens, credentials, or signed URLs`;
  return null;
}

export function validateActionChannel(value: unknown): string | null {
  const channel = trimmedString(value);
  if (!channel) return 'channel is required';
  if (channel.length > 60) return 'channel must be 60 characters or fewer';
  if (UNSAFE_NOTE_PATTERN.test(channel)) return 'channel must not contain tokens, credentials, or signed URLs';
  return null;
}

export function makeTaskHistoryEvent(
  action: TaskHistoryAction,
  task: Task,
  data: {
    actorId?: string;
    channel?: string;
    waitingFor?: string;
    followUpAt?: string;
    previousFollowUpAt?: string;
    note?: string;
    createdAt?: string;
  } = {}
): TaskHistoryEvent {
  const event: TaskHistoryEvent = {
    id: crypto.randomUUID(),
    taskId: task.id,
    action,
    createdAt: data.createdAt || new Date().toISOString(),
  };
  if (task.cardId) event.cardId = task.cardId;
  if (data.actorId) event.actorId = data.actorId;
  if (data.channel) event.channel = data.channel;
  if (data.waitingFor) event.waitingFor = data.waitingFor;
  if (data.followUpAt) event.followUpAt = data.followUpAt;
  if (data.previousFollowUpAt) event.previousFollowUpAt = data.previousFollowUpAt;
  if (data.note) event.note = data.note;
  return event;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidationPayload(value: unknown): boolean {
  return (
    typeof value === 'string'
    || (
      value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
    )
  );
}

function isRecordArrayWithStringId(value: unknown, idField: string): boolean {
  return Array.isArray(value) && value.every((item) => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && isNonEmptyString((item as Record<string, unknown>)[idField])
  ));
}

export function validateProofRequirement(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'proofRequirement must be an object';
  }

  const proofRequirement = value as Record<string, unknown>;
  if (!VALID_PROOF_REQUIREMENT_TYPES.has(String(proofRequirement.type))) {
    return `proofRequirement.type must be one of: ${Array.from(VALID_PROOF_REQUIREMENT_TYPES).join(', ')}`;
  }
  if (proofRequirement.label !== undefined && typeof proofRequirement.label !== 'string') {
    return 'proofRequirement.label must be a string';
  }
  if (proofRequirement.required !== undefined && typeof proofRequirement.required !== 'boolean') {
    return 'proofRequirement.required must be a boolean';
  }
  return null;
}

export function validateTaskDocContext(fields: Record<string, unknown>): string | null {
  for (const field of ['instructionDocId', 'instructionStepId', 'phase']) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  if (fields.systems !== undefined && !isStringArray(fields.systems)) {
    return 'systems must be an array of strings';
  }
  if (fields.sourceDocIds !== undefined && !isStringArray(fields.sourceDocIds)) {
    return 'sourceDocIds must be an array of strings';
  }
  if (fields.validation !== undefined && !isValidationPayload(fields.validation)) {
    return 'validation must be a string or object';
  }
  return null;
}

export function validateTaskRefs(fields: Record<string, unknown>): string | null {
  if (fields.artifactRefs !== undefined && !isRecordArrayWithStringId(fields.artifactRefs, 'artifactId')) {
    return 'artifactRefs must be an array of objects with artifactId';
  }
  if (fields.assistantJobRefs !== undefined && !isRecordArrayWithStringId(fields.assistantJobRefs, 'assistantJobId')) {
    return 'assistantJobRefs must be an array of objects with assistantJobId';
  }
  if (fields.intakeRefs !== undefined && !isRecordArrayWithStringId(fields.intakeRefs, 'intakeItemId')) {
    return 'intakeRefs must be an array of objects with intakeItemId';
  }
  if (fields.auditEventRefs !== undefined && !isRecordArrayWithStringId(fields.auditEventRefs, 'auditEventId')) {
    return 'auditEventRefs must be an array of objects with auditEventId';
  }
  return null;
}

function proofMissingError(type: string, label?: string): string {
  const suffix = label ? ` '${label}'` : '';
  return `Cannot mark task as done: required ${type} proof${suffix} is missing`;
}

function normalizedStatusText(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  return value.trim().toLowerCase();
}

function skipClosureConfig(validation: unknown): Record<string, unknown> | null {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return null;
  const skipClosure = (validation as Record<string, unknown>).skipClosure;
  if (!skipClosure || typeof skipClosure !== 'object' || Array.isArray(skipClosure)) return null;
  return skipClosure as Record<string, unknown>;
}

function allowedSkipStatuses(validation: unknown): string[] {
  const config = skipClosureConfig(validation);
  if (!config || !Array.isArray(config.allowedStatuses)) return [];
  return config.allowedStatuses.filter((status): status is string => isNonEmptyString(status));
}

function skipClosureRequires(validation: unknown): string[] {
  const config = skipClosureConfig(validation);
  if (!config || !Array.isArray(config.requires)) return [];
  return config.requires.filter((field): field is string => isNonEmptyString(field));
}

function matchesAllowedSkipStatus(value: unknown, statuses: string[]): boolean {
  const normalizedValue = normalizedStatusText(value);
  if (!normalizedValue) return false;
  const normalizedStatuses = statuses
    .map((status) => normalizedStatusText(status))
    .filter((status): status is string => status !== null);
  if (normalizedStatuses.includes(normalizedValue)) return true;

  const commentLines = normalizedValue
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line.length > 0);
  return commentLines.some((line) => normalizedStatuses.includes(line));
}

function hasAllowedSkipClosure(taskData: Record<string, unknown>): boolean {
  return allowedSkipClosureStatus(taskData) !== null;
}

function allowedSkipClosureStatus(taskData: Record<string, unknown>): string | null {
  const statuses = allowedSkipStatuses(taskData.validation);
  if (statuses.length === 0) return null;

  const commentMatches = matchesAllowedSkipStatus(taskData.comment, statuses);
  const externalStatusMatches = matchesAllowedSkipStatus(taskData.externalStatus, statuses);
  if (!commentMatches && !externalStatusMatches) return null;

  const requiredFields = skipClosureRequires(taskData.validation);
  if (requiredFields.includes('comment') && !commentMatches) return null;
  if (requiredFields.includes('externalStatus') && !externalStatusMatches) return null;

  return statuses.find((status) => (
    matchesAllowedSkipStatus(taskData.comment, [status])
    || matchesAllowedSkipStatus(taskData.externalStatus, [status])
  )) || null;
}

function skipClosureScope(validation: unknown, status: string): Record<string, unknown> | null {
  const config = skipClosureConfig(validation);
  if (!config) return null;
  const suppresses = config.suppresses;
  if (!suppresses || typeof suppresses !== 'object' || Array.isArray(suppresses)) return null;
  const scope = (suppresses as Record<string, unknown>)[status];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  return scope as Record<string, unknown>;
}

function hasScopedSkipClosure(validation: unknown): boolean {
  const config = skipClosureConfig(validation);
  if (!config) return false;
  return Boolean(config.suppresses && typeof config.suppresses === 'object' && !Array.isArray(config.suppresses));
}

export function skipClosureSuppresses(taskData: Record<string, unknown>, gate: 'cardLink' | 'requiredLink' | 'file' | 'proof', name?: string): boolean {
  const status = allowedSkipClosureStatus(taskData);
  if (!status) return false;
  if (!hasScopedSkipClosure(taskData.validation)) return true;

  const scope = skipClosureScope(taskData.validation, status);
  if (!scope) return false;
  if (gate === 'cardLink') {
    const cardLinks = scope.cardLinks;
    if (!Array.isArray(cardLinks)) return false;
    return cardLinks.some((linkName) => linkName === '*' || (isNonEmptyString(linkName) && linkName === name));
  }
  if (gate === 'requiredLink') return scope.requiredLink === true;
  if (gate === 'file') return scope.file === true;
  if (gate === 'proof') return scope.proof === true;
  return false;
}

function requiredCardLinkNames(validation: unknown): string[] {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return [];
  const requiredCardLinks = (validation as Record<string, unknown>).requiredCardLinks;
  if (!Array.isArray(requiredCardLinks)) return [];
  return requiredCardLinks.filter((name): name is string => isNonEmptyString(name));
}

function cardHasLink(cardLinks: unknown, name: string): boolean {
  if (!Array.isArray(cardLinks)) return false;
  return cardLinks.some((link) => (
    link
    && typeof link === 'object'
    && (link as Record<string, unknown>).name === name
    && isNonEmptyString((link as Record<string, unknown>).url)
  ));
}

function artifactRefIds(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => (ref && typeof ref === 'object' ? (ref as ArtifactRef).artifactId : undefined))
    .filter((id): id is string => isNonEmptyString(id));
}

async function hasApprovedArtifactProof(
  client: DynamoDBDocumentClient,
  taskId: string | null,
  taskData: Record<string, unknown>
): Promise<boolean> {
  if (taskId) {
    const taskArtifacts = await listArtifacts(client, { taskId, status: 'approved' });
    if (taskArtifacts.length > 0) return true;
  }

  const cardId = isNonEmptyString(taskData.cardId) ? taskData.cardId : null;
  const refIds = new Set(artifactRefIds(taskData.artifactRefs));

  if (cardId) {
    const cardArtifacts = await listArtifacts(client, { cardId, status: 'approved' });
    if (cardArtifacts.length > 0) return true;

    const card = await getCard(client, cardId);
    for (const id of artifactRefIds(card?.artifactRefs)) refIds.add(id);
  }

  for (const artifactId of refIds) {
    const artifact = await getArtifact(client, artifactId);
    if (artifact?.status === 'approved') return true;
  }

  return false;
}

export async function validateRequiredCardLinks(
  client: DynamoDBDocumentClient,
  taskData: Record<string, unknown>
): Promise<string | null> {
  const requiredNames = requiredCardLinkNames(taskData.validation);
  if (requiredNames.length === 0) return null;

  const cardId = isNonEmptyString(taskData.cardId) ? taskData.cardId : null;
  if (!cardId) {
    return `Cannot mark task as done: required shared card link '${requiredNames[0]}' needs a workflow card`;
  }

  const card = await getCard(client, cardId);
  for (const name of requiredNames) {
    if (skipClosureSuppresses(taskData, 'cardLink', name)) continue;
    if (!cardHasLink(card?.cardLinks, name)) {
      return `Cannot mark task as done: required card link '${name}' is not filled`;
    }
  }

  return null;
}

export async function validateDoneProof(
  client: DynamoDBDocumentClient,
  id: string,
  existing: Task,
  updates: Record<string, unknown>
): Promise<string | null> {
  const taskData = { ...existing, ...updates };
  if (skipClosureSuppresses(taskData, 'proof')) {
    return null;
  }

  const proofRequirement = (updates.proofRequirement !== undefined
    ? updates.proofRequirement
    : existing.proofRequirement) as Record<string, unknown> | undefined;

  if (!proofRequirement || proofRequirement.required === false) {
    return null;
  }

  const proofType = String(proofRequirement.type || '');
  const proofLabel = typeof proofRequirement.label === 'string' ? proofRequirement.label : undefined;
  if (proofType === 'url') {
    const link = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
    return isNonEmptyString(link) ? null : proofMissingError('url', proofLabel);
  }
  if (proofType === 'comment') {
    const comment = (updates.comment !== undefined ? updates.comment : existing.comment) as string | null | undefined;
    return isNonEmptyString(comment) ? null : proofMissingError('comment', proofLabel);
  }
  if (proofType === 'external-status') {
    const externalStatus = (updates.externalStatus !== undefined ? updates.externalStatus : existing.externalStatus) as string | undefined;
    return isNonEmptyString(externalStatus) ? null : proofMissingError('external-status', proofLabel);
  }
  if (proofType === 'artifact') {
    return await hasApprovedArtifactProof(client, id, taskData) ? null : proofMissingError('approved artifact', proofLabel);
  }
  if (proofType === 'file') {
    const files = await listFilesByTask(client, id);
    return files.length > 0 ? null : proofMissingError('file', proofLabel);
  }

  return null;
}

export async function validateDoneProofOnCreate(client: DynamoDBDocumentClient, taskData: Record<string, unknown>): Promise<string | null> {
  const requiredLinkName = taskData.requiredLinkName as string | undefined;
  if (requiredLinkName && !isNonEmptyString(taskData.link) && !skipClosureSuppresses(taskData, 'requiredLink', requiredLinkName)) {
    return `Cannot mark task as done: required link '${requiredLinkName}' is not filled`;
  }
  if (taskData.requiresFile === true && !skipClosureSuppresses(taskData, 'file')) {
    return 'Cannot mark task as done: required file has not been uploaded';
  }

  if (skipClosureSuppresses(taskData, 'proof')) return null;

  const proofRequirement = taskData.proofRequirement as Record<string, unknown> | undefined;
  if (!proofRequirement || proofRequirement.required === false) return null;

  const proofType = String(proofRequirement.type || '');
  const proofLabel = typeof proofRequirement.label === 'string' ? proofRequirement.label : undefined;
  if (proofType === 'url') {
    return isNonEmptyString(taskData.link) ? null : proofMissingError('url', proofLabel);
  }
  if (proofType === 'comment') {
    return isNonEmptyString(taskData.comment) ? null : proofMissingError('comment', proofLabel);
  }
  if (proofType === 'external-status') {
    return isNonEmptyString(taskData.externalStatus) ? null : proofMissingError('external-status', proofLabel);
  }
  if (proofType === 'artifact') {
    return await hasApprovedArtifactProof(client, null, taskData) ? null : proofMissingError('approved artifact', proofLabel);
  }
  if (proofType === 'file') {
    return proofMissingError('file', proofLabel);
  }

  return null;
}
