import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getArtifact, listArtifacts } from '../db/artifacts';
import { getCard } from '../db/cards';
import { listFilesByTask } from '../db/files';
import { requiresError } from '../resources/vocabulary';
import { browserRequirementError } from '../browserRequirement';
import { extractTitleLinks, mergeMaterials, normalizeTaskMaterials } from '../taskMaterials';
import type { ArtifactRef, Task, TaskHistoryAction, TaskHistoryEvent, TaskMaterial, TaskStatus } from '../types';

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
  'subject',
  'source',
  'waitingFor',
  'followUpAt',
  'followUpChannel',
  'snoozedUntil',
  'snoozeReason',
  'notBeforeAt',
  'proofRequirement',
  'externalStatus',
  'instructionsUrl',
  'instructionDocId',
  'instructionStepId',
  'phase',
  'requires',
  'browserRequirement',
  'dependsOn',
  'validation',
  'link',
  'materials',
  'requiredLinkName',
  'requiresFile',
  'requiresCalendarInvite',
  'assigneeId',
  'tags',
  'templateId',
  'sourceDocIds',
  'artifactRefs',
  'intakeRefs',
  'auditEventRefs',
];
const VALID_TASK_STATUSES = new Set<TaskStatus>(['todo', 'waiting', 'done', 'skipped']);
export const INVALID_STATUS_ERROR = "Invalid status. Must be 'todo', 'waiting', 'done', or 'skipped'";
export const SKIPPED_STATUS_ERROR = 'skipped is set with the skip action, which requires a reason';
export const SKIPPED_TASK_ERROR = 'Skipped Tasks must be unskipped before they can be changed';
export const SKIPPED_TASK_LIFECYCLE_ERROR = 'A skipped Task keeps its status and has no follow-up; unskip it first';
/** Lifecycle fields a skipped Task cannot take until it is unskipped. */
export const SKIPPED_TASK_LOCKED_FIELDS = ['status', 'waitingFor', 'followUpAt', 'followUpChannel', 'snoozedUntil', 'snoozeReason', 'notBeforeAt'] as const;
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

export function validateSkipReason(value: unknown): string | null {
  return validateActionNote(value, 'reason');
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
  if (fields.requires !== undefined) {
    const error = requiresError(fields.requires);
    if (error) return error;
  }
  if (fields.browserRequirement !== undefined) {
    const error = browserRequirementError(fields.browserRequirement);
    if (error) return error;
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
  if (fields.intakeRefs !== undefined && !isRecordArrayWithStringId(fields.intakeRefs, 'intakeItemId')) {
    return 'intakeRefs must be an array of objects with intakeItemId';
  }
  if (fields.auditEventRefs !== undefined && !isRecordArrayWithStringId(fields.auditEventRefs, 'auditEventId')) {
    return 'auditEventRefs must be an array of objects with auditEventId';
  }
  return null;
}

export function validateTaskTags(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return 'tags must be an array of strings';
  }
  if (value.length > 10) return 'tags must have 10 or fewer entries';
  for (const tag of value as string[]) {
    const trimmed = tag.trim();
    if (!trimmed) return 'tags must not contain empty entries';
    if (trimmed.length > 60) return 'tags must each be 60 characters or fewer';
  }
  return null;
}

// A Markdown link (`[label](url)`) is not a tag.
const LEADING_TAG_PATTERN = /^\[([^\[\]]{1,40})\](?!\()\s*/;

export function extractLeadingTag(description: unknown): { tag: string; clean: string } | null {
  if (typeof description !== 'string') return null;
  const match = description.match(LEADING_TAG_PATTERN);
  if (!match) return null;
  const tag = match[1].trim();
  if (!tag) return null;
  const clean = description.slice(match[0].length).trim();
  if (!clean) return null;
  return { tag, clean };
}

/**
 * Migration-debt handler: the Trello import baked the checklist name into
 * the description as "[Checklist] Task". The canonical home is `tags[0]`.
 * When the caller did not supply tags explicitly, split the prefix off so
 * new and updated Tasks store the tag separately. Explicit tags win and the
 * description is left untouched.
 */
export function applyLeadingTagToTaskData(taskData: Record<string, unknown>): void {
  if (taskData.tags !== undefined) return;
  const extracted = extractLeadingTag(taskData.description);
  if (!extracted) return;
  taskData.description = extracted.clean;
  taskData.tags = [extracted.tag];
}

/**
 * Store supplied `materials` clean and move links pasted into `description`
 * into them. Runs before the leading-tag split, which would otherwise read a
 * title's first `[label]` as a tag. `moved` lists the links taken out of the
 * title; `supplied` says whether the caller sent `materials` itself, so an
 * update without them can merge into the Task's existing materials.
 */
export function applyTitleLinksToTaskData(
  taskData: Record<string, unknown>,
): { error: string } | { moved: TaskMaterial[]; supplied: boolean } {
  const supplied = taskData.materials !== undefined;
  let materials: TaskMaterial[] = [];
  if (supplied) {
    const normalized = normalizeTaskMaterials(taskData.materials);
    if ('error' in normalized) return normalized;
    materials = normalized.materials;
    taskData.materials = materials;
  }
  if (typeof taskData.description !== 'string') return { moved: [], supplied };
  const extracted = extractTitleLinks(taskData.description);
  if (extracted.materials.length === 0) return { moved: [], supplied };
  taskData.description = extracted.title;
  taskData.materials = mergeMaterials(materials, extracted.materials);
  return { moved: extracted.materials, supplied };
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

export function skipClosureSuppresses(taskData: Record<string, unknown>, gate: 'cardLink' | 'requiredLink' | 'file' | 'proof' | 'calendarInvite', name?: string): boolean {
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
  if (gate === 'calendarInvite') return scope.calendarInvite === true;
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

function findCardLinkUrl(cardLinks: unknown, name: string): string | null {
  if (!Array.isArray(cardLinks)) return null;
  for (const link of cardLinks) {
    if (
      link
      && typeof link === 'object'
      && (link as Record<string, unknown>).name === name
      && isNonEmptyString((link as Record<string, unknown>).url)
    ) {
      return String((link as Record<string, unknown>).url).trim();
    }
  }
  return null;
}

export async function resolveCardLinkForTask(
  client: DynamoDBDocumentClient,
  cardId: unknown,
  requiredLinkName: unknown,
): Promise<string | null> {
  if (!isNonEmptyString(cardId) || !isNonEmptyString(requiredLinkName)) return null;
  const card = await getCard(client, String(cardId).trim());
  return findCardLinkUrl(card?.cardLinks, String(requiredLinkName).trim());
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
  const taskProvidedName = isNonEmptyString(taskData.requiredLinkName) ? String(taskData.requiredLinkName).trim() : null;
  const taskProvidedUrl = isNonEmptyString(taskData.link) ? String(taskData.link).trim() : null;
  for (const name of requiredNames) {
    if (skipClosureSuppresses(taskData, 'cardLink', name)) continue;
    const satisfiedByTask = taskProvidedName === name && Boolean(taskProvidedUrl);
    if (!satisfiedByTask && !cardHasLink(card?.cardLinks, name)) {
      return `Cannot mark task as done: required card link '${name}' is not filled`;
    }
  }

  return null;
}

/**
 * Template ref for the guest-invite Task in the webinar and podcast
 * templates. It implies the calendar-invite requirement for Cards created
 * before their Template declared `requires_calendar_invite` explicitly.
 */
export const CALENDAR_INVITE_TASK_REF = 'create-calendar-invite';

export function taskRequiresCalendarInvite(taskData: Record<string, unknown>): boolean {
  if (taskData.requiresCalendarInvite === true) return true;
  const validation = taskData.validation;
  if (
    validation && typeof validation === 'object' && !Array.isArray(validation)
    && (validation as Record<string, unknown>).requiresCalendarInvite === true
  ) return true;
  return taskData.templateTaskRef === CALENDAR_INVITE_TASK_REF;
}

export function calendarInviteDoneError(taskData: Record<string, unknown>): string {
  const cardId = isNonEmptyString(taskData.cardId) ? String(taskData.cardId).trim() : '<card-id>';
  return `Cannot mark task as done: no calendar invite is linked to this card. Link one with: dataops cards invite add ${cardId} --event-id <event-id> --calendar <calendar>`;
}

export async function validateCalendarInviteRequirement(
  client: DynamoDBDocumentClient,
  taskData: Record<string, unknown>,
): Promise<string | null> {
  if (!taskRequiresCalendarInvite(taskData)) return null;
  if (skipClosureSuppresses(taskData, 'calendarInvite')) return null;
  const cardId = isNonEmptyString(taskData.cardId) ? String(taskData.cardId).trim() : null;
  if (!cardId) {
    return `Cannot mark task as done: no calendar invite is linked to this card. Link one with: dataops cards invite add <card-id> --event-id <event-id> --calendar <calendar>`;
  }
  const card = await getCard(client, cardId);
  if (Array.isArray(card?.calendarInvites) && card.calendarInvites.length > 0) return null;
  return calendarInviteDoneError(taskData);
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
  const calendarInviteError = await validateCalendarInviteRequirement(client, taskData);
  if (calendarInviteError) return calendarInviteError;

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
