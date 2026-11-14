import assert from 'node:assert/strict';
import test from 'node:test';
import { listAcademyLeads, normalizeAcademyLead, summarizeAcademyLeads } from '../src/academyLeads/service';

test('normalizeAcademyLead prefers first_utm/last_utm snapshots over legacy top-level fields', () => {
  const lead = normalizeAcademyLead({
    created_at: '2026-11-14T08:00:00+00:00',
    email: 'ada@example.org',
    track: 'agentic-engineering',
    utm_source: 'stale',
    first_utm: {},
    last_utm: { utm_source: 'meta', utm_medium: 'paid-social' },
    answers: { location: 'berlin' },
    is_test: false,
  });
  assert.equal(lead.utm_source, '');
  assert.equal(lead.last_utm_source, 'meta');
  assert.equal(lead.last_utm_medium, 'paid-social');
  assert.deepEqual(lead.answers, { location: 'berlin' });
});

test('listAcademyLeads hides is_test rows by default and computes track + utm summaries', async () => {
  const items = [
    {
      created_at: '2026-11-14T08:00:00+00:00',
      email: 'a@real.org',
      track: 'agentic-engineering',
      first_utm: { utm_source: 'meta', utm_medium: 'paid-social', utm_content: 'seats' },
      is_test: false,
    },
    {
      created_at: '2026-11-14T08:05:00+0+0:00',
      email: 'b@real.org',
      track: 'ai-engineering',
      first_utm: { utm_source: 'meta', utm_medium: 'paid-social', utm_content: 'seats' },
      is_test: false,
    },
    {
      created_at: '2026-11-14T08:10:00+00:00',
      email: 'a@real.org',
      track: 'ai-engineering',
      first_utm: { utm_source: 'meta', utm_medium: 'paid-social', utm_content: 'seats' },
      is_test: false,
    },
    {
      created_at: '2026-11-14T08:15:00+00:00',
      email: 'dev+academytest@dtcdev.click',
      track: 'agentic-engineering',
      first_utm: { utm_source: 'devtest', utm_content: 'live' },
      is_test: true,
    },
  ];

  const hidden = await listAcademyLeads({ scanItems: async () => items });
  assert.equal(hidden.leads.length, 3);
  assert.equal(hidden.summary.testCount, 1);
  assert.equal(hidden.summary.byTrack['agentic-engineering'], 1);
  assert.equal(hidden.summary.byTrack['ai-engineering'], 2);
  assert.deepEqual(hidden.summary.firstChoice, { 'agentic only': 0, 'AI only': 1, both: 1 });
  assert.deepEqual(hidden.summary.byUtm, [
    { utm_source: 'meta', utm_content: 'seats', agentic: 1, ai: 2, other: 0, total: 3 },
  ]);

  const withTests = await listAcademyLeads({ includeTests: true, scanItems: async () => items });
  assert.equal(withTests.leads.length, 4);
  assert.equal(withTests.summary.byTrack['agentic-engineering'], 2);
});

test('summarizeAcademyLeads handles empty list', () => {
  const summary = summarizeAcademyLeads([], 0);
  assert.equal(summary.total, 0);
  assert.deepEqual(summary.byUtm, []);
});
