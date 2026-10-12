import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { GRACE_USER_ID } from '../src/sponsorCrm/model';

const IMPORT_FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sponsor-crm-import.json'), 'utf8'));
const grace = { 'x-user-id': GRACE_USER_ID };

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = grace) => {
  const url = new URL(path, 'http://sponsor-crm.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);

describe('sponsor CRM newsletters', () => {
  before(async () => {
    const port = await startLocal();
    await createTables(await getClient(port));
  });
  after(stopLocal);

  it('creates, lists with health, records receipts, and imports by slug', async () => {
    const created = await invoke('POST', '/api/sponsor-crm/newsletters', {
      name: 'Data Engineering Weekly',
      url: 'https://www.dataengineeringweekly.com/archive',
      senders: ['dataengineeringweekly@substack.com'],
      cadence: 'Weekly',
      expectedIntervalDays: 7,
      subscriptionStatus: 'subscribed',
      subscribedAt: '2026-09-01',
    });
    assert.equal(created.statusCode, 201, created.body);
    const newsletter = data(created);
    assert.equal(newsletter.slug, 'data-engineering-weekly');
    assert.equal(newsletter.mailbox, 'newsletter@dtcdev.click');
    assert.equal(newsletter.health, 'missing');

    const pending = data(await invoke('POST', '/api/sponsor-crm/newsletters', {
      name: 'Import AI',
      url: 'https://importai.substack.com/archive',
      cadence: 'Weekly',
      expectedIntervalDays: 7,
      subscriptionStatus: 'pending',
    }));
    assert.equal(pending.health, 'pending');

    const listed = data(await invoke('GET', '/api/sponsor-crm/newsletters?today=2026-10-12&limit=50'));
    assert.equal(listed.items[0].id, newsletter.id);
    assert.equal(listed.items[0].health, 'missing');

    const receipt = await invoke('POST', '/api/sponsor-crm/newsletters/receipts', {
      sender: 'dataengineeringweekly@substack.com',
      subject: 'Data Engineering Weekly #290',
      receivedAt: '2026-10-11T12:00:00Z',
      messageId: 'msg-290',
    });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(data(receipt).health, 'current');
    assert.equal(data(receipt).lastSubject, 'Data Engineering Weekly #290');

    const replay = await invoke('POST', '/api/sponsor-crm/newsletters/receipts', {
      sender: 'dataengineeringweekly@substack.com',
      subject: 'replay',
      receivedAt: '2026-10-12T12:00:00Z',
      messageId: 'msg-290',
    });
    assert.equal(data(replay).lastSubject, 'Data Engineering Weekly #290');

    const unknown = await invoke('POST', '/api/sponsor-crm/newsletters/receipts', {
      sender: 'unknown@example.invalid',
      subject: 'Hello',
      receivedAt: '2026-10-12T12:00:00Z',
    });
    assert.equal(unknown.statusCode, 422);

    const imported = await invoke('POST', '/api/sponsor-crm/imports', IMPORT_FIXTURE);
    assert.equal(imported.statusCode, 200, imported.body);
    assert.ok(data(imported).newsletters >= 1);
    const digest = data(await invoke('GET', '/api/sponsor-crm/newsletters?search=example-digest&today=2026-10-12')).items
      .find((item: any) => item.slug === 'example-digest');
    assert.ok(digest);
    assert.equal(digest.mailbox, 'newsletter@example.invalid');

    const again = await invoke('POST', '/api/sponsor-crm/imports', {
      newsletters: [{
        name: 'Example Digest',
        slug: 'example-digest',
        url: 'https://digest.example.invalid/archive',
        expectedIntervalDays: 7,
        subscriptionStatus: 'subscribed',
      }],
    });
    assert.equal(data(again).newsletters, 0);
    assert.ok(data(again).duplicates >= 1);
  });
});
