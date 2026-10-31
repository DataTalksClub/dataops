import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { financeSummary, financeUpcoming, parsePeriodQuery } from '../finance/service';
import { listTaxSchedule, putTaxScheduleEntry, ScheduleVersionConflict } from '../finance/taxSchedule';
import { validateScheduleEntry, type ScheduleEntry } from '../finance/upcoming';
import { json, parse } from './bookkeepingShared';

/**
 * Finance views:
 *   GET /api/finance/summary?month=|year=|ytd=1
 *   GET /api/finance/upcoming?days=60          scheduled tax/TK debits + balance check
 *   GET /api/finance/tax-schedule              the schedule those debits come from
 *   PUT /api/finance/tax-schedule/<id>         create/replace one entry (expectedVersion)
 */
export async function handleFinanceRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  if (path === '/api/finance/summary') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const query = parsePeriodQuery(event.queryStringParameters);
    if (typeof query === 'string') return json(400, { error: query });
    return json(200, await financeSummary(client, query));
  }
  if (path === '/api/finance/upcoming') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    const raw = event.queryStringParameters?.days;
    const days = raw === undefined || raw === '' ? 60 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 366) return json(400, { error: 'days must be a whole number from 1 to 366' });
    return json(200, await financeUpcoming(client, days));
  }
  if (path === '/api/finance/tax-schedule') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    return json(200, { items: await listTaxSchedule(client) });
  }
  const entry = path.match(/^\/api\/finance\/tax-schedule\/([a-z0-9][a-z0-9-]{1,60})$/);
  if (entry) {
    if (method !== 'PUT') return json(405, { error: 'Method not allowed' });
    const body = parse(event.body || null);
    if (!body) return json(400, { error: 'JSON body required' });
    const { expectedVersion, version: _version, updatedAt: _at, updatedBy: _by, ...fields } = body;
    const value = { ...fields, id: entry[1] } as Record<string, unknown>;
    const errors = validateScheduleEntry(value);
    if (errors.length) return json(400, { error: 'Invalid schedule entry', fields: errors });
    if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0)) return json(400, { error: 'expectedVersion must be a whole number' });
    try {
      const actor = String(event.headers?.['x-user-id'] || 'unknown');
      return json(200, await putTaxScheduleEntry(client, value as ScheduleEntry, expectedVersion as number | undefined, actor));
    } catch (error) {
      if (error instanceof ScheduleVersionConflict) return json(409, { error: error.message, current: (await listTaxSchedule(client)).find((e) => e.id === entry[1]) || null });
      throw error;
    }
  }
  return null;
}
