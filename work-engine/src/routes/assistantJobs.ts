import { createHash } from 'crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  appendAssistantJobEvent,
  createAssistantJob,
  getAssistantJob,
  listAssistantJobEvents,
  listAssistantJobs,
  updateAssistantJob,
} from '../db/assistantJobs';
import { createArtifact, getArtifact, listArtifacts, updateArtifact } from '../db/artifacts';
import { getBundle, updateBundle } from '../db/bundles';
import { createNotification } from '../db/notifications';
import { getTask, updateTask } from '../db/tasks';
import type {
  ArtifactRecord,
  ArtifactRef,
  AssistantJobEventAction,
  AssistantJobLogRef,
  AssistantJobRecord,
  AssistantJobRef,
  AssistantJobStatus,
  LambdaEvent,
  LambdaResponse,
} from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const ASSISTANT_STATUSES = new Set<AssistantJobStatus>([
  'draft',
  'queued',
  'running',
  'waiting_approval',
  'approved',
  'rejected',
  'retrying',
  'succeeded',
  'failed',
  'canceled',
]);
const TERMINAL_STATUSES = new Set<AssistantJobStatus>(['approved', 'rejected', 'succeeded', 'failed', 'canceled']);
const EVENT_ACTIONS = new Set<AssistantJobEventAction>([
  'created',
  'queued',
  'started',
  'log-appended',
  'artifact-attached',
  'approval-requested',
  'approved',
  'rejected',
  'retry-requested',
  'failed',
  'canceled',
  'succeeded',
]);
const VALID_TRANSITIONS: Record<AssistantJobStatus, AssistantJobStatus[]> = {
  draft: ['queued', 'canceled'],
  queued: ['running', 'failed', 'canceled'],
  running: ['waiting_approval', 'succeeded', 'failed', 'canceled'],
  waiting_approval: ['approved', 'rejected', 'canceled'],
  approved: ['succeeded'],
  rejected: ['retrying'],
  retrying: ['queued', 'running', 'failed', 'canceled'],
  succeeded: [],
  failed: ['retrying'],
  canceled: [],
};
const SECRET_KEY_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SECRET_VALUE_PATTERN = /(x-amz-signature|x-amz-credential|x-amz-security-token|access_token=|token=|api[_-]?key|bearer\s+[a-z0-9._-]+|ghp_[a-z0-9_]+|sk-[a-z0-9_-]+)/i;

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

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedString(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function containsSecret(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      SECRET_KEY_PATTERN.test(key) || containsSecret(child)
    ));
  }
  return false;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object');
  }
  const json = JSON.stringify(value);
  if (json.length > 4096) throw new Error('metadata must be 4096 bytes or less');
  if (containsSecret(value)) throw new Error('metadata must not contain secrets or signed URLs');
  return value as Record<string, unknown>;
}

function sanitizeError(value: unknown): { code: string; summary: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    if (containsSecret(value)) return { code: 'redacted', summary: 'Assistant runner failed with redacted sensitive details' };
    return { code: 'runner-error', summary: boundedString(value, 500) };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { code: 'runner-error', summary: 'Assistant runner failed' };
  const record = value as Record<string, unknown>;
  const code = isNonEmptyString(record.code) ? boundedString(record.code, 80) : 'runner-error';
  const summary = isNonEmptyString(record.summary) ? record.summary : record.message;
  if (containsSecret(summary) || containsSecret(record)) {
    return { code, summary: 'Assistant runner failed with redacted sensitive details' };
  }
  return { code, summary: boundedString(summary, 500) || 'Assistant runner failed' };
}

function validateInputRefs(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'inputRefs must be an array';
  if (JSON.stringify(value).length > 8192) return 'inputRefs must be 8192 bytes or less';
  for (const [index, ref] of value.entries()) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return `inputRefs[${index}] must be an object`;
    if (!isNonEmptyString((ref as Record<string, unknown>).type)) return `inputRefs[${index}].type is required`;
    if (containsSecret(ref)) return `inputRefs[${index}] must not contain secrets`;
  }
  return null;
}

function validateLogRefs(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'logRefs must be an array';
  if (JSON.stringify(value).length > 4096) return 'logRefs must be 4096 bytes or less';
  for (const [index, ref] of value.entries()) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return `logRefs[${index}] must be an object`;
    if (containsSecret(ref)) return `logRefs[${index}] must not contain secrets`;
  }
  return null;
}

function assistantJobRef(job: AssistantJobRecord): AssistantJobRef {
  return {
    assistantJobId: job.id,
    assistantType: job.assistantType,
    status: job.status,
  };
}

function artifactRef(artifact: ArtifactRecord): ArtifactRef {
  return {
    artifactId: artifact.id,
    type: artifact.type,
    title: artifact.title,
    storageUri: artifact.storageUri,
    status: artifact.status,
  };
}

function mergeAssistantJobRef(refs: AssistantJobRef[] | undefined, ref: AssistantJobRef): AssistantJobRef[] {
  const existing = Array.isArray(refs) ? refs : [];
  return existing.filter((item) => item.assistantJobId !== ref.assistantJobId).concat(ref);
}

function mergeArtifactRef(refs: ArtifactRef[] | undefined, ref: ArtifactRef): ArtifactRef[] {
  const existing = Array.isArray(refs) ? refs : [];
  return existing.filter((item) => item.artifactId !== ref.artifactId).concat(ref);
}

function mergeBundleLink(
  links: Array<{ name: string; url: string }> | undefined,
  name: string,
  url: string
): Array<{ name: string; url: string }> {
  const existing = Array.isArray(links) ? links : [];
  let matched = false;
  const next = existing.map((link) => {
    if (link.name === name) {
      matched = true;
      return { name: link.name, url };
    }
    return { name: link.name, url: link.url };
  });
  if (!matched) next.push({ name, url });
  return next;
}

async function mirrorJobRef(client: DynamoDBDocumentClient, job: AssistantJobRecord): Promise<void> {
  const ref = assistantJobRef(job);
  if (job.taskId) {
    const task = await getTask(client, job.taskId);
    if (task) await updateTask(client, job.taskId, { assistantJobRefs: mergeAssistantJobRef(task.assistantJobRefs, ref) });
  }
  if (job.bundleId) {
    const bundle = await getBundle(client, job.bundleId);
    if (bundle) await updateBundle(client, job.bundleId, { assistantJobRefs: mergeAssistantJobRef(bundle.assistantJobRefs, ref) });
  }
}

async function mirrorArtifactRef(client: DynamoDBDocumentClient, job: AssistantJobRecord, artifact: ArtifactRecord): Promise<void> {
  const ref = artifactRef(artifact);
  if (job.taskId) {
    const task = await getTask(client, job.taskId);
    if (task) await updateTask(client, job.taskId, { artifactRefs: mergeArtifactRef(task.artifactRefs, ref) });
  }
  if (job.bundleId) {
    const bundle = await getBundle(client, job.bundleId);
    if (bundle) await updateBundle(client, job.bundleId, { artifactRefs: mergeArtifactRef(bundle.artifactRefs, ref) });
  }
}

async function mirrorApprovedArtifactProof(
  client: DynamoDBDocumentClient,
  job: AssistantJobRecord,
  artifact: ArtifactRecord
): Promise<void> {
  await mirrorArtifactRef(client, job, artifact);

  if (!job.taskId || !artifact.storageUri) return;
  const task = await getTask(client, job.taskId);
  if (!task || !task.requiredLinkName || task.link) return;

  await updateTask(client, job.taskId, {
    link: artifact.storageUri,
    artifactRefs: mergeArtifactRef(task.artifactRefs, artifactRef(artifact)),
  });

  const bundleId = job.bundleId || task.bundleId;
  if (!bundleId) return;
  const bundle = await getBundle(client, bundleId);
  if (!bundle) return;
  await updateBundle(client, bundleId, {
    bundleLinks: mergeBundleLink(bundle.bundleLinks, task.requiredLinkName, artifact.storageUri),
  });
}

async function appendEvent(
  client: DynamoDBDocumentClient,
  jobId: string,
  action: AssistantJobEventAction,
  summary: string,
  actorId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await appendAssistantJobEvent(client, {
    assistantJobId: jobId,
    actorId,
    action,
    summary: boundedString(summary, 1000),
    metadata,
  });
}

async function validateRelationships(client: DynamoDBDocumentClient, taskId?: string, bundleId?: string): Promise<string | null> {
  if (!taskId && !bundleId) return 'taskId or bundleId is required';
  if (taskId && !(await getTask(client, taskId))) return 'Task not found';
  if (bundleId && !(await getBundle(client, bundleId))) return 'Bundle not found';
  return null;
}

function ensureTransition(job: AssistantJobRecord, nextStatus: AssistantJobStatus): string | null {
  if (!ASSISTANT_STATUSES.has(nextStatus)) return 'Unknown assistant job status';
  if (!VALID_TRANSITIONS[job.status].includes(nextStatus)) return `Invalid assistant job transition: ${job.status} -> ${nextStatus}`;
  if (nextStatus === 'succeeded' && job.approvalRequired && job.status !== 'approved' && job.approval?.status !== 'approved') {
    return 'Approval-required jobs cannot become succeeded until approved';
  }
  return null;
}

function ensureRetryAllowed(job: AssistantJobRecord): string | null {
  if (job.attemptCount >= job.maxAttempts) return 'Assistant job retry limit has been reached';
  return null;
}

function retryOverrideError(body: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(body, 'override')) return 'Retry override is not supported by this API';
  return null;
}

function eventActionForStatus(status: AssistantJobStatus): AssistantJobEventAction {
  if (status === 'queued') return 'queued';
  if (status === 'running') return 'started';
  if (status === 'waiting_approval') return 'approval-requested';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'canceled';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  if (status === 'retrying') return 'retry-requested';
  return 'log-appended';
}

function transitionTimestamps(nextStatus: AssistantJobStatus): Record<string, unknown> {
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === 'queued') updates.queuedAt = now;
  if (nextStatus === 'running') updates.startedAt = now;
  if (TERMINAL_STATUSES.has(nextStatus)) updates.completedAt = now;
  return updates;
}

async function createFailureNotification(client: DynamoDBDocumentClient, job: AssistantJobRecord): Promise<void> {
  await createNotification(client, {
    type: 'automation-failure',
    message: `Assistant job failed: ${job.title}`,
    taskId: job.taskId,
    bundleId: job.bundleId,
    userId: job.requestedBy,
  });
}

async function handleCreate(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });

  if (!isNonEmptyString(body.assistantType)) return jsonResponse(400, { error: 'assistantType is required' });
  const taskId = isNonEmptyString(body.taskId) ? body.taskId : undefined;
  const bundleId = isNonEmptyString(body.bundleId) ? body.bundleId : undefined;
  const relationshipError = await validateRelationships(client, taskId, bundleId);
  if (relationshipError) return jsonResponse(relationshipError.endsWith('not found') ? 404 : 400, { error: relationshipError });

  const inputRefsError = validateInputRefs(body.inputRefs);
  if (inputRefsError) return jsonResponse(400, { error: inputRefsError });
  if (body.maxAttempts !== undefined && (!Number.isInteger(body.maxAttempts) || Number(body.maxAttempts) < 1 || Number(body.maxAttempts) > 10)) {
    return jsonResponse(400, { error: 'maxAttempts must be an integer from 1 to 10' });
  }

  const actorId = headerValue(event.headers, 'x-user-id') || (isNonEmptyString(body.requestedBy) ? body.requestedBy : undefined);
  const job = await createAssistantJob(client, {
    assistantType: body.assistantType,
    title: isNonEmptyString(body.title) ? body.title : `${body.assistantType} assistant job`,
    taskId,
    bundleId,
    requestedBy: actorId,
    inputRefs: body.inputRefs || [],
    approvalRequired: body.approvalRequired !== undefined ? body.approvalRequired === true : true,
    approval: body.approvalRequired === false ? undefined : { status: 'pending' },
    maxAttempts: body.maxAttempts || 2,
    retryOfJobId: isNonEmptyString(body.retryOfJobId) ? body.retryOfJobId : undefined,
  });

  await mirrorJobRef(client, job);
  await appendEvent(client, job.id, 'created', 'Assistant job draft created', actorId, { status: job.status });
  return jsonResponse(201, { job });
}

async function handleUpdateDraft(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.status !== 'draft') return jsonResponse(400, { error: 'Only draft assistant jobs can be updated' });
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });

  const updates: Record<string, unknown> = {};
  for (const field of ['assistantType', 'title', 'taskId', 'bundleId', 'inputRefs', 'approvalRequired', 'maxAttempts']) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  if (updates.inputRefs !== undefined) {
    const inputRefsError = validateInputRefs(updates.inputRefs);
    if (inputRefsError) return jsonResponse(400, { error: inputRefsError });
  }
  const taskId = updates.taskId !== undefined ? (isNonEmptyString(updates.taskId) ? updates.taskId : undefined) : job.taskId;
  const bundleId = updates.bundleId !== undefined ? (isNonEmptyString(updates.bundleId) ? updates.bundleId : undefined) : job.bundleId;
  const relationshipError = await validateRelationships(client, taskId, bundleId);
  if (relationshipError) return jsonResponse(relationshipError.endsWith('not found') ? 404 : 400, { error: relationshipError });
  if (updates.maxAttempts !== undefined && (!Number.isInteger(updates.maxAttempts) || Number(updates.maxAttempts) < 1 || Number(updates.maxAttempts) > 10)) {
    return jsonResponse(400, { error: 'maxAttempts must be an integer from 1 to 10' });
  }
  if (updates.approvalRequired === true && !job.approval) updates.approval = { status: 'pending' };
  if (updates.approvalRequired === false) updates.approval = undefined;

  const updated = await updateAssistantJob(client, id, updates);
  if (updated) {
    await mirrorJobRef(client, updated);
    await appendEvent(client, id, 'log-appended', 'Assistant job draft updated', headerValue(event.headers, 'x-user-id') || undefined);
  }
  return jsonResponse(200, { job: updated });
}

async function handleSubmit(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.status !== 'draft' && job.status !== 'retrying') return jsonResponse(400, { error: `Invalid assistant job transition: ${job.status} -> queued` });
  const attemptCount = job.attemptCount > 0 ? job.attemptCount : 1;
  const updated = await updateAssistantJob(client, id, { ...transitionTimestamps('queued'), attemptCount, lastError: undefined });
  if (updated) {
    await mirrorJobRef(client, updated);
    await appendEvent(client, id, 'queued', 'Assistant job submitted to queue', headerValue(event.headers, 'x-user-id') || undefined, { attemptCount });
  }
  return jsonResponse(200, { job: updated });
}

async function handleTransition(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });
  if (!isNonEmptyString(body.status) || !ASSISTANT_STATUSES.has(body.status as AssistantJobStatus)) {
    return jsonResponse(400, { error: 'Unknown assistant job status' });
  }
  const nextStatus = body.status as AssistantJobStatus;
  const transitionError = ensureTransition(job, nextStatus);
  if (transitionError) return jsonResponse(400, { error: transitionError });
  if (nextStatus === 'retrying') {
    const overrideError = retryOverrideError(body);
    if (overrideError) return jsonResponse(400, { error: overrideError });
    const retryError = ensureRetryAllowed(job);
    if (retryError) return jsonResponse(400, { error: retryError });
  }

  const metadata = sanitizeMetadata(body.metadata);
  const logRefsError = validateLogRefs(body.logRefs);
  if (logRefsError) return jsonResponse(400, { error: logRefsError });
  const outputArtifactIds = Array.isArray(body.outputArtifactIds) ? body.outputArtifactIds.filter(isNonEmptyString) : job.outputArtifactIds;
  const logRefs = Array.isArray(body.logRefs) ? body.logRefs as AssistantJobLogRef[] : job.logRefs;
  const updates: Record<string, unknown> = {
    ...transitionTimestamps(nextStatus),
    outputArtifactIds,
    logRefs,
  };
  if (nextStatus === 'retrying') updates.attemptCount = job.attemptCount + 1;
  const sanitizedError = sanitizeError(body.error || body.lastError);
  if (sanitizedError) updates.lastError = sanitizedError;

  const updated = await updateAssistantJob(client, id, updates);
  if (updated) {
    await mirrorJobRef(client, updated);
    if (nextStatus === 'failed') await createFailureNotification(client, updated);
    await appendEvent(
      client,
      id,
      eventActionForStatus(nextStatus),
      isNonEmptyString(body.summary) ? body.summary : `Assistant job moved to ${nextStatus}`,
      headerValue(event.headers, 'x-user-id') || undefined,
      metadata || { from: job.status, to: nextStatus, attemptCount: updated.attemptCount }
    );
  }
  return jsonResponse(200, { job: updated });
}

async function handleRetry(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.status !== 'failed' && job.status !== 'rejected') return jsonResponse(400, { error: 'Only failed or rejected assistant jobs can be retried' });
  const body = parseBody(event) || {};
  const overrideError = retryOverrideError(body);
  if (overrideError) return jsonResponse(400, { error: overrideError });
  const retryError = ensureRetryAllowed(job);
  if (retryError) return jsonResponse(400, { error: retryError });
  const attemptCount = job.attemptCount + 1;
  const updated = await updateAssistantJob(client, id, {
    status: 'retrying',
    attemptCount,
  });
  if (updated) {
    await mirrorJobRef(client, updated);
    await appendEvent(client, id, 'retry-requested', 'Assistant job retry requested', headerValue(event.headers, 'x-user-id') || undefined, { attemptCount });
  }
  return jsonResponse(200, { job: updated });
}

async function handleApprove(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.status !== 'waiting_approval') return jsonResponse(400, { error: 'Only waiting_approval assistant jobs can be approved' });
  const actorId = headerValue(event.headers, 'x-user-id') || job.requestedBy;
  const decidedAt = new Date().toISOString();
  const approval: Record<string, unknown> = { status: 'approved', decidedAt };
  if (actorId) approval.decidedBy = actorId;
  const approvedArtifacts: ArtifactRecord[] = [];
  for (const artifactId of Array.from(new Set(job.outputArtifactIds))) {
    const artifact = await getArtifact(client, artifactId);
    if (!artifact) continue;
    const artifactUpdates: Record<string, unknown> = {
      status: 'approved',
      reviewedAt: decidedAt,
    };
    if (actorId) artifactUpdates.reviewedBy = actorId;
    const approvedArtifact = await updateArtifact(client, artifact.id, artifactUpdates);
    if (approvedArtifact) approvedArtifacts.push(approvedArtifact);
  }
  const updated = await updateAssistantJob(client, id, {
    status: 'approved',
    approval,
    completedAt: decidedAt,
  });
  if (updated) {
    await mirrorJobRef(client, updated);
    for (const artifact of approvedArtifacts) {
      await mirrorApprovedArtifactProof(client, updated, artifact);
    }
    await appendEvent(client, id, 'approved', 'Assistant job output approved', actorId, { outputArtifactIds: updated.outputArtifactIds });
  }
  return jsonResponse(200, { job: updated });
}

async function handleReject(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.status !== 'waiting_approval') return jsonResponse(400, { error: 'Only waiting_approval assistant jobs can be rejected' });
  const body = parseBody(event);
  if (!body || !isNonEmptyString(body.reason)) return jsonResponse(400, { error: 'rejection reason is required' });
  if (containsSecret(body.reason)) return jsonResponse(400, { error: 'rejection reason must not contain secrets' });
  const actorId = headerValue(event.headers, 'x-user-id') || job.requestedBy;
  const decidedAt = new Date().toISOString();
  const reason = boundedString(body.reason, 1000);
  const approval: Record<string, unknown> = { status: 'rejected', decidedAt, reason };
  if (actorId) approval.decidedBy = actorId;
  const updated = await updateAssistantJob(client, id, {
    status: 'rejected',
    approval,
    completedAt: decidedAt,
  });
  if (updated) {
    await mirrorJobRef(client, updated);
    await appendEvent(client, id, 'rejected', 'Assistant job output rejected', actorId, { reason });
  }
  return jsonResponse(200, { job: updated });
}

async function handleCancel(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (TERMINAL_STATUSES.has(job.status)) return jsonResponse(400, { error: 'Terminal assistant jobs cannot be canceled' });
  const updated = await updateAssistantJob(client, id, transitionTimestamps('canceled'));
  if (updated) {
    await mirrorJobRef(client, updated);
    await appendEvent(client, id, 'canceled', 'Assistant job canceled', headerValue(event.headers, 'x-user-id') || undefined);
  }
  return jsonResponse(200, { job: updated });
}

async function handleAttachArtifact(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  const body = parseBody(event);
  if (!body || !isNonEmptyString(body.artifactId)) return jsonResponse(400, { error: 'artifactId is required' });
  const artifact = await getArtifact(client, body.artifactId);
  if (!artifact) return jsonResponse(404, { error: 'Artifact not found' });

  const artifactUpdates: Record<string, unknown> = { assistantJobId: job.id };
  if (job.taskId && !artifact.taskId) artifactUpdates.taskId = job.taskId;
  if (job.bundleId && !artifact.bundleId) artifactUpdates.bundleId = job.bundleId;
  const updatedArtifact = await updateArtifact(client, artifact.id, artifactUpdates);
  const outputArtifactIds = Array.from(new Set(job.outputArtifactIds.concat(artifact.id)));
  const updated = await updateAssistantJob(client, id, { outputArtifactIds });
  if (updated && updatedArtifact) {
    await mirrorJobRef(client, updated);
    await mirrorArtifactRef(client, updated, updatedArtifact);
    await appendEvent(client, id, 'artifact-attached', 'Assistant output artifact attached', headerValue(event.headers, 'x-user-id') || undefined, { artifactIds: [artifact.id] });
  }
  return jsonResponse(200, { job: updated, artifact: updatedArtifact });
}

function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function handlePodcastDryRun(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  let job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  if (job.assistantType !== 'podcast') return jsonResponse(400, { error: 'Dry-run runner is only available for podcast assistant jobs' });
  if (TERMINAL_STATUSES.has(job.status)) return jsonResponse(400, { error: 'Terminal assistant jobs cannot be dry-run' });

  const actorId = headerValue(event.headers, 'x-user-id') || job.requestedBy;
  if (job.status === 'draft') {
    const submitted = await updateAssistantJob(client, id, { ...transitionTimestamps('queued'), attemptCount: job.attemptCount || 1 });
    if (submitted) {
      job = submitted;
      await mirrorJobRef(client, job);
      await appendEvent(client, id, 'queued', 'Podcast dry-run submitted assistant job', actorId, { runner: 'podcast-dry-run' });
    }
  }
  if (job.status === 'queued' || job.status === 'retrying') {
    const running = await updateAssistantJob(client, id, transitionTimestamps('running'));
    if (running) {
      job = running;
      await mirrorJobRef(client, job);
      await appendEvent(client, id, 'started', 'Podcast dry-run started', actorId, { runner: 'podcast-dry-run' });
    }
  }
  if (job.status !== 'running') return jsonResponse(400, { error: `Invalid assistant job transition: ${job.status} -> running` });

  const outputMetadata = {
    assistant_job_id: job.id,
    assistant_type: job.assistantType,
    input_ref_count: job.inputRefs.length,
    output_kind: 'podcast-prep-draft',
    runner: 'podcast-dry-run',
    title: job.title,
  };
  const artifact = await createArtifact(client, {
    type: 'assistant-output',
    title: `${job.title} output metadata`,
    description: 'Deterministic DataOps podcast assistant dry-run output metadata.',
    status: job.approvalRequired ? 'needs-review' : 'approved',
    storageProvider: 'local-dev',
    storageUri: `local-dev://assistant-jobs/${job.id}/podcast-dry-run.json`,
    checksum: stableHash(outputMetadata),
    dataClass: 'internal',
    visibility: 'internal',
    taskId: job.taskId,
    bundleId: job.bundleId,
    assistantJobId: job.id,
    sourceType: 'assistant-output',
    createdBy: actorId,
    metadata: outputMetadata,
  });

  const nextStatus: AssistantJobStatus = job.approvalRequired ? 'waiting_approval' : 'succeeded';
  const updated = await updateAssistantJob(client, id, {
    ...transitionTimestamps(nextStatus),
    outputArtifactIds: Array.from(new Set(job.outputArtifactIds.concat(artifact.id))),
    lastError: undefined,
  });
  if (updated) {
    await mirrorJobRef(client, updated);
    await mirrorArtifactRef(client, updated, artifact);
    await appendEvent(client, id, 'artifact-attached', 'Podcast dry-run output artifact attached', actorId, { artifactIds: [artifact.id], runner: 'podcast-dry-run' });
    await appendEvent(client, id, eventActionForStatus(nextStatus), `Podcast dry-run moved job to ${nextStatus}`, actorId, { runner: 'podcast-dry-run' });
  }
  return jsonResponse(200, { job: updated, artifact });
}

async function handleAppendEvent(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });
  if (!isNonEmptyString(body.action) || !EVENT_ACTIONS.has(body.action as AssistantJobEventAction)) {
    return jsonResponse(400, { error: 'Unknown assistant job event action' });
  }
  if (!isNonEmptyString(body.summary)) return jsonResponse(400, { error: 'summary is required' });
  if (containsSecret(body.summary)) return jsonResponse(400, { error: 'summary must not contain secrets' });
  const metadata = sanitizeMetadata(body.metadata);
  const actorId = headerValue(event.headers, 'x-user-id') || (isNonEmptyString(body.actorId) ? body.actorId : undefined);
  const created = await appendAssistantJobEvent(client, {
    assistantJobId: id,
    actorId,
    action: body.action,
    summary: boundedString(body.summary, 1000),
    metadata,
  });
  return jsonResponse(201, { event: created });
}

async function handleDetail(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const job = await getAssistantJob(client, id);
  if (!job) return jsonResponse(404, { error: 'Assistant job not found' });
  const artifacts = await listArtifacts(client, { assistantJobId: id });
  const events = await listAssistantJobEvents(client, id);
  return jsonResponse(200, { job, artifacts, events: events.slice(-50) });
}

async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  if (params.status && !ASSISTANT_STATUSES.has(params.status as AssistantJobStatus)) {
    return jsonResponse(400, { error: 'Unknown assistant job status' });
  }
  const jobs = await listAssistantJobs(client, {
    status: params.status,
    assistantType: params.assistantType,
    taskId: params.taskId,
    bundleId: params.bundleId,
    needsApproval: params.needsApproval === 'true',
  });
  return jsonResponse(200, { jobs });
}

async function handleAssistantJobRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const reqPath = event.path || '/';
  if (!reqPath.startsWith('/api/assistant-jobs')) return null;

  const suffix = reqPath.slice('/api/assistant-jobs'.length);

  try {
    if ((suffix === '' || suffix === '/') && method === 'POST') return await handleCreate(event, client);
    if ((suffix === '' || suffix === '/') && method === 'GET') return await handleList(event, client);

    const actionMatch = suffix.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (actionMatch) {
      const [, id, action] = actionMatch;
      if ((method === 'POST' || method === 'PUT') && action === 'submit') return await handleSubmit(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'transition') return await handleTransition(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'retry') return await handleRetry(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'approve') return await handleApprove(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'reject') return await handleReject(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'cancel') return await handleCancel(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'artifacts') return await handleAttachArtifact(id, event, client);
      if ((method === 'POST' || method === 'PUT') && action === 'run-dry') return await handlePodcastDryRun(id, event, client);
      if (method === 'POST' && action === 'events') return await handleAppendEvent(id, event, client);
      if (method === 'GET' && action === 'events') {
        const events = await listAssistantJobEvents(client, id);
        return jsonResponse(200, { events: events.slice(-50) });
      }
    }

    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch && method === 'GET') return await handleDetail(idMatch[1], client);
    if (idMatch && method === 'PUT') return await handleUpdateDraft(idMatch[1], event, client);

    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    if (err instanceof Error && (
      err.message.includes('metadata must')
      || err.message.includes('must not contain secrets')
    )) {
      return jsonResponse(400, { error: err.message });
    }
    console.error('Assistant job route error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

export {
  ASSISTANT_STATUSES,
  handleAssistantJobRoutes,
};
