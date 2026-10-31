import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { financeSummary, parsePeriodQuery } from '../finance/service';
import { json } from './bookkeepingShared';

/** Read-only finance views: GET /api/finance/summary?month=|year=|ytd=1. */
export async function handleFinanceRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  if (path !== '/api/finance/summary') return null;
  if (method !== 'GET') return json(405, { error: 'Method not allowed' });
  const query = parsePeriodQuery(event.queryStringParameters);
  if (typeof query === 'string') return json(400, { error: query });
  return json(200, await financeSummary(client, query));
}
