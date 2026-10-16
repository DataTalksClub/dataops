import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listFinanceCandidates } from '../src/sponsorFinance/repository';

const payments = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `payment-${String(index).padStart(4, '0')}`, amount: '10', currency: 'EUR',
  updatedAt: '2026-10-01T00:00:00Z', transactionDate: '2026-10-01',
}));

describe('finance candidate claim reads', () => {
  it('returns a page from 1,000 eligible sources without exhausting the claim-read budget', async () => {
    const originalNow = Date.now;
    let now = 0, gets = 0, batches = 0;
    Date.now = () => now;
    const client = { send: async (command: { constructor: { name: string }; input: any }) => {
      if (command.constructor.name === 'ScanCommand') {
        return { Items: payments(1_000).reverse(), ScannedCount: 1_000 };
      }
      now += 10; // One remote round trip, independent of its batch size.
      if (command.constructor.name === 'GetCommand') { gets++; return {}; }
      assert.equal(command.constructor.name, 'BatchGetCommand');
      batches++;
      const request = Object.values(command.input.RequestItems)[0] as any;
      assert.equal(request.ConsistentRead, true);
      assert.ok(request.Keys.length <= 100);
      return { Responses: {} };
    } };
    try {
      const first = await listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 25 });
      assert.equal(first.items.length, 25);
      assert.equal(first.items[0].id, 'payment-0000');
      assert.equal(first.items[24].id, 'payment-0024');
      assert.ok(first.nextCursor);
      assert.equal(gets, 0);
      assert.equal(batches, 1);
    } finally { Date.now = originalNow; }
  });

  it('passes claimed batches and preserves ordered, nonduplicating cursor pages', async () => {
    let batches = 0;
    const sources = payments(230).reverse();
    const client = { send: async (command: { constructor: { name: string }; input: any }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: sources, ScannedCount: sources.length };
      assert.equal(command.constructor.name, 'BatchGetCommand');
      batches++;
      const [table, request] = Object.entries(command.input.RequestItems)[0] as [string, any];
      return { Responses: { [table]: request.Keys.filter((key: any) => Number(key.PK.slice(-4)) < 200).reverse() } };
    } };
    const first = await listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 25 });
    assert.equal(first.items[0].id, 'payment-0200');
    assert.equal(first.items[24].id, 'payment-0224');
    assert.equal(batches, 3);
    const second = await listFinanceCandidates(client as never, {
      kind: 'transaction', currency: 'EUR', limit: 25, cursor: first.nextCursor!,
    });
    assert.deepEqual(second.items.map(item => item.id), payments(230).slice(225).map(item => item.id));
    assert.equal(second.nextCursor, null);
  });

  it('retries only unprocessed keys and retains already observed claims', async () => {
    let calls = 0;
    let pending: any;
    const client = { send: async (command: { constructor: { name: string }; input: any }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: payments(3), ScannedCount: 3 };
      assert.equal(command.constructor.name, 'BatchGetCommand');
      const [table, request] = Object.entries(command.input.RequestItems)[0] as [string, any];
      calls++;
      if (calls === 1) {
        pending = request.Keys[0];
        return { Responses: { [table]: [request.Keys[1]] }, UnprocessedKeys: { [table]: { Keys: [pending] } } };
      }
      assert.deepEqual(request.Keys, [pending]);
      assert.equal(request.ConsistentRead, true);
      return { Responses: { [table]: [pending] } };
    } };
    const result = await listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 2 });
    assert.deepEqual(result.items.map(item => item.id), ['payment-0002']);
    assert.equal(result.nextCursor, null);
    assert.equal(calls, 2);
  });

  it('fails discovery instead of returning partial results when claim reads remain unprocessed', async () => {
    let calls = 0;
    const client = { send: async (command: { constructor: { name: string }; input: any }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: payments(3), ScannedCount: 3 };
      calls++;
      return { UnprocessedKeys: command.input.RequestItems };
    } };
    await assert.rejects(
      () => listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 2 }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
    assert.equal(calls, 3);
  });

  it('propagates claim-storage failures rather than silently treating sources as ineligible', async () => {
    const failure = new Error('synthetic storage failure');
    const client = { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: payments(3), ScannedCount: 3 };
      throw failure;
    } };
    await assert.rejects(
      () => listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 2 }),
      (error: unknown) => error === failure,
    );
  });

  it('rejects a claim batch that finishes after the discovery deadline', async () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;
    const client = { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: payments(3), ScannedCount: 3 };
      now = 2_001;
      return { Responses: {} };
    } };
    try {
      await assert.rejects(
        () => listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 2 }),
        (error: Error & { statusCode?: number }) => error.statusCode === 503,
      );
    } finally { Date.now = originalNow; }
  });

  it('excludes malformed or other-currency payments before reading claims', async () => {
    const sources = payments(3);
    sources[0].currency = 'USD';
    sources[1].amount = '-10';
    const client = { send: async (command: { constructor: { name: string }; input: any }) => {
      if (command.constructor.name === 'ScanCommand') return { Items: sources, ScannedCount: 3 };
      const request = Object.values(command.input.RequestItems)[0] as any;
      assert.equal(request.Keys.length, 1);
      assert.match(request.Keys[0].PK, /payment-0002$/);
      return { Responses: {} };
    } };
    const result = await listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 2 });
    assert.deepEqual(result.items.map(item => item.id), ['payment-0002']);
    assert.equal(result.nextCursor, null);
  });
});
