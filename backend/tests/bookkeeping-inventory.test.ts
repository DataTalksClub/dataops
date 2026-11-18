import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { putBookkeepingItem, putBookkeepingTransactionWithItems, sweepInventory, updateBookkeepingTransaction, getBookkeepingItem } from '../src/db/bookkeeping';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  classifyPhysicalItem,
  deriveInventoryItems,
  inventoryItemId,
} from '../src/finance/inventory';

const invoke = (method: string, path: string, body?: unknown) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, {});

const transaction = (overrides: Record<string, unknown>) => ({
  id: 'inv-fixture-tx',
  transactionDate: '2026-03-19',
  paidDate: '2026-03-19',
  counterparty: 'Synthetic Vendor',
  description: 'Synthetic service',
  amount: '10.00',
  currency: 'EUR',
  entryType: 'expense',
  sourceType: 'manual',
  ...overrides,
});

describe('inventory derivation', () => {
  it('classifies purchase descriptions into inventory types', () => {
    assert.equal(classifyPhysicalItem('Laptop'), 'computer');
    assert.equal(classifyPhysicalItem('Microsoft Surface Pro | Copilot+ PC'), 'computer');
    assert.equal(classifyPhysicalItem('Standing desk'), 'furniture');
    assert.equal(classifyPhysicalItem('Chair (Steelcase Series 2)'), 'furniture');
    assert.equal(classifyPhysicalItem('Apple Airpods'), 'audio');
    assert.equal(classifyPhysicalItem('AGPTEK Lavalier Microphone'), 'audio');
    assert.equal(classifyPhysicalItem('Google Pixel Phone'), 'phone');
    assert.equal(classifyPhysicalItem('Mobile - serial number 35275718699270'), 'phone');
    assert.equal(classifyPhysicalItem('CSL HDMI cable'), 'accessory');
    assert.equal(classifyPhysicalItem('LENCENT power strip'), 'accessory');
    assert.equal(classifyPhysicalItem('Cudy WU650 USB Wi-Fi adapter'), 'accessory');
    assert.equal(classifyPhysicalItem('Standard plan (75,000 contacts)'), null);
    assert.equal(classifyPhysicalItem('ChatGPT Plus Subscription'), null);
    assert.equal(classifyPhysicalItem('Flights On Booking.com'), null);
    assert.equal(classifyPhysicalItem('Dedicated Server and Storage'), null);
  });

  it('derives one candidate per physical expense from fromYear on', () => {
    const items = deriveInventoryItems([
      transaction({ description: 'Laptop', amount: '1813.58' }),
      transaction({ description: 'Mailchimp Standard plan', transactionDate: '2021-11-19', paidDate: '2021-11-19' }),
      transaction({ description: 'Zoom Pro renewal', entryType: 'income' }),
      transaction({ description: 'Headphones', amount: '107.99', transactionDate: '2022-01-07', paidDate: '2022-01-07' }),
      transaction({ description: 'Old laptop', voidStatus: 'voided' }),
      transaction({ description: 'Used phone abroad', amount: '172.38', currency: 'USD', amountEur: '160.00', transactionDate: '2023-03-24', paidDate: '2023-03-24' }),
    ]);
    assert.deepEqual(items.map((item) => [item.name, item.type, item.amountEur]), [
      ['Laptop', 'computer', '1813.58'],
      ['Headphones', 'audio', '107.99'],
      ['Used phone abroad', 'phone', '160.00'],
    ]);
    assert.ok(items.every((item) => item.acquisitionDate));
  });

  it('splits one payment into per-allocation candidates when the invoice rows name physical items', () => {
    const items = deriveInventoryItems([
      transaction({
        description: 'Amzn Mktp De*nk50845b4',
        amount: '420.84',
        allocations: [
          { id: 'alloc-1', description: 'Lenovo ThinkCentre M920q', amount: '399.00', currency: 'EUR', amountEur: '399.00' },
          { id: 'alloc-2', description: 'UGREEN video capture card', amount: '14.99', currency: 'EUR', amountEur: '14.99' },
          { id: 'alloc-3', description: 'CSL HDMI cable', amount: '6.85', currency: 'EUR', amountEur: '6.85' },
        ],
      }),
    ]);
    assert.deepEqual(items.map((item) => [item.allocationId, item.name, item.type]), [
      ['alloc-1', 'Lenovo ThinkCentre M920q', 'computer'],
      ['alloc-2', 'UGREEN video capture card', 'accessory'],
      ['alloc-3', 'CSL HDMI cable', 'accessory'],
    ]);
    // No transaction-level duplicate when allocations matched.
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.transactionId));
  });

  it('derives stable ids from the transaction and allocation reference', () => {
    assert.equal(inventoryItemId('tx-1'), inventoryItemId('tx-1'));
    assert.notEqual(inventoryItemId('tx-1'), inventoryItemId('tx-2'));
    assert.notEqual(inventoryItemId('tx-1'), inventoryItemId('tx-1', 'alloc-1'));
  });
});

describe('inventory API', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(stopLocal);

  it('sweeps physical purchases from the ledger, idempotently', async () => {
    await putBookkeepingItem(client, 'bookkeeping', { ...transaction({ description: 'Laptop', amount: '1813.58' }), id: 'inv-tx-laptop' });
    await putBookkeepingItem(client, 'bookkeeping', { ...transaction({ description: 'Mailchimp Standard plan' }), id: 'inv-tx-subscription' });
    await putBookkeepingItem(client, 'bookkeeping', { ...transaction({
      description: 'Amzn Mktp De*nk50845b4', amount: '420.84',
      allocations: [
        { id: 'alloc-1', description: 'Lenovo ThinkCentre M920q', amount: '399.00', currency: 'EUR', amountEur: '399.00' },
        { id: 'alloc-2', description: 'UGREEN video capture card', amount: '14.99', currency: 'EUR', amountEur: '14.99' },
      ],
    }), id: 'inv-tx-split' });

    const first = await sweepInventory(client);
    assert.equal(first.matched, 3);
    assert.equal(first.created.length, 3);
    const names = first.created.map((item) => String(item.name)).sort();
    assert.deepEqual(names, ['Laptop', 'Lenovo ThinkCentre M920q', 'UGREEN video capture card']);
    assert.ok(first.created.every((item) => item.status === 'in-use' && item.usage === 'active'));

    const again = await sweepInventory(client);
    assert.equal(again.matched, 0);
    assert.equal(again.created.length, 0);

    const swept = JSON.parse((await invoke('POST', '/api/bookkeeping/inventory/sweep', {})).body);
    assert.equal(swept.created, 0);
    assert.deepEqual(swept.items, []);
    const stored = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    assert.equal(stored.items.length, 3);
    assert.ok(stored.items.every((item: any) => item.transactionId && item.acquisitionDate));
  });

  it('exposes the ledger record each item was derived from', async () => {
    const listed = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    const laptop = listed.items.find((item: any) => item.name === 'Laptop');
    assert.deepEqual(laptop.source, {
      transactionId: 'inv-tx-laptop',
      description: 'Laptop',
      counterparty: 'Synthetic Vendor',
      date: '2026-03-19',
      amount: '1813.58',
      currency: 'EUR',
      amountEur: '1813.58',
    });
    const allocationItem = listed.items.find((item: any) => item.allocationId === 'alloc-1');
    assert.equal(allocationItem.source.allocationId, 'alloc-1');
    assert.equal(allocationItem.source.description, 'Lenovo ThinkCentre M920q');
    assert.equal(allocationItem.source.amount, '399.00');
  });

  it('rejects invalid edits and keeps ledger-seeded fields read-only', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'Laptop');
    const rejected = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { type: 'vehicle' });
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(JSON.parse(rejected.body).fields, ['type']);
    // Status follows the disposal records; direct edits are rejected.
    const statusPut = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { status: 'disposed' });
    assert.equal(statusPut.statusCode, 400);
    assert.deepEqual(JSON.parse(statusPut.body).fields, ['status']);
    const returnedDatePut = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { returnedDate: '2027-01-01' });
    assert.equal(returnedDatePut.statusCode, 400);
    assert.deepEqual(JSON.parse(returnedDatePut.body).fields, ['returnedDate']);
    const usagePut = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { usage: 'sometimes' });
    assert.equal(usagePut.statusCode, 400);
    assert.deepEqual(JSON.parse(usagePut.body).fields, ['usage']);
    // Ledger-seeded fields are not editable; naming none is a read-back.
    const noop = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { amount: '1.00' });
    assert.equal(noop.statusCode, 200);
    assert.equal(JSON.parse(noop.body).updatedAt, item.updatedAt);
  });

  it('records a sale as a disposal with proceeds and removes it again', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'Laptop');
    const noProceeds = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { disposal: { kind: 'sold', date: '2027-01-15' } });
    assert.equal(noProceeds.statusCode, 400);
    assert.deepEqual(JSON.parse(noProceeds.body).fields, ['disposal.proceeds']);
    const unknownKind = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { disposal: { kind: 'scrapped', date: '2027-01-15' } });
    assert.equal(unknownKind.statusCode, 400);
    assert.deepEqual(JSON.parse(unknownKind.body).fields, ['disposal.kind']);

    const sold = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      disposal: { kind: 'sold', date: '2027-01-15', proceeds: '250', notes: 'eBay' },
    })).body);
    assert.equal(sold.status, 'disposed');
    assert.equal(sold.disposedDate, '2027-01-15');
    assert.equal(sold.disposals.length, 1);
    assert.equal(sold.disposals[0].kind, 'sold');
    assert.equal(sold.disposals[0].proceeds, '250');
    assert.equal(sold.disposals[0].currency, 'EUR');
    assert.equal(sold.disposals[0].notes, 'eBay');
    assert.ok(sold.disposals[0].id);
    // The response still carries the ledger record.
    assert.equal(sold.source.transactionId, 'inv-tx-laptop');

    const missing = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { removeDisposalId: 'no-such-record' });
    assert.equal(missing.statusCode, 404);
    const restored = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      removeDisposalId: sold.disposals[0].id,
    })).body);
    assert.equal(restored.status, 'in-use');
    assert.equal(restored.disposedDate, undefined);
    assert.deepEqual(restored.disposals, []);
    assert.ok(restored.updatedAt > sold.updatedAt);
  });

  it('records a decommission without proceeds and keeps the latest disposed date', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'UGREEN video capture card');
    const scrapped = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      disposal: { kind: 'decommissioned', date: '2027-02-01' },
    })).body);
    assert.equal(scrapped.status, 'disposed');
    assert.equal(scrapped.disposedDate, '2027-02-01');
    assert.equal(scrapped.disposals.length, 1);
    assert.equal(scrapped.disposals[0].kind, 'decommissioned');
    assert.equal(scrapped.disposals[0].proceeds, undefined);

    const later = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      disposal: { kind: 'decommissioned', date: '2027-04-10' },
    })).body);
    assert.equal(later.disposedDate, '2027-04-10');
    assert.equal(later.disposals.length, 2);
  });

  it('records a return, and a later sale takes over the status', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'Lenovo ThinkCentre M920q');
    const returned = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      disposal: { kind: 'returned', date: '2026-12-01', notes: 'refund received' },
    })).body);
    assert.equal(returned.status, 'returned');
    assert.equal(returned.returnedDate, '2026-12-01');
    assert.equal(returned.disposedDate, undefined);
    assert.equal(returned.disposals[0].kind, 'returned');
    assert.equal(returned.disposals[0].proceeds, undefined);

    const sold = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      disposal: { kind: 'sold', date: '2027-01-15', proceeds: '100' },
    })).body);
    assert.equal(sold.status, 'disposed');
    assert.equal(sold.disposedDate, '2027-01-15');
    assert.equal(sold.returnedDate, undefined);
    assert.equal(sold.disposals.length, 2);
  });

  it('tracks whether an item is actively used', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'Laptop');
    const idle = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { usage: 'idle' })).body);
    assert.equal(idle.usage, 'idle');
    assert.equal(idle.status, 'in-use');
    const active = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { usage: 'active' })).body);
    assert.equal(active.usage, 'active');
  });

  it('keeps pictures on an item', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items.find((candidate: any) => candidate.name === 'Laptop');
    const bad = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { addImage: { url: 'not-a-url' } });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(JSON.parse(bad.body).fields, ['addImage.url']);

    const first = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      addImage: { url: 'https://m.media-amazon.com/images/front.jpg', caption: 'front' },
    })).body);
    assert.equal(first.images.length, 1);
    assert.equal(first.images[0].url, 'https://m.media-amazon.com/images/front.jpg');
    assert.equal(first.images[0].caption, 'front');

    const second = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      addImage: { url: 'https://example.com/back.jpg' },
    })).body);
    assert.equal(second.images.length, 2);

    const removed = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, {
      removeImageUrl: 'https://m.media-amazon.com/images/front.jpg',
    })).body);
    assert.equal(removed.images.length, 1);
    assert.equal(removed.images[0].url, 'https://example.com/back.jpg');
  });

  it('records items by hand from an invoice and splits one payment into several', async () => {
    await putBookkeepingTransactionWithItems(
      client,
      { ...transaction({ description: 'Headphones and webcam', amount: '150.00' }), id: 'inv-tx-duo' },
      [],
    );
    // The automatic transaction-level item exists, so hand-recording is refused.
    const denied = await invoke('POST', '/api/bookkeeping/inventory/items', { transactionId: 'inv-tx-duo' });
    assert.equal(denied.statusCode, 409);

    const unknown = await invoke('POST', '/api/bookkeeping/inventory/items', { transactionId: 'inv-tx-missing' });
    assert.equal(unknown.statusCode, 404);
    const badType = await invoke('POST', '/api/bookkeeping/inventory/items', { transactionId: 'inv-tx-duo', name: 'X', type: 'vehicle' });
    assert.equal(badType.statusCode, 400);

    // Remove the automatic item, then record the two real items it stands for.
    const listed = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    const automatic = listed.items.find((candidate: any) => candidate.transactionId === 'inv-tx-duo');
    const removed = await invoke('DELETE', `/api/bookkeeping/inventory/${automatic.id}`);
    assert.equal(removed.statusCode, 204);

    const one = JSON.parse((await invoke('POST', '/api/bookkeeping/inventory/items', {
      transactionId: 'inv-tx-duo', name: 'Sennheiser HD 450BT', type: 'audio',
    })).body);
    assert.equal(one.manual, true);
    assert.equal(one.status, 'in-use');
    assert.equal(one.usage, 'active');
    assert.equal(one.source.transactionId, 'inv-tx-duo');
    assert.equal(one.source.amount, '150.00');
    assert.equal(one.amount, '150.00');
    const two = JSON.parse((await invoke('POST', '/api/bookkeeping/inventory/items', {
      transactionId: 'inv-tx-duo', name: 'Logitech C920', type: 'accessory', notes: 'studio camera',
    })).body);
    assert.equal(two.notes, 'studio camera');
    assert.notEqual(one.id, two.id);

    // Both items share the invoice, and the sweep never re-adds the automatic one.
    const after = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    const duo = after.items.filter((candidate: any) => candidate.transactionId === 'inv-tx-duo');
    assert.equal(duo.length, 2);
    const swept = await sweepInventory(client);
    assert.equal(swept.created.some((candidate) => candidate.transactionId === 'inv-tx-duo'), false);
  });

  it('rejects a stale optimistic-concurrency version with 409', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items[0];
    const stale = await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { notes: 'stale', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    assert.equal(stale.statusCode, 409);
    const fresh = JSON.parse((await invoke('PUT', `/api/bookkeeping/inventory/${item.id}`, { notes: 'fresh', expectedUpdatedAt: item.updatedAt })).body);
    assert.equal(fresh.notes, 'fresh');
  });

  it('deletes an inventory item', async () => {
    const items = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items;
    const item = items[0];
    const removed = await invoke('DELETE', `/api/bookkeeping/inventory/${item.id}`);
    assert.equal(removed.statusCode, 204);
    const missing = await invoke('DELETE', `/api/bookkeeping/inventory/${item.id}`);
    assert.equal(missing.statusCode, 404);
    const stored = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    assert.equal(stored.items.some((candidate: any) => candidate.id === item.id), false);
  });

  it('adds inventory entries automatically when the ledger gains a physical purchase', async () => {
    const before = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body).items.length;

    await putBookkeepingTransactionWithItems(client, { ...transaction({ description: 'Standing desk', amount: '259.00' }), id: 'inv-tx-desk' }, []);
    let listed = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    assert.equal(listed.items.length, before + 1);
    const desk = listed.items.find((candidate: any) => candidate.transactionId === 'inv-tx-desk');
    assert.equal(desk.type, 'furniture');
    assert.equal(desk.acquisitionDate, '2026-03-19');
    assert.equal(desk.status, 'in-use');

    // A subscription never reaches the inventory.
    await putBookkeepingTransactionWithItems(client, { ...transaction({ description: 'Mailchimp Standard plan' }), id: 'inv-tx-manual-subscription' }, []);
    listed = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    assert.equal(listed.items.length, before + 1);

    // Editing a transaction to carry physical allocation rows derives them too.
    const stored = await getBookkeepingItem(client, 'bookkeeping', 'inv-tx-desk');
    await updateBookkeepingTransaction(client, 'inv-tx-desk', String(stored.updatedAt), {
      allocations: [
        { id: 'auto-alloc-1', description: 'Lenovo ThinkCentre M920q', amount: '399.00', currency: 'EUR', amountEur: '399.00' },
      ],
    });
    listed = JSON.parse((await invoke('GET', '/api/bookkeeping/inventory')).body);
    const derived = listed.items.find((candidate: any) => candidate.allocationId === 'auto-alloc-1');
    assert.equal(derived.type, 'computer');
    assert.equal(derived.transactionId, 'inv-tx-desk');
  });
});
