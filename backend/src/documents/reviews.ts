import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { resolveInteractiveActor } from '../identity/actor';
import { recordRequestError } from '../requestErrorLog';
import { deleteDocumentThread, changeDocumentThread, createDocumentReviewer, createDocumentThread, DocumentReviewError, listDocumentReviewers, listDocumentThreads, revokeDocumentReviewer, verifyDocumentReviewer, type ReviewAuthor } from '../db/documentReviews';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers, body: JSON.stringify(body) });
function header(event: LambdaEvent, name: string): string {
  return Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1] || '';
}
export function isAnonymousDocumentReviewRequest(method: string, path: string): boolean {
  return (method === 'GET' && /^\/api\/documents\/[^/]+\/review\/?$/.test(path))
    || (['GET', 'POST'].includes(method) && /^\/api\/documents\/[^/]+\/comments(?:\/[^/]+\/(?:reply|resolve))?\/?$/.test(path));
}
export function isAnonymousDocumentReviewAsset(method: string, path: string): boolean {
  return method === 'GET' && (/^\/document-review\/[^/]+\/?$/.test(path)
    || ['/src/document-review-page.js', '/src/surfaces/document-reviews.js'].includes(path));
}
// The document loader is provided by the run-document routes. All callers must
// check existence here; a deleted document never remains accessible by a link.
export async function handleDocumentReviewRoutes(event: LambdaEvent, client: DynamoDBDocumentClient, getDocument: (id: string) => Promise<unknown | null>): Promise<LambdaResponse | null> {
  const match = (event.path || '').match(/^\/api\/documents\/([^/]+)\/(review|comments|reviewers)(?:\/([^/]+)(?:\/(reply|resolve))?)?\/?$/);
  if (!match) return null;
  try {
    const [, rawId, resource, itemId, action] = match;
    const documentId = decodeURIComponent(rawId);
    const method = (event.httpMethod || 'GET').toUpperCase();
    const token = header(event, 'x-document-review-token');
    let author: ReviewAuthor;
    let staff = false;
    if (token) {
      const reviewer = await verifyDocumentReviewer(client, documentId, token);
      if (!reviewer) return json(401, { error: 'Review link is invalid, expired or revoked' });
      author = reviewer;
    } else {
      const actor = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
      if (!actor.ok) return actor.response;
      staff = true;
      author = { id: actor.actor.id || 'test-staff', name: actor.actor.user?.name || 'DataOps Staff', kind: 'staff' };
    }
    if (resource === 'reviewers' && !staff) return json(403, { error: 'Only staff can manage reviewers' });
    const document = await getDocument(documentId);
    if (!document) return json(404, { error: 'Document not found' });
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'JSON object required' });
    }
    if (resource === 'review' && !itemId && method === 'GET') {
      const doc = document as { id: string; title: string; content: string; version: number; updatedAt: string };
      return json(200, { document: { id: doc.id, title: doc.title, content: doc.content, version: doc.version, updatedAt: doc.updatedAt }, reviewer: author });
    }
    if (resource === 'reviewers') {
      if (!itemId && method === 'GET') return json(200, { reviewers: await listDocumentReviewers(client, documentId) });
      if (!itemId && method === 'POST') {
        const created = await createDocumentReviewer(client, documentId, body.name);
        return json(201, { ...created, reviewPath: `/document-review/${encodeURIComponent(documentId)}?review=${encodeURIComponent(created.token)}` });
      }
      if (itemId && !action && method === 'DELETE') {
        await revokeDocumentReviewer(client, documentId, itemId);
        return json(200, { revoked: true });
      }
    }
    if (resource === 'comments') {
      if (itemId && !action && method === 'DELETE') {
        if (!staff) return json(403, { error: 'Only staff can delete threads' });
        await deleteDocumentThread(client, documentId, itemId, Number(event.queryStringParameters?.version));
        return json(200, { deleted: true });
      }
      if (!itemId && method === 'GET') return json(200, { threads: await listDocumentThreads(client, documentId) });
      if (!itemId && method === 'POST') return json(201, { thread: await createDocumentThread(client, documentId, author, body.body, body.quote) });
      if (itemId && method === 'POST' && (action === 'reply' || action === 'resolve')) {
        if (action === 'resolve' && typeof body.resolved !== 'boolean') return json(400, { error: 'resolved must be a boolean' });
        return json(200, { thread: await changeDocumentThread(client, documentId, itemId, author, { version: body.version, ...(action === 'reply' ? { body: body.body } : { resolved: body.resolved as boolean }) }) });
      }
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    if (error instanceof DocumentReviewError) return json(error.status, { error: error.message });
    if (error instanceof URIError) return json(400, { error: 'Invalid document id' });
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}
