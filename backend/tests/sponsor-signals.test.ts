import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { handler } from '../src/handler';
import { setSponsorLeadIntakeClientsForTests, resetSponsorLeadIntakeStateForTests } from '../src/routes/sponsorLeads';
import { mergeSignals, noteSignal, parseSignalQuery } from '../src/sponsorCrm/signals';

const SECRET = 'sponsor-signals-test-secret';
const invoke = (method: string, path: string, body?: unknown, query?: Record<string, string>) => handler({
  httpMethod: method, path, headers: {}, queryStringParameters: query || null,
  body: body === undefined ? null : JSON.stringify(body),
}, {});
const data = (response: { body: string }) => JSON.parse(response.body);
const signals = async (query: Record<string, string>) => {
  const response = await invoke('GET', '/api/sponsor-crm/signals', undefined, query);
  return { status: response.statusCode, body: data(response) };
};

async function intake(messageId: string, receivedAt: string, name: string, url = '') {
  const response = await handler({
    httpMethod: 'POST', path: '/api/v1/intake/leads', headers: { 'x-dataops-intake-secret': SECRET },
    body: JSON.stringify({
      version: '2026-10-10', messageId,
      newsletter: { name: 'Fixture Letter', sender: 'news@fixture-letter.org', subject: `Issue ${messageId}`, receivedAt },
      sponsors: [{ name, url, category: '', blurb: `${name} blurb`, context: '' }],
    }),
  }, {});
  assert.ok([200, 201].includes(response.statusCode), response.body);
  return data(response).leads[0].id as string;
}

const portalLead = async (source: string, url: string, observedAt: string, organizationId?: string) => {
  const response = await invoke('POST', '/api/sponsor-crm/leads', { source, url, summary: `seen ${url}`, observedAt, ...(organizationId ? { organizationId } : {}) });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  return data(response).id as string;
};

async function putNote(client: DynamoDBDocumentClient, orgId: string, id: string, createdAt: string, body: string, sourceKey?: string) {
  await client.send(new PutCommand({ TableName: TABLE_SPONSOR_CRM, Item: {
    PK: `NOTE#organization:${orgId}`, SK: `${createdAt}#${id}`, id, targetType: 'organization', targetId: orgId,
    authorId: 'u1', body, createdAt, version: 1, ...(sourceKey ? { sourceKey } : {}),
  } }));
}

describe('sponsor signals read path', () => {
  let client: DynamoDBDocumentClient;
  let orgId: string;
  const ids: Record<string, string> = {};
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.LEADS_INTAKE_RATE_LIMIT = '1000';
    resetSponsorLeadIntakeStateForTests();
    setSponsorLeadIntakeClientsForTests({});
    orgId = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Linked Co', domain: 'linked-co.example', sourceKey: 'sig-org' })).id;
    // Berlin is UTC+1 in November: 23:30Z on the 9th is already the 10th in Berlin.
    ids.before = await intake('m-before', '2026-11-09T22:59:00Z', 'Edge Before');
    ids.first = await intake('m-first', '2026-11-09T23:30:00Z', 'Edge First', 'https://first-sponsor.fixture-letter.org/a');
    ids.last = await intake('m-last', '2026-11-16T22:59:00Z', 'Edge Last');
    ids.after = await intake('m-after', '2026-11-16T23:00:00Z', 'Edge After');
    ids.paidLinked = await portalLead('paid', 'https://ads.fixture-letter.org/landing', '2026-11-12T10:00:00Z', orgId);
    ids.influencer = await portalLead('influencer', 'https://influencer.fixture-letter.org/p', '2026-11-13T10:00:00Z');
    ids.twin = await portalLead('paid', 'https://ads.fixture-letter.org/other', '2026-11-12T11:00:00Z');
    // Legacy explicit note for the same paid placement, plus a distinct one.
    await putNote(client, orgId, 'note-dup', '2026-11-12T12:00:00.000Z', 'Outbound signal (source=paid): Linked Co promoted a guide. Evidence: https://ads.fixture-letter.org/landing/');
    await putNote(client, orgId, 'note-distinct', '2026-11-12T13:00:00.000Z', 'Outbound signal (source=social): Linked Co posted. Evidence: https://social.fixture-letter.org/post/1');
    await putNote(client, orgId, 'note-keyed', '2026-11-11T13:00:00.000Z', 'Linked Co sponsored a livestream', 'outbound-signal:influencer:stream-1');
    await putNote(client, orgId, 'note-conference', '2026-11-11T14:00:00.000Z', 'Outbound signal (source=conference): Linked Co sponsored the event. Evidence: https://events.example/sponsors');
    await putNote(client, orgId, 'note-conference-keyed', '2026-11-11T15:00:00.000Z', 'Linked Co appeared on the exhibitor list.', 'conference:https://events.example/exhibitors');
    await putNote(client, orgId, 'note-funding', '2026-11-17T16:00:00.000Z', 'Funding signal: Linked Co raised capital. Evidence: https://news.example/capital Observed: 2026-11-10 Europe/Berlin.');
    await putNote(client, orgId, 'note-funding-keyed', '2026-11-11T17:00:00.000Z', 'Linked Co completed a round.', 'funding:https://news.example/round');
    await putNote(client, orgId, 'note-ordinary', '2026-11-12T14:00:00.000Z', 'Follow-up status: newsletter paid collab, silent');
    await putNote(client, orgId, 'note-ordinary-keyed', '2026-11-12T14:30:00.000Z', 'Follow-up note.', 'follow-up:https://news.example/other');
    await putNote(client, orgId, 'note-bad-source', '2026-11-12T15:00:00.000Z', 'Outbound signal (source=podcast): odd. Evidence: https://x.example/y');
  });
  after(async () => {
    await stopLocal();
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    delete process.env.LEADS_INTAKE_RATE_LIMIT;
  });

  const window = { from: '2026-11-10', before: '2026-11-17' };

  it('validates the window and source', async () => {
    assert.match(parseSignalQuery({ from: '2026-11-10' }) as string, /required/);
    assert.match(parseSignalQuery({ from: '2026-11-10', before: '2026-11-10' }) as string, /after from/);
    assert.match(parseSignalQuery({ from: '2026-01-01', before: '2026-11-10' }) as string, /at most/);
    assert.match(parseSignalQuery({ ...window, source: 'podcast' }) as string, /Unsupported source/);
    assert.match(parseSignalQuery({ ...window, limit: '0' }) as string, /limit/);
    assert.strictEqual((await signals({ from: '2026-11-10' })).status, 400);
  });

  it('uses Berlin days: from inclusive, before exclusive', async () => {
    const { body } = await signals({ ...window, source: 'newsletter' });
    const found = body.items.map((item: any) => item.nativeId);
    assert.ok(found.includes(ids.first), '23:30Z on the 9th is the 10th in Berlin');
    assert.ok(found.includes(ids.last), '22:59Z on the 16th is still the 16th in Berlin');
    assert.ok(!found.includes(ids.before));
    assert.ok(!found.includes(ids.after), '23:00Z on the 16th is the 17th, excluded by before');
    assert.strictEqual(body.coverage.window.timezone, 'Europe/Berlin');
  });

  it('filters by normalized source and returns every source without a filter', async () => {
    const all = (await signals(window)).body;
    assert.deepStrictEqual(Object.keys(all.coverage.bySource).sort(), ['conference', 'funding', 'influencer', 'newsletter', 'paid', 'social', 'unknown']);
    const paid = (await signals({ ...window, source: 'paid' })).body;
    assert.ok(paid.items.length > 0 && paid.items.every((item: any) => item.source === 'paid'));
    const influencer = (await signals({ ...window, source: 'influencer' })).body;
    assert.deepStrictEqual(influencer.items.map((item: any) => item.nativeId).sort(), [ids.influencer, 'note-keyed'].sort());
    assert.strictEqual((await signals({ ...window, source: 'podcast' })).status, 400);
  });

  it('selects documented conference and funding notes by marker or source key', async () => {
    const conference = (await signals({ ...window, source: 'conference' })).body;
    assert.deepStrictEqual(conference.items.map((item: any) => [item.nativeId, item.placement.url]), [
      ['note-conference', 'https://events.example/sponsors'],
      ['note-conference-keyed', 'https://events.example/exhibitors'],
    ]);
    const funding = (await signals({ ...window, source: 'funding' })).body;
    assert.deepStrictEqual(funding.items.map((item: any) => [item.nativeId, item.placement.url]), [
      ['note-funding', 'https://news.example/capital'],
      ['note-funding-keyed', 'https://news.example/round'],
    ]);
    assert.ok([...conference.items, ...funding.items].every((item) => item.missing.length === 0));
    assert.strictEqual(funding.items[0].observedDay, '2026-11-10');
    assert.strictEqual(funding.items[0].observedAtBasis, 'note.observedDate');
    assert.strictEqual(funding.items[1].observedAtBasis, 'note.createdAt');
    const following = (await signals({ from: '2026-11-17', before: '2026-11-24', source: 'funding' })).body;
    assert.ok(!following.items.some((item: any) => item.nativeId === 'note-funding'));
  });

  it('keeps linked and unlinked leads and does not guess a company', async () => {
    const { body } = await signals(window);
    const unlinked = body.items.find((item: any) => item.nativeId === ids.influencer);
    assert.deepStrictEqual(unlinked.company, { displayName: 'influencer.fixture-letter.org', organizationId: null, linked: false, linkedBy: null });
    const intakeRow = body.items.find((item: any) => item.nativeId === ids.first);
    assert.strictEqual(intakeRow.company.organizationId, null);
    assert.strictEqual(intakeRow.placement.newsletter, 'Fixture Letter');
    assert.strictEqual(intakeRow.observedAtBasis, 'newsletter.receivedAt');
    assert.ok(intakeRow.missing.length === 0);
    const noUrl = body.items.find((item: any) => item.nativeId === ids.last);
    assert.deepStrictEqual(noUrl.missing, ['placement.url']);
  });

  it('counts identical lead and legacy note evidence once but keeps distinct placements', async () => {
    const { body } = await signals({ ...window, source: 'paid' });
    // A distinct paid placement (another URL) stays; the note joins only the lead with the same landing URL.
    assert.strictEqual(body.items.length, 2);
    const merged = body.items.filter((item: any) => item.evidence.some((entry: any) => entry.kind === 'note'));
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].nativeId, ids.paidLinked);
    assert.deepStrictEqual(merged[0].evidence.map((entry: any) => entry.kind), ['lead', 'note']);
    assert.strictEqual(merged[0].company.organizationId, orgId);
    assert.strictEqual(body.coverage.mergedDuplicates, 1);
    const social = (await signals({ ...window, source: 'social' })).body;
    assert.deepStrictEqual(social.items.map((item: any) => item.id), ['note:note-distinct']);
  });

  it('reads only explicitly marked notes and reports missing metadata', async () => {
    const { body } = await signals(window);
    const noteIds = body.items.filter((item: any) => item.nativeType === 'note').map((item: any) => item.nativeId);
    assert.ok(!noteIds.includes('note-ordinary'));
    assert.ok(!noteIds.includes('note-ordinary-keyed'));
    const keyed = body.items.find((item: any) => item.nativeId === 'note-keyed');
    assert.strictEqual(keyed.source, 'influencer');
    assert.ok(keyed.missing.includes('evidence'));
    const odd = body.items.find((item: any) => item.nativeId === 'note-bad-source');
    assert.strictEqual(odd.source, null);
    assert.ok(odd.missing.some((entry: string) => entry.startsWith('source')));
    assert.ok(body.coverage.sources.notes.complete);
    assert.ok(body.coverage.withMissingMetadata >= 2);
  });

  it('pages with a bound cursor and reports completeness', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { status, body } = await signals({ ...window, limit: '2', ...(cursor ? { cursor } : {}) });
      assert.strictEqual(status, 200);
      assert.ok(body.items.length <= 2);
      assert.strictEqual(body.complete, !body.nextCursor);
      seen.push(...body.items.map((item: any) => item.id));
      cursor = body.nextCursor || undefined;
      pages += 1;
    } while (cursor);
    assert.ok(pages > 1);
    assert.strictEqual(new Set(seen).size, seen.length);
    const all = (await signals({ ...window, limit: '100' })).body;
    assert.deepStrictEqual(seen, all.items.map((item: any) => item.id));
    const first = (await signals({ ...window, limit: '1' })).body;
    assert.strictEqual((await signals({ ...window, source: 'paid', limit: '1', cursor: first.nextCursor })).status, 400);
  });

  it('lead list honors source (also as promotionSource) and rejects unsupported values', async () => {
    const list = async (query: Record<string, string>) => data(await invoke('GET', '/api/sponsor-crm/leads', undefined, { ...query, limit: '100' })).items.map((item: any) => item.id);
    const newsletterIds = await list({ source: 'newsletter' });
    assert.ok(newsletterIds.includes(ids.first) && !newsletterIds.includes(ids.paidLinked) && !newsletterIds.includes(ids.influencer));
    const paidIds = await list({ promotionSource: 'paid' });
    assert.deepStrictEqual(paidIds.sort(), [ids.paidLinked, ids.twin].sort());
    assert.strictEqual((await invoke('GET', '/api/sponsor-crm/leads', undefined, { source: 'podcast' })).statusCode, 400);
  });

  it('is read only', async () => {
    assert.strictEqual((await invoke('POST', '/api/sponsor-crm/signals', {})).statusCode, 405);
  });

  it('unit: marker parsing and merge rules', () => {
    const org: any = { id: 'o1', displayName: 'O' };
    assert.strictEqual(noteSignal({ id: 'n', body: 'plain note', createdAt: '2026-11-12T10:00:00Z' }, org), null);
    const note = noteSignal({ id: 'n', body: 'Outbound signal (source=paid): x. Evidence: https://a.example/p.', createdAt: '2026-11-12T10:00:00Z' }, org)!;
    assert.strictEqual(note.placement.url, 'https://a.example/p');
    const twin = { ...note, id: 'note:m', nativeId: 'm', evidence: [{ ...note.evidence[0], id: 'm' }] };
    assert.strictEqual(mergeSignals([note, twin]).merged, 1, 'same evidence recorded twice is one sighting');
    const other = noteSignal({ id: 'z', body: 'Outbound signal (source=paid): x. Evidence: https://a.example/q', createdAt: '2026-11-12T10:00:00Z' }, org)!;
    assert.strictEqual(mergeSignals([note, other]).merged, 0);
    // Two leads match the same note evidence: ambiguous, so nothing is merged or guessed.
    const lead = (id: string): any => ({ ...note, id: `lead:${id}`, nativeType: 'lead', nativeId: id, company: { displayName: 'L', organizationId: null, linked: false, linkedBy: null }, evidence: [{ kind: 'lead', id, text: '', url: note.placement.url }] });
    const result = mergeSignals([lead('a'), lead('b'), note]);
    assert.strictEqual(result.merged, 0);
    assert.strictEqual(result.signals.length, 3);
  });
});
