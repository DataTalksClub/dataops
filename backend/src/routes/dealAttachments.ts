import crypto from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord } from '../db/sponsorCrm';
import {
  createDealAttachment,
  deleteDealAttachment,
  getDealAttachment,
  listDealAttachmentAudit,
  listDealAttachments,
  publicDealAttachment,
  recordDealAttachmentAudit,
} from '../db/dealAttachments';
import {
  contentDispositionFor,
  createDealAttachmentDownloadAuthorization,
  FileStorageError,
  getMimeType,
  MAX_DEAL_ATTACHMENT_BYTES,
  readDealAttachment,
  removeDealAttachment,
  saveDealAttachment,
  validateFilename,
  verifyLocalDealAttachmentDownloadLink,
} from '../storage';
import { parseMultipart } from './files';
import { resolveInteractiveActor } from '../identity/actor';
import { JSON_HEADERS, json, jsonResponse } from '../http';
import { recordRequestError } from '../requestErrorLog';
import type { LambdaEvent, LambdaResponse } from '../types';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function decodeId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function actorLabel(actorId: string): string {
  return actorId || 'test-bypass';
}

const PRIVATE_JSON_HEADERS = {
  ...JSON_HEADERS,
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

function privateJson(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: PRIVATE_JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Handle /api/sponsor-crm/deals/:dealId/attachments routes.
 *
 * All attachments are stored in private durable storage (TaskFilesBucket under
 * `crm-deals/`, or local-dev in test/local) and downloaded exclusively via
 * short-lived signed URLs. Uploads, downloads and deletes are audited.
 */
export async function handleDealAttachmentRoutes(
  reqPath: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const baseMatch = reqPath.match(/^\/api\/sponsor-crm\/deals\/([^/]+)\/attachments(?:\/(.*))?$/);
  if (!baseMatch) return null;

  const dealId = decodeId(baseMatch[1]);
  if (!dealId) return json(400, { error: 'Invalid deal ID' });

  const tail = (baseMatch[2] || '').replace(/\/+$/, '');

  // Local-dev HMAC-signed content delivery route (never serves S3/production objects).
  const contentMatch = tail.match(/^([^/]+)\/content$/);
  if (contentMatch && method === 'GET') {
    const attachmentId = decodeId(contentMatch[1]);
    if (!attachmentId) return json(400, { error: 'Invalid attachment ID' });
    return await handleLocalContent(dealId, attachmentId, event, client);
  }

  const auth = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
  if (!auth.ok) return auth.response;
  const actorId = actorLabel(auth.actor.id);

  try {
    // Verify the deal exists for all interactive routes.
    const deal = await getCrmRecord(client, 'deal', dealId);
    if (!deal) return json(404, { error: 'Deal not found' });

    // POST /api/sponsor-crm/deals/:dealId/attachments — upload
    if (!tail && method === 'POST') {
      return await handleUpload(dealId, actorId, event, client);
    }

    // GET /api/sponsor-crm/deals/:dealId/attachments — list
    if (!tail && method === 'GET') {
      const items = (await listDealAttachments(client, dealId)).map(publicDealAttachment);
      return privateJson(200, { items });
    }

    // GET /api/sponsor-crm/deals/:dealId/attachments/audit — audit log
    if (tail === 'audit' && method === 'GET') {
      const items = await listDealAttachmentAudit(client, dealId);
      return privateJson(200, { items });
    }

    // GET /api/sponsor-crm/deals/:dealId/attachments/:attachmentId/download — signed download link
    const downloadMatch = tail.match(/^([^/]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      const attachmentId = decodeId(downloadMatch[1]);
      if (!attachmentId) return json(400, { error: 'Invalid attachment ID' });
      return await handleDownload(dealId, attachmentId, actorId, client);
    }

    // GET / DELETE /api/sponsor-crm/deals/:dealId/attachments/:attachmentId
    if (tail && !tail.includes('/')) {
      const attachmentId = decodeId(tail);
      if (!attachmentId) return json(400, { error: 'Invalid attachment ID' });
      if (method === 'GET') {
        const attachment = await getDealAttachment(client, dealId, attachmentId);
        if (!attachment) return json(404, { error: 'Attachment not found' });
        return privateJson(200, { attachment: publicDealAttachment(attachment) });
      }
      if (method === 'DELETE') {
        return await handleDelete(dealId, attachmentId, actorId, client);
      }
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err: unknown) {
    if (err instanceof FileStorageError) {
      return privateJson(err.statusCode, {
        error: err.message,
        code: err.code,
        ...(err.code === 'file_too_large' ? { maxBytes: MAX_DEAL_ATTACHMENT_BYTES } : {}),
      });
    }
    recordRequestError(err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpload(
  dealId: string,
  actorId: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return json(400, { error: 'Content-Type must be multipart/form-data' });
  }
  if (!event.body) {
    return json(400, { error: 'Request body is required' });
  }

  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('binary') : event.body;
  const parsed = parseMultipart(body, contentType);

  if (!parsed.file || !parsed.file.filename) {
    return json(400, { error: 'Missing required field: file' });
  }

  validateFilename(parsed.file.filename);

  if (parsed.file.content.length > MAX_DEAL_ATTACHMENT_BYTES) {
    return privateJson(413, {
      error: `File exceeds the ${MAX_DEAL_ATTACHMENT_BYTES / (1024 * 1024)} MiB upload limit`,
      code: 'file_too_large',
      maxBytes: MAX_DEAL_ATTACHMENT_BYTES,
    });
  }

  const rawNote = parsed.fields.note?.trim();
  if (rawNote && rawNote.length > 500) {
    return json(400, { error: 'note must be at most 500 characters' });
  }

  const fileContentType = parsed.file.contentType && parsed.file.contentType !== 'application/octet-stream'
    ? parsed.file.contentType
    : getMimeType(parsed.file.filename);

  const location = await saveDealAttachment(dealId, parsed.file.filename, parsed.file.content, fileContentType);
  const checksum = `sha256:${crypto.createHash('sha256').update(parsed.file.content).digest('hex')}`;

  let record;
  try {
    record = await createDealAttachment(client, {
      dealId,
      filename: parsed.file.filename,
      contentType: fileContentType,
      sizeBytes: parsed.file.content.length,
      checksum,
      ...location,
      uploadedBy: actorId,
      ...(rawNote ? { note: rawNote } : {}),
    });
  } catch (error) {
    try { await removeDealAttachment(location); } catch { console.error('Failed to clean up deal attachment after metadata failure'); }
    throw error;
  }

  await recordDealAttachmentAudit(client, {
    dealId,
    attachmentId: record.id,
    action: 'uploaded',
    actorId,
    filename: record.filename,
    sizeBytes: record.sizeBytes,
    checksum: record.checksum,
  });

  return privateJson(201, { attachment: publicDealAttachment(record) });
}

async function handleDownload(
  dealId: string,
  attachmentId: string,
  actorId: string,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const attachment = await getDealAttachment(client, dealId, attachmentId);
  if (!attachment) return json(404, { error: 'Attachment not found' });

  const authorization = await createDealAttachmentDownloadAuthorization(dealId, attachment);

  await recordDealAttachmentAudit(client, {
    dealId,
    attachmentId: attachment.id,
    action: 'downloaded',
    actorId,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    checksum: attachment.checksum,
  });

  return privateJson(200, {
    downloadUrl: authorization.url,
    expiresIn: authorization.expiresIn,
    filename: attachment.filename,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    checksum: attachment.checksum,
  });
}

async function handleLocalContent(
  dealId: string,
  attachmentId: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  if (!verifyLocalDealAttachmentDownloadLink(dealId, attachmentId, params.expires, params.mac)) {
    return privateJson(403, { error: 'Download link is invalid or expired', code: 'file_download_link_invalid' });
  }
  const attachment = await getDealAttachment(client, dealId, attachmentId);
  if (!attachment) return json(404, { error: 'Attachment not found' });
  if (attachment.storageProvider !== 'local-dev') {
    return privateJson(409, { error: 'File storage provider is unavailable', code: 'file_storage_unavailable' });
  }
  try {
    const content = await readDealAttachment(attachment);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': attachment.contentType || getMimeType(attachment.filename),
        'Content-Disposition': contentDispositionFor(attachment.filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: content.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err: unknown) {
    if (err instanceof FileStorageError) return privateJson(err.statusCode, { error: err.message, code: err.code });
    throw err;
  }
}

async function handleDelete(
  dealId: string,
  attachmentId: string,
  actorId: string,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const attachment = await getDealAttachment(client, dealId, attachmentId);
  if (!attachment) return json(404, { error: 'Attachment not found' });

  // Remove from storage first so a storage error preserves metadata for retry.
  await removeDealAttachment(attachment);
  await deleteDealAttachment(client, dealId, attachmentId);

  await recordDealAttachmentAudit(client, {
    dealId,
    attachmentId: attachment.id,
    action: 'deleted',
    actorId,
    filename: attachment.filename,
    sizeBytes: attachment.sizeBytes,
    checksum: attachment.checksum,
  });

  return {
    statusCode: 204,
    headers: PRIVATE_JSON_HEADERS,
    body: '',
  };
}
