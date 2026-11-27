/**
 * A sponsor-doc save is an edit of every newsletter draft that takes its
 * sponsor block from the doc. When such a draft's email is scheduled in Relay,
 * the save must not land as a partial update: the schedule is cancelled first
 * and verified with Relay (./relayTransport.ts `unscheduleForEdit`, through
 * `commitContent`), which also withdraws the approval and test receipt; only
 * then is the doc saved and staged. If Relay cannot confirm the cancel, the
 * doc is not saved at all.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SponsorDoc } from '../db/sponsorDocs';
import { commitContent, type BlockActor } from './blocksEdit';
import { getBlockSet } from './blocksStore';
import { LOCKED_DELIVERY } from './draftApproval';
import { issueSlotsForDoc } from './sponsorBlocks';

const issueLabel = (issue: { id: string; issueNumber?: number }) => (issue.issueNumber ? `#${issue.issueNumber}` : issue.id);

/** Linked issues whose email Relay holds scheduled (or is being given). */
export async function scheduledIssuesForDoc(client: DynamoDBDocumentClient, doc: Pick<SponsorDoc, 'id' | 'publicationDate'>) {
  const linked = await issueSlotsForDoc(client, doc);
  const scheduled = [];
  for (const { issue } of linked) {
    const set = await getBlockSet(client, issue.id);
    if (set?.delivery && LOCKED_DELIVERY.has(set.delivery.state)) scheduled.push({ issue, set });
  }
  return scheduled;
}

/**
 * Unschedule every linked scheduled draft before the doc is saved. Throws
 * (BlocksError `unschedule_failed` / `schedule_in_progress`) on the first draft
 * Relay cannot confirm; drafts already unscheduled stay unscheduled (and
 * unapproved), which never lets a stale email go out.
 */
export async function unscheduleDraftsForDocSave(
  client: DynamoDBDocumentClient,
  doc: Pick<SponsorDoc, 'id' | 'publicationDate' | 'title'>,
  actor: BlockActor,
): Promise<string[]> {
  const done: string[] = [];
  for (const { issue, set } of await scheduledIssuesForDoc(client, doc)) {
    const now = new Date().toISOString();
    await commitContent(client, set, {}, [{
      blockId: '',
      blockType: 'draft',
      origin: 'sponsor-doc',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: `sponsor doc ${doc.id} is being saved; issue ${issueLabel(issue)} goes back to draft first`,
      before: null,
      after: null,
    }], actor, now);
    done.push(issue.id);
  }
  return done;
}
