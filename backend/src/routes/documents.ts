import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDocument, DOCUMENT_KINDS, DocumentRecord, DocumentVersionConflict, getDocument, listDocuments, updateDocument } from '../db/documents';
import { resolveInteractiveActor } from '../identity/actor';
import { getTask } from '../db/tasks';
import type { LambdaEvent, LambdaResponse } from '../types';

const json = (statusCode: number, data: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export function validateDocumentText(body: Record<string, unknown>): string | null {
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) return 'title must contain 1–200 characters';
  if (typeof body.content !== 'string' || Buffer.byteLength(body.content, 'utf8') > 250000) return 'content must be text of at most 250000 UTF-8 bytes';
  return null;
}
export async function handleDocumentRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const path = event.path || '';
  const match = /^\/api\/documents(?:\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  const method = event.httpMethod || 'GET';
  const actor = await resolveInteractiveActor(client, event, method === 'GET' ? 'work-read' : 'work-write');
  if (!actor.ok) return actor.response;
  const id = match[1];
  if (method === 'GET') {
    if (id) {
      const document = await getDocument(client, id);
      return document ? json(200, { document }) : json(404, { error: 'Document not found' });
    }
    const taskId = event.queryStringParameters?.taskId;
    if (!taskId) return json(400, { error: 'taskId is required' });
    if (!await getTask(client, taskId)) return json(404, { error: 'Task not found' });
    return json(200, { documents: await listDocuments(client, taskId) });
  }
  if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
    let body: Record<string, unknown>;
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || null) as unknown as Record<string, unknown>; }
    catch { return json(400, { error: 'Invalid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });
    if (!id && body.from !== undefined) {
      if (typeof body.from !== 'string' || !body.from) return json(400, { error: 'from must be a document id' });
      const source = await getDocument(client, body.from);
      if (!source) return json(404, { error: 'Source document not found' });
      body = { title: source.title, content: source.content, kind: source.kind, ...body };
    }
    const error = validateDocumentText(body);
    if (error) return json(400, { error });
    if (!id) {
      if (typeof body.taskId !== 'string' || !body.taskId) return json(400, { error: 'taskId is required' });
      if (!DOCUMENT_KINDS.includes(body.kind as DocumentRecord['kind'])) return json(400, { error: 'kind must be transcript, timecodes, summary, or note' });
      if (!await getTask(client, body.taskId)) return json(404, { error: 'Task not found' });
      const document = await createDocument(client, { taskId: body.taskId, kind: body.kind as DocumentRecord['kind'], title: (body.title as string).trim(), content: body.content as string });
      return json(201, { document });
    }
    if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) return json(400, { error: 'version is required' });
    try {
      const document = await updateDocument(client, id, { title: (body.title as string).trim(), content: body.content as string }, Number(body.version));
      return document ? json(200, { document }) : json(404, { error: 'Document not found' });
    } catch (error) {
      if (error instanceof DocumentVersionConflict) return json(409, { error: error.message });
      throw error;
    }
  }
  return json(405, { error: 'Method not allowed' });
}
