import { listAcademyLeads } from '../academyLeads/service';
import { json } from '../http';
import type { LambdaEvent, LambdaResponse } from '../types';

export async function handleAcademyLeadsRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (path !== '/api/academy-leads' || method !== 'GET') return null;
  const qs = event.queryStringParameters || {};
  const includeTests = qs.includeTests === 'true' || qs.includeTests === '1';
  const track = typeof qs.track === 'string' ? qs.track : '';
  const data = await listAcademyLeads({ includeTests, track });
  return json(200, data);
}
