import { resolveGuestAcceptanceTask } from './guestIntakeCompletion';
import { makeTaskHistoryEvent } from '../routes/taskValidation';
import { resumeGuestPortalTimeChoices } from './guestIntakePortal';
import { claimGuestSlotAllocator, releaseAllocator } from './guestIntakeAllocator';
export { claimGuestSlotAllocator } from './guestIntakeAllocator';
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../db/tableNames';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import { getTaskConsistent, updateTask, listTasksByCardConsistent } from '../db/tasks';
import { createSponsorDoc } from '../db/sponsorDocs';
import { getEventRecord } from './store';
import { getGuestIntakeJob, saveGuestIntakeJob, claimGuestIntakeJob, releaseGuestIntakeLease, listResumableGuestIntakes, type GuestIntakeJob } from './guestIntakeStore';
import { proposeEvent, rescheduleEvent, retryEventOperation, resolveCardEventPolicy, pollEventCalendarAcceptances } from './service';
import { guestEventSlots } from './guestIntakeSlots';
import { loadGuestFirstContact } from './guestFirstContact';
import { deliverGuestFirstContact, provenPreSendFailure } from './guestFirstContactDelivery';
import { getSponsorDocTemplate } from '../sponsorDocs/templates';
import { addDays } from '../podcast/recordingSlots';
import { berlinToday } from '../calendar/ownerCalendarOverlay';
import { APPROVED_GUEST_EVENT_TYPES } from './guestIntakePolicy';

async function projectJob(db: DynamoDBDocumentClient, job: GuestIntakeJob) {
  const card = await getCardConsistent(db, job.cardId);
  if (!card) throw new Error('Invitation Card is missing');
  await updateCardAdditive(db, card, () => ({ guestIntake: { jobId: job.id, taskId: job.taskId, status: job.status, skipEmail: job.skipEmail,
    ...(job.guestEmail ? { recipient: job.guestEmail } : {}), ...(job.messageId ? { messageId: job.messageId } : {}), ...(job.sentAt ? { sentAt: job.sentAt } : {}), ...(job.startIso ? { startIso: job.startIso } : {}), ...(job.error ? { error: job.error } : {}) } }));
}
async function recordFailure(db: DynamoDBDocumentClient, job: GuestIntakeJob, error: unknown) {
  const previousReportedError = job.lastReportedError;
  job.status = 'failed'; job.error = (error as Error).message || 'Invitation preparation failed';
  const task = await getTaskConsistent(db, job.taskId);
  // Any durable dispatch claim without proven pre-provider failure needs reconciliation, never a blind resend.
  const prior = task?.podcastFirstContact;
  job.retryable = !(prior && prior.state !== 'sent' && !(prior.state === 'deferred' && provenPreSendFailure(prior.delivery)));
  job.lastReportedError = job.error;
  await saveGuestIntakeJob(db, job);
  await projectJob(db, job);
  if (task && previousReportedError !== job.error) await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { comment: `${job.error}. ${job.retryable ? 'DataOps will resume this same invitation automatically after the issue is fixed.' : 'Delivery outcome requires reconciliation before any retry.'}` }, actorId: job.actorId, triggerKind: 'guest-intake-failed' });
}
export async function processGuestIntake(db: DynamoDBDocumentClient, id: string): Promise<void> {
  let job = await getGuestIntakeJob(db, id);
  if (!job || !APPROVED_GUEST_EVENT_TYPES.has(job.type) || ['sent', 'skipped', 'contact-pending', 'cancelled'].includes(job.status) || job.retryable === false) return;
  if (!await claimGuestIntakeJob(db, job)) throw new Error('Invitation is already being prepared; retry after its lease');
  job = (await getGuestIntakeJob(db, id))!;
  let allocator = false;
  try {
    const card = await getCardConsistent(db, job.cardId);
    if (!card || card.status === 'archived') {
      job.status = 'cancelled'; job.retryable = false; job.error = 'Invitation cancelled because its Card was archived or removed';
      await saveGuestIntakeJob(db, job); if (card) await projectJob(db, job); return;
    }
    if (card.status === 'parked') {
      if (job.status !== 'paused') {
        job.status = 'paused'; job.error = 'Invitation paused while its Card is parked';
        await saveGuestIntakeJob(db, job); await projectJob(db, job);
      }
      return;
    }
    if (!job.guestEmail || !job.policy?.enabled) throw new Error('Guest email and enabled event intake policy are required');
    job.status = 'preparing'; delete job.error;
    await saveGuestIntakeJob(db, job); await projectJob(db, job);
    const { policy } = await resolveCardEventPolicy(db, card);
    // Intake owns exactly one first-contact letter; lifecycle transition templates must not send a second one.
    if (Object.values(policy.notifications).some(n => n.emails.length)) throw new Error('Guest intake requires lifecycle email notifications to be empty; configure the editable first-contact template instead');
    const base = (process.env.DATAOPS_PORTAL_URL || 'https://ops.dtcdev.click').replace(/\/$/, '');
    const created = await createSponsorDoc(db, { id: `sdoc-${job.id.slice(0,24)}`, cardId: card.id, template: job.policy.formTemplate, title: card.title || 'Guest event', createdBy: job.actorId,
      content: { ...(job.guestTimezone ? { guestTimezone: job.guestTimezone } : {}) } });
    job.docId = created.doc.id;
    const formPath = `/${job.policy.formTemplate}-docs`;
    const docUrl = `${base}${formPath}/${encodeURIComponent(job.docId)}`;
    const formUrl = `${docUrl}?code=${encodeURIComponent(created.accessCode)}`;
    const currentCard = (await getCardConsistent(db, card.id))!;
    const linkName = getSponsorDocTemplate(job.policy.formTemplate).defaultLinkType;
    await updateCardAdditive(db, currentCard, c => ({ cardLinks: [...(c.cardLinks || []).filter(l => l.name !== linkName), { name: linkName, url: docUrl }] }));
    await saveGuestIntakeJob(db, job);
    let event = await getEventRecord(db, `hold_${card.id}`);
    if (!event) {
      allocator = await claimGuestSlotAllocator(db, id);
      if (!allocator) throw new Error('Another invitation is reserving a time; this invitation will resume automatically');
      const slots = await guestEventSlots(db, job, policy, 1);
      if (!slots.length) throw new Error('No available event time was found; update the scheduling preference on the invitation Task');
      const slot = slots[0]; job.selectedDate = slot.date; job.selectedTime = slot.time; job.selectedWindow = slot.window; job.startIso = slot.startIso;
      await saveGuestIntakeJob(db, job);
      // Validate the editable copy before the first guest-facing Calendar operation.
      if (!job.skipEmail) await loadGuestFirstContact(db, { type: job.type, templateId: job.policy.emailTemplateId, guestName: job.guestName, topic: job.topic, startIso: slot.startIso, guestTimezone: job.guestTimezone, formUrl, accessCode: created.accessCode });
      const result = await proposeEvent(db, card.id, { date: slot.date, time: slot.time, title: card.title, topic: job.topic, guestNames: job.guestName, guestTimezone: job.guestTimezone, guestEmails: [job.guestEmail], documentUrl: formUrl,
        operationKey: `guest-intake-${id.slice(0,32)}`, actor: job.actorId, suppressGuestNotifications: job.skipEmail });
      if (result.sync.state !== 'synced') throw new Error(`Calendar invitation is pending: ${result.sync.reason || 'provider unavailable'}`);
      event = result.event;
    } else {
      if (event.status !== 'proposed' && event.status !== 'approved') {
        job.status = 'cancelled'; job.retryable = false; job.error = 'Invitation cancelled because its linked event was released';
        await saveGuestIntakeJob(db, job); await projectJob(db, job); return;
      }
      const op = event.operations.at(-1);
      if (op && op.state !== 'complete') {
        const result = await retryEventOperation(db, card.id, { operationKey: op.key, actor: job.actorId });
        if (result.sync.state !== 'synced') throw new Error(`Calendar invitation is pending: ${result.sync.reason || 'provider unavailable'}`);
        event = result.event;
      }
      // An explicit initial invitation after skip reuses the same private event and restores guest notifications.
      if (!job.skipEmail && !event.policy.guests.proposal && event.status === 'proposed') {
        const notified = await rescheduleEvent(db, card.id, { date: event.date, time: event.time, guestEmails: [job.guestEmail], documentUrl: formUrl, operationKey: `guest-intake-notify-${id.slice(0,32)}`, actor: job.actorId });
        if (notified.sync.state !== 'synced') throw new Error(`Calendar invitation is pending: ${notified.sync.reason || 'provider unavailable'}`);
        event = notified.event;
      }
    }
    job.holdId = event.id; job.startIso = event.startIso;
    await saveGuestIntakeJob(db, job);
    if (allocator) { await releaseAllocator(db, id); allocator = false; }
    if (job.skipEmail) {
      job.status = 'skipped'; await saveGuestIntakeJob(db, job); await projectJob(db, job); return;
    }
    const delivery = await deliverGuestFirstContact(db, { type: job.type, templateId: job.policy.emailTemplateId, guestName: job.guestName, topic: job.topic, startIso: event.startIso, guestTimezone: job.guestTimezone,
      formUrl, accessCode: created.accessCode, taskId: job.taskId, holdId: event.id, docId: job.docId, recipient: job.guestEmail, actorId: job.actorId });
    if (delivery.state !== 'sent' || !delivery.messageId) throw new Error(`First-contact email is pending: ${delivery.reason || delivery.state}`);
    job.messageId = delivery.messageId; job.sentAt = delivery.sentAt || new Date().toISOString(); delete job.error;
    const task = await getTaskConsistent(db, job.taskId);
    const latestEvent = await getEventRecord(db, event.id);
    if (latestEvent?.status === 'approved') await resolveGuestAcceptanceTask(db, card.id, event.id, job.actorId);
    else if (task) await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { status: 'waiting', waitingFor: job.guestEmail, followUpAt: addDays(berlinToday(), job.policy.followUpDays), comment: `Invitation sent to ${job.guestEmail}; Gmail message ID ${delivery.messageId}. Waiting for the guest's time choice.` }, historyEvents: task.status !== 'waiting' ? [makeTaskHistoryEvent('waiting-started', task, { actorId: job.actorId, createdAt: new Date().toISOString(), note: 'First invitation delivered; waiting for guest time choice.' })] : [], actorId: job.actorId, triggerKind: 'guest-intake-sent' });
    const proofUrl = `https://mail.google.com/mail/u/orin@datatalks.club/#all/${encodeURIComponent(delivery.messageId)}`;
    const sentCard = (await getCardConsistent(db, card.id))!;
    await updateCardAdditive(db, sentCard, c => ({ cardLinks: [...(c.cardLinks || []).filter(l => l.name !== 'Guest email'), { name: 'Guest email', url: proofUrl }] }));
    const tasks = await listTasksByCardConsistent(db, card.id);
    for (const ref of job.policy.firstContactTaskRefs || []) {
      const manual = tasks.find(t => t.templateTaskRef === ref);
      if (!manual || !['todo','waiting'].includes(manual.status)) continue;
      await updateTask(db, manual.id, { currentTask: manual, expectedVersion: manual.version, patch: { status: 'done', completedAt: new Date().toISOString(), completedBy: job.actorId, link: proofUrl, comment: `First invitation delivered by intake Task ${job.taskId}; Gmail message ID ${delivery.messageId}; Calendar event ${event.id}.` }, historyEvents: [makeTaskHistoryEvent('completed', manual, { actorId: job.actorId, createdAt: new Date().toISOString(), note: `Automated invitation proof: ${proofUrl}` })], actorId: job.actorId, triggerKind: 'guest-intake-automated-step' });
    }
    job.status = 'sent'; await saveGuestIntakeJob(db, job); await projectJob(db, job);
  } catch (error) { await recordFailure(db, job, error); throw error; }
  finally { if (allocator) await releaseAllocator(db, id); await releaseGuestIntakeLease(db, job); }
}
export async function resumeGuestIntakes(db: DynamoDBDocumentClient) {
  const jobs = await listResumableGuestIntakes(db);
  const outcomes: Array<{ id: string; ok: boolean }> = [];
  // Bound each scheduled invocation; unprocessed durable rows remain for the next run.
  for (const job of jobs.sort((a,b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 1)) {
    try { await processGuestIntake(db, job.id); outcomes.push({ id: job.id, ok: true }); }
    catch { outcomes.push({ id: job.id, ok: false }); }
  }
  return { checked: outcomes.length, outcomes };
}
export async function pollGuestIntakeAcceptances(db: DynamoDBDocumentClient) {
  // Includes new explicit standalone event proposals, never historical proposals lacking the marker.
  await resumeGuestPortalTimeChoices(db);
  return pollEventCalendarAcceptances(db, { automaticOnly: true });
}
