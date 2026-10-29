import { DOCX_CONTENT_TYPE, markdownToDocx } from '../docs/docxExport';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCardDocument, deleteCardDocument, CARD_DOCUMENT_KINDS, CardDocumentRecord, CardDocumentVersionConflict, getCardDocument, listCardDocuments, updateCardDocument } from '../db/cardDocuments';
import { resolveInteractiveActor } from '../identity/actor';
import { getCardConsistent } from '../db/cards';
import type { LambdaEvent, LambdaResponse } from '../types';

const json = (statusCode: number, data: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) });
export function validateDocumentText(body: Record<string, unknown>): string | null {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) return 'title must contain 1–200 characters';
  if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > 250000) return 'content must be text of at most 250000 UTF-8 bytes';
  return null;
}
export async function handleCardDocumentRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const path = event.path || '';
  const match = /^\/api\/card-documents(?:\/([^/]+)(?:\/(export))?)?\/?$/.exec(path);
  if (!match) return null;
  const method = event.httpMethod || 'GET';
  const actor = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
  if (!actor.ok) return actor.response;
  const id = match[1];
  if (match[2]) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const format = event.queryStringParameters?.format || 'md';
    if (!['md', 'txt', 'docx'].includes(format)) return json(400, { error: 'format must be md, txt, or docx' });
    const doc = await getCardDocument(client, id);
    if (!doc) return json(404, { error: 'Document not found' });
    return { statusCode: 200, headers: {
      'Content-Type': format === 'docx' ? DOCX_CONTENT_TYPE : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="document.${format}"`, 'Cache-Control': 'no-store',
    }, body: format === 'docx' ? (await markdownToDocx(doc.content)).toString('base64') : doc.content,
    ...(format === 'docx' ? { isBase64Encoded: true } : {}) };
  }
  if (method === 'GET') {
    if (id) {
      const document = await getCardDocument(client, id);
      return document ? json(200, { document }) : json(404, { error: 'Document not found' });
    }
    const cardId = event.queryStringParameters?.cardId;
    if (!cardId) return json(400, { error: 'cardId is required' });
    if (!await getCardConsistent(client, cardId)) return json(404, { error: 'Card not found' });
    return json(200, { documents: await listCardDocuments(client, cardId) });
  }
  if (method === 'DELETE' && id) {
    const version = Number(event.queryStringParameters?.version);
    if (!Number.isSafeInteger(version) || version < 1) return json(400, { error: 'version is required' });
    try {
      return await deleteCardDocument(client, id, version) ? json(200, { deleted: true }) : json(404, { error: 'Document not found' });
    } catch (error) {
      if (error instanceof CardDocumentVersionConflict) return json(409, { error: error.message });
      throw error;
    }
  }
  if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
    let body: Record<string, unknown>;
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || null) as unknown as Record<string, unknown>; }
    catch { return json(400, { error: 'Invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });
    if (!id && body.from !== undefined) {
      if (typeof body.from !== 'string' || !body.from) return json(400, { error: 'from must be a document id' });
      const source = await getCardDocument(client, body.from);
      if (!source) return json(404, { error: 'Source document not found' });
      body = { title: source.title, content: source.content, kind: source.kind, ...body };
    }
    const error = validateDocumentText(body);
    if (error) return json(400, { error });
    if (!id) {
      if (typeof body.cardId !== 'string' || !body.cardId) return json(400, { error: 'cardId is required' });
      if (!CARD_DOCUMENT_KINDS.includes(body.kind as CardDocumentRecord['kind'])) return json(400, { error: 'kind must be transcript, timecodes, summary, or note' });
      if (!await getCardConsistent(client, body.cardId)) return json(404, { error: 'Card not found' });
      const document = await createCardDocument(client, { cardId: body.cardId, kind: body.kind as CardDocumentRecord['kind'], title: (body.title as string).trim(), content: body.content as string });
      return json(201, { document });
    }
    if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) return json(400, { error: 'version is required' });
    try {
      const document = await updateCardDocument(client, id, { title: (body.title as string).trim(), content: body.content as string }, Number(body.version));
      return document ? json(200, { document }) : json(404, { error: 'Document not found' });
    } catch (error) {
      if (error instanceof CardDocumentVersionConflict) return json(409, { error: error.message });
      throw error;
    }
  }
  return json(405, { error: 'Method not allowed' });
}
