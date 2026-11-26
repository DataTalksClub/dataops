import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { jsonResponse } from '../http';
import { parseSignalQuery, selectSignals } from '../sponsorCrm/signals';
import type { LambdaEvent, LambdaResponse } from '../types';

/** GET /api/sponsor-crm/signals: read-only, date-bounded outbound sponsor signals. */
export async function handleSponsorSignalsRoute(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const query = parseSignalQuery(event.queryStringParameters || {});
  if (typeof query === 'string') return jsonResponse(400, { error: query });
  const result = await selectSignals(client, query);
  return jsonResponse(result.status, result.body);
}
