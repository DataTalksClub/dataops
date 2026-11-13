import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../db/client';
import { resolveInteractiveActor } from '../identity/actor';
import { jsonResponse } from '../http';
import { FileStorageError } from '../storage';
import { readPublicImage, removePublicImage, savePublicImage, type StoredPublicImage } from '../publicImages';
import { parseMultipart } from './files';
import { sponsorDocPortalBaseUrl } from './sponsorDocs';
import { recordRequestError } from '../requestErrorLog';
import type { LambdaEvent, LambdaResponse } from '../types';

export function isAnonymousPublicImageRequest(method: string, reqPath: string): boolean {
  return method.toUpperCase() === 'GET' && /^\/api\/public-images\/[^/]+\/?$/.test(reqPath);
}

/** Extract an uploaded image buffer from a multipart/form-data request. */
export function extractMultipartImageBuffer(event: LambdaEvent): Buffer {
  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new FileStorageError('Content-Type must be multipart/form-data', 400, 'invalid_content_type');
  }
  if (!event.body) {
    throw new FileStorageError('Request body is required', 400, 'empty_body');
  }
  const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('binary') : event.body;
  const parsed = parseMultipart(body, contentType);
  if (!parsed.file || !parsed.file.content) {
    throw new FileStorageError('Missing required field: file', 400, 'missing_file');
  }
  return parsed.file.content;
}

export function publicImagePayload(saved: StoredPublicImage, event: LambdaEvent) {
  const baseUrl = sponsorDocPortalBaseUrl(event);
  return {
    ...saved,
    url: `${baseUrl}${saved.path}`,
  };
}

/** Handle `/api/public-images` routes (shared durable public image hosting). */
export async function handlePublicImageRoutes(
  event: LambdaEvent,
  client?: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const reqPath = event.path || '/';
  if (!reqPath.startsWith('/api/public-images')) return null;

  const suffix = reqPath.slice('/api/public-images'.length);

  try {
    // Public immutable read: GET /api/public-images/:id
    const idMatch = /^\/([^/]+)\/?$/.exec(suffix);
    if (method === 'GET' && idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      const { data, contentType } = await readPublicImage(id);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
        },
        body: data.toString('base64'),
        isBase64Encoded: true,
      };
    }

    const db = client || await getClient();
    const actor = await resolveInteractiveActor(db, event, 'work-write');
    if (!actor.ok) return actor.response;

    // Staff/API upload: POST /api/public-images
    if (method === 'POST' && (suffix === '' || suffix === '/')) {
      const content = extractMultipartImageBuffer(event);
      const saved = await savePublicImage(content);
      return jsonResponse(201, { image: publicImagePayload(saved, event) });
    }

    // Staff cleanup: DELETE /api/public-images/:id
    if (method === 'DELETE' && idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      await removePublicImage(id);
      return jsonResponse(200, { ok: true, id });
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (err: unknown) {
    if (err instanceof FileStorageError) {
      return jsonResponse(err.statusCode, { error: err.message, code: err.code });
    }
    recordRequestError(err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}
