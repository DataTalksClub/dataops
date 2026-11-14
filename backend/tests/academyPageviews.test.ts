import assert from 'node:assert/strict';
import test from 'node:test';
import { listAcademyPageviews, normalizePageview } from '../src/academyLeads/pageviews';

test('normalizePageview parses 5-part and legacy 4-part sort keys', () => {
  const a = normalizePageview({ pk: 'PV#2026-11-14', sk: '/agentic-engineering|meta|paid|c1|seats', count: 3 })!;
  assert.deepEqual([a.date, a.page, a.track, a.utm_medium, a.count], ['2026-11-14', '/agentic-engineering', 'agentic-engineering', 'paid', 3]);
  const b = normalizePageview({ pk: 'PV#2026-11-13', sk: '/ai-engineering|meta|c1|seats', count: 2 })!;
  assert.equal(b.utm_medium, '-');
  assert.equal(b.utm_campaign, 'c1');
  assert.equal(normalizePageview({ pk: 'SIGNUP#x', sk: 'y' }), null);
});

test('listAcademyPageviews computes conversion per track and hides test traffic', async () => {
  const res = await listAcademyPageviews({
    scanPageviews: async () => [
      { pk: 'PV#2026-11-14', sk: '/agentic-engineering|meta|paid|c|x', count: 10 },
      { pk: 'PV#2026-11-14', sk: '/ai-engineering|-|-|-|-', count: 4 },
      { pk: 'PV#2026-11-14', sk: '/ai-engineering|test|-|-|-', count: 99 },
    ],
    scanSignups: async () => [
      { created_at: '2026-11-14T08:00:00+00:00', email: 'a@real.org', track: 'agentic-engineering', is_test: false },
      { created_at: '2026-11-14T08:01:00+00:00', email: 'b@real.org', track: 'agentic-engineering', is_test: false },
      { created_at: '2026-11-14T08:02:00+00:00', email: 'c@example.com', track: 'ai-engineering', is_test: true },
    ],
  });
  assert.equal(res.summary.visits, 14);
  assert.equal(res.summary.testVisits, 99);
  assert.deepEqual(res.summary.byTrack['agentic-engineering'], { visits: 10, signups: 2, conversion: 0.2 });
  assert.deepEqual(res.summary.byTrack['ai-engineering'], { visits: 4, signups: 0, conversion: 0 });
});
