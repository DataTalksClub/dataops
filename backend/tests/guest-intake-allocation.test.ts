import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, createTables, stopLocal } from '../scripts/local-dynamodb';
import { claimGuestSlotAllocator } from '../src/events/guestIntakeWorker';
import { prepareGuestIntake } from '../src/events/guestIntakeCreate';
import { saveGuestIntakeJob } from '../src/events/guestIntakeStore';
import { createCard } from '../src/db/cards';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { templateLink } from './helpers/cardTemplate';
import type { Template } from '../src/types';
let db: DynamoDBDocumentClient;
before(async () => { db = await getClient(await startLocal()); await createTables(db); });
after(stopLocal);
const template = { id: 'synthetic-template', type: 'podcast', name: 'Podcast', guestIntake: { enabled: true, emailTemplateId: 'podcast.first-contact', formTemplate: 'podcast', followUpDays: 7 } } as Template;

test('two concurrent guest Card jobs cannot enter slot read/reservation together', async () => {
  const results = await Promise.all(['job-one', 'job-two'].map(id => claimGuestSlotAllocator(db, id)));
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? 'job-one' : 'job-two';
  const loser = results[0] ? 'job-two' : 'job-one';
  assert.equal(await claimGuestSlotAllocator(db, loser), false, 'loser cannot select the same available slot while winner reserves it');
  await db.send(new UpdateCommand({ TableName: TABLE_ARTIFACTS, Key: { PK: 'GUESTINTAKEALLOCATOR', SK: 'GUESTINTAKEALLOCATOR' }, UpdateExpression: 'SET leaseUntil = :zero', ConditionExpression: 'ownerId = :winner', ExpressionAttributeValues: { ':zero': 0, ':winner': winner } }));
  assert.equal(await claimGuestSlotAllocator(db, loser), true, 'next job may refresh authoritative availability only after prior durable proposal');
});

test('email alone creates enabled guest intake; unapproved and disabled types do not', async () => {
  const enabled = await prepareGuestIntake(db, 'synthetic-actor', template, { guestEmail: 'guest@example.test', creationKey: 'email-alone' });
  assert.equal(enabled!.job.status, 'queued');
  assert.equal(enabled!.job.guestEmail, 'guest@example.test');
  assert.equal(enabled!.job.requestedDate, undefined);
  assert.equal(enabled!.job.guestName, undefined);
  assert.equal(await prepareGuestIntake(db, 'synthetic-actor', { ...template, type: 'office-hours' }, { guestEmail: 'guest@example.test' }), null);
  assert.equal(await prepareGuestIntake(db, 'synthetic-actor', { ...template, guestIntake: { ...template.guestIntake!, enabled: false } }, { guestEmail: 'guest@example.test' }), null);
});

test('same-key changed requests fail both sequential lookup and concurrent loser replay', async () => {
  const firstBody = { guestEmail: 'first@example.test', creationKey: 'same-key' };
  const secondBody = { guestEmail: 'second@example.test', creationKey: 'same-key' };
  const [first, second] = await Promise.all([prepareGuestIntake(db, 'synthetic-actor', template, firstBody), prepareGuestIntake(db, 'synthetic-actor', template, secondBody)]);
  assert.equal(first!.job.id, second!.job.id);
  const card = await createCard(db, { ...templateLink(), title: 'Synthetic winner', anchorDate: '2030-12-02' });
  second!.job.cardId = card.id;
  await saveGuestIntakeJob(db, second!.job);
  await assert.rejects(prepareGuestIntake(db, 'synthetic-actor', template, firstBody), /different Card request/);
  await assert.rejects(first!.replay(), /different Card request/);
  const replay = await second!.replay();
  assert.equal(replay!.card.id, card.id);
});

test('routine invitation Task uses the configured operational assignee rather than the creator', async () => {
  const configured = { ...template, guestIntake: { ...template.guestIntake!, firstContactTaskRefs: ['first-contact'] }, taskDefinitions: [{ refId: 'first-contact', description: 'First contact', assigneeId: 'synthetic-ops-owner' }] } as Template;
  const intent = (await prepareGuestIntake(db, 'synthetic-human-creator', configured, { guestEmail: 'guest@example.test', creationKey: 'ownership' }))!;
  assert.equal(intent.job.actorId, 'synthetic-human-creator');
  assert.equal(intent.tasks({ id: 'synthetic-card' } as any)[0].assigneeId, 'synthetic-ops-owner');
});
