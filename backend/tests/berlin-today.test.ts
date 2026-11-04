import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { berlinToday, todayIn } from '../src/relativeDates';
import { berlinDate } from '../src/sponsorFinance/core';
import { berlinToday as crmBerlinToday } from '../src/crmWorkspace/berlin';
import { berlinToday as calendarBerlinToday } from '../src/calendar/ownerCalendarOverlay';
import { berlinToday as financeBerlinToday } from '../src/finance/service';
import { localDate } from '../src/podcast/publication';
import { handleSponsorNewsletterRoutes } from '../src/routes/sponsorNewsletters';
import { handleSponsorCrmRoutes } from '../src/routes/sponsorCrm';

describe('Berlin today consolidation (23:30 UTC)', () => {
  it('computes 2026-01-16 in Europe/Berlin at 2026-01-15T23:30:00Z across all backend exports', () => {
    const at2330Utc = new Date('2026-01-15T23:30:00Z');
    assert.equal(berlinToday(at2330Utc), '2026-01-16');
    assert.equal(berlinDate(at2330Utc), '2026-01-16');
    assert.equal(crmBerlinToday(at2330Utc), '2026-01-16');
    assert.equal(financeBerlinToday(at2330Utc), '2026-01-16');
    assert.equal(berlinDate, berlinToday);
    assert.equal(crmBerlinToday, berlinToday);
    assert.equal(calendarBerlinToday, berlinToday);
    assert.equal(financeBerlinToday, berlinToday);
  });

  it('uses Berlin day (2026-01-16, not UTC 2026-01-15) in sponsorNewsletters and sponsorCrm todayOf(event) at 23:30 UTC', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T23:30:00Z') });

    const client = {
      send: async () => ({
        Items: [
          {
            PK: 'NEWSLETTER#nl-1',
            SK: 'NEWSLETTER#nl-1',
            id: 'nl-1',
            name: 'Late Night Tech',
            slug: 'late-night-tech',
            subscriptionStatus: 'subscribed',
            expectedIntervalDays: 7,
            lastReceivedAt: '2026-01-04T10:00:00Z',
            senders: ['news@example.com'],
          },
          {
            PK: 'DEAL#deal-1',
            SK: 'DEAL#deal-1',
            id: 'deal-1',
            organizationId: 'org-1',
            title: 'Test Deal',
            status: 'proposal_sent',
            followUpAt: '2026-01-16',
          },
        ],
      }),
    } as unknown as DynamoDBDocumentClient;

    const nlRes = await handleSponsorNewsletterRoutes(
      '/api/sponsor-crm/newsletters/nl-1',
      'GET',
      {
        httpMethod: 'GET',
        path: '/api/sponsor-crm/newsletters/nl-1',
        headers: {},
        queryStringParameters: null,
        body: null,
      },
      client,
    );
    assert.equal(nlRes.statusCode, 200);
    // Grace for 7d interval is 11d: from 2026-01-04 to 2026-01-15 (UTC) is 11d (current),
    // whereas to 2026-01-16 (Berlin) is 12d (overdue).
    assert.equal(JSON.parse(nlRes.body).health, 'overdue');

    const crmRes = await handleSponsorCrmRoutes(
      '/api/sponsor-crm/cold',
      'GET',
      {
        httpMethod: 'GET',
        path: '/api/sponsor-crm/cold',
        headers: {},
        queryStringParameters: null,
        body: null,
      },
      client,
    );
    assert.equal(crmRes.statusCode, 200);
    assert.equal(JSON.parse(crmRes.body).today, '2026-01-16');
  });

  it('routes every instant-to-date consumer through todayIn across DST edges (96e9567a follow-up)', () => {
    // CEST (+02:00) late-summer instant and CET (+01:00) winter instant: the
    // podcast publication localDate and the calendar invite date must match
    // relativeDates.todayIn exactly, including the day flip at 22:00 UTC in
    // summer (00:00 next day in Berlin) and 23:00 UTC in winter.
    for (const [utcIso, expected] of [
      ['2026-08-17T21:30:00Z', '2026-08-17'],
      ['2026-08-17T22:30:00Z', '2026-08-18'],
      ['2026-01-15T22:30:00Z', '2026-01-15'],
      ['2026-01-15T23:30:00Z', '2026-01-16'],
    ] as const) {
      const at = new Date(utcIso);
      assert.equal(todayIn('Europe/Berlin', at), expected, utcIso);
      assert.equal(localDate(utcIso, 'Europe/Berlin'), expected, utcIso);
      assert.equal(berlinToday(at), expected, utcIso);
    }
    // Other zones keep their own wall clock through the same helper.
    assert.equal(localDate('2026-08-17T21:30:00Z', 'America/New_York'), '2026-08-17');
    assert.equal(todayIn('America/New_York', new Date('2026-08-17T21:30:00Z')), '2026-08-17');
  });
});
