// Run only through scripts/test-sponsor-finance-transaction.sh against DynamoDB Local.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createTables, TABLE_USERS } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCrmRecord } from '../src/db/sponsorCrm';
import { classifyFinance, issueInvoice, projectFinance } from '../src/sponsorFinance/repository';
import { checkVatId } from '../src/vies/service';

const key = (prefix: string, id: string) => ({ PK: `${prefix}#${id}`, SK: `${prefix}#${id}` });
const put = (client: DynamoDBDocumentClient, table: string, item: Record<string, unknown>) =>
  client.send(new PutCommand({ TableName: table, Item: item }));
const idem = (label: string) => `${label}-0123456789abcdef`;
const adminId = 'vies-gate-admin-1';

async function classifiedDeal(client: DynamoDBDocumentClient, dealId: string, expectedVersion: number) {
  const classified = await classifyFinance(client, {
    actorId: adminId, dealId, dealVersion: 1, expectedVersion,
    idempotencyKey: idem(`${dealId}-classify`),
    body: { invoiceRequirement: 'required', amountDue: '1000.00', currency: 'EUR', taxMode: 'not-applicable' },
  });
  return classified.financeVersion;
}

describe('VIES reverse-charge gate on invoice issue', () => {
  let client: DynamoDBDocumentClient;
  let server: Server, requests: string[];

  before(async () => {
    assert.ok(process.env.DYNAMODB_ENDPOINT, 'focused harness requires real DynamoDB Local');
    requests = [];
    // Valid answer for every VAT ID except the 9999* block, which reads as not registered.
    server = createServer((req, res) => {
      requests.push(String(req.url));
      const vat = decodeURIComponent(String(req.url).split('/vat/')[1] || '');
      const valid = !vat.startsWith('9999');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isValid: valid, name: 'Synthetic ApS', requestDate: '2026-10-19' }));
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    process.env.VIES_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    client = await getClient();
    await createTables(client);
    await put(client, TABLE_USERS, { ...key('USER', adminId), id: adminId, role: 'admin', disabled: false });
  });

  after(async () => {
    delete process.env.VIES_BASE_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('blocks an EU deal whose customer has no VAT ID', async () => {
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'No VAT ApS', country: 'DK' })).item;
    const deal = (await createCrmRecord(client, 'deal', { organizationId: organization.id, status: 'agreed', active: true, title: 'Gate deal A' })).item;
    const financeVersion = await classifiedDeal(client, deal.id, 0);
    await assert.rejects(
      issueInvoice(client, {
        actorId: adminId, dealId: deal.id, dealVersion: 1, expectedVersion: financeVersion,
        invoiceNumber: 'S-2026-100', issuedOn: '2026-10-19', dueOn: '2026-11-19', idempotencyKey: idem(`${deal.id}-issue`),
      }),
      (error: NodeJS.ErrnoException) => {
        assert.equal((error as { statusCode?: number }).statusCode, 422);
        assert.match(String(error.message), /VAT ID/);
        return true;
      },
    );
    const projection = await projectFinance(client, deal.id, 'admin');
    assert.equal(projection.vat?.required, true);
    assert.equal(projection.vat?.blocking?.reason, 'missing-vat-id');
  });

  it('blocks a deal whose VAT ID VIES does not know and reports it on the projection', async () => {
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'Ghost ApS', country: 'DK', vatId: 'DK99999999' })).item;
    const deal = (await createCrmRecord(client, 'deal', { organizationId: organization.id, status: 'agreed', active: true, title: 'Gate deal B' })).item;
    const financeVersion = await classifiedDeal(client, deal.id, 0);
    const check = await checkVatId(client, 'DK99999999');
    assert.equal(check.status, 'not-found');
    await assert.rejects(
      issueInvoice(client, {
        actorId: adminId, dealId: deal.id, dealVersion: 1, expectedVersion: financeVersion,
        invoiceNumber: 'S-2026-101', issuedOn: '2026-10-19', dueOn: '2026-11-19', idempotencyKey: idem(`${deal.id}-issue`),
      }),
      (error: NodeJS.ErrnoException) => {
        assert.equal((error as { statusCode?: number }).statusCode, 422);
        assert.match(String(error.message), /not registered/);
        return true;
      },
    );
    const projection = await projectFinance(client, deal.id, 'admin');
    assert.equal(projection.vat?.blocking?.reason, 'not-found');
  });

  it('issues once the VAT ID checks out and clears the flag for non-EU customers', async () => {
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'Sound ApS', country: 'DK', vatId: 'DK12345678' })).item;
    const deal = (await createCrmRecord(client, 'deal', { organizationId: organization.id, status: 'agreed', active: true, title: 'Gate deal C' })).item;
    const financeVersion = await classifiedDeal(client, deal.id, 0);
    const issued = await issueInvoice(client, {
      actorId: adminId, dealId: deal.id, dealVersion: 1, expectedVersion: financeVersion,
      invoiceNumber: 'S-2026-102', issuedOn: '2026-10-19', dueOn: '2026-11-19', idempotencyKey: idem(`${deal.id}-issue`),
    });
    assert.ok(issued, 'issue recorded');
    const projection = await projectFinance(client, deal.id, 'admin');
    assert.equal(projection.invoiceState, 'issued');
    assert.equal(projection.vat?.check?.status, 'valid');
    assert.equal(projection.vat?.vatId, 'DK12345678');
    assert.equal(requests.length >= 1, true, 'the gate consulted VIES once for the new VAT ID');
    const usOrganization = (await createCrmRecord(client, 'organization', { displayName: 'US Inc', country: 'US' })).item;
    const usDeal = (await createCrmRecord(client, 'deal', { organizationId: usOrganization.id, status: 'agreed', active: true, title: 'Gate deal D' })).item;
    const usFinanceVersion = await classifiedDeal(client, usDeal.id, 0);
    const usIssued = await issueInvoice(client, {
      actorId: adminId, dealId: usDeal.id, dealVersion: 1, expectedVersion: usFinanceVersion,
      invoiceNumber: 'S-2026-103', issuedOn: '2026-10-19', dueOn: '2026-11-19', idempotencyKey: idem(`${usDeal.id}-issue`),
    });
    assert.ok(usIssued, 'non-EU issue recorded');
    const usProjection = await projectFinance(client, usDeal.id, 'admin');
    assert.equal(usProjection.vat, undefined, 'non-EU customers stay out of scope');
  });
});
