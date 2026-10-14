import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { CrmRecord } from '../src/db/sponsorCrm';
import { leadListPage, parseLeadListQuery, type LeadListFilters } from '../src/routes/sponsorLeads';

function lead(id: string, name: string, newsletter: string, receivedAt: string, status = 'new', url = ''): CrmRecord {
  return {
    id,
    version: 1,
    status,
    messageId: `msg-${id}`,
    newsletter: { name: newsletter, sender: 'news@example.test', subject: `${newsletter} issue`, receivedAt },
    sponsor: { name, url, normalizedName: name.toLowerCase(), normalizedUrl: '' },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  } as unknown as CrmRecord;
}

function filters(query: Record<string, string> = {}): LeadListFilters {
  const parsed = parseLeadListQuery(query);
  assert.strictEqual(typeof parsed, 'object');
  return parsed as LeadListFilters;
}

const LEADS = [
  lead('a', 'Acme', 'Data Weekly', '2026-10-01T08:00:00Z'),
  lead('b', 'Beta', 'Data Weekly', '2026-10-03T08:00:00Z', 'ignored'),
  lead('c', 'Acme', 'ML Digest', '2026-10-05T08:00:00Z', 'new', 'https://acme.example'),
  lead('d', 'Gamma', 'ML Digest', '2026-10-05T08:00:00Z'),
  lead('e', 'Acme', 'Data Weekly', '2026-10-07T08:00:00Z', 'triaged'),
];

const ids = (page: Record<string, unknown>) => (page.items as Array<{ id: string }>).map((item) => item.id);

describe('sponsor lead list', () => {
  it('lists newest sighting first with a total order', () => {
    assert.deepStrictEqual(ids(leadListPage(LEADS, filters())), ['e', 'd', 'c', 'b', 'a']);
  });

  it('pages with a keyset cursor that survives a status change between pages', () => {
    const first = leadListPage(LEADS, filters({ status: 'new', limit: '1' }));
    assert.deepStrictEqual(ids(first), ['d']);
    // The operator ignores d after reading page one: it leaves the filter,
    // yet the next page still starts right after it.
    const changed = LEADS.map((item) => (item.id === 'd' ? { ...item, status: 'ignored' } : item)) as CrmRecord[];
    const second = leadListPage(changed, filters({ status: 'new', limit: '1', cursor: String(first.nextCursor) }));
    assert.deepStrictEqual(ids(second), ['c']);
    const third = leadListPage(changed, filters({ status: 'new', limit: '1', cursor: String(second.nextCursor) }));
    assert.deepStrictEqual(ids(third), ['a']);
    assert.strictEqual(third.nextCursor, null);
  });

  it('filters by newsletter, sponsor and search, and lists every newsletter for the picker', () => {
    const byNewsletter = leadListPage(LEADS, filters({ newsletter: 'ML Digest' }));
    assert.deepStrictEqual(ids(byNewsletter), ['d', 'c']);
    assert.deepStrictEqual(byNewsletter.newsletters, ['Data Weekly', 'ML Digest']);
    assert.deepStrictEqual(ids(leadListPage(LEADS, filters({ sponsor: ' ACME ' }))), ['e', 'c', 'a']);
    assert.deepStrictEqual(ids(leadListPage(LEADS, filters({ search: 'acme.example' }))), ['c']);
    assert.deepStrictEqual(ids(leadListPage(LEADS, filters({ search: 'digest', status: 'new' }))), ['d', 'c']);
  });

  it('groups sightings by sponsor, newest sponsor first', () => {
    const grouped = leadListPage(LEADS, filters({ group: 'sponsor' }));
    assert.deepStrictEqual(grouped.items, [
      { key: 'acme', name: 'Acme', url: 'https://acme.example', latestAt: '2026-10-07T08:00:00Z', sightings: 3, newsletters: ['Data Weekly', 'ML Digest'] },
      { key: 'gamma', name: 'Gamma', url: '', latestAt: '2026-10-05T08:00:00Z', sightings: 1, newsletters: ['ML Digest'] },
      { key: 'beta', name: 'Beta', url: '', latestAt: '2026-10-03T08:00:00Z', sightings: 1, newsletters: ['Data Weekly'] },
    ]);
    const newOnly = leadListPage(LEADS, filters({ group: 'sponsor', status: 'new', limit: '1' }));
    // Gamma and Acme were both last seen on 10-05; the key breaks the tie.
    assert.deepStrictEqual((newOnly.items as Array<{ key: string; sightings: number }>).map((g) => [g.key, g.sightings]), [['gamma', 1]]);
    const next = leadListPage(LEADS, filters({ group: 'sponsor', status: 'new', limit: '1', cursor: String(newOnly.nextCursor) }));
    assert.deepStrictEqual((next.items as Array<{ key: string; sightings: number }>).map((g) => [g.key, g.sightings]), [['acme', 2]]);
    assert.strictEqual(next.nextCursor, null);
  });

  it('rejects malformed queries', () => {
    for (const query of [{ cursor: 'nope' }, { limit: '0' }, { status: 'contacted' }, { group: 'company' }, { search: 'x'.repeat(201) }]) {
      assert.strictEqual(typeof parseLeadListQuery(query), 'string', JSON.stringify(query));
    }
  });
});
