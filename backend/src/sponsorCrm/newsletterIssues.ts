import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCrmRecord, deterministicCrmId, getCrmRecord, updateCrmRecord } from '../db/sponsorCrm';

export const NEWSLETTER_ISSUE_KIND = 'newsletter-issue';

/**
 * Record one issue. Inbox and archive sightings of the same issue share an
 * issue key; a later sighting only fills fields the first one lacked.
 */
export async function upsertNewsletterIssue(client: DynamoDBDocumentClient, record: Record<string, unknown>) {
  const id = deterministicCrmId(NEWSLETTER_ISSUE_KIND, String(record.sourceKey));
  const existing = await getCrmRecord(client, NEWSLETTER_ISSUE_KIND, id);
  if (!existing) {
    const created = await createCrmRecord(client, NEWSLETTER_ISSUE_KIND, record);
    return { item: created.item, outcome: created.duplicate ? 'duplicate' as const : 'created' as const };
  }
  const missing = Object.fromEntries(
    Object.entries(record).filter(([name, value]) => value !== undefined && (existing[name] === undefined || existing[name] === '')),
  );
  if (!Object.keys(missing).length) return { item: existing, outcome: 'duplicate' as const };
  return { item: await updateCrmRecord(client, NEWSLETTER_ISSUE_KIND, existing, missing), outcome: 'updated' as const };
}
