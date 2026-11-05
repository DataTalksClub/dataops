import { GetCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR, TABLE_CARDS, TABLE_PODCAST_EPISODES } from '../db/tableNames';
import { getCardConsistent } from '../db/cards';
import { getCalendarHold, listCalendarHolds } from '../db/calendarHolds';
import type { PodcastEpisode } from '../db/podcastEpisodes';
import { adoptEventDate, calendarInviteUrl, closeCardInviteTasks, parseCardGuests } from './cardInvite';
import { confirmedHoldInvite, HOLD_ZOOM_LOCATION, HOLD_ATTENDEE_DENY_LIST } from './holds';
import { fetchGoogleEvent, HOLD_ORGANIZER, type HoldGoogleDeps } from './holdGoogleSync';
import { PUBLIC_DTC_EVENTS_CALENDAR } from './dapierBroker';

export class HoldLinkError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

async function cardEpisodes(client: DynamoDBDocumentClient, cardId: string): Promise<PodcastEpisode[]> {
  const rows: PodcastEpisode[] = [];
  let cursor: Record<string, any> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: TABLE_PODCAST_EPISODES,
      FilterExpression: 'begins_with(PK, :prefix) AND cardId = :card',
      ExpressionAttributeValues: { ':prefix': 'EPISODE#', ':card': cardId }, ConsistentRead: true,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    rows.push(...(page.Items || []) as PodcastEpisode[]);
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}

/** Repair only an existing DataOps invitation. Google is read, never written. */
export async function linkConfirmedHold(
  client: DynamoDBDocumentClient, holdId: string, cardId: string, deps: HoldGoogleDeps,
  actorId: string, options: { apply?: boolean; expectedCardVersion?: number; expectedHoldVersion?: number; expectedEpisodeVersion?: number } = {},
) {
  const [hold, card, holds, episodes] = await Promise.all([
    getCalendarHold(client, holdId), getCardConsistent(client, cardId), listCalendarHolds(client), cardEpisodes(client, cardId),
  ]);
  if (!hold || !card) throw new HoldLinkError('Hold or Card not found', 404);
  if (hold.status !== 'confirmed' || hold.googleSync.state !== 'synced') throw new HoldLinkError('Only a confirmed, Google-synced DataOps hold can be linked');
  if (hold.cardId && hold.cardId !== card.id) throw new HoldLinkError('This hold already belongs to another Card');
  if (card.status === 'archived') throw new HoldLinkError('An archived Card cannot own this invitation');
  const other = holds.find(h => h.id !== hold.id && h.cardId === card.id && ['tentative', 'confirmed'].includes(h.status));
  if (other) throw new HoldLinkError('The Card already owns another active hold; resolve it first');
  const matches = episodes.filter(ep => ep.cardId === card.id);
  if (matches.length > 1) throw new HoldLinkError('More than one podcast episode is linked to this Card');
  const episode = matches[0];
  if (options.apply && episode && options.expectedEpisodeVersion === undefined) throw new HoldLinkError('Apply requires the reviewed episode version');
  let guests: string[];
  try { guests = parseCardGuests([hold.guestRef]); }
  catch { throw new HoldLinkError('The confirmed hold has no valid guest email', 422); }
  if (episode && episode.guests.length !== 1) throw new HoldLinkError('A podcast invitation requires exactly one existing episode guest');
  if (episode?.guests[0].email && episode.guests[0].email.trim().toLowerCase() !== guests[0]) throw new HoldLinkError('The episode guest email conflicts with the confirmed hold');
  for (const [requested, actual, label] of [
    [options.expectedCardVersion, card.version, 'Card'], [options.expectedHoldVersion, hold.version, 'Hold'],
    [options.expectedEpisodeVersion, episode?.version, 'Episode'],
  ] as const) if (requested !== undefined && requested !== actual) throw new HoldLinkError(`${label} changed; reread before linking`);
  const eventIds = hold.googleEventIds || {};
  if (!eventIds[HOLD_ORGANIZER] || eventIds[PUBLIC_DTC_EVENTS_CALENDAR]) throw new HoldLinkError('The hold must own a private organizer invitation and no public calendar entry');
  const expectedInvite = confirmedHoldInvite(hold);
  for (const [calendar, eventId] of Object.entries(eventIds)) {
    const read = await fetchGoogleEvent(eventId, calendar, deps);
    if (read.state !== 'ok') throw new HoldLinkError(read.state === 'gone' ? 'A linked Google event is gone' : read.reason, 422);
    const event = read.event;
    if (event.id !== eventId || Date.parse(event.start?.dateTime || '') !== Date.parse(expectedInvite.startIso)
      || Date.parse(event.end?.dateTime || '') !== Date.parse(expectedInvite.endIso)) throw new HoldLinkError('Google event identity or interval differs from the confirmed hold');
    if (calendar === HOLD_ORGANIZER) {
      if (event.organizer?.email?.toLowerCase() !== HOLD_ORGANIZER || event.location !== HOLD_ZOOM_LOCATION
        || !expectedInvite.attendees.every(email => event.attendees?.some(a => a.email?.toLowerCase() === email))
        || guests.some(email => event.attendees?.some(a => a.email?.toLowerCase() === email && a.responseStatus === 'declined'))
        || /^\(Proposal\)|^Proposed -/i.test(event.summary || '')
        || event.attendees?.some(a => HOLD_ATTENDEE_DENY_LIST.includes(a.email?.toLowerCase() || ''))
        || event.attendees?.some(a => a.email === PUBLIC_DTC_EVENTS_CALENDAR)) throw new HoldLinkError('Google invitation organizer, guests or Zoom do not match the DataOps invitation');
    }
  }
  const previousHold = card.eventTime?.eventKey && card.eventTime.eventKey !== hold.id
    ? holds.find(h => h.id === card.eventTime!.eventKey) : undefined;
  if (card.eventTime && card.eventTime.eventKey !== hold.id && !previousHold) throw new HoldLinkError('The existing Card invitation has no verifiable released hold');
  if (previousHold && !['released', 'expired'].includes(previousHold.status)) throw new HoldLinkError('The prior Card hold must be released or expired');
  const superseded = new Set(Object.entries(previousHold?.googleEventIds || {}).map(([calendar, id]) => `${calendar}:${id}`));
  const invites = (card.calendarInvites || []).filter(i => !superseded.has(`${i.calendar}:${i.eventId}`));
  const at = new Date().toISOString();
  for (const [calendar, eventId] of Object.entries(eventIds)) {
    const index = invites.findIndex(i => i.calendar === calendar && i.eventId === eventId);
    const entry = { calendar, eventId, url: calendarInviteUrl(calendar, eventId), createdAt: at, createdBy: actorId };
    if (index < 0) invites.push(entry); else invites[index] = entry;
  }
  const lifecycle = hold as typeof hold & { generation?: number; lifecycleStatus?: string };
  const lifecycleFields = Number.isInteger(lifecycle.generation) && lifecycle.lifecycleStatus === 'approved'
    ? { generation: lifecycle.generation, status: 'approved' as const } : {};
  const eventTime = { ...lifecycleFields, eventKey: hold.id, startIso: hold.startIso, endIso: hold.endIso, timeZone: hold.timeZone,
    durationMinutes: hold.durationMinutes, googleEventIds: eventIds, sync: 'synced' as const, syncStartedAt: at };
  const preview = { holdId, cardId, episodeId: episode?.id, expectedCardVersion: card.version, expectedHoldVersion: hold.version,
    ...(episode ? { expectedEpisodeVersion: episode.version } : {}), eventTime, guestEmails: guests, calendarInvites: invites,
    googleWrites: 0, notificationsSent: 0 };
  if (!options.apply) return { mode: 'dry-run', ...preview };
  const key = (prefix: string, id: string) => ({ PK: `${prefix}#${id}`, SK: `${prefix}#${id}` });
  // Check the physical hold shape as well: lifecycle records can map approved -> confirmed.
  const raw = (await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: key('CALHOLD', hold.id), ConsistentRead: true }))).Item;
  if (!raw || raw.version !== hold.version) throw new HoldLinkError('Hold changed; reread before linking');
  const writes: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
    { Update: { TableName: TABLE_CARDS, Key: key('CARD', card.id),
      UpdateExpression: 'SET eventTime = :time, guestEmails = :guests, calendarInvites = :invites, updatedAt = :at ADD #version :one',
      ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':time': eventTime, ':guests': guests, ':invites': invites, ':at': at, ':one': 1, ':expected': card.version } } },
    { Update: { TableName: TABLE_CALENDAR, Key: key('CALHOLD', hold.id),
      UpdateExpression: 'SET cardId = :card, updatedAt = :at ADD #version :one',
      ConditionExpression: '#version = :expected AND #status = :status', ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
      ExpressionAttributeValues: { ':card': card.id, ':at': at, ':one': 1, ':expected': hold.version, ':status': raw.status } } },
  ];
  if (previousHold) writes.push({ ConditionCheck: { TableName: TABLE_CALENDAR, Key: key('CALHOLD', previousHold.id),
    ConditionExpression: '#version = :expected AND #status IN (:released, :expired)',
    ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
    ExpressionAttributeValues: { ':expected': previousHold.version, ':released': 'released', ':expired': 'expired' } } });
  if (episode) {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: hold.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(hold.startIso));
    writes.push({ Update: { TableName: TABLE_PODCAST_EPISODES, Key: key('EPISODE', episode.id),
      UpdateExpression: 'SET recordingDate = :date, recordingTime = :time, recordingTimeZone = :tz, recordingStartIso = :start, recordingEndIso = :end, recordingEventStatus = :status, recordingHoldId = :hold, guests = :guests, dateKey = :dateKey, updatedAt = :at ADD #version :one',
      ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':date': hold.date, ':time': time, ':tz': hold.timeZone, ':start': hold.startIso, ':end': hold.endIso,
        ':status': lifecycle.lifecycleStatus || hold.status, ':hold': hold.id, ':guests': [{ ...episode.guests[0], email: guests[0] }],
        ':dateKey': `${episode.releaseDate || hold.date}#${episode.id}`, ':at': at, ':one': 1, ':expected': episode.version } } });
  }
  try { await client.send(new TransactWriteCommand({ TransactItems: writes })); }
  catch (e: any) { if (['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(e.name)) throw new HoldLinkError('Calendar association changed; reread all records before retrying'); throw e; }
  const linked = (await getCardConsistent(client, card.id))!;
  const dated = await adoptEventDate(client, linked, card.eventTime);
  const taskClosure = await closeCardInviteTasks(client, dated.card, actorId);
  return { mode: 'apply', ...preview, card: (await getCardConsistent(client, card.id))!, taskClosure };
}