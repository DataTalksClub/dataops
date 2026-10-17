import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { getTuitionAgreement, listTuitionAgreements, saveTuitionAgreement, tuitionEvidence, type TuitionAgreement } from '../db/tuition';
import { realDate } from '../sponsorCrm/model';
const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export async function handleTuitionRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/tuition(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const id = match[1], query = event.queryStringParameters || {};
  if (id && !ID.test(id)) return json(400, { error: 'Invalid agreement ID' });
  if (method === 'GET' && id) {
    const agreement = await getTuitionAgreement(client, id);
    if (!agreement) return json(404, { error: 'Tuition agreement not found' });
    const evidence = await tuitionEvidence(client, id);
    // Original records stay reachable as private, immutable evidence; never book cash from an obligation.
    return json(200, { ...agreement, evidence: evidence.map(({ PK, SK, ...item }) => item) });
  }
  if (method === 'GET' && !id) {
    const limit = Number(query.limit || 30), cursor = Number(query.cursor || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) return json(400, { error: 'Invalid pagination' });
    let items = await listTuitionAgreements(client);
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.search) { const q = query.search.toLowerCase(); items = items.filter((item) => `${item.studentName} ${item.title}`.toLowerCase().includes(q)); }
    items.sort((a, b) => String(a.dueOn || '9999').localeCompare(String(b.dueOn || '9999')) || a.id.localeCompare(b.id));
    return json(200, { items: items.slice(cursor, cursor + limit), total: items.length, nextCursor: cursor + limit < items.length ? String(cursor + limit) : null });
  }
  if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
    let body: Record<string, unknown>;
    try { body = JSON.parse(String(event.body || '')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); }
    catch { return json(400, { error: 'Invalid JSON' }); }
    const existing = id ? await getTuitionAgreement(client, id) : null;
    if (id && !existing) return json(404, { error: 'Tuition agreement not found' });
    if (existing && body.version !== existing.version) return json(409, { error: 'Agreement changed; reload and retry' });
    const value: Record<string, unknown> = { ...existing, ...body };
    for (const field of ['studentName', 'title', 'trigger']) if (typeof value[field] !== 'string' || !String(value[field]).trim() || String(value[field]).length > 1000) return json(400, { error: `${field} is required` });
    if (!['conditional', 'due', 'invoiced', 'settled', 'cancelled'].includes(String(value.status))) return json(400, { error: 'Invalid tuition status' });
    if (value.dueOn != null && !realDate(value.dueOn)) return json(400, { error: 'Invalid dueOn' });
    if (value.amount != null && (typeof value.amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value.amount) || Number(value.amount) <= 0)) return json(400, { error: 'Invalid amount' });
    if (value.currency != null && !/^[A-Z]{3}$/.test(String(value.currency))) return json(400, { error: 'Invalid currency' });
    if (value.notes != null && (typeof value.notes !== 'string' || value.notes.length > 5000)) return json(400, { error: 'Invalid notes' });
    const allowed = ['studentName', 'title', 'trigger', 'status', 'dueOn', 'amount', 'currency', 'notes'];
    const fields = Object.fromEntries(allowed.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
    if (existing?.taskIds) fields.taskIds = existing.taskIds;
    try { return json(existing ? 200 : 201, await saveTuitionAgreement(client, fields as Omit<TuitionAgreement, 'id' | 'version' | 'createdAt' | 'updatedAt'>, existing || undefined)); }
    catch (error) { if ((error as Error).name.includes('Conditional')) return json(409, { error: 'Agreement changed; reload and retry' }); throw error; }
  }
  return json(405, { error: 'Method not allowed' });
}
