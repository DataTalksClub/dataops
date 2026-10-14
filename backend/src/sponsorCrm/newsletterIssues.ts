import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCrmRecord, deterministicCrmId, getCrmRecord, listCrmRecords, updateCrmRecord, type CrmRecord } from '../db/sponsorCrm';
import { issueNewsletter, newsletterIssueRecord, receiptPatch } from './newsletters';

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


/**
 * Record one issue that arrived in the newsletter inbox (Dapier lead intake),
 * with or without sponsors, and mark it as the newsletter's latest receipt.
 */
export async function recordInboxIssue(
  client: DynamoDBDocumentClient,
  messageId: string,
  newsletter: { name: string; sender: string; subject: string; receivedAt: string },
) {
  const newsletters = await listCrmRecords(client, 'newsletter');
  const target = issueNewsletter(newsletters, newsletter.sender, newsletter.name) as CrmRecord | null;
  const stored = await upsertNewsletterIssue(client, newsletterIssueRecord(target, {
    issueKey: messageId.trim(),
    title: newsletter.subject,
    publishedAt: newsletter.receivedAt,
    source: 'inbox',
    sender: newsletter.sender,
    newsletterName: newsletter.name,
  }));
  const patch = target ? receiptPatch(target, { ...newsletter, messageId: messageId.trim() }) : null;
  if (target && patch) {
    try {
      await updateCrmRecord(client, 'newsletter', target, patch);
    } catch (error) {
      // A concurrent edit wins; the issue itself is recorded either way.
      if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return { id: stored.item.id, outcome: stored.outcome, newsletterId: target?.id || null };
}
