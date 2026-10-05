import { createHash, timingSafeEqual } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { handleInvoiceRoutes } from '../routes/invoices';

const PRINCIPAL = { id: 'invoice-reader', scopes: ['invoices:read'], expiresAt: null };
const response = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** A deployment-managed service credential never becomes an interactive user. */
export async function handleInvoiceReader(
  event: LambdaEvent, client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const header = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] || '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] || '';
  if (!token.startsWith('dops_svc_')) return null;
  const configured = process.env.INVOICE_READER_TOKEN_SHA256 || '';
  if (!/^dops_svc_[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(configured)
    || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(configured, 'hex'))) {
    return response(401, { error: 'Unauthorized' });
  }
  const path = event.path || '/';
  if (event.httpMethod === 'GET' && path === '/api/me') return response(200, { service: PRINCIPAL });
  const allowed = path === '/api/bookkeeping/invoices' || path === '/api/bookkeeping/invoices/readiness'
    || /^\/api\/bookkeeping\/invoices\/[a-f0-9]{64}(?:\/document)?$/.test(path);
  if (event.httpMethod !== 'GET' || !allowed) return response(403, { error: 'Service credential permits invoice reads only' });
  return handleInvoiceRoutes(path, 'GET', event, client, true);
}
