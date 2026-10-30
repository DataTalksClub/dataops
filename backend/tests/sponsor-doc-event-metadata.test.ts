import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createCard, getCardConsistent, updateCard } from '../src/db/cards';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { buildHold, releaseHoldRecord } from '../src/calendar/holds';
import { putCalendarHold } from '../src/db/calendarHolds';
import { planEventTransition, type EventRecord } from '../src/events/lifecycle';
import { commitEventTransition, claimEventOperation, completeEventOperation, getEventRecord } from '../src/events/store';
import { policy as buildTestPolicy } from './helpers/eventPolicy';
import { createSponsorDoc, getSponsorDoc, getSponsorDocWithAuthMaterial, listSponsorDocSummariesByCardId, updateSponsorDoc, rotateSponsorDocAccessCode, sponsorDocKey, cardSponsorDocIndexKey } from '../src/db/sponsorDocs';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { renderSponsorDocMarkdownExport, type SponsorDocTemplateKey } from '../src/sponsorDocs/templates';
import { templateLink } from './helpers/cardTemplate';

let client: DynamoDBDocumentClient;
before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); });
after(async () => { await stopLocal(); });
const rawDoc = async (key: Record<string, string>) => (await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key, ConsistentRead: true }))).Item!;

test('every event document reads the live hold after move/approve/release without any document write', async () => {
  const card = await createCard(client, { ...templateLink(), title: 'Synthetic event', anchorDate: '2030-11-04', people: ['Test guest'] });
  let hold = buildHold({ title: 'Synthetic event', topic: 'Synthetic topic', date: '2030-11-04', window: 'midday', cardId: card.id }, 'test');
  await putCalendarHold(client, hold);
  const templates: SponsorDocTemplateKey[] = ['podcast', 'webinar', 'podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'];
  const docs = [];
  for (const template of templates) {
    const { doc } = await createSponsorDoc(client, { cardId: card.id, template, title: 'Old stored title', publicationDate: '1999-01-01', createdBy: 'test' });
    docs.push({ doc, row: await rawDoc(sponsorDocKey(doc.id)), index: await rawDoc(cardSponsorDocIndexKey(card.id, doc.id)) });
  }
  for (const stage of ['move', 'approve', 'release']) {
    if (stage === 'move') {
      const moved = buildHold({ title: hold.title, topic: hold.topic, date: '2030-12-03', window: 'midday', cardId: card.id }, 'test');
      hold = { ...moved, id: hold.id, version: hold.version + 1 };
    } else if (stage === 'approve') hold = { ...hold, status: 'confirmed', version: hold.version + 1 };
    else hold = releaseHoldRecord(hold, 'manual');
    await putCalendarHold(client, hold);
    for (const { doc, row, index } of docs) {
      const live = (await getSponsorDoc(client, doc.id))!;
      assert.equal(live.eventMetadata!.date, '2030-12-03');
      assert.equal(live.eventMetadata!.time, '12:30');
      assert.equal(live.eventMetadata!.state, stage === 'move' ? 'tentative' : stage === 'approve' ? 'confirmed' : 'released');
      assert.match(live.title, /3 Dec 2030 12:30 Europe\/Berlin/);
      assert.ok(!live.title.includes('1999'));
      const markdown = renderSponsorDocMarkdownExport(live);
      assert.ok(markdown.includes(live.eventMetadata!.label));
      assert.deepEqual(await rawDoc(sponsorDocKey(doc.id)), row);
      assert.deepEqual(await rawDoc(cardSponsorDocIndexKey(card.id, doc.id)), index);
      assert.equal(Object.hasOwn(row, 'title'), false);
      assert.equal(Object.hasOwn(row, 'publicationDate'), false);
      assert.equal(Object.hasOwn(row, 'eventMetadata'), false);
      for (const key of ['recordingDate', 'proposedSlotLabel', 'episodeTitle']) assert.equal(Object.hasOwn(row.content, key), false);
    }
    const summaries = await listSponsorDocSummariesByCardId(client, card.id);
    assert.equal(summaries.length, templates.length);
    assert.ok(summaries.every(d => d.eventMetadata!.date === '2030-12-03'));
  }
  assert.equal((await getCardConsistent(client, card.id))!.anchorDate, '2030-11-04', 'live document follows hold even if the old Card date has not moved');
});

test('staff/guest edits reject derived fields and code rotation never persists read projections', async () => {
  const card = await createCard(client, { ...templateLink(), title: 'Synthetic topic', anchorDate: '2030-12-03' });
  const { doc } = await createSponsorDoc(client, { cardId: card.id, template: 'podcast-episode-brief', title: 'Ignored', createdBy: 'test', content: { goal: 'Authored goal' } });
  for (const actorKind of ['staff', 'sponsor'] as const) {
    await assert.rejects(() => updateSponsorDoc(client, doc.id, { actorKind, content: { recordingDate: 'Wrong date' } }), /derived/);
    await assert.rejects(() => updateSponsorDoc(client, doc.id, { actorKind, title: 'Wrong title' }), /derived/);
    const updated = (await updateSponsorDoc(client, doc.id, { actorKind, content: { goal: 'New authored goal' } }))!;
    assert.equal(updated.content.goal, 'New authored goal');
    assert.ok(updated.content.recordingDate.includes('2030-12-03'));
  }
  await rotateSponsorDocAccessCode(client, doc.id);
  const stored = await rawDoc(sponsorDocKey(doc.id));
  assert.equal(stored.content.goal, 'New authored goal');
  assert.equal(Object.hasOwn(stored.content, 'recordingDate'), false);
  assert.equal(Object.hasOwn(stored, 'title'), false);
  assert.ok((await getSponsorDoc(client, doc.id))!.title.includes('2030-12-03'));
});

test('any document template linked to an event Card uses its event authority', async () => {
  const card = await createCard(client, { ...templateLink(), title: 'Synthetic event' });
  const hold = buildHold({ title: 'Synthetic event', topic: 'Topic', date: '2030-12-03', cardId: card.id }, 'test');
  await putCalendarHold(client, hold);
  const { doc } = await createSponsorDoc(client, { cardId: card.id, template: 'newsletter-main', title: 'Old document date', publicationDate: '1999-01-01', createdBy: 'test' });
  assert.equal(doc.eventMetadata!.date, '2030-12-03');
  assert.equal(Object.hasOwn(await rawDoc(sponsorDocKey(doc.id)), 'publicationDate'), false);
});


test('explicit Card invitation takes precedence over historical released holds', async () => {
  for (const prefix of ['card:', 'legacy:']) {
    const card = await createCard(client, { ...templateLink(), title: 'Current event' });
    let old = buildHold({ title: 'Obsolete title', topic: 'Topic', date: '2030-01-01', cardId: card.id }, 'test');
    old = releaseHoldRecord(old, 'manual'); await putCalendarHold(client, old);
    await updateCard(client, card.id, { expectedVersion: card.version, patch: { eventTime: {
      eventKey: `${prefix}${card.id}`, startIso: '2030-12-03T11:30:00Z', endIso: '2030-12-03T12:30:00Z',
      timeZone: 'Europe/Berlin', durationMinutes: 60, googleEventIds: {}, sync: 'synced', syncStartedAt: '2030-01-01T00:00:00Z',
    } } });
    const { doc } = await createSponsorDoc(client, { cardId: card.id, template: 'podcast', title: 'Ignored', createdBy: 'test' });
    assert.equal(doc.eventMetadata!.date, '2030-12-03');
    assert.equal(doc.eventMetadata!.state, 'confirmed');
    assert.ok(doc.title.includes('Current event'));
    assert.ok(!doc.title.includes('Obsolete'));
  }
});

test('unified EventRecord transitions (propose/reschedule/approve/release) and episode-owned docs derive live metadata without doc writes', async () => {
  const card = await createCard(client, { ...templateLink(), title: 'Ian Whitestone - Agentic Data', anchorDate: '2026-10-29', people: ['Ian Whitestone'] });
  const episode = await createPodcastEpisode(client, {
    title: 'Ian Whitestone - Agentic Data',
    guests: [{ name: 'Ian Whitestone', email: 'ian@example.test' }],
    status: 'booked',
    cardId: card.id,
  });
  // Create both a card-owned doc and an episode-owned guest materials doc
  const { doc: cardDoc } = await createSponsorDoc(client, { cardId: card.id, template: 'podcast-episode-brief', title: 'Old title', createdBy: 'test' });
  const { doc: epDoc } = await createSponsorDoc(client, { cardId: episode.id, template: 'podcast', title: 'Old guest doc', createdBy: 'test' });

  const policy = buildTestPolicy('podcast');
  const proposal = {
    templateId: 'podcast-template',
    templateVersion: 1,
    policy,
    title: card.title!,
    topic: card.title!,
    guestNames: 'Ian Whitestone',
    documentUrl: '',
    guestEmails: ['ian@example.test'],
  };
  const finishOp = async (ev: EventRecord, nowIso: string) => {
    const key = ev.operations.at(-1)!.key;
    const lease = (await claimEventOperation(client, ev.id, key, nowIso))!;
    await completeEventOperation(client, ev, key, lease, { organizer: 'gcal-org-1' }, nowIso);
    return (await getEventRecord(client, ev.id))!;
  };

  // 1. Propose on 2026-10-29 12:30
  let event = planEventTransition(`hold_${card.id}`, card.id, null, {
    transition: 'propose',
    expectedVersion: 0,
    operationKey: 'op-1',
    actor: 'test',
    now: '2026-10-01T10:00:00.000Z',
    date: '2026-10-29',
    time: '12:30',
    proposal,
  });
  let currentCard = (await getCardConsistent(client, card.id))!;
  await commitEventTransition(client, currentCard, 0, event);
  event = await finishOp(event, '2026-10-01T10:00:01.000Z');

  for (const id of [cardDoc.id, epDoc.id]) {
    const live = (await getSponsorDoc(client, id))!;
    assert.equal(live.eventMetadata!.date, '2026-10-29');
    assert.equal(live.eventMetadata!.state, 'tentative');
    assert.match(live.eventMetadata!.label, /Thu, 29 Oct 2026 12:30 Europe\/Berlin \(tentative\)/);
  }

  // 2. Reschedule to 2026-12-01 12:30 (Tue, 1 Dec 2026 12:30 Europe/Berlin (tentative))
  const movedPlan = planEventTransition(event.id, card.id, event, {
    transition: 'reschedule',
    expectedVersion: event.version,
    operationKey: 'op-2',
    actor: 'test',
    now: '2026-10-02T10:00:00.000Z',
    date: '2026-12-01',
    time: '12:30',
    proposal,
  });
  currentCard = (await getCardConsistent(client, card.id))!;
  await commitEventTransition(client, currentCard, event.version, movedPlan);
  event = await finishOp(movedPlan, '2026-10-02T10:00:01.000Z');

  for (const id of [cardDoc.id, epDoc.id]) {
    const live = (await getSponsorDoc(client, id))!;
    assert.equal(live.eventMetadata!.date, '2026-12-01');
    assert.equal(live.eventMetadata!.state, 'tentative');
    assert.equal(live.eventMetadata!.label, 'Tue, 1 Dec 2026 12:30 Europe/Berlin (tentative)');
    assert.ok(live.title.includes('Tue, 1 Dec 2026 12:30 Europe/Berlin (tentative)'));
  }

  // 3. Approve on 2026-12-01 12:30 -> confirmed
  const approvedPlan = planEventTransition(event.id, card.id, event, {
    transition: 'approve',
    expectedVersion: event.version,
    operationKey: 'op-3',
    actor: 'test',
    now: '2026-10-03T10:00:00.000Z',
  });
  currentCard = (await getCardConsistent(client, card.id))!;
  await commitEventTransition(client, currentCard, event.version, approvedPlan);
  event = await finishOp(approvedPlan, '2026-10-03T10:00:01.000Z');

  for (const id of [cardDoc.id, epDoc.id]) {
    const live = (await getSponsorDoc(client, id))!;
    assert.equal(live.eventMetadata!.date, '2026-12-01');
    assert.equal(live.eventMetadata!.state, 'confirmed');
    assert.equal(live.eventMetadata!.label, 'Tue, 1 Dec 2026 12:30 Europe/Berlin (confirmed)');
  }
});

