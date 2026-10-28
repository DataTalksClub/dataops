import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventConflictError, planEventTransition, type EventCommand, type EventRecord } from '../src/events/lifecycle';
import { policy } from './helpers/eventPolicy';

const command = (transition: EventCommand['transition'], expectedVersion: number, extras: Partial<EventCommand> = {}): EventCommand => ({
  transition, expectedVersion, actor: 'test-operator', now: '2030-01-01T10:00:00Z', operationKey: `${transition}-${expectedVersion}`,
  ...extras,
});
const proposal = (type = 'podcast'): NonNullable<EventCommand['proposal']> => ({
  templateId: `template-${type}`, templateVersion: 1, policy: policy(type), title: 'Synthetic event',
  topic: 'Synthetic topic', guestNames: 'Test guest', documentUrl: 'https://example.invalid/outline', guestEmails: ['test@example.invalid'],
});
function propose(type = 'podcast') {
  return planEventTransition('hold-test', 'card-test', null, command('propose', 0, { date: '2030-02-01', window: 'midday', proposal: proposal(type) }));
}
function complete(record: EventRecord): EventRecord {
  record.operations.at(-1)!.state = 'complete';
  return record;
}

test('three template types follow the same full lifecycle with template-derived timing/title/Zoom/email', () => {
  for (const type of ['podcast', 'webinar', 'workshop']) {
    let event = propose(type);
    assert.equal(event.status, 'proposed'); assert.equal(event.generation, 1);
    assert.equal(event.time, type === 'workshop' ? '12:00' : '12:30');
    assert.equal(event.operations[0].desired.summary, `(Proposal) ${type}: Synthetic event`);
    assert.equal(event.operations[0].desired.location, '');
    event = planEventTransition(event.id, event.cardId, complete(event), command('approve', event.version));
    assert.equal(event.status, 'approved'); assert.equal(event.generation, 1);
    assert.equal(event.operations.at(-1)!.desired.location, type === 'workshop' ? '' : 'https://zoom.us/j/123456789');
    assert.deepEqual(event.operations.at(-1)!.desired.emails[0].to, ['test@example.invalid']);
    assert.equal(event.operations.at(-1)!.desired.summary, `${type}: Synthetic event`);
    event.googleEventIds = { organizer: 'one', mirror: 'two' };
    event = planEventTransition(event.id, event.cardId, complete(event), command('reschedule', event.version, { date: '2030-03-01', time: '16:00', proposal: proposal(type) }));
    assert.equal(event.status, 'proposed'); assert.equal(event.generation, 2);
    assert.equal(event.identityGeneration, 1); assert.equal(event.googleEventIds.organizer, 'one');
    assert.match(event.operations.at(-1)!.desired.summary, /^\(Proposal\)/);
    assert.equal(event.expiresAt, '2030-01-08T10:00:00.000Z');
    event = planEventTransition(event.id, event.cardId, complete(event), command('approve', event.version));
    assert.equal(event.status, 'approved'); assert.equal(event.generation, 2);
    event = planEventTransition(event.id, event.cardId, complete(event), command('release', event.version));
    assert.equal(event.status, 'released'); assert.equal(event.generation, 2);
    event = planEventTransition(event.id, event.cardId, complete(event), command('propose', event.version, { date: '2030-04-01', window: 'evening', proposal: proposal(type) }));
    assert.equal(event.generation, 3); assert.equal(event.identityGeneration, 3);
    assert.deepEqual(event.googleEventIds, {}); assert.equal(event.previousGoogleEventIds[0].organizer, 'one');
  }
});

test('pending effects block competing transitions; retry is stable and rejects different intent', () => {
  const event = propose();
  assert.throws(() => planEventTransition(event.id, event.cardId, event, command('approve', event.version)), /pending/);
  const retry = command('propose', 0, { date: '2030-02-01', window: 'midday', proposal: proposal(), actor: 'retry-worker', now: '2030-01-02T00:00:00Z' });
  assert.deepEqual(planEventTransition(event.id, event.cardId, event, retry), event);
  retry.date = '2030-02-02';
  assert.throws(() => planEventTransition(event.id, event.cardId, event, retry), /different input/);
  event.operations[0].state = 'outcome-unknown';
  assert.throws(() => planEventTransition(event.id, event.cardId, event, command('reschedule', event.version)), /reconcile/);
});

test('CAS, ownership, released-state and time mutation guards prevent implicit approval/date drift', () => {
  const event = complete(propose());
  assert.throws(() => planEventTransition(event.id, event.cardId, event, command('approve', 0)), EventConflictError);
  assert.throws(() => planEventTransition(event.id, 'another-card', event, command('approve', 1)), /ownership/);
  assert.throws(() => planEventTransition(event.id, event.cardId, event, command('approve', 1, { date: '2030-02-02' })), /Only propose/);
  assert.throws(() => planEventTransition(event.id, event.cardId, event, command('propose', 1)), /active event/);
  const released = complete(planEventTransition(event.id, event.cardId, event, command('release', 1)));
  assert.throws(() => planEventTransition(event.id, event.cardId, released, command('reschedule', 2)), /Released/);
  assert.deepEqual(planEventTransition(event.id, event.cardId, released, command('release', 2)), released);
});

test('Calendar approval records exact audit attribution and rejects old generation/internal attendee', () => {
  const event = complete(propose());
  for (const approval of [
    { via: 'calendar-accept' as const, attendeeEmail: 'test@example.invalid', acceptedEmails: ['test@example.invalid'], generation: 0 },
    { via: 'calendar-accept' as const, attendeeEmail: 'internal@example.invalid', acceptedEmails: ['internal@example.invalid'], generation: 1 },
  ]) assert.throws(() => planEventTransition(event.id, event.cardId, event, command('approve', 1, { approval })), EventConflictError);
  const approved = planEventTransition(event.id, event.cardId, event, command('approve', 1, { approval: { via: 'calendar-accept', attendeeEmail: 'TEST@example.invalid', acceptedEmails: ['test@example.invalid'], generation: 1 } }));
  assert.equal(approved.history.at(-1)!.note, 'approved via calendar accept');
  assert.equal(approved.history.at(-1)!.attendeeEmail, 'test@example.invalid');
  assert.equal(approved.history.at(-1)!.at, '2030-01-01T10:00:00Z');
});

test('proposal validates IANA DST wall times, named windows and freezes render values', () => {
  for (const [date, time] of [['2030-03-31', '02:30'], ['2030-10-27', '02:30']]) {
    assert.throws(() => planEventTransition('hold', 'card', null, command('propose', 0, { date, time, proposal: proposal() })), /nonexistent or ambiguous/);
  }
  assert.throws(() => planEventTransition('hold', 'card', null, command('propose', 0, { date: '2030-02-01', window: 'missing', proposal: proposal() })), /Template-defined/);
  const p = proposal(); const request = command('propose', 0, { date: '2030-02-01', time: '12:30', proposal: p });
  const event = planEventTransition('hold', 'card', null, request);
  p.title = 'Changed'; p.policy.titles.approved = 'Changed';
  const approved = planEventTransition('hold', 'card', complete(event), command('approve', 1));
  assert.equal(approved.operations.at(-1)!.desired.summary, 'podcast: Synthetic event');
});


test('reschedule and reproposal do not mutate their input even when output arrays change', () => {
  for (const released of [false, true]) {
    let current = complete(propose());
    if (released) current = complete(planEventTransition(current.id, current.cardId, current, command('release', 1)));
    current.googleEventIds = { organizer: 'old-event' };
    const before = structuredClone(current);
    const next = planEventTransition(current.id, current.cardId, current, command(released ? 'propose' : 'reschedule', current.version, {
      date: '2030-03-01', time: '12:30', proposal: proposal(),
    }));
    assert.deepEqual(current, before);
    next.operations[0].state = 'pending';
    next.history[0].actor = 'changed';
    if (next.previousGoogleEventIds.length) next.previousGoogleEventIds[0].organizer = 'changed';
    assert.deepEqual(current, before);
  }
});

test('all-guest Calendar approval requires the entire eligible guest set', () => {
  const p = proposal(); p.policy.calendarAcceptance.quorum = 'all';
  p.guestEmails = ['one@example.invalid', 'two@example.invalid'];
  const current = complete(planEventTransition('hold', 'card', null, command('propose', 0, { date: '2030-02-01', time: '12:30', proposal: p })));
  const approval = { via: 'calendar-accept' as const, attendeeEmail: 'one@example.invalid', acceptedEmails: ['one@example.invalid'], generation: 1 };
  assert.throws(() => planEventTransition('hold', 'card', current, command('approve', 1, { approval })), EventConflictError);
  approval.acceptedEmails.push('two@example.invalid');
  assert.equal(planEventTransition('hold', 'card', current, command('approve', 1, { approval })).status, 'approved');
});
