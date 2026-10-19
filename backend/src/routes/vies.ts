import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { checkVatId, preflightOrganizations, refreshPreflight } from '../vies/service';
import { normalizeVatId } from '../vies/format';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const parse = (event: LambdaEvent) => { try { const value = event.body ? JSON.parse(String(event.body)) : null; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } };

/**
 * VAT validation endpoints. `POST /api/vies/check` runs (or forces) a VIES
 * check for one VAT ID; `GET /api/vies/preflight` reports the last known
 * state of every in-scope customer without touching the network, and its
 * POST refreshes stale entries through VIES first — the gate to run before
 * a monthly bookkeeping pack leaves for the tax office.
 */
export async function handleViesRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === '/api/vies/check' && method === 'POST') {
    const body = parse(event);
    const vatId = normalizeVatId(String(body?.vatId || ''));
    if (!vatId) return json(400, { error: 'vatId is required' });
    return json(200, { check: await checkVatId(client, vatId, { force: body?.force === true }) });
  }
  if (path === '/api/vies/preflight' && (method === 'GET' || method === 'POST')) {
    if (method === 'POST') {
      const report = await preflightOrganizations(client);
      const { refreshed } = await refreshPreflight(client, report.entries);
      const updated = await preflightOrganizations(client);
      return json(200, { ...updated, refreshed });
    }
    return json(200, await preflightOrganizations(client));
  }
  return null;
}
