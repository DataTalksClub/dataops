import crypto from 'crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { getTask } from '../db/tasks';
import {
  createFile,
  getFile,
  deleteFile,
  listFilesByTaskPage,
  listFilesPage,
  listFilesByTask,
  listFiles,
} from '../db/files';
import { CollectionCursorError, encodeCollectionCursor } from '../db/collectionPagination';
import {
  saveFile,
  readFile,
  removeFile,
  validateFilename,
  FileStorageError,
  createFileDownloadAuthorization,
  verifyLocalDownloadLink,
  contentDispositionFor,
  getMimeType,
} from '../storage';
import { resolveInteractiveActor } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';
import { recordRequestError } from '../requestErrorLog';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function paginationFailure(error: unknown): LambdaResponse | null {
  if (!(error instanceof CollectionCursorError)) return null;
  return jsonResponse(400, { error: 'Invalid pagination input', code: 'invalid_pagination_input' });
}

function fileViewer(actorId: string): string {
  return actorId || 'test-bypass';
}

/**
 * Simple multipart/form-data parser.
 * Extracts fields and file content from the raw body string.
 */
interface ParsedMultipart {
  fields: Record<string, string>;
  file?: {
    filename: string;
    content: Buffer;
    contentType: string;
  };
}

function parseMultipart(body: string, contentType: string): ParsedMultipart {
  const result: ParsedMultipart = { fields: {} };

  // Extract boundary from Content-Type header
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!boundaryMatch) {
    return result;
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  // Convert body to a Buffer for binary-safe operations
  const bodyBuffer = Buffer.from(body, 'binary');
  const boundaryBuffer = Buffer.from('--' + boundary);

  // Find all boundary positions
  const positions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = bodyBuffer.indexOf(boundaryBuffer, searchFrom);
    if (idx === -1) break;
    const followsLine = idx === 0 || (bodyBuffer[idx - 2] === 13 && bodyBuffer[idx - 1] === 10);
    const after = bodyBuffer.subarray(idx + boundaryBuffer.length, idx + boundaryBuffer.length + 2).toString('ascii');
    if (followsLine && (after === '\r\n' || after === '--')) positions.push(idx);
    searchFrom = idx + boundaryBuffer.length;
  }

  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i] + boundaryBuffer.length;
    const end = positions[i + 1];

    const partBuffer = bodyBuffer.subarray(start, end);
    const partStr = partBuffer.toString('binary');

    // Find the header/body separator (double CRLF)
    const headerEnd = partStr.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerSection = partStr.substring(0, headerEnd);
    const bodyStart = headerEnd + 4; // skip \r\n\r\n

    // Get the body content (remove trailing \r\n before next boundary)
    let bodyContent = partBuffer.subarray(bodyStart);
    // Trim trailing \r\n
    if (bodyContent.length >= 2 &&
        bodyContent[bodyContent.length - 2] === 0x0d &&
        bodyContent[bodyContent.length - 1] === 0x0a) {
      bodyContent = bodyContent.subarray(0, bodyContent.length - 2);
    }

    // Parse Content-Disposition header
    const dispositionMatch = headerSection.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!dispositionMatch) continue;

    const fieldName = dispositionMatch[1];
    const filename = dispositionMatch[2];

    if (filename !== undefined) {
      // This is a file field
      const ctMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);
      const fileContentType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';

      result.file = {
        filename: Buffer.from(filename, 'binary').toString('utf8'),
        content: Buffer.from(bodyContent),
        contentType: fileContentType,
      };
    } else {
      // This is a regular form field
      result.fields[fieldName] = bodyContent.toString('utf-8');
    }
  }

  return result;
}

/**
 * Handle all /api/files routes.
 */
async function handleFileRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const reqPath = event.path || '/';

  if (!reqPath.startsWith('/api/files')) {
    return null;
  }

  const client = await getClient();

  try {
    const suffix = reqPath.slice('/api/files'.length);

    // Route: POST /api/files (upload)
    if (method === 'POST' && (suffix === '' || suffix === '/')) {
      return await handleUpload(event, client);
    }

    // Route: GET /api/files (list with query params)
    if (method === 'GET' && (suffix === '' || suffix === '/')) {
      return await handleList(event, client);
    }

    // Route: GET /api/files/:id/download — mint a short-lived download link
    const downloadMatch = suffix.match(/^\/([^/]+)\/download\/?$/);
    if (downloadMatch && method === 'GET') {
      const id = downloadMatch[1];
      return await handleDownload(id, client);
    }

    // Route: GET /api/files/:id/content — HMAC-scoped delivery for local-dev
    // storage only; the link proves its own authorization.
    const contentMatch = suffix.match(/^\/([^/]+)\/content$/);
    if (contentMatch && method === 'GET') {
      return await handleLocalContent(contentMatch[1], event, client);
    }

    // Route: GET /api/files/:id (metadata)
    const idMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (idMatch && method === 'GET') {
      const id = idMatch[1];
      return await handleGetMetadata(id, client);
    }

    // Route: DELETE /api/files/:id
    if (idMatch && method === 'DELETE') {
      const id = idMatch[1];
      return await handleDelete(id, client);
    }

    // Not matched within /api/files
    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    if (err instanceof FileStorageError) return jsonResponse(err.statusCode, { error: err.message, code: err.code });
    recordRequestError(err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Handle POST /api/files - upload a file.
 */
async function handleUpload(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';

  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse(400, { error: 'Content-Type must be multipart/form-data' });
  }

  if (!event.body) {
    return jsonResponse(400, { error: 'Request body is required' });
  }

  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('binary') : event.body;
  const parsed = parseMultipart(body, contentType);

  const taskId = parsed.fields.taskId;
  if (!taskId) {
    return jsonResponse(400, { error: 'Missing required field: taskId' });
  }

  if (!parsed.file || !parsed.file.filename) {
    return jsonResponse(400, { error: 'Missing required field: file' });
  }
  validateFilename(parsed.file.filename);

  // Validate that task exists
  const task = await getTask(client, taskId);
  if (!task) {
    return jsonResponse(404, { error: 'Task not found' });
  }

  const category = parsed.fields.category || 'document';
  const validCategories = ['image', 'invoice', 'document'];
  if (!validCategories.includes(category)) {
    return jsonResponse(400, { error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
  }

  let tags: string[] | undefined;
  if (parsed.fields.tags) {
    try {
      tags = JSON.parse(parsed.fields.tags);
    } catch {
      return jsonResponse(400, { error: 'Invalid tags format. Must be a JSON array.' });
    }
  }

  const location = await saveFile(taskId, parsed.file.filename, parsed.file.content, parsed.file.contentType);

  // Create metadata record
  const fileData: Record<string, unknown> = {
    taskId,
    cardId: task.cardId,
    filename: parsed.file.filename,
    category,
    ...location,
    contentType: parsed.file.contentType,
    checksum: `sha256:${crypto.createHash('sha256').update(parsed.file.content).digest('hex')}`,
    sizeBytes: parsed.file.content.length,
  };

  if (tags) {
    fileData.tags = tags;
  }

  let fileRecord;
  try { fileRecord = await createFile(client, fileData); }
  catch (error) {
    // Do not leave an untracked current object when the metadata write fails.
    try { await removeFile(location); } catch { console.error('Failed to clean up task-file upload after metadata failure'); }
    throw error;
  }

  return jsonResponse(201, { file: fileRecord });
}

/**
 * Handle GET /api/files - list files with query params.
 */
async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  try {
    const viewer = await resolveInteractiveActor(client, event, 'work-read');
    if (!viewer.ok) return viewer.response;
    const params = event.queryStringParameters || {};
    const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
    const filters = {
      category: typeof params.category === 'string' ? params.category : undefined,
      tag: typeof params.tag === 'string' ? params.tag : undefined,
    };
    const binding = {
      collection: 'files',
      filters: { taskId: taskId || null, category: filters.category || null, tag: filters.tag || null },
      principal: fileViewer(viewer.actor.id),
    };
    const page = taskId
      ? await listFilesByTaskPage(client, taskId, binding, params)
      : await listFilesPage(client, filters, binding, params);
    const items = [...page.items].sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
      || left.id.localeCompare(right.id)
    ));
    const body: { files: Record<string, unknown> } = { files: { items } };
    if (page.nextExclusiveStartKey) {
      body.files.nextCursor = await encodeCollectionCursor(binding, page.nextExclusiveStartKey);
    }
    return jsonResponse(200, body);
  } catch (error) {
    const failure = paginationFailure(error);
    if (failure) return failure;
    throw error;
  }
}

/**
 * Handle GET /api/files/:id - get file metadata.
 */
async function handleGetMetadata(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const file = await getFile(client, id);
  if (!file) {
    return jsonResponse(404, { error: 'File not found' });
  }
  return jsonResponse(200, { file });
}

/**
 * Handle GET /api/files/:id/download — mint a short-lived download link.
 * The bytes never move through this Lambda response; the consumer fetches the
 * link directly from storage. The link is minted only after the caller passed
 * authentication and the file record was resolved, and it is never persisted.
 */
async function handleDownload(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const file = await getFile(client, id);
  if (!file) {
    return jsonResponse(404, { error: 'File not found' });
  }

  try {
    const authorization = await createFileDownloadAuthorization(file);
    return jsonResponse(200, { downloadUrl: authorization.url, expiresIn: authorization.expiresIn });
  } catch (err: unknown) {
    if (err instanceof FileStorageError) return jsonResponse(err.statusCode, { error: err.message, code: err.code });
    throw err;
  }
}

/**
 * Handle GET /api/files/:id/content — deliver a local-dev object behind its
 * signed link. The route is auth-exempt because the link itself is the
 * credential (HMAC + expiry, minted post-authorization), and it serves only
 * local-dev objects: production runs on S3 and cannot mint or store
 * local-dev files, so this never becomes an inline-bytes fallback there.
 */
async function handleLocalContent(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  if (!verifyLocalDownloadLink(id, params.expires, params.mac)) {
    return jsonResponse(403, { error: 'Download link is invalid or expired', code: 'file_download_link_invalid' });
  }
  const file = await getFile(client, id);
  if (!file) {
    return jsonResponse(404, { error: 'File not found' });
  }
  if (file.storageProvider !== 'local-dev') {
    return jsonResponse(409, { error: 'File storage provider is unavailable', code: 'file_storage_unavailable' });
  }

  try {
    const content = await readFile(file);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': file.contentType || getMimeType(file.filename),
        'Content-Disposition': contentDispositionFor(file.filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: content.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err: unknown) {
    if (err instanceof FileStorageError) return jsonResponse(err.statusCode, { error: err.message, code: err.code });
    throw err;
  }
}

/**
 * Handle DELETE /api/files/:id - delete file and metadata.
 */
async function handleDelete(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const file = await getFile(client, id);
  if (!file) {
    return jsonResponse(404, { error: 'File not found' });
  }

  // A storage failure must preserve the metadata so the deletion can be retried.
  await removeFile(file);

  // Remove metadata from database
  await deleteFile(client, id);

  return {
    statusCode: 204,
    headers: JSON_HEADERS,
    body: '',
  };
}

export { handleFileRoutes };
