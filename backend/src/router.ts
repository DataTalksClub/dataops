import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handleBundleRoutes } from './routes/bundles';
import { handleTemplateRoutes } from './routes/templates';
import { handleRecurringRoutes } from './routes/recurring';
import { handleUserRoutes } from './routes/users';
import { handleFileRoutes } from './routes/files';
import { handleArtifactRoutes } from './routes/artifacts';
import { handleAssistantJobRoutes } from './routes/assistantJobs';
import { handleSocialDraftAssistantRoutes } from './assistant/socialDraftAssistant';
import { handleDocsRoutes, isDocsDomainEnabled } from './docs';
import { handlePortal } from './docs/portal';
import { handleIntakeRoutes } from './routes/intake';
import { handleTelegramWebhook } from './routes/telegram';
import { handleEmailWebhook } from './routes/email';
import { handleEmailDocumentIntake } from './routes/emailDocuments';
import { handleNotificationRoutes } from './routes/notifications';
import { handleCronRoutes } from './routes/cron';
import { handleBookkeepingRoutes } from './routes/bookkeeping';
import { handleMailingExportRoutes } from './routes/mailingExports';
import { handleSponsorCrmRoutes } from './routes/sponsorCrm';
import { handleNewsletterSlotRoutes } from './routes/newsletterSlots';
import { handleCalendarRoutes } from './routes/calendar';
import { handleAuthRoutes, extractToken } from './routes/auth';
import { getSession } from './db/sessions';
import { getUser } from './db/users';
import {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByBundle,
  listTasksByStatus,
} from './db/tasks';
import { getBundle, updateBundle } from './db/bundles';
import { getArtifact, listArtifacts } from './db/artifacts';
import { listFilesByTask } from './db/files';
import type { ArtifactRef, LambdaEvent, LambdaResponse, Task, TaskHistoryAction, TaskHistoryEvent, TaskStatus } from './types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
let cachedPortalSecret: string | null | undefined;
let secretsClient: SecretsManagerClient | null = null;

// Routes that do NOT require authentication
const AUTH_EXEMPT_PATHS = new Set([
  '/',
  '/api/health',
  '/api/auth/login',
]);

function isAuthExempt(method: string, path: string): boolean {
  if (AUTH_EXEMPT_PATHS.has(path)) return true;
  if (method === 'POST' && path === '/api/v1/intake/email-documents') return true;
  // Static assets
  if (method === 'GET' && path.startsWith('/public/')) return true;
  return false;
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function deleteHeader(headers: Record<string, string> | null | undefined, name: string): void {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

async function portalSecret(): Promise<string> {
  if (process.env.WORK_ENGINE_PORTAL_SECRET) return process.env.WORK_ENGINE_PORTAL_SECRET;
  if (cachedPortalSecret !== undefined) return cachedPortalSecret || '';

  const secretName = process.env.WORK_ENGINE_PORTAL_SECRET_NAME;
  if (!secretName) {
    cachedPortalSecret = null;
    return '';
  }

  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  const secret = result.SecretString || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
  cachedPortalSecret = secret || null;
  return secret;
}

function constantTimeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function portalTrustedUserId(event: LambdaEvent): Promise<string | null> {
  if (process.env.WORK_ENGINE_AUTH_MODE !== 'portal') return null;
  const portalAuth = headerValue(event.headers, 'x-portal-auth');
  if (portalAuth !== 'true') return null;
  const expectedSecret = await portalSecret();
  const providedSecret = headerValue(event.headers, 'x-portal-secret');
  if (!constantTimeEquals(providedSecret, expectedSecret)) return null;
  return headerValue(event.headers, 'x-user-id') || 'portal-admin';
}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function decodeBase64Body(event: LambdaEvent): void {
  if (!event.isBase64Encoded || typeof event.body !== 'string') return;
  event.body = Buffer.from(event.body, 'base64').toString('binary');
  event.isBase64Encoded = false;
}

function extractTaskId(reqPath: string): string | null {
  const prefix = '/api/tasks/';
  if (reqPath.startsWith(prefix) && reqPath.length > prefix.length) {
    return reqPath.slice(prefix.length);
  }
  return null;
}

function extractTaskAction(reqPath: string): { taskId: string; action: string } | null {
  const match = reqPath.match(/^\/api\/tasks\/([^/]+)\/actions\/([^/]+)$/);
  if (!match) return null;
  return { taskId: decodeURIComponent(match[1]), action: match[2] };
}

const ALLOWED_UPDATE_FIELDS = [
  'description',
  'date',
  'comment',
  'status',
  'bundleId',
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
  'artifactRefs',
  'assistantJobRefs',
  'intakeRefs',
  'auditEventRefs',
];
const VALID_TASK_STATUSES = new Set<TaskStatus>(['todo', 'waiting', 'done', 'archived']);
const VALID_PROOF_REQUIREMENT_TYPES = new Set(['url', 'file', 'artifact', 'comment', 'external-status']);
const WAITING_FIELDS_ERROR = 'Waiting tasks require waitingFor, followUpAt, and comment';
const WAITING_COMPLETION_ERROR = 'Waiting tasks must be resolved with the follow-up resolve action before completion';
const WAITING_TODO_ERROR = 'Waiting tasks must use the response received or unblocked action before returning to todo';
const UNSAFE_NOTE_PATTERN = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=|api[_-]?key=|authorization:|bearer\s+\S+)/i;

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && VALID_TASK_STATUSES.has(value as TaskStatus);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validateDateOrTimestampValue(value: unknown, fieldName: string): string | null {
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

function validateActionNote(value: unknown, fieldName = 'note'): string | null {
  const note = trimmedString(value);
  if (!note) return `${fieldName} is required`;
  if (note.length > 500) return `${fieldName} must be 500 characters or fewer`;
  if (UNSAFE_NOTE_PATTERN.test(note)) return `${fieldName} must not contain tokens, credentials, or signed URLs`;
  return null;
}

function validateActionChannel(value: unknown): string | null {
  const channel = trimmedString(value);
  if (!channel) return 'channel is required';
  if (channel.length > 60) return 'channel must be 60 characters or fewer';
  if (UNSAFE_NOTE_PATTERN.test(channel)) return 'channel must not contain tokens, credentials, or signed URLs';
  return null;
}

function taskHistory(task: Task): TaskHistoryEvent[] {
  return Array.isArray(task.taskHistory) ? task.taskHistory : [];
}

function makeTaskHistoryEvent(
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
  if (task.bundleId) event.bundleId = task.bundleId;
  if (data.actorId) event.actorId = data.actorId;
  if (data.channel) event.channel = data.channel;
  if (data.waitingFor) event.waitingFor = data.waitingFor;
  if (data.followUpAt) event.followUpAt = data.followUpAt;
  if (data.previousFollowUpAt) event.previousFollowUpAt = data.previousFollowUpAt;
  if (data.note) event.note = data.note;
  return event;
}

function appendHistory(task: Task, event: TaskHistoryEvent): TaskHistoryEvent[] {
  return [...taskHistory(task), event];
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

function validateProofRequirement(value: unknown): string | null {
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

function validateTaskDocContext(fields: Record<string, unknown>): string | null {
  for (const field of ['instructionDocId', 'instructionStepId', 'phase']) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') {
      return `${field} must be a string`;
    }
  }
  if (fields.systems !== undefined && !isStringArray(fields.systems)) {
    return 'systems must be an array of strings';
  }
  if (fields.validation !== undefined && !isValidationPayload(fields.validation)) {
    return 'validation must be a string or object';
  }
  return null;
}

function validateTaskRefs(fields: Record<string, unknown>): string | null {
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

function skipClosureSuppresses(taskData: Record<string, unknown>, gate: 'bundleLink' | 'requiredLink' | 'file' | 'proof', name?: string): boolean {
  const status = allowedSkipClosureStatus(taskData);
  if (!status) return false;
  if (!hasScopedSkipClosure(taskData.validation)) return true;

  const scope = skipClosureScope(taskData.validation, status);
  if (!scope) return false;
  if (gate === 'bundleLink') {
    const bundleLinks = scope.bundleLinks;
    if (!Array.isArray(bundleLinks)) return false;
    return bundleLinks.some((linkName) => linkName === '*' || (isNonEmptyString(linkName) && linkName === name));
  }
  if (gate === 'requiredLink') return scope.requiredLink === true;
  if (gate === 'file') return scope.file === true;
  if (gate === 'proof') return scope.proof === true;
  return false;
}

function requiredBundleLinkNames(validation: unknown): string[] {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return [];
  const requiredBundleLinks = (validation as Record<string, unknown>).requiredBundleLinks;
  if (!Array.isArray(requiredBundleLinks)) return [];
  return requiredBundleLinks.filter((name): name is string => isNonEmptyString(name));
}

function bundleHasLink(bundleLinks: unknown, name: string): boolean {
  if (!Array.isArray(bundleLinks)) return false;
  return bundleLinks.some((link) => (
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

  const bundleId = isNonEmptyString(taskData.bundleId) ? taskData.bundleId : null;
  const refIds = new Set(artifactRefIds(taskData.artifactRefs));

  if (bundleId) {
    const bundleArtifacts = await listArtifacts(client, { bundleId, status: 'approved' });
    if (bundleArtifacts.length > 0) return true;

    const bundle = await getBundle(client, bundleId);
    for (const id of artifactRefIds(bundle?.artifactRefs)) refIds.add(id);
  }

  for (const artifactId of refIds) {
    const artifact = await getArtifact(client, artifactId);
    if (artifact?.status === 'approved') return true;
  }

  return false;
}

async function validateRequiredBundleLinks(
  client: DynamoDBDocumentClient,
  taskData: Record<string, unknown>
): Promise<string | null> {
  const requiredNames = requiredBundleLinkNames(taskData.validation);
  if (requiredNames.length === 0) return null;

  const bundleId = isNonEmptyString(taskData.bundleId) ? taskData.bundleId : null;
  if (!bundleId) {
    return `Cannot mark task as done: required shared bundle link '${requiredNames[0]}' needs a workflow bundle`;
  }

  const bundle = await getBundle(client, bundleId);
  for (const name of requiredNames) {
    if (skipClosureSuppresses(taskData, 'bundleLink', name)) continue;
    if (!bundleHasLink(bundle?.bundleLinks, name)) {
      return `Cannot mark task as done: required bundle link '${name}' is not filled`;
    }
  }

  return null;
}

async function validateDoneProof(
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

async function validateDoneProofOnCreate(client: DynamoDBDocumentClient, taskData: Record<string, unknown>): Promise<string | null> {
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

async function route(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const method = event.httpMethod || 'GET';
  let reqPath = event.path || '/';
  const portalMode = process.env.WORK_ENGINE_AUTH_MODE === 'portal';
  const skipAuth = process.env.NODE_ENV === 'test' && process.env.SKIP_AUTH === 'true';

  try {
    // Machine-to-machine intake has its own rotated secret and must not pass
    // through interactive session or portal authentication.
    if (method === 'POST' && reqPath === '/api/v1/intake/email-documents') {
      return await handleEmailDocumentIntake(event, client);
    }

    decodeBase64Body(event);

    // ── Single-origin portal layer (docs domain, flag-gated) ─────
    // When the docs domain is enabled, the portal serves the frontend, the docs
    // content API, and `/content/*`, enforces the opaque browser session, and
    // rewrites the old `/work/api/*` proxy path to `/api/*`. A verified portal
    // session also authorizes the work `/api/*` routes (portalAuthorized).
    let portalAuthorized = false;
    let browserUserId: string | undefined;
    if (isDocsDomainEnabled()) {
      const portal = await handlePortal(event, client);
      if (portal.response) return portal.response;
      portalAuthorized = portal.authorized;
      browserUserId = portal.userId;
      // The portal may rewrite the path (e.g. /work/api/* -> /api/*).
      reqPath = event.path || '/';
    }

    // ── Auth routes (exempt from middleware) ─────────────────────
    const portalUserId = await portalTrustedUserId(event);
    // x-user-id is an internal identity propagation header, never a client
    // credential. Preserve it only in the explicit test auth bypass; all real
    // requests must replace it with an identity established below.
    if (!skipAuth) deleteHeader(event.headers, 'x-user-id');
    const verifiedInteractiveUserId = browserUserId || portalUserId;
    if (verifiedInteractiveUserId) {
      if (!event.headers) event.headers = {};
      event.headers['x-user-id'] = verifiedInteractiveUserId;
    }
    if (portalMode && reqPath.startsWith('/api/auth')) {
      return jsonResponse(404, { error: 'Not found' });
    }
    if (portalMode && reqPath === '/api/me') {
      if (verifiedInteractiveUserId) {
        const user = await getUser(client, verifiedInteractiveUserId);
        return user && !user.disabled ? jsonResponse(200, { user }) : jsonResponse(401, { error: 'Unauthorized' });
      }
      // Preserve the existing non-browser bearer-session contract.
      const bearer = extractToken(event);
      const session = bearer ? await getSession(client, bearer) : null;
      if (session) {
        const user = await getUser(client, session.userId);
        return user && !user.disabled ? jsonResponse(200, { user }) : jsonResponse(401, { error: 'Unauthorized' });
      }
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    if (reqPath.startsWith('/api/auth') || reqPath === '/api/me') {
      const result = await handleAuthRoutes(event);
      if (result) return result;
    }

    // ── Auth middleware ───────────────────────────────────────────
    // All /api/* routes (except exempt ones) require a valid session.
    // In test mode (NODE_ENV=test), auth can be bypassed with SKIP_AUTH=true.
    const bookkeepingIngest = method === 'POST' && reqPath === '/api/bookkeeping/ingest';
    // Portal browser cookies and legacy bearer sessions are independent. The
    // generic bearer middleware below remains available in portal mode.
    if (!skipAuth && !portalUserId && !portalAuthorized && reqPath.startsWith('/api/') && !isAuthExempt(method, reqPath) && (!bookkeepingIngest || portalMode)) {
      const token = extractToken(event);
      if (!token) {
        return jsonResponse(401, { error: 'Unauthorized' });
      }
      const session = await getSession(client, token);
      if (!session) {
        return jsonResponse(401, { error: 'Unauthorized' });
      }
      // Attach userId to event headers for downstream use
      if (!event.headers) event.headers = {};
      event.headers['x-user-id'] = session.userId;
    }

    // GET / — serve SPA HTML
    if (method === 'GET' && reqPath === '/') {
      const htmlPath = path.join(__dirname, 'pages', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: html,
      };
    }

    // GET /public/*.js — serve static JS files
    if (method === 'GET' && reqPath.startsWith('/public/')) {
      // Guard against path traversal
      if (reqPath.includes('..')) {
        return jsonResponse(404, { error: 'Not found' });
      }

      // Only serve .js files
      if (!reqPath.endsWith('.js')) {
        return jsonResponse(404, { error: 'Not found' });
      }

      const filename = reqPath.slice('/public/'.length);

      // Extra safety: reject if filename contains slashes (only serve from top-level public dir)
      if (filename.includes('/') || filename.includes('\\')) {
        return jsonResponse(404, { error: 'Not found' });
      }

      const filePath = path.join(__dirname, 'public', filename);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/javascript' },
          body: content,
        };
      } catch {
        return jsonResponse(404, { error: 'Not found' });
      }
    }

    // GET /api/health — health check
    if (method === 'GET' && reqPath === '/api/health') {
      return jsonResponse(200, { status: 'ok' });
    }

    // ── Task routes ────────────────────────────────────────────────
    if (reqPath.startsWith('/api/bookkeeping')) {
      return await handleBookkeepingRoutes(reqPath, method, event, client, skipAuth || !!portalUserId || portalAuthorized || !!headerValue(event.headers, 'x-user-id'));
    }

    if (reqPath.startsWith('/api/sponsor-crm')) {
      return await handleSponsorCrmRoutes(reqPath, method, event, client);
    }
    if (reqPath.startsWith('/api/newsletter-slots')) return await handleNewsletterSlotRoutes(reqPath,method,event,client);
    if (reqPath.startsWith('/api/calendar-items')) return await handleCalendarRoutes(reqPath,method,event,client);

    if (reqPath.startsWith('/api/mailing-exports')) {
      const result = await handleMailingExportRoutes(reqPath, method, event, client);
      if (result) return result;
    }

    // POST /api/tasks — Create a task
    if (method === 'POST' && reqPath === '/api/tasks') {
      const body = parseBody(event);
      if (!body) {
        return jsonResponse(400, { error: 'Request body is required' });
      }
      if (!body.description) {
        return jsonResponse(400, { error: 'Missing required field: description' });
      }
      if (!body.date) {
        return jsonResponse(400, { error: 'Missing required field: date' });
      }

      const taskData: Record<string, unknown> = {};
      if (body.description) taskData.description = body.description;
      if (body.date) taskData.date = body.date;
      if (body.comment !== undefined) taskData.comment = body.comment;
      if (body.bundleId !== undefined) taskData.bundleId = body.bundleId;
      if (body.waitingFor !== undefined) taskData.waitingFor = body.waitingFor;
      if (body.followUpAt !== undefined) taskData.followUpAt = body.followUpAt;
      if (body.followUpChannel !== undefined) taskData.followUpChannel = body.followUpChannel;
      if (body.proofRequirement !== undefined) taskData.proofRequirement = body.proofRequirement;
      if (body.externalStatus !== undefined) taskData.externalStatus = body.externalStatus;
      if (body.instructionsUrl !== undefined) taskData.instructionsUrl = body.instructionsUrl;
      if (body.instructionDocId !== undefined) taskData.instructionDocId = body.instructionDocId;
      if (body.instructionStepId !== undefined) taskData.instructionStepId = body.instructionStepId;
      if (body.phase !== undefined) taskData.phase = body.phase;
      if (body.systems !== undefined) taskData.systems = body.systems;
      if (body.validation !== undefined) taskData.validation = body.validation;
      if (body.link !== undefined) taskData.link = body.link;
      if (body.requiredLinkName !== undefined) taskData.requiredLinkName = body.requiredLinkName;
      if (body.requiresFile !== undefined) taskData.requiresFile = body.requiresFile;
      if (body.assigneeId !== undefined) taskData.assigneeId = body.assigneeId;
      if (body.tags !== undefined) taskData.tags = body.tags;
      if (body.templateId !== undefined) taskData.templateId = body.templateId;
      if (body.artifactRefs !== undefined) taskData.artifactRefs = body.artifactRefs;
      if (body.assistantJobRefs !== undefined) taskData.assistantJobRefs = body.assistantJobRefs;
      if (body.auditEventRefs !== undefined) taskData.auditEventRefs = body.auditEventRefs;
      taskData.source = (body.source as string) || 'manual';
      if (body.status !== undefined) {
        if (!isTaskStatus(body.status)) {
          return jsonResponse(400, { error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'" });
        }
        taskData.status = body.status;
      }
      if (taskData.status === 'waiting' && (
        !isNonEmptyString(taskData.waitingFor)
        || !isNonEmptyString(taskData.followUpAt)
        || !isNonEmptyString(taskData.comment)
      )) {
        return jsonResponse(400, { error: WAITING_FIELDS_ERROR });
      }
      const docContextError = validateTaskDocContext(taskData);
      if (docContextError) {
        return jsonResponse(400, { error: docContextError });
      }
      const proofRequirementError = validateProofRequirement(taskData.proofRequirement);
      if (proofRequirementError) {
        return jsonResponse(400, { error: proofRequirementError });
      }
      const refsError = validateTaskRefs(taskData);
      if (refsError) {
        return jsonResponse(400, { error: refsError });
      }
      if (taskData.status === 'done') {
        const bundleLinkError = await validateRequiredBundleLinks(client, taskData);
        if (bundleLinkError) {
          return jsonResponse(400, { error: bundleLinkError });
        }
        const proofError = await validateDoneProofOnCreate(client, taskData);
        if (proofError) {
          return jsonResponse(400, { error: proofError });
        }
      }

      const task = await createTask(client, taskData);
      return jsonResponse(201, task);
    }

    // GET /api/tasks — List tasks with filters
    if (method === 'GET' && reqPath === '/api/tasks') {
      const params = event.queryStringParameters || {};
      const { date, startDate, endDate, bundleId, status } = params;

      if (!date && !startDate && !endDate && !bundleId && !status) {
        return jsonResponse(400, {
          error: 'At least one filter is required: date, startDate+endDate, bundleId, or status',
        });
      }

      // Priority: date > startDate+endDate > bundleId > status
      if (date) {
        const tasks = await listTasksByDate(client, date);
        return jsonResponse(200, { tasks });
      }

      if (startDate || endDate) {
        if (!startDate || !endDate) {
          return jsonResponse(400, {
            error: 'Both startDate and endDate are required for range queries',
          });
        }
        const tasks = await listTasksByDateRange(client, startDate, endDate);
        return jsonResponse(200, { tasks });
      }

      if (bundleId) {
        const tasks = await listTasksByBundle(client, bundleId);
        return jsonResponse(200, { tasks });
      }

      if (status) {
        if (!isTaskStatus(status)) {
          return jsonResponse(400, {
            error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'",
          });
        }
        const tasks = await listTasksByStatus(client, status);
        return jsonResponse(200, { tasks });
      }
    }

    // POST /api/tasks/:id/actions/:action — Atomic task follow-up actions
    if (method === 'POST' && reqPath.startsWith('/api/tasks/')) {
      const taskAction = extractTaskAction(reqPath);
      if (!taskAction) {
        return jsonResponse(404, { error: 'Not found' });
      }

      const existing = await getTask(client, taskAction.taskId);
      if (!existing) {
        return jsonResponse(404, { error: 'Task not found' });
      }

      const body = parseBody(event);
      if (!body) {
        return jsonResponse(400, { error: 'Request body is required' });
      }

      const actorId = headerValue(event.headers, 'x-user-id') || undefined;
      const now = new Date().toISOString();

      if (taskAction.action === 'mark-waiting') {
        if (existing.status === 'done') {
          return jsonResponse(400, { error: 'Completed tasks must be reopened before marking waiting' });
        }
        const waitingFor = trimmedString(body.waitingFor);
        const followUpAt = trimmedString(body.followUpAt);
        const channel = trimmedString(body.channel);
        const note = trimmedString(body.note);
        const noteError = validateActionNote(note);
        const channelError = validateActionChannel(channel);
        const dateError = validateDateOrTimestampValue(followUpAt, 'followUpAt');
        if (!waitingFor) return jsonResponse(400, { error: 'waitingFor is required' });
        if (waitingFor.length > 160) return jsonResponse(400, { error: 'waitingFor must be 160 characters or fewer' });
        if (dateError) return jsonResponse(400, { error: dateError });
        if (channelError) return jsonResponse(400, { error: channelError });
        if (noteError) return jsonResponse(400, { error: noteError });

        const historyEvent = makeTaskHistoryEvent('waiting-started', existing, {
          actorId,
          channel,
          waitingFor,
          followUpAt,
          note,
          createdAt: now,
        });
        const updated = await updateTask(client, existing.id, {
          status: 'waiting',
          waitingFor,
          followUpAt,
          followUpChannel: channel,
          taskHistory: appendHistory(existing, historyEvent),
        });
        return jsonResponse(200, updated);
      }

      if (taskAction.action === 'follow-up-sent') {
        if (existing.status !== 'waiting') {
          return jsonResponse(400, { error: 'Task must be waiting before recording a follow-up' });
        }
        const channel = trimmedString(body.channel);
        const note = trimmedString(body.note);
        const nextFollowUpAt = trimmedString(body.nextFollowUpAt || body.followUpAt);
        const noteError = validateActionNote(note);
        const channelError = validateActionChannel(channel);
        const dateError = validateDateOrTimestampValue(nextFollowUpAt, 'nextFollowUpAt');
        if (channelError) return jsonResponse(400, { error: channelError });
        if (noteError) return jsonResponse(400, { error: noteError });
        if (dateError) return jsonResponse(400, { error: dateError });

        const historyEvent = makeTaskHistoryEvent('follow-up-sent', existing, {
          actorId,
          channel,
          waitingFor: existing.waitingFor,
          previousFollowUpAt: existing.followUpAt,
          followUpAt: nextFollowUpAt,
          note,
          createdAt: now,
        });
        const updated = await updateTask(client, existing.id, {
          status: 'waiting',
          followUpAt: nextFollowUpAt,
          followUpChannel: channel,
          taskHistory: appendHistory(existing, historyEvent),
        });
        return jsonResponse(200, updated);
      }

      if (taskAction.action === 'response-received' || taskAction.action === 'unblocked') {
        if (existing.status !== 'waiting') {
          return jsonResponse(400, { error: 'Task must be waiting before it can be unblocked' });
        }
        const note = trimmedString(body.note);
        const noteError = validateActionNote(note);
        if (noteError) return jsonResponse(400, { error: noteError });

        const action = taskAction.action === 'unblocked' ? 'unblocked' : 'response-received';
        const historyEvent = makeTaskHistoryEvent(action, existing, {
          actorId,
          channel: trimmedString(body.channel) || existing.followUpChannel,
          waitingFor: existing.waitingFor,
          previousFollowUpAt: existing.followUpAt,
          note,
          createdAt: now,
        });
        const updated = await updateTask(client, existing.id, {
          status: 'todo',
          waitingFor: null,
          followUpAt: null,
          followUpChannel: null,
          taskHistory: appendHistory(existing, historyEvent),
        });
        return jsonResponse(200, updated);
      }

      if (taskAction.action === 'resolve-done') {
        if (existing.status !== 'waiting') {
          return jsonResponse(400, { error: 'Task must be waiting before resolving the wait' });
        }
        const note = trimmedString(body.note);
        const noteError = validateActionNote(note);
        if (noteError) return jsonResponse(400, { error: noteError });

        const updates: Record<string, unknown> = {
          status: 'done',
          waitingFor: null,
          followUpAt: null,
          followUpChannel: null,
        };
        for (const field of ['comment', 'link', 'externalStatus', 'artifactRefs', 'assistantJobRefs', 'auditEventRefs']) {
          if (body[field] !== undefined) updates[field] = body[field];
        }

        const taskData = { ...existing, ...updates };
        const effectiveRequiredLinkName = (updates.requiredLinkName !== undefined ? updates.requiredLinkName : existing.requiredLinkName) as string | undefined;
        const effectiveLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
        if (
          effectiveRequiredLinkName
          && !effectiveLink
          && !skipClosureSuppresses(taskData, 'requiredLink', effectiveRequiredLinkName)
        ) {
          return jsonResponse(400, { error: `Cannot mark task as done: required link '${effectiveRequiredLinkName}' is not filled` });
        }

        const effectiveRequiresFile = existing.requiresFile as boolean | undefined;
        if (effectiveRequiresFile && !skipClosureSuppresses(taskData, 'file')) {
          const files = await listFilesByTask(client, existing.id);
          if (files.length === 0) {
            return jsonResponse(400, { error: 'Cannot mark task as done: required file has not been uploaded' });
          }
        }

        const bundleLinkError = await validateRequiredBundleLinks(client, taskData);
        if (bundleLinkError) return jsonResponse(400, { error: bundleLinkError });

        const proofError = await validateDoneProof(client, existing.id, existing, updates);
        if (proofError) return jsonResponse(400, { error: proofError });

        updates.completedAt = now;
        if (actorId) updates.completedBy = actorId;
        const resolvedEvent = makeTaskHistoryEvent('wait-resolved', existing, {
          actorId,
          channel: trimmedString(body.channel) || existing.followUpChannel,
          waitingFor: existing.waitingFor,
          previousFollowUpAt: existing.followUpAt,
          note,
          createdAt: now,
        });
        const completedEvent = makeTaskHistoryEvent('completed', existing, {
          actorId,
          note,
          createdAt: now,
        });
        updates.taskHistory = [...taskHistory(existing), resolvedEvent, completedEvent];

        const updated = await updateTask(client, existing.id, updates);
        if (updated) {
          const task = updated as Task;
          if (task.stageOnComplete && task.bundleId && task.source === 'template') {
            await updateBundle(client, task.bundleId, { stage: task.stageOnComplete });
          }
        }
        return jsonResponse(200, updated);
      }

      return jsonResponse(404, { error: 'Not found' });
    }

    // GET /api/tasks/:id — Get a single task
    if (method === 'GET' && reqPath.startsWith('/api/tasks/')) {
      const id = extractTaskId(reqPath);
      if (!id) {
        return jsonResponse(404, { error: 'Not found' });
      }
      const task = await getTask(client, id);
      if (!task) {
        return jsonResponse(404, { error: 'Task not found' });
      }
      return jsonResponse(200, task);
    }

    // PUT /api/tasks/:id — Update a task
    if (method === 'PUT' && reqPath.startsWith('/api/tasks/')) {
      const id = extractTaskId(reqPath);
      if (!id) {
        return jsonResponse(404, { error: 'Not found' });
      }

      const body = parseBody(event);
      if (!body) {
        return jsonResponse(400, { error: 'Request body is required' });
      }

      // Filter to allowed fields only
      const updates: Record<string, unknown> = {};
      for (const field of ALLOWED_UPDATE_FIELDS) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return jsonResponse(400, { error: 'No valid fields to update' });
      }
      if (updates.status !== undefined && !isTaskStatus(updates.status)) {
        return jsonResponse(400, { error: "Invalid status. Must be 'todo', 'waiting', 'done', or 'archived'" });
      }
      const docContextError = validateTaskDocContext(updates);
      if (docContextError) {
        return jsonResponse(400, { error: docContextError });
      }
      const proofRequirementError = validateProofRequirement(updates.proofRequirement);
      if (proofRequirementError) {
        return jsonResponse(400, { error: proofRequirementError });
      }
      const refsError = validateTaskRefs(updates);
      if (refsError) {
        return jsonResponse(400, { error: refsError });
      }

      // Verify task exists
      const existing = await getTask(client, id);
      if (!existing) {
        return jsonResponse(404, { error: 'Task not found' });
      }

      const effectiveStatus = updates.status !== undefined ? updates.status : existing.status;
      if (existing.status === 'waiting' && updates.status === 'done') {
        return jsonResponse(400, { error: WAITING_COMPLETION_ERROR });
      }
      if (existing.status === 'waiting' && updates.status === 'todo') {
        return jsonResponse(400, { error: WAITING_TODO_ERROR });
      }
      if (effectiveStatus === 'waiting') {
        const effectiveWaitingFor = updates.waitingFor !== undefined ? updates.waitingFor : existing.waitingFor;
        const effectiveFollowUpAt = updates.followUpAt !== undefined ? updates.followUpAt : existing.followUpAt;
        const effectiveComment = updates.comment !== undefined ? updates.comment : existing.comment;
        if (
          !isNonEmptyString(effectiveWaitingFor)
          || !isNonEmptyString(effectiveFollowUpAt)
          || !isNonEmptyString(effectiveComment)
        ) {
          return jsonResponse(400, { error: WAITING_FIELDS_ERROR });
        }
      }

      // requiredLinkName validation: cannot mark done if requiredLinkName is set but link is empty
      if (updates.status === 'done') {
        const completedAt = new Date().toISOString();
        const taskData = { ...existing, ...updates };
        const effectiveRequiredLinkName = (updates.requiredLinkName !== undefined ? updates.requiredLinkName : existing.requiredLinkName) as string | undefined;
        const effectiveLink = (updates.link !== undefined ? updates.link : existing.link) as string | undefined;
        if (
          effectiveRequiredLinkName
          && !effectiveLink
          && !skipClosureSuppresses(taskData, 'requiredLink', effectiveRequiredLinkName)
        ) {
          return jsonResponse(400, { error: `Cannot mark task as done: required link '${effectiveRequiredLinkName}' is not filled` });
        }

        // requiresFile validation: cannot mark done if requiresFile is true and no files uploaded
        const effectiveRequiresFile = (updates.requiresFile !== undefined ? updates.requiresFile : existing.requiresFile) as boolean | undefined;
        if (effectiveRequiresFile && !skipClosureSuppresses(taskData, 'file')) {
          const files = await listFilesByTask(client, id);
          if (files.length === 0) {
            return jsonResponse(400, { error: 'Cannot mark task as done: required file has not been uploaded' });
          }
        }

        const bundleLinkError = await validateRequiredBundleLinks(client, taskData);
        if (bundleLinkError) {
          return jsonResponse(400, { error: bundleLinkError });
        }

        const proofError = await validateDoneProof(client, id, existing, updates);
        if (proofError) {
          return jsonResponse(400, { error: proofError });
        }

        updates.completedAt = completedAt;
        const actorId = headerValue(event.headers, 'x-user-id');
        if (actorId) updates.completedBy = actorId;
        if (existing.status !== 'done') {
          updates.taskHistory = appendHistory(existing, makeTaskHistoryEvent('completed', existing, {
            actorId: actorId || undefined,
            note: isNonEmptyString(updates.comment) ? String(updates.comment) : undefined,
            createdAt: completedAt,
          }));
        }
      } else if (existing.status === 'done' && updates.status === 'todo') {
        const actorId = headerValue(event.headers, 'x-user-id');
        updates.taskHistory = appendHistory(existing, makeTaskHistoryEvent('reopened', existing, {
          actorId: actorId || undefined,
        }));
      }

      const updated = await updateTask(client, id, updates);

      // Stage transition: when a task with stageOnComplete is marked done,
      // automatically update the parent bundle's stage
      if (updated && updates.status === 'done' && existing.status !== 'done') {
        const task = updated as Task;
        if (task.stageOnComplete && task.bundleId && task.source === 'template') {
          await updateBundle(client, task.bundleId, { stage: task.stageOnComplete });
        }
      }

      return jsonResponse(200, updated);
    }

    // DELETE /api/tasks/:id — Delete a task
    if (method === 'DELETE' && reqPath.startsWith('/api/tasks/')) {
      const id = extractTaskId(reqPath);
      if (!id) {
        return jsonResponse(404, { error: 'Not found' });
      }
      await deleteTask(client, id);
      return {
        statusCode: 204,
        headers: JSON_HEADERS,
        body: '',
      };
    }

    // ── Assistant, artifact, and file routes ──────────────────────

    if (reqPath.startsWith('/api/intake')) {
      const result = await handleIntakeRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/assistant-jobs')) {
      const result = await handleAssistantJobRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/assistant-social-drafts')) {
      const result = await handleSocialDraftAssistantRoutes(event, client);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/artifacts')) {
      const result = await handleArtifactRoutes(event);
      if (result) return result;
    }

    if (reqPath.startsWith('/api/files')) {
      const result = await handleFileRoutes(event);
      if (result) return result;
    }

    // ── Bundle routes ──────────────────────────────────────────────

    if (reqPath.startsWith('/api/bundles')) {
      const result = await handleBundleRoutes(reqPath, method, event.body || null);
      if (result) return result;
    }

    // ── Template routes ────────────────────────────────────────────

    if (reqPath.startsWith('/api/templates')) {
      const result = await handleTemplateRoutes(reqPath, method, event.body || null);
      if (result) return result;
    }

    // ── Recurring routes ───────────────────────────────────────────

    if (reqPath.startsWith('/api/recurring')) {
      const result = await handleRecurringRoutes(reqPath, method, event.body || null);
      if (result) return result;
    }

    // ── User routes ──────────────────────────────────────────────

   if (reqPath.startsWith('/api/users')) {
      const result = await handleUserRoutes(reqPath, method, event.body || null, event);
      if (result) return result;
   }

    // ── Notification routes ─────────────────────────────────────

    if (reqPath.startsWith('/api/notifications')) {
      const rawUserId = event.headers?.['x-user-id'] || undefined;
      const userId = rawUserId === 'portal-admin' ? undefined : rawUserId;
      const result = await handleNotificationRoutes(reqPath, method, event.body || null, event.queryStringParameters || null, userId);
      if (result) return result;
    }

    // ── Cron routes ───────────────────────────────────────────────

    if (reqPath.startsWith('/api/cron')) {
      const result = await handleCronRoutes(reqPath, method);
      if (result) return result;
    }

    // ── Telegram webhook ────────────────────────────────────────

    if (method === 'POST' && reqPath === '/api/webhook/telegram') {
      return handleTelegramWebhook(event);
    }

    // ── Email webhook ───────────────────────────────────────────

    if (method === 'POST' && reqPath === '/api/webhook/email') {
      return await handleEmailWebhook(event, client);
    }

    // ── Docs domain (seam — stubs, flag-gated) ──────────────────
    // TODO(#87/#88): the docs content API is ported into this backend. While the
    // seam is stub-only it stays behind DATAOPS_DOCS_DOMAIN so existing routes
    // and tests are unaffected. Handlers currently return 501.
    if (isDocsDomainEnabled()) {
      const result = await handleDocsRoutes(event);
      if (result) return result;
    }

    // Anything else — 404
    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    console.error('Unexpected error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

export { route };
