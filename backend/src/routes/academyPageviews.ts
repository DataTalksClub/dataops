import { listAcademyPageviews } from '../academyLeads/pageviews';
import { json } from '../http';
import type { LambdaEvent, LambdaResponse } from '../types';

export async function handleAcademyPageviewsRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (path !== '/api/academy-pageviews' || method !== 'GET') return null;
  const qs = event.queryStringParameters || {};
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const data = await listAcademyPageviews({
    includeTests: qs.includeTests === 'true' || qs.includeTests === '1',
    from: date(qs.from),
    to: date(qs.to),
  });
  return json(200, data);
}
