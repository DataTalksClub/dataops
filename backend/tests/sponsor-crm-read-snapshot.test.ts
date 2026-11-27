import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listCrmRecords, listOrganizationDeals, listCrmItems, withCrmReadSnapshot } from '../src/db/sponsorCrm';
import { ENTITY_TYPE_INDEX, withEntityType } from '../src/db/sponsorCrmTypeIndex';
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
  { PK: 'MESSAGE#m-1', SK: 'MESSAGE#m-1', organizationId: 'org-1' },
  { PK: 'HISTORY#organization:org-1', SK: `${now}#1`, action: 'created' },
];

/** A fake table: type-index Queries return that type's rows. Scans fail. */
function fakeClient() {
  const queries: string[] = [];
  const consistent: unknown[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const name = command.constructor.name;
      if (name === 'ScanCommand') {
        // Finance enrichment may also scan the Tasks table (recorded sponsor
        // chases), which is outside this contract and reads as empty here.
        if (command.input.TableName !== TABLE_SPONSOR_CRM) return { Items: [] };
        throw new Error('sponsor CRM list reads must not scan the table');
      }
      if (name === 'QueryCommand' && command.input.IndexName === ENTITY_TYPE_INDEX) {
        assert.equal(command.input.TableName, TABLE_SPONSOR_CRM);
        const type = command.input.ExpressionAttributeValues[':type'];
        const organizationId = command.input.ExpressionAttributeValues[':organizationId'];
        queries.push(type);
        consistent.push(command.input.ConsistentRead);
        return { Items: ITEMS.map(withEntityType).filter((item) => item.GSI5PK === type
          && (organizationId === undefined || (item as Record<string, unknown>).organizationId === organizationId)) };
      }
      if (name === 'GetCommand') return {};
      if (name === 'QueryCommand') return { Items: [] };
      if (name === 'BatchGetCommand') return { Responses: {} };
      throw new Error(`read-only test client got ${name}`);
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, queries, consistent };
}

describe('sponsor CRM type-index reads', () => {
  it('queries one type per list outside a snapshot', async () => {
    const { client, queries } = fakeClient();
    assert.deepEqual((await listCrmRecords(client, 'deal')).map((item) => item.id), ['deal-1']);
    await listCrmRecords(client, 'organization');
    assert.deepEqual(queries, ['DEAL', 'ORGANIZATION']);
  });

  it('serves repeated list reads in one request from one query per type', async () => {
    const { client, queries } = fakeClient();
    const [organizations, deals, again, issues, newsletters, finance] = await withCrmReadSnapshot(() => Promise.all([
      listCrmRecords(client, 'organization'),
      listCrmRecords(client, 'deal'),
      listCrmRecords(client, 'deal'),
      listCrmRecords(client, 'newsletter-issue'),
      listCrmRecords(client, 'newsletter'),
      listCrmItems(client, 'SPONSOR_FINANCE#'),
    ]));
    assert.deepEqual(queries.sort(), ['DEAL', 'NEWSLETTER', 'NEWSLETTER-ISSUE', 'ORGANIZATION', 'SPONSOR_FINANCE']);
    assert.deepEqual(organizations.map((item) => item.id), ['org-1']);
    assert.deepEqual(deals.map((item) => item.id), ['deal-1']);
    assert.deepEqual(again, deals);
    assert.deepEqual(issues.map((item) => item.id), ['issue-1']);
    assert.deepEqual(newsletters.map((item) => item.id), ['newsletter-1']);
    assert.deepEqual(finance.map((item) => item.PK), ['SPONSOR_FINANCE#deal-1']);
    assert.equal(organizations[0].PK, undefined, 'records are cleaned');
    assert.equal(organizations[0].GSI5PK, undefined, 'the index key never leaves storage');
  });

  it('refuses a prefix that is not an indexed type instead of scanning', async () => {
    const { client } = fakeClient();
    await assert.rejects(listCrmItems(client, 'HISTORY#'), /not an indexed entity type/);
    await assert.rejects(listCrmItems(client, 'SPONSOR_FINANCE'), /not an indexed entity type/);
  });

  it('lists with eventually consistent reads', async () => {
    const { client, consistent } = fakeClient();
    await listCrmRecords(client, 'deal');
    await withCrmReadSnapshot(() => listCrmRecords(client, 'organization'));
    await listOrganizationDeals(client, 'org-1');
    assert.deepEqual(consistent, [undefined, undefined, undefined], 'list reads must not pay for strong consistency');
  });

  it('reads one organization\'s deals from the DEAL partition only', async () => {
    const { client, queries } = fakeClient();
    assert.deepEqual((await listOrganizationDeals(client, 'org-1')).map((item) => item.id), ['deal-1']);
    assert.deepEqual(await listOrganizationDeals(client, 'org-2'), []);
    assert.deepEqual(queries, ['DEAL', 'DEAL']);
  });

  it('does not share a snapshot between requests', async () => {
    const { client, queries } = fakeClient();
    await withCrmReadSnapshot(() => listCrmRecords(client, 'deal'));
    await withCrmReadSnapshot(() => listCrmRecords(client, 'deal'));
    assert.equal(queries.length, 2);
  });

  for (const path of ['/api/sponsor-crm/deals', '/api/sponsor-crm/organizations']) {
    it(`GET ${path} queries each type at most once`, async () => {
      const previous = process.env.SPONSOR_FINANCE_ENABLED;
      process.env.SPONSOR_FINANCE_ENABLED = 'true';
      try {
        const { client, queries } = fakeClient();
        const response = await route({
          httpMethod: 'GET', path, headers: {}, queryStringParameters: { limit: '100' }, body: null,
        }, client);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(new Set(queries).size, queries.length, `queries: ${JSON.stringify(queries)}`);
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
