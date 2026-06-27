import path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { getTask } from '../db/tasks';
import {
  createFile,
  getFile,
  deleteFile,
  listFilesByTask,
  listFiles,
} from '../db/files';
import { saveFile, readFile, removeFile } from '../storage';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * Determine MIME type from filename extension.
 */
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeTypes[ext] || 'application/octet-stream';
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
    positions.push(idx);
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
        filename: filename,
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

    // Route: GET /api/files/:id/download
    const downloadMatch = suffix.match(/^\/([^/]+)\/download\/?$/);
    if (downloadMatch && method === 'GET') {
      const id = downloadMatch[1];
      return await handleDownload(id, client);
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
    console.error('File route error:', err);
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

  const parsed = parseMultipart(event.body, contentType);

  const taskId = parsed.fields.taskId;
  if (!taskId) {
    return jsonResponse(400, { error: 'Missing required field: taskId' });
  }

  if (!parsed.file || !parsed.file.filename) {
    return jsonResponse(400, { error: 'Missing required field: file' });
  }

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

  // Save file to filesystem
  const storagePath = saveFile(taskId, parsed.file.filename, parsed.file.content);

  // Create metadata record
  const fileData: Record<string, unknown> = {
    taskId,
    filename: parsed.file.filename,
    category,
    storagePath,
  };

  if (tags) {
    fileData.tags = tags;
  }

  const fileRecord = await createFile(client, fileData);

  return jsonResponse(201, { file: fileRecord });
}

/**
 * Handle GET /api/files - list files with query params.
 */
async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};

  if (params.taskId) {
    const files = await listFilesByTask(client, params.taskId);
    return jsonResponse(200, { files });
  }

  const filters: { category?: string; tag?: string } = {};
  if (params.category) {
    filters.category = params.category;
  }
  if (params.tag) {
    filters.tag = params.tag;
  }

  const files = await listFiles(client, Object.keys(filters).length > 0 ? filters : undefined);
  return jsonResponse(200, { files });
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
 * Handle GET /api/files/:id/download - download file content.
 */
async function handleDownload(id: string, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const file = await getFile(client, id);
  if (!file) {
    return jsonResponse(404, { error: 'File not found' });
  }

  try {
    const content = readFile(file.storagePath);
    const mimeType = getMimeType(file.filename);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
      body: content.toString('binary'),
    };
  } catch (err: unknown) {
    return jsonResponse(404, { error: 'File not found on disk' });
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

  // Remove file from filesystem
  removeFile(file.storagePath);

  // Remove metadata from database
  await deleteFile(client, id);

  return {
    statusCode: 204,
    headers: JSON_HEADERS,
    body: '',
  };
}

export { handleFileRoutes };
