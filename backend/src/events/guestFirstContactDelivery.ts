import type { SponsorDocEmailDelivery } from '../sponsorDocs/emailDelivery';
import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getTaskConsistent, updateTask } from '../db/tasks';
import { deliverRenderedEmail } from '../sponsorDocs/emailDelivery';
import { loadGuestFirstContact, type GuestFirstContactInput } from './guestFirstContact';

/** Only reasons emitted before the Gmail send request are eligible for automatic recovery. */
export function provenPreSendFailure(delivery: SponsorDocEmailDelivery | undefined): boolean {
  if (!delivery || delivery.state !== 'deferred' || delivery.messageId) return false;
  return ['missing_dapier_credential', 'dapier_unreachable', 'invalid_broker_json', 'empty_access_token', 'wrong_sender_identity', 'sender_identity_unverified'].includes(delivery.reason || '') || /^dapier_token_http_\d+$/.test(delivery.reason || '');
}

/** Saved Task claim precedes provider dispatch. Unknown outcomes are never retried automatically. */
export async function deliverGuestFirstContact(db: DynamoDBDocumentClient, input: GuestFirstContactInput & { taskId: string; holdId: string; docId: string; recipient: string; actorId: string }) {
  const task = await getTaskConsistent(db, input.taskId);
  if (!task) throw new Error('Invitation Task is missing');
  const prior = task.podcastFirstContact;
  if (prior?.state === 'sent') {
    if (prior.holdId !== input.holdId || prior.docId !== input.docId || prior.recipient !== input.recipient) throw new Error('Invitation Task belongs to another invitation');
    return prior.delivery!;
  }
  const safeRetry = prior?.state === 'deferred' && provenPreSendFailure(prior.delivery) && prior.holdId === input.holdId && prior.docId === input.docId && prior.recipient === input.recipient;
  if (prior && !safeRetry) throw new Error('Invitation delivery outcome requires reconciliation; automatic resend is blocked');
  const email = await loadGuestFirstContact(db, input);
  const claim = { holdId: input.holdId, docId: input.docId, recipient: input.recipient, state: 'sending' as const,
    claimedAt: new Date().toISOString(), attempts: prior ? [...(prior.attempts || []), { claimedAt: prior.claimedAt, delivery: prior.delivery! }] : [] };
  await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { podcastFirstContact: claim }, actorId: input.actorId, triggerKind: 'guest-first-contact-claim' });
  const result = await deliverRenderedEmail(db, { draft: email, recipientEmail: input.recipient, recipientName: input.guestName || '', taskId: task.id,
    connectionId: process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID?.trim() || 'google-calendar-orin', cc: [] });
  const delivery = { ...result, templateId: email.templateId, templateRevision: email.templateUpdatedAt };
  const current = await getTaskConsistent(db, task.id);
  if (!current) throw new Error('Invitation Task disappeared after provider delivery');
  await updateTask(db, task.id, { currentTask: current, expectedVersion: current.version, patch: {
    podcastFirstContact: { ...claim, state: delivery.state === 'sent' ? 'sent' : 'deferred', delivery },
    notesLog: [...(current.notesLog || []), { id: randomUUID(), text: `Guest first-contact ${delivery.state}: ${input.recipient}; hold ${input.holdId}; doc ${input.docId}${delivery.messageId ? `; Gmail message ID: ${delivery.messageId}` : `; ${delivery.reason || 'check delivery'}`}`, authorId: input.actorId, createdAt: new Date().toISOString() }],
  }, actorId: input.actorId, triggerKind: 'guest-first-contact-result' });
  return delivery;
}
