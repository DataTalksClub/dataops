import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { getClient } from '../db/client';
import { createArtifact, getArtifact, listArtifacts, updateArtifact } from '../db/artifacts';
import { getBundle, updateBundle } from '../db/bundles';
import { getFile } from '../db/files';
import { getTask, updateTask } from '../db/tasks';
import { isLocalFilesystemStorageAllowed } from '../storage';
import type { ArtifactRecord, ArtifactRef, LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const ARTIFACT_TYPES = new Set(['podcast-doc', 'transcript', 'recording', 'report', 'invoice', 'event-page', 'assistant-output', 'external-link', 'other']);
const ARTIFACT_STATUSES = new Set(['draft', 'needs-review', 'approved', 'rejected', 'archived', 'superseded']);
const STORAGE_PROVIDERS = new Set(['s3', 'dropbox', 'google-drive', 'github', 'external-url', 'local-dev', 'unknown']);
const DATA_CLASSES = new Set(['public', 'internal', 'private', 'sensitive']);
const SOURCE_TYPES = new Set(['manual-link', 'manual-upload', 'assistant-output', 'import', 'migration', 'system']);
const SECRET_KEY_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SIGNED_URL_PATTERN = /(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature=|sig=|access_token=|token=)/i;
let signArtifactUrl = getSignedUrl;
let artifactS3Client: S3Client | null = null;

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function publicArtifact(artifact: ArtifactRecord): ArtifactRecord {
  if (!artifact.storageUri?.startsWith('s3://')) return artifact;
  const { storageUri: _storageUri, ...safe } = artifact;
  return safe as ArtifactRecord;
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

function inferStorageProvider(storageUri: string): string {
  if (storageUri.startsWith('s3://')) return 's3';
  if (storageUri.startsWith('local-dev://')) return 'local-dev';
  if (storageUri.includes('github.com')) return 'github';
  if (storageUri.includes('dropbox.com')) return 'dropbox';
  if (storageUri.includes('drive.google.com') || storageUri.includes('docs.google.com')) return 'google-drive';
  if (/^https?:\/\//.test(storageUri)) return 'external-url';
  return 'unknown';
}

function validateStringArray(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return `${field} must be an array of strings`;
  }
  return null;
}

function validateMetadata(value: unknown, path = 'metadata'): string | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'metadata must be an object';
  }
  const json = JSON.stringify(value);
  if (json.length > 4096) return 'metadata must be 4096 bytes or less';

  const stack: Array<{ prefix: string; record: Record<string, unknown> }> = [{ prefix: path, record: value as Record<string, unknown> }];
  while (stack.length > 0) {
    const current = stack.pop() as { prefix: string; record: Record<string, unknown> };
    for (const [key, child] of Object.entries(current.record)) {
      const childPath = `${current.prefix}.${key}`;
      if (SECRET_KEY_PATTERN.test(key)) return `${childPath} must not contain secrets or signed URLs`;
      if (typeof child === 'string' && SIGNED_URL_PATTERN.test(child)) return `${childPath} must not contain signed URLs or tokens`;
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        stack.push({ prefix: childPath, record: child as Record<string, unknown> });
      }
    }
  }
  return null;
}

function validateArtifactFields(fields: Record<string, unknown>, requireCoreFields: boolean): string | null {
  if (requireCoreFields) {
    for (const field of ['type', 'title', 'storageUri']) {
      if (!isNonEmptyString(fields[field])) return `Missing required field: ${field}`;
    }
  }

  if (fields.type !== undefined && (!isNonEmptyString(fields.type) || !ARTIFACT_TYPES.has(fields.type))) {
    return `type must be one of: ${Array.from(ARTIFACT_TYPES).join(', ')}`;
  }
  if (fields.title !== undefined && !isNonEmptyString(fields.title)) return 'title must be a non-empty string';
  if (fields.description !== undefined && typeof fields.description !== 'string') return 'description must be a string';
  if (fields.status !== undefined && (!isNonEmptyString(fields.status) || !ARTIFACT_STATUSES.has(fields.status))) {
    return `status must be one of: ${Array.from(ARTIFACT_STATUSES).join(', ')}`;
  }
  if (fields.storageUri !== undefined) {
    if (!isNonEmptyString(fields.storageUri)) return 'storageUri must be a non-empty string';
    if (SIGNED_URL_PATTERN.test(fields.storageUri)) return 'storageUri must be stable and must not be a signed URL or tokenized URL';
  }

  const storageProvider = fields.storageProvider || (typeof fields.storageUri === 'string' ? inferStorageProvider(fields.storageUri) : undefined);
  if (storageProvider !== undefined && (!isNonEmptyString(storageProvider) || !STORAGE_PROVIDERS.has(storageProvider))) {
    return `storageProvider must be one of: ${Array.from(STORAGE_PROVIDERS).join(', ')}`;
  }
  if (storageProvider === 'local-dev' && !isLocalFilesystemStorageAllowed()) {
    return 'local-dev artifact storage is allowed only in local/test mode';
  }
  if ((storageProvider === 's3' || storageProvider === 'local-dev') && fields.checksum !== undefined && !isNonEmptyString(fields.checksum)) {
    return 'checksum must be a non-empty string when present';
  }
  if ((storageProvider === 's3' || storageProvider === 'local-dev') && requireCoreFields && !isNonEmptyString(fields.checksum)) {
    return 'checksum is required for DataOps-owned s3 or local-dev artifacts';
  }

  if (fields.filename !== undefined && typeof fields.filename !== 'string') return 'filename must be a string';
  if (fields.contentType !== undefined && typeof fields.contentType !== 'string') return 'contentType must be a string';
  if (fields.sizeBytes !== undefined && (typeof fields.sizeBytes !== 'number' || !Number.isFinite(fields.sizeBytes) || fields.sizeBytes < 0)) {
    return 'sizeBytes must be a non-negative number';
  }
  if (fields.visibility !== undefined && (!isNonEmptyString(fields.visibility) || !DATA_CLASSES.has(fields.visibility))) {
    return `visibility must be one of: ${Array.from(DATA_CLASSES).join(', ')}`;
  }
  if (fields.dataClass !== undefined && (!isNonEmptyString(fields.dataClass) || !DATA_CLASSES.has(fields.dataClass))) {
    return `dataClass must be one of: ${Array.from(DATA_CLASSES).join(', ')}`;
  }
  if (fields.sourceType !== undefined && (!isNonEmptyString(fields.sourceType) || !SOURCE_TYPES.has(fields.sourceType))) {
    return `sourceType must be one of: ${Array.from(SOURCE_TYPES).join(', ')}`;
  }
  for (const field of ['taskId', 'bundleId', 'assistantJobId', 'fileId', 'createdBy', 'reviewedBy', 'reviewedAt']) {
    if (fields[field] !== undefined && typeof fields[field] !== 'string') return `${field} must be a string`;
  }
  const tagsError = validateStringArray(fields.tags, 'tags');
  if (tagsError) return tagsError;
  return validateMetadata(fields.metadata);
}

function artifactRef(artifact: ArtifactRecord): ArtifactRef {
  const ref: ArtifactRef = {
    artifactId: artifact.id,
    type: artifact.type,
    title: artifact.title,
    status: artifact.status,
  };
  if (!artifact.storageUri?.startsWith('s3://')) ref.storageUri = artifact.storageUri;
  return ref;
}

function mergeArtifactRef(refs: ArtifactRef[] | undefined, ref: ArtifactRef): ArtifactRef[] {
  const existing = Array.isArray(refs) ? refs : [];
  const next = existing.filter((item) => item.artifactId !== ref.artifactId);
  next.push(ref);
  return next;
}

async function validateRelationships(client: DynamoDBDocumentClient, fields: Record<string, unknown>): Promise<string | null> {
  if (fields.taskId && !(await getTask(client, String(fields.taskId)))) return 'Task not found';
  if (fields.bundleId && !(await getBundle(client, String(fields.bundleId)))) return 'Bundle not found';
  if (fields.fileId && !(await getFile(client, String(fields.fileId)))) return 'File not found';
  return null;
}

async function handleCreate(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });

  const storageUri = String(body.storageUri || '').trim();
  const storageProvider = body.storageProvider || inferStorageProvider(storageUri);
  const dataClass = body.dataClass || body.visibility || 'internal';
  const artifactData: Record<string, unknown> = {
    type: body.type,
    title: body.title,
    storageUri,
    storageProvider,
    dataClass,
    visibility: body.visibility || dataClass,
    status: body.status || 'draft',
    sourceType: body.sourceType || 'manual-link',
  };

  for (const field of [
    'description', 'filename', 'contentType', 'checksum', 'sizeBytes', 'taskId', 'bundleId',
    'assistantJobId', 'fileId', 'createdBy', 'reviewedBy', 'reviewedAt', 'tags', 'metadata',
  ]) {
    if (body[field] !== undefined) artifactData[field] = body[field];
  }
  if (!artifactData.createdBy) {
    const actor = headerValue(event.headers, 'x-user-id');
    if (actor) artifactData.createdBy = actor;
  }
  if (artifactData.status === 'approved' || artifactData.status === 'rejected') {
    artifactData.reviewedAt = artifactData.reviewedAt || new Date().toISOString();
    artifactData.reviewedBy = artifactData.reviewedBy || artifactData.createdBy;
  }

  const validationError = validateArtifactFields(artifactData, true);
  if (validationError) return jsonResponse(400, { error: validationError });
  const relationshipError = await validateRelationships(client, artifactData);
  if (relationshipError) return jsonResponse(404, { error: relationshipError });

  const artifact = await createArtifact(client, artifactData);
  return jsonResponse(201, { artifact: publicArtifact(artifact) });
}

async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  const artifacts = await listArtifacts(client, {
    taskId: params.taskId,
    bundleId: params.bundleId,
    assistantJobId: params.assistantJobId,
    fileId: params.fileId,
    status: params.status,
    type: params.type,
  });
  return jsonResponse(200, { artifacts: artifacts.map(publicArtifact) });
}

async function handleUpdate(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const existing = await getArtifact(client, id);
  if (!existing) return jsonResponse(404, { error: 'Artifact not found' });
  const body = parseBody(event);
  if (!body || Object.keys(body).length === 0) return jsonResponse(400, { error: 'Request body is required' });

  const allowedFields = [
    'type', 'title', 'description', 'status', 'storageProvider', 'storageUri', 'filename', 'contentType',
    'checksum', 'sizeBytes', 'visibility', 'dataClass', 'taskId', 'bundleId', 'assistantJobId', 'fileId',
    'sourceType', 'reviewedBy', 'reviewedAt', 'tags', 'metadata',
  ];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  if (updates.storageUri && !updates.storageProvider) updates.storageProvider = inferStorageProvider(String(updates.storageUri));
  if (updates.visibility && !updates.dataClass) updates.dataClass = updates.visibility;
  if ((updates.status === 'approved' || updates.status === 'rejected') && !updates.reviewedAt) {
    updates.reviewedAt = new Date().toISOString();
    updates.reviewedBy = updates.reviewedBy || headerValue(event.headers, 'x-user-id') || existing.reviewedBy;
  }

  if (Object.keys(updates).length === 0) return jsonResponse(400, { error: 'No valid fields to update' });
  const validationError = validateArtifactFields({ ...existing, ...updates }, false);
  if (validationError) return jsonResponse(400, { error: validationError });
  const relationshipError = await validateRelationships(client, updates);
  if (relationshipError) return jsonResponse(404, { error: relationshipError });

  const artifact = await updateArtifact(client, id, updates);
  return jsonResponse(200, { artifact: artifact ? publicArtifact(artifact) : artifact });
}

async function handleAttach(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const existing = await getArtifact(client, id);
  if (!existing) return jsonResponse(404, { error: 'Artifact not found' });
  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });
  const taskId = isNonEmptyString(body.taskId) ? body.taskId : undefined;
  const bundleId = isNonEmptyString(body.bundleId) ? body.bundleId : undefined;
  if (!taskId && !bundleId) return jsonResponse(400, { error: 'taskId or bundleId is required' });

  const updates: Record<string, unknown> = {};
  const ref = artifactRef(existing);
  if (taskId) {
    const task = await getTask(client, taskId);
    if (!task) return jsonResponse(404, { error: 'Task not found' });
    updates.taskId = taskId;
    await updateTask(client, taskId, { artifactRefs: mergeArtifactRef(task.artifactRefs, ref) });
  }
  if (bundleId) {
    const bundle = await getBundle(client, bundleId);
    if (!bundle) return jsonResponse(404, { error: 'Bundle not found' });
    updates.bundleId = bundleId;
    await updateBundle(client, bundleId, { artifactRefs: mergeArtifactRef(bundle.artifactRefs, ref) });
  }

  const artifact = await updateArtifact(client, id, updates);
  return jsonResponse(200, { artifact: artifact ? publicArtifact(artifact) : artifact });
}

async function handleArchive(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const existing = await getArtifact(client, id);
  if (!existing) return jsonResponse(404, { error: 'Artifact not found' });
  const artifact = await updateArtifact(client, id, { status: 'archived' });
  return jsonResponse(200, { artifact: artifact ? publicArtifact(artifact) : artifact });
}

async function handlePrivateDownload(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const artifact = await getArtifact(client, id);
  if (!artifact) return jsonResponse(404, { error: 'Artifact not found' });
  const emailBucket = process.env.EMAIL_DOCUMENTS_BUCKET || '';
  const mailingBucket = process.env.DATAOPS_MAILING_EXPORTS_BUCKET || '';
  const prefix = (process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX || 'artifacts/').replace(/^\/+|\/+$/g, '');
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(artifact.storageUri || '');
  const emailDocument = artifact.dataClass === 'sensitive' && match?.[1] === emailBucket && match[2].startsWith(`${prefix}/`);
  const mailingExport = artifact.dataClass === 'private' && match?.[1] === mailingBucket && match[2].startsWith('mailing-exports/');
  if (!match || (!emailDocument && !mailingExport)) {
    return jsonResponse(409, { error: 'Private download is not available for this artifact' });
  }
  artifactS3Client ||= new S3Client({});
  const downloadUrl = await signArtifactUrl(artifactS3Client, new GetObjectCommand({ Bucket: match[1], Key: match[2] }), { expiresIn: 300 });
  return jsonResponse(200, { downloadUrl, expiresIn: 300 });
}

function setArtifactDownloadSignerForTests(signer: typeof getSignedUrl): void {
  signArtifactUrl = signer;
}

async function handleArtifactRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const reqPath = event.path || '/';
  if (!reqPath.startsWith('/api/artifacts')) return null;

  const client = await getClient();
  const suffix = reqPath.slice('/api/artifacts'.length);

  try {
    if ((suffix === '' || suffix === '/') && method === 'POST') return await handleCreate(event, client);
    if ((suffix === '' || suffix === '/') && method === 'GET') return await handleList(event, client);

    const attachMatch = suffix.match(/^\/([^/]+)\/attach\/?$/);
    if (attachMatch && (method === 'PUT' || method === 'POST')) return await handleAttach(attachMatch[1], event, client);

    const archiveMatch = suffix.match(/^\/([^/]+)\/archive\/?$/);
    if (archiveMatch && method === 'PUT') return await handleArchive(archiveMatch[1], client);

    const downloadMatch = suffix.match(/^\/([^/]+)\/download\/?$/);
    if (downloadMatch && method === 'GET') return await handlePrivateDownload(downloadMatch[1], client);

    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch && method === 'GET') {
      const artifact = await getArtifact(client, idMatch[1]);
      if (!artifact) return jsonResponse(404, { error: 'Artifact not found' });
      return jsonResponse(200, { artifact: publicArtifact(artifact) });
    }
    if (idMatch && method === 'PUT') return await handleUpdate(idMatch[1], event, client);

    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    console.error('Artifact route error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

export {
  handleArtifactRoutes,
  setArtifactDownloadSignerForTests,
  validateArtifactFields,
};
