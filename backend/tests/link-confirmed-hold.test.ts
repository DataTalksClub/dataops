import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { linkConfirmedHold } from '../src/calendar/linkConfirmedHold';
import { TABLE_CALENDAR, TABLE_CARDS, TABLE_PODCAST_EPISODES } from '../src/db/tableNames';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { HOLD_ZOOM_LOCATION, HOLD_REQUIRED_ATTENDEES } from '../src/calendar/holds';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';

function fixture() {
  const hold: any = { id: 'hold_confirmed_example', version: 4, title: 'Example Guest at DataTalks.Club Podcast', status: 'confirmed', date: '2027-02-08', window: 'midday',
    startIso: '2027-02-08T11:30:00.000Z', endIso: '2027-02-08T12:30:00.000Z', durationMinutes: 60, timeZone: 'Europe/Berlin',
    proposedAt: '2027-01-01T00:00:00Z', guestRef: 'guest@example.test', googleSync: { state: 'synced' },
    googleEventIds: Object.fromEntries([HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS].map((cal,i) => [cal, `event-${i}`])) };
  const prior: any = { ...hold, id: 'hold_released_example', version: 2, status: 'released', cardId: 'card-example', googleEventIds: { [HOLD_ORGANIZER]: 'old-event' } };
  const card: any = { id: 'card-example', title: 'Example podcast', version: 3, status: 'active', stage: 'preparation', taskCount: 0, openTaskCount: 0, anchorDate: hold.date,
    templateId: 'template-example', templateVersion: 1, selectedOptionalGroups: [], templateDefinitionSnapshot: { taskRefs: [] },
    eventTime: { ...hold, eventKey: prior.id }, calendarInvites: [{ calendar: HOLD_ORGANIZER, eventId: 'old-event' }] };
  const episode: any = { id: 'episode-example', cardId: card.id, version: 2, status: 'booked', guests: [{ name: 'Example Guest' }], recordingHoldId: prior.id, recordingDate: '2027-01-25' };
  const writes: any[] = [];
  const calls: string[] = [];
  let failTransaction = false;
  const client = { send: async (command: any) => {
    const name=command.constructor.name, input=command.input;
    if (name === 'GetCommand') return { Item: input.TableName === TABLE_CARDS ? card : input.TableName === TABLE_CALENDAR ? (input.Key.PK === `CALHOLD#${hold.id}` ? hold : prior) : undefined };
    if (name === 'ScanCommand') return { Items: input.TableName === TABLE_CALENDAR ? [hold, prior] : input.TableName === TABLE_PODCAST_EPISODES ? [episode] : [] };
    if (name === 'QueryCommand') return { Items: input.TableName === TABLE_PODCAST_EPISODES ? [episode] : [] };
    if (name === 'TransactWriteCommand') {
      writes.push(input.TransactItems);
      if (failTransaction) throw Object.assign(new Error('changed'),{name:'TransactionCanceledException'});
      const cardWrite=input.TransactItems.find((w:any)=>w.Update?.TableName===TABLE_CARDS).Update;
      Object.assign(card,{eventTime:cardWrite.ExpressionAttributeValues[':time'],calendarInvites:cardWrite.ExpressionAttributeValues[':invites'],version:card.version+1});
      return {};
    }
    throw new Error(`unexpected ${name}`);
  } } as unknown as DynamoDBDocumentClient;
  const deps = { credential: 'synthetic-token', connectionId: 'synthetic-connection', fetchImpl: (async (url: any, init: any={}) => {
    if (String(url).includes('/api/agent/token')) return Response.json({access_token:'synthetic-access'});
    calls.push(init.method || 'GET');
    const match = new URL(String(url)).pathname.match(/calendars\/([^/]+)\/events\/([^/]+)/)!;
    return Response.json({id:decodeURIComponent(match[2]), status:'confirmed', organizer:{email:HOLD_ORGANIZER},
      start:{dateTime:'2027-02-08T11:25:00.000Z'},end:{dateTime:hold.endIso},location:HOLD_ZOOM_LOCATION,
      attendees:[{email:hold.guestRef,responseStatus:'accepted'},...HOLD_REQUIRED_ATTENDEES.map(email=>({email}))]});
  }) as typeof fetch };
  return {hold,prior,card,episode,client,deps,writes,calls,setConflict:()=>{failTransaction=true;}};
}

test('preview verifies existing Google event without any writes or notifications',async()=>{
  const f=fixture(); const result=await linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator');
  assert.equal(result.mode,'dry-run'); assert.equal(result.googleWrites,0); assert.equal(f.writes.length,0);
  assert.ok(f.calls.length); assert.ok(f.calls.every(m=>m==='GET'));
  assert.deepEqual(result.calendarInvites.map(i=>i.eventId),Object.values(f.hold.googleEventIds));
  assert.equal(result.expectedEpisodeVersion,2);
});

test('apply atomically links Hold/Card/Episode with reviewed versions and preserves event identity',async()=>{
  const f=fixture(); const result=await linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator',
    {apply:true,expectedCardVersion:3,expectedHoldVersion:4,expectedEpisodeVersion:2});
  assert.equal(result.mode,'apply'); assert.equal(f.writes.length,1);
  const writes=f.writes[0]; assert.equal(writes.length,4);
  for(const table of [TABLE_CALENDAR,TABLE_CARDS,TABLE_PODCAST_EPISODES]) assert.equal(writes.filter((w:any)=>w.Update?.TableName===table).length,1);
  const ep=writes.find((w:any)=>w.Update?.TableName===TABLE_PODCAST_EPISODES).Update;
  assert.equal(ep.ExpressionAttributeValues[':date'],'2027-02-08');
  assert.equal(ep.ExpressionAttributeValues[':hold'],f.hold.id);
  assert.deepEqual(ep.ExpressionAttributeValues[':guests'],[{name:'Example Guest',email:'guest@example.test'}]);
  assert.deepEqual(result.eventTime.googleEventIds,f.hold.googleEventIds);
  assert.ok(f.calls.every(m=>m==='GET')); assert.equal(result.taskClosure.outcome,'no_invite_tasks');
});

test('wrong ownership, active old hold, mismatched guest and stale versions refuse repair',async()=>{
  for (const change of [(f:any)=>{f.hold.cardId='another-card';},(f:any)=>{f.prior.status='confirmed';},
    (f:any)=>{f.episode.guests[0].email='other@example.test';}]) {
    const f=fixture(); change(f); await assert.rejects(linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator')); assert.equal(f.writes.length,0);
  }
  const f=fixture(); await assert.rejects(linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator',{apply:true,expectedCardVersion:99,expectedHoldVersion:4,expectedEpisodeVersion:2}),/changed/);
  assert.equal(f.writes.length,0);
});

test('conditional transaction failure leaves task closure unattempted',async()=>{
  const f=fixture(); f.setConflict(); await assert.rejects(linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator',
    {apply:true,expectedCardVersion:3,expectedHoldVersion:4,expectedEpisodeVersion:2}),/changed/);
  assert.equal(f.card.eventTime.eventKey,f.prior.id); assert.equal(f.writes.length,1);
});

test('unified approved hold retains its lifecycle generation and episode status',async()=>{
  const f=fixture(); Object.assign(f.hold,{generation:2,renderValues:{title:'Example'},policy:{},status:'approved'});
  const result=await linkConfirmedHold(f.client,f.hold.id,f.card.id,f.deps,'operator',
    {apply:true,expectedCardVersion:3,expectedHoldVersion:4,expectedEpisodeVersion:2});
  assert.equal(result.eventTime.generation,2); assert.equal(result.eventTime.status,'approved');
  const ep=f.writes[0].find((w:any)=>w.Update?.TableName===TABLE_PODCAST_EPISODES).Update;
  assert.equal(ep.ExpressionAttributeValues[':status'],'approved');
});
