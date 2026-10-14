import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord, listCrmRecords } from '../db/sponsorCrm';
import type { ProjectionContext } from './repository';

/** Latest published date across delivered deliverables; the invoice is owed from then on. */
export function deliveredOn(deliverables: Array<Record<string, unknown>>): string | undefined {
  const dates = deliverables
    .filter((item) => !item.archivedAt && item.publishedAt)
    .map((item) => String(item.publishedAt).slice(0, 10))
    .sort();
  return dates.at(-1);
}

export async function dealProjectionContext(client: DynamoDBDocumentClient, dealId: string): Promise<ProjectionContext> {
  const [deal, deliverables] = await Promise.all([
    getCrmRecord(client, 'deal', dealId),
    listCrmRecords(client, 'deliverable'),
  ]);
  const delivered = deliveredOn(deliverables.filter((item) => item.dealId === dealId));
  return {
    ...(deal ? { dealStatus: String(deal.status) } : {}),
    ...(delivered ? { deliveredOn: delivered } : {}),
  };
}
