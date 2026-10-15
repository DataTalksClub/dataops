import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listCrmRecords, scanCrmPrefix, withCrmReadSnapshot } from '../src/db/sponsorCrm';
import { collectBoundedPages, StoragePaginationError } from '../src/db/boundedPagination';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { route } from '../src/router';

const now = '2026-10-15T00:00:00.000Z';
const record = (kind: string, id: string, extra: Record<string, unknown> = {}) => ({
  PK: `${kind}#${id}`, SK: `${kind}#${id}`, id, version: 1, createdAt: now, updatedAt: now, ...extra,
});
const ITEMS = [
  record('ORGANIZATION', 'org-1', { displayName: 'Acme' }),
  record('CONTACT', 'contact-1', { organizationId: 'org-1' }),
  record('DEAL', 'deal-1', { organizationId: 'org-1', title: 'Newsletter', status: 'won' }),
  record('DELIVERABLE', 'deliverable-1', { dealId: 'deal-1', organizationId: 'org-1', channel: 'newsletter' }),
  record('LEAD', 'lead-1'),
  record('NEWSLETTER', 'newsletter-1'),
  record('NEWSLETTER-ISSUE', 'issue-1'),
  { PK: 'SPONSOR_FINANCE#deal-1', SK: 'SPONSOR_FINANCE#deal-1', recordType: 'sponsor-finance', dealId: 'deal-1', paymentLinkIds: [] },
  { PK: 'HISTORY#organization:org-1', SK: `${now}#1`, action: 'created' },
];

/** A fake table: Scan applies the OR-of-begins_with filter the code sends. */
function fakeClient() {
  const scans: string[][] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const name = command.constructor.name;
      if (name === 'ScanCommand') {
        assert.equal(command.input.TableName, TABLE_SPONSOR_CRM);
        const prefixes = Object.values(command.input.ExpressionAttributeValues || {}) as string[];
        scans.push(prefixes);
        return { Items: ITEMS.filter((item) => prefixes.some((prefix) => item.PK.startsWith(prefix))) };
      }
      if (name === 'GetCommand') return {};
      if (name === 'QueryCommand') return { Items: [] };
      if (name === 'BatchGetCommand') return { Responses: {} };
      throw new Error(`read-only test client got ${name}`);
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, scans };
}

describe('sponsor CRM read snapshot', () => {
  it('scans once per kind outside a snapshot', async () => {
    const { client, scans } = fakeClient();
    assert.deepEqual((await listCrmRecords(client, 'deal')).map((item) => item.id), ['deal-1']);
    await listCrmRecords(client, 'organization');
    assert.deepEqual(scans, [['DEAL#'], ['ORGANIZATION#']]);
  });

  it('serves concurrent list reads in one request from a single scan', async () => {
    const { client, scans } = fakeClient();
    const [organizations, deals, issues, newsletters, finance] = await withCrmReadSnapshot(() => Promise.all([
      listCrmRecords(client, 'organization'),
      listCrmRecords(client, 'deal'),
      listCrmRecords(client, 'newsletter-issue'),
      listCrmRecords(client, 'newsletter'),
      scanCrmPrefix(client, 'SPONSOR_FINANCE'),
    ]));
    assert.equal(scans.length, 1);
    assert.deepEqual(organizations.map((item) => item.id), ['org-1']);
    assert.deepEqual(deals.map((item) => item.id), ['deal-1']);
    assert.deepEqual(issues.map((item) => item.id), ['issue-1']);
    assert.deepEqual(newsletters.map((item) => item.id), ['newsletter-1']);
    assert.deepEqual(finance.map((item) => item.PK), ['SPONSOR_FINANCE#deal-1']);
    assert.equal(organizations[0].PK, undefined, 'snapshot records are cleaned like direct reads');
  });

  it('scans directly for a prefix the snapshot does not cover', async () => {
    const { client, scans } = fakeClient();
    const history = await withCrmReadSnapshot(() => scanCrmPrefix(client, 'HISTORY#'));
    assert.equal(history.length, 1);
    assert.deepEqual(scans, [['HISTORY#']]);
  });

  it('does not share a snapshot between requests', async () => {
    const { client, scans } = fakeClient();
    await withCrmReadSnapshot(() => listCrmRecords(client, 'deal'));
    await withCrmReadSnapshot(() => listCrmRecords(client, 'deal'));
    assert.equal(scans.length, 2);
  });

  for (const path of ['/api/sponsor-crm/deals', '/api/sponsor-crm/organizations', '/api/sponsor-crm/queue']) {
    it(`GET ${path} scans the CRM table once`, async () => {
      const previous = process.env.SPONSOR_FINANCE_ENABLED;
      process.env.SPONSOR_FINANCE_ENABLED = 'true';
      try {
        const { client, scans } = fakeClient();
        const response = await route({
          httpMethod: 'GET', path, headers: {}, queryStringParameters: { limit: '100' }, body: null,
        }, client);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(scans.length, 1, `scans: ${JSON.stringify(scans)}`);
      } finally {
        if (previous === undefined) delete process.env.SPONSOR_FINANCE_ENABLED;
        else process.env.SPONSOR_FINANCE_ENABLED = previous;
      }
    });
  }
});

describe('bounded pagination failures', () => {
  it('keeps the storage error as the cause', async () => {
    const throttled = Object.assign(new Error('Throughput exceeds the current capacity'), {
      name: 'ProvisionedThroughputExceededException',
    });
    await assert.rejects(
      collectBoundedPages({ loadPage: async () => { throw throttled; } }),
      (error: unknown) => error instanceof StoragePaginationError
        && error.reason === 'storage-pagination-failed'
        && error.cause === throttled,
    );
  });
});
