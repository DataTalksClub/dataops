import { getTaskConsistent, updateTask } from '../db/tasks';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { SponsorDoc } from '../db/sponsorDocs';
import { getCardConsistent } from '../db/cards';
import { getGuestIntakeJob } from './guestIntakeStore';
import { guestEventSlots } from './guestIntakeSlots';
import { resolveCardEventPolicy, approveEvent, rescheduleEvent, retryEventOperation } from './service';
import { getEventRecord } from './store';
import { claimGuestSlotAllocator, releaseAllocator } from './guestIntakeAllocator';
import { PutCommand, ScanCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getSponsorDocWithAuthMaterial } from '../db/sponsorDocs';
import { TABLE_ARTIFACTS } from '../db/tableNames';

export async function guestPortalSlots(db: DynamoDBDocumentClient, doc: SponsorDoc) {
  const card = await getCardConsistent(db, doc.cardId);
  if (!card?.guestIntake) return null;
  const job = await getGuestIntakeJob(db, card.guestIntake.jobId);
  if (!job?.policy) return null;
  const { policy } = await resolveCardEventPolicy(db, card);
  const slots = await guestEventSlots(db, { ...job, requestedDate: undefined, requestedTime: undefined }, policy, 8);
  return slots.map(s => ({ date: s.date, window: s.window, localTime: s.time, startIso: s.startIso, endIso: s.endIso, label: s.label }));
}
export interface GuestTimeChoiceIntent { choice: string; proposalStartIso: string; proposalVersion: number }
const choiceKey = (id: string) => ({ PK: `GUESTCHOICE#${id}`, SK: `GUESTCHOICE#${id}` });
class SupersededChoiceError extends Error {}
class InvalidChoiceError extends Error {}

/** Only an explicit externally authenticated time action may record acceptance. */
export async function applyGuestPortalTimeChoice(
  db: DynamoDBDocumentClient, doc: SponsorDoc, intent: GuestTimeChoiceIntent,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  const choice = intent.choice;
  if (!choice || choice === 'none_fit') return;
  const card = await getCardConsistent(db, doc.cardId);
  if (!card?.guestIntake) return;
  const job = await getGuestIntakeJob(db, card.guestIntake.jobId);
  if (!job?.holdId || !job.guestEmail || job.docId !== doc.id) throw new Error('Guest invitation is still preparing; try shortly');
  let current = await getEventRecord(db, job.holdId);
  if (!current || !['proposed', 'approved'].includes(current.status)) throw new InvalidChoiceError('This invitation is no longer active');
  if (card.stage !== 'preparation') throw new InvalidChoiceError('This event has been published; reply to Orin to arrange a schedule change');
  const moveKey = `guest-choice-${doc.id}-r${doc.version}`;
  const acceptKey = `guest-accept-${doc.id}-r${doc.version}`;
  const lastOperationKey = current.operations.at(-1)?.key;
  const ownsTransition = lastOperationKey === moveKey || lastOperationKey === acceptKey;
  if (!ownsTransition && (current.version !== intent.proposalVersion || current.startIso !== intent.proposalStartIso)) {
    throw new InvalidChoiceError('The proposal changed; reload the form before choosing a time');
  }
  await assertCurrent();
  if (current.operations.some(o => o.state !== 'complete')) {
    const retried = await retryEventOperation(db, card.id, { actor: 'guest-portal' });
    if (retried.sync.state !== 'synced') throw new Error('Your time choice is saved; Calendar synchronization is pending');
    current = retried.event;
  }
  if (choice !== 'confirm_proposed') {
    const match = /^slot:(\d{4}-\d{2}-\d{2}):([a-z][a-z0-9-]*)$/.exec(choice);
    if (!match) throw new InvalidChoiceError('Choose a currently available time');
    const { policy } = await resolveCardEventPolicy(db, card);
    const wantedTime = policy.windows[match[2]];
    if (current.date !== match[1] || current.time !== wantedTime) {
      const available = await guestPortalSlots(db, doc);
      if (!available?.some(s => s.date === match[1] && s.window === match[2])) throw new InvalidChoiceError('That time is no longer available; choose another time');
      await assertCurrent();
      const changed = await rescheduleEvent(db, card.id, { date: match[1], time: wantedTime, guestEmails: [job.guestEmail], guestTimezone: doc.content.guestTimezone || job.guestTimezone,
        operationKey: moveKey, expectedEventVersion: current.version, actor: 'guest-portal' });
      if (changed.sync.state !== 'synced') throw new Error('Your time change is saved; Calendar synchronization is pending');
      current = changed.event;
    }
  }
  await assertCurrent();
  if (current.status === 'proposed') {
    const approved = await approveEvent(db, card.id, { operationKey: acceptKey, expectedEventVersion: current.version, actor: 'guest-portal' });
    if (approved.sync.state !== 'synced') throw new Error('Your acceptance is saved; Calendar synchronization is pending');
  }
}

export async function processGuestChoice(db: DynamoDBDocumentClient, item: Record<string, any>) {
  const token = crypto.randomUUID();
  try {
    await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: choiceKey(item.docId),
      UpdateExpression: 'SET leaseToken = :token, leaseUntil = :until',
      ConditionExpression: '#v = :v AND #s = :pending AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
      ExpressionAttributeNames: { '#v': 'version', '#s': 'status' },
      ExpressionAttributeValues: { ':v': item.version, ':pending': 'pending', ':token': token, ':until': Date.now()+150000, ':now': Date.now() } }));
  } catch (error) { if ((error as Error).name === 'ConditionalCheckFailedException') return; throw error; }
  let allocator = false;
  const owner = `choice-${token}`;
  const finish = async (status: string, error?: string) => {
    try {
      await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: choiceKey(item.docId),
        UpdateExpression: 'SET #s = :status, #error = :error REMOVE leaseToken, leaseUntil',
        ConditionExpression: '#v = :v AND leaseToken = :token',
        ExpressionAttributeNames: { '#s': 'status', '#v': 'version', '#error': 'error' },
        ExpressionAttributeValues: { ':status': status, ':error': error || '', ':v': item.version, ':token': token } }));
    } catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; }
  };
  const assertCurrent = async () => {
    const [saved, loaded] = await Promise.all([
      db.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: choiceKey(item.docId), ConsistentRead: true })),
      getSponsorDocWithAuthMaterial(db, item.docId),
    ]);
    if (saved.Item?.version !== item.version || saved.Item?.leaseToken !== token || saved.Item?.status !== 'pending'
      || !loaded || loaded.doc.content.slotChoice !== item.choice) throw new SupersededChoiceError('A newer guest time choice superseded this action');
  };
  try {
    await assertCurrent();
    allocator = await claimGuestSlotAllocator(db, owner);
    if (!allocator) throw new Error('A time is being reserved; try shortly');
    const loaded = (await getSponsorDocWithAuthMaterial(db, item.docId))!;
    await applyGuestPortalTimeChoice(db, { ...loaded.doc, version: item.version }, item.intent, assertCurrent);
    await finish('complete');
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof SupersededChoiceError) await finish('cancelled', message);
    else if (error instanceof InvalidChoiceError || /proposal changed|Event changed/.test(message)) {
      await finish('failed', message);
      const loaded = await getSponsorDocWithAuthMaterial(db, item.docId);
      const card = loaded ? await getCardConsistent(db, loaded.doc.cardId) : null;
      const task = card?.guestIntake ? await getTaskConsistent(db, card.guestIntake.taskId) : null;
      if (task) await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { comment: `Guest time choice needs attention: ${message}` }, actorId: 'guest-portal', triggerKind: 'guest-time-choice-failed' });
      throw error;
    } else { await finish('pending', message); throw error; }
  } finally { if (allocator) await releaseAllocator(db, owner); }
}

/** Persist explicit guest-origin intent before provider calls; ordinary bio saves never enter here. */
export async function recordGuestPortalTimeChoice(db: DynamoDBDocumentClient, doc: SponsorDoc, raw: unknown) {
  const intent = raw as GuestTimeChoiceIntent;
  if (!intent || intent.choice !== doc.content.slotChoice || !Number.isInteger(intent.proposalVersion) || typeof intent.proposalStartIso !== 'string' || !Number.isFinite(Date.parse(intent.proposalStartIso))) throw new InvalidChoiceError('Reload the form and explicitly save your time choice');
  const card = await getCardConsistent(db, doc.cardId);
  if (!card?.guestIntake) return;
  const item = { ...choiceKey(doc.id), docId: doc.id, choice: intent.choice, intent, version: doc.version, status: intent.choice === 'none_fit' ? 'cancelled' : 'pending' };
  try {
    await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: item, ConditionExpression: 'attribute_not_exists(PK) OR #v < :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': doc.version } }));
  } catch (error) { if ((error as Error).name !== 'ConditionalCheckFailedException') throw error; }
  if (item.status === 'pending') await processGuestChoice(db, item);
}
export async function resumeGuestPortalTimeChoices(db: DynamoDBDocumentClient) {
  let cursor: Record<string, unknown> | undefined;
  let checked = 0;
  do {
    const page = await db.send(new ScanCommand({ TableName: TABLE_ARTIFACTS, ConsistentRead: true, FilterExpression: 'begins_with(PK, :prefix) AND #s = :pending', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':prefix': 'GUESTCHOICE#', ':pending': 'pending' }, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    for (const item of page.Items || []) {
      checked++;
      try { await processGuestChoice(db, item); } catch { /* transient intent remains durable; permanent failure is visible on the owning Task */ }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return { checked };
}
