/**
 * POST /api/podcast-first-contact/email: render Orin's first-contact email.
 *
 * The render endpoint is side-effect free. The send endpoint reads an existing
 * tentative proposal, guest materials document and owning Task, then delivers
 * from Orin with an optimistic Task claim and durable delivery evidence.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

import { resolveInteractiveActor } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  PODCAST_DOCS_URL,
  renderPodcastFirstContactEmail,
  formatSlotLabel,
} from '../podcast/firstContact';
import { noStoreJson as json, parseJsonObjectEventOrEmpty as parse } from '../http';
import { getTaskConsistent, updateTask, TaskVersionConflictError } from '../db/tasks';
import { getCalendarHold } from '../db/calendarHolds';
import { getCardConsistent } from '../db/cards';
import { getSponsorDocWithAuthMaterial, decryptSponsorDocAccessCode } from '../db/sponsorDocs';
import { deliverRenderedEmail } from '../sponsorDocs/emailDelivery';
import { sponsorDocPortalBaseUrl } from './sponsorDocs';

export async function handlePodcastFirstContactRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  if (!['/api/podcast-first-contact/email', '/api/podcast-first-contact/send'].includes(path)) return json(404, { error: 'Not found' });
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;

  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  if (path.endsWith('/send')) {
    const { holdId, docId, taskId, guestName } = body;
    if (![holdId, docId, taskId, guestName].every(value => typeof value === 'string' && value.trim() && value.length <= 200)) {
      return json(400, { error: 'holdId, docId, taskId and guestName are required' });
    }
    const [hold, loaded, task] = await Promise.all([
      getCalendarHold(client, holdId), getSponsorDocWithAuthMaterial(client, docId), getTaskConsistent(client, taskId),
    ]);
    if (!hold || !loaded || !task) return json(404, { error: 'Hold, guest document or Task not found' });
    if (task.podcastFirstContact?.state === 'sent') {
      const prior = task.podcastFirstContact;
      if (prior.holdId !== holdId || prior.docId !== docId) return json(409, { error: 'This Task already sent a different invitation' });
      return json(200, { emailDelivery: prior.delivery, taskId, alreadySent: true });
    }
    const prior = task.podcastFirstContact;
    // This broker response happens before any Gmail send request. A provider
    // timeout or missing response is deliberately never eligible for recovery.
    const retryEligible = prior?.state === 'deferred'
      && prior.delivery?.state === 'deferred'
      && prior.delivery.reason === 'dapier_token_http_404'
      && !prior.delivery.messageId
      && prior.holdId === holdId && prior.docId === docId
      && prior.recipient === hold.guestRef?.trim().toLowerCase();
    if ((prior && (!retryEligible || (body.retryPreSend !== true && body.preview !== true)))
      || (body.retryPreSend === true && !retryEligible)) {
      return json(409, { error: 'This Task already attempted delivery. Check its recorded result and Gmail before retrying.', code: 'invitation_already_attempted' });
    }
    const doc = loaded.doc;
    if (doc.template !== 'podcast' || !hold.cardId || hold.cardId !== doc.cardId || (task.cardId && task.cardId !== doc.cardId)) {
      return json(422, { error: 'The tentative hold and guest materials document must belong to the same Card as the owning Task' });
    }
    const card = await getCardConsistent(client, doc.cardId);
    if (!card || card.status === 'archived' || !['todo', 'waiting'].includes(task.status)) return json(422, { error: 'An active Card and open Task are required' });
    if (hold.status !== 'tentative' || hold.googleSync.state !== 'synced' || !(Date.parse(hold.startIso) > Date.now())
      || !(Date.parse(hold.expiresAt) > Date.now())) return json(422, { error: 'A future, unexpired, Google-synced tentative proposal is required' });
    if (!hold.topic?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hold.guestRef || '')) return json(422, { error: 'The proposal needs a topic and guest email' });
    const accessCode = decryptSponsorDocAccessCode(doc.id, loaded.accessCodeCiphertext);
    if (!accessCode) return json(422, { error: 'Guest document access code is unavailable; rotate it before sending' });
    const formUrl = `${sponsorDocPortalBaseUrl(event)}/podcast-docs/${encodeURIComponent(doc.id)}?code=${encodeURIComponent(accessCode)}`;
    let email;
    try {
      email = renderPodcastFirstContactEmail({ guestFirstName: guestName.trim().split(/\s+/)[0], slotLabel: formatSlotLabel(hold.startIso), topicSeed: hold.topic, formUrl });
    } catch (error) { return json(422, { error: (error as Error).message }); }
    const recipient = hold.guestRef!.trim().toLowerCase();
    // Use the existing Orin Google connection with verified Gmail scopes, also
    // used by contract delivery. No new account, connection or grant is created.
    const connectionId = process.env.DATAOPS_ORIN_GMAIL_CONNECTION_ID?.trim() || 'google-calendar-orin';
    if (body.preview === true) return json(200, { preview: true, email: { ...email, to: recipient, cc: [] }, connectionId, retryEligible: Boolean(retryEligible), taskId, holdId, docId });
    const attempts = prior ? [...(prior.attempts || []), { claimedAt: prior.claimedAt, delivery: prior.delivery! }] : [];
    const claim = { holdId, docId, recipient, state: 'sending' as const, claimedAt: new Date().toISOString(), attempts };
    try {
      await updateTask(client, task.id, { currentTask: task, expectedVersion: task.version, patch: { podcastFirstContact: claim }, actorId: resolved.actor.id, triggerKind: 'podcast-first-contact-claim' });
    } catch (error) {
      if (error instanceof TaskVersionConflictError) return json(409, { error: 'Task changed; reread its delivery state before retrying' });
      throw error;
    }
    // Only the explicit, proven pre-Gmail recovery above can repeat an attempt.
    const delivery = await deliverRenderedEmail(client, { draft: email, recipientEmail: recipient, recipientName: guestName, taskId, connectionId, cc: [] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await getTaskConsistent(client, taskId);
      if (!current) throw new Error('Owning Task disappeared after invitation delivery');
      const note = `Podcast first-contact ${delivery.state}: ${recipient}; hold ${holdId}; doc ${docId}${delivery.messageId ? `; Gmail message ID: ${delivery.messageId}` : `; ${delivery.reason || 'check delivery'}`}`;
      try {
        await updateTask(client, taskId, { currentTask: current, expectedVersion: current.version, patch: {
          podcastFirstContact: { ...claim, state: delivery.state === 'sent' ? 'sent' : 'deferred', delivery },
          notesLog: [...(current.notesLog || []), { id: randomUUID(), text: note, authorId: resolved.actor.id, createdAt: new Date().toISOString() }],
        }, actorId: resolved.actor.id, triggerKind: 'podcast-first-contact-result' });
        break;
      } catch (error) { if (!(error instanceof TaskVersionConflictError) || attempt === 2) throw error; }
    }
    return json(200, { emailDelivery: delivery, taskId, holdId, docId });
  }

  try {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: body.guestFirstName as string,
      slotLabel: body.slotLabel as string,
      formUrl: typeof body.formUrl === 'string' ? body.formUrl : undefined,
      topicSeed: typeof body.topicSeed === 'string' ? body.topicSeed : undefined,
    });
    return json(200, { ...email, docsPage: PODCAST_DOCS_URL });
  } catch (error) {
    return json(400, { error: (error as Error).message });
  }
}
