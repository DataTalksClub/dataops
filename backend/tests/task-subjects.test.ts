import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createDealAtomic, createOrganizationAtomic } from '../src/db/sponsorCrm';
import { handler } from '../src/handler';

const invoke = async (method: string, path: string, body?: unknown) => {
  const url = new URL(path, 'http://task-subjects.test');
  const response = await handler({
    httpMethod: method,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

describe('Tasks about a sponsor deal or company (no Card)', () => {
  let companyId = '';
  let dealId = '';

  before(async () => {
    const client = await getClient(await startLocal());
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    const company = await createOrganizationAtomic(client, { displayName: 'Synthetic Sponsor Co' }, 'test');
    companyId = company.item.id;
    const deal = await createDealAtomic(client, { organizationId: companyId, status: 'open', productKind: 'one-off' }, 'test');
    dealId = deal.item.id;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('creates a cardless Task linked to a deal and projects the company name and deal path', async () => {
    const created = await invoke('POST', '/api/tasks', {
      description: 'Chase the signed order form',
      date: '2026-10-16',
      subject: { type: 'sponsor-deal', id: dealId },
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.cardId, undefined);
    assert.deepStrictEqual(created.body.subject, {
      type: 'sponsor-deal',
      id: dealId,
      label: 'Synthetic Sponsor Co',
      href: `/sponsors/deals/${dealId}`,
    });

    const listed = await invoke('GET', '/api/tasks?date=2026-10-16');
    const task = listed.body.tasks.find((item: { id: string }) => item.id === created.body.id);
    assert.strictEqual(task.subject.label, 'Synthetic Sponsor Co');
    assert.strictEqual(task.subject.href, `/sponsors/deals/${dealId}`);
  });

  it('links a Task to a company and can clear the link', async () => {
    const created = await invoke('POST', '/api/tasks', {
      description: 'Ask about next quarter',
      date: '2026-10-17',
      subject: { type: 'sponsor-company', id: companyId, label: 'ignored' },
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.subject.href, `/sponsors/companies/${companyId}`);

    const cleared = await invoke('PUT', `/api/tasks/${created.body.id}`, { subject: null, expectedVersion: 1 });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.body.subject, undefined);
  });

  it('rejects an unknown subject, a malformed one, and a subject on a Card Task', async () => {
    const missing = await invoke('POST', '/api/tasks', {
      description: 'Nothing to link', date: '2026-10-16', subject: { type: 'sponsor-deal', id: 'no-such-deal' },
    });
    assert.strictEqual(missing.status, 404);

    const malformed = await invoke('POST', '/api/tasks', {
      description: 'Bad type', date: '2026-10-16', subject: { type: 'card', id: dealId },
    });
    assert.strictEqual(malformed.status, 400);

    const both = await invoke('POST', '/api/tasks', {
      description: 'Both', date: '2026-10-16', cardId: 'some-card', subject: { type: 'sponsor-deal', id: dealId },
    });
    assert.strictEqual(both.status, 400);
    assert.match(both.body.error, /not both/);
  });
});
