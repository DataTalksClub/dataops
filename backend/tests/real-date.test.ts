import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from '../src/router';
import { validateRows } from '../src/reconcile/service';
import { realDate } from '../src/sponsorCrm/model';

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
});
