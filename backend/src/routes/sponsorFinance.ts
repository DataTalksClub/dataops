import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  classifyFinance,
  financeActor,
  financeEnabled,
  getFinanceState,
  linkInvoice,
  linkPayment,
  listFinanceCandidates,
  listFinanceHistory,
  projectFinance,
  recordInvoiceRequest,
  unlinkFinanceSource,
  voidFinance,
} from '../sponsorFinance/repository';
import { OPAQUE } from '../sponsorFinance/core';

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers, body: JSON.stringify(body) });
const parse = (event: LambdaEvent): Record<string, unknown> | null => {
  try {
    const body = event.body ? JSON.parse(String(event.body)) : {};
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
};
const header = (event: LambdaEvent, name: string) => Object.entries(event.headers || {})
  .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '';

export async function handleSponsorFinanceRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.includes('/finance')) return null;
  if (!financeEnabled()) return json(404, { error: 'Finance follow-through is disabled' });
  const match = path.match(/^\/api\/sponsor-crm\/bookings\/([^/]+)\/finance(?:\/(.*))?$/);
  if (!match || !OPAQUE.test(match[1])) return json(404, { error: 'Not found' });
  const bookingId = match[1], action = match[2] || '';
  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid request' });
  const actorId = header(event, 'x-user-id');
  try {
    const write = method !== 'GET';
    const actor = await financeActor(client, actorId, write || action.startsWith('candidates/'));
    if (method === 'GET' && !action) return json(200, await projectFinance(client, bookingId, actor.role));
    if (method === 'GET' && action === 'history') return json(200, { items: await listFinanceHistory(client, bookingId) });
    if (method === 'GET' && (action === 'candidates/invoices' || action === 'candidates/payments')) {
      const state = await getFinanceState(client, bookingId);
      if (!state) return json(409, { error: 'Finance state changed; reload and retry' });
      const limit = Number(event.queryStringParameters?.limit || 25);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return json(400, { error: 'Invalid pagination' });
      return json(200, await listFinanceCandidates(client, {
        kind: action.endsWith('invoices') ? 'document' : 'transaction',
        currency: state.currency,
        limit,
        cursor: event.queryStringParameters?.cursor,
      }));
    }
    const idempotencyKey = header(event, 'idempotency-key');
    const common = {
      actorId: actor.id,
      bookingId,
      bookingVersion: Number(body.bookingVersion),
      expectedVersion: body.expectedVersion === undefined ? undefined : Number(body.expectedVersion),
      idempotencyKey,
    };
    if (method === 'PUT' && !action) {
      const result = await classifyFinance(client, { ...common, body });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    if (method === 'POST' && action === 'request') {
      const result = await recordInvoiceRequest(client, { ...common, expectedVersion: Number(body.expectedVersion) });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    if (method === 'POST' && action === 'invoice') {
      const result = await linkInvoice(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        sourceId: String(body.sourceId || ''),
        identityToken: String(body.identityToken || ''),
        issuedOn: String(body.issuedOn || ''),
        dueOn: String(body.dueOn || ''),
      });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    if (method === 'POST' && action === 'payments') {
      const result = await linkPayment(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        sourceId: String(body.sourceId || ''),
        identityToken: String(body.identityToken || ''),
      });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    const unlink = action.match(/^(invoice|payments)\/([^/]+)$/);
    if (method === 'DELETE' && unlink) {
      const result = await unlinkFinanceSource(client, {
        ...common,
        expectedVersion: Number(body.expectedVersion),
        kind: unlink[1] === 'invoice' ? 'document' : 'transaction',
        sourceId: unlink[2],
      });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    if (method === 'POST' && action === 'void') {
      const result = await voidFinance(client, { ...common, expectedVersion: Number(body.expectedVersion) });
      return json(200, { result, projection: await projectFinance(client, bookingId, actor.role) });
    }
    if (method === 'POST' && action === 'reconcile') {
      return json(200, { projection: await projectFinance(client, bookingId, actor.role) });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number }).statusCode || 409);
    const outcome = (error as { outcome?: string }).outcome;
    return json(statusCode, {
      error: statusCode === 503 && outcome === 'outcome_unknown'
        ? 'Finance outcome unknown; reload or retry with the same Idempotency-Key'
        : statusCode === 503 ? 'Finance data is temporarily unavailable; retry'
        : statusCode === 401 ? 'Unauthorized'
          : statusCode === 403 ? 'Forbidden'
            : statusCode === 400 ? (error as Error).message
              : 'Finance state changed; reload and retry',
      ...(outcome ? { outcome } : {}),
    });
  }
}
