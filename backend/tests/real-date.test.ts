import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from '../src/router';
import { validateRows } from '../src/reconcile/service';
import { realDate } from '../src/sponsorCrm/model';
import { isCalendarDate, resolveTaskDate } from '../src/relativeDates';

const dummyClient = {
  send: async () => ({ Item: { id: 'op-1', email: 'op@datatalks.club', name: 'Op', role: 'operator' } }),
} as unknown as DynamoDBDocumentClient;

function invoke(path: string, method = 'GET', query: Record<string, string> = {}, body?: unknown) {
  process.env.NODE_ENV = 'test';
  process.env.SKIP_AUTH = 'true';
  return route(
    {
      httpMethod: method,
      path,
      headers: { 'x-user-id': 'op-1' },
      queryStringParameters: query,
      body: body === undefined ? null : JSON.stringify(body),
    } as never,
    dummyClient,
  );
}

describe('realDate consolidation (month 00/13 returns 400, not 500/RangeError)', () => {
  it('validates calendar dates in sponsorCrm/model.realDate without throwing on out-of-range months', () => {
    assert.equal(realDate('2026-01-15'), true);
    assert.equal(realDate('2024-02-29'), true);
    assert.equal(realDate('2026-02-29'), false);
    assert.equal(realDate('2026-00-01'), false);
    assert.equal(realDate('2026-13-01'), false);
    assert.equal(realDate('not-a-date'), false);
  });

  for (const invalid of ['2026-00-01', '2026-13-01']) {
    it(`returns 400 (not 500) on GET /api/newsletter-issues with ${invalid}`, async () => {
      const res = await invoke('/api/newsletter-issues', 'GET', { from: invalid, to: '2026-12-31' });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Invalid range/i);
    });

    it(`returns 400 (not 500) on GET /api/calendar-holds with ${invalid}`, async () => {
      const res = await invoke('/api/calendar-holds', 'GET', { from: invalid, to: '2026-12-31' });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Invalid range/i);
    });

    it(`returns 400 (not 500) on GET /api/calendar-items with ${invalid}`, async () => {
      const res = await invoke('/api/calendar-items', 'GET', { from: invalid, to: '2026-12-31' });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /Invalid or unbounded range/i);
    });

    it(`rejects the removed caller-row statement API with ${invalid}`, async () => {
      assert.deepEqual(
        validateRows([{ date: invalid, amount: '10.00', currency: 'EUR', counterparty: 'Vendor' }]),
        ['row 0 date'],
      );
      const res = await invoke('/api/reconcile/statements', 'POST', {}, {
        account: 'revolut',
        period: '2026-10',
        rows: [{ date: invalid, amount: '10.00', currency: 'EUR', counterparty: 'Vendor' }],
      });
      assert.equal(res.statusCode, 404);
    });
  }

  it('isCalendarDate stays stricter than realDate for four-digit years below 0100 (documented divergence)', () => {
    // Both agree on every realistic input, including impossible calendar days.
    for (const value of ['2026-01-15', '2024-02-29', '2026-02-30', '2026-13-01', 'not-a-date']) {
      assert.equal(isCalendarDate(value), realDate(value), value);
    }
    // The one deliberate divergence: realDate's parse-based roundtrip accepts
    // years 0000-0099 while isCalendarDate's Date.UTC roundtrip rejects them,
    // so relative task-date resolution never lands on a year-0099 date.
    assert.equal(realDate('0099-01-01'), true);
    assert.equal(isCalendarDate('0099-01-01'), false);
    assert.equal(resolveTaskDate('0099-01-01', '2026-11-04'), null);
  });
});
