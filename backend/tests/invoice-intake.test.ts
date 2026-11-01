import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { useTestDatabase, truncateTestTables } from './helpers/db';
import { createArtifactIfAbsent } from '../src/db/artifacts';
import { createIntakeItemIfAbsent } from '../src/db/intake';
import { createInvoice, getInvoice } from '../src/invoices/store';
import type { Invoice } from '../src/invoices/model';
import { processInvoiceIntake, setInvoiceServiceForTests } from '../src/invoices/service';
import { handleInvoiceRoutes } from '../src/routes/invoices';

let client: DynamoDBDocumentClient;
const BUCKET = 'synthetic-invoice-documents';
const savedEnv = Object.fromEntries(['IS_LOCAL','EMAIL_DOCUMENTS_BUCKET','EMAIL_DOCUMENT_DESTINATION_PREFIX'].map(name => [name, process.env[name]]));
let objects = new Map<string, Buffer>();

async function intakeWithPdf(bytes: Buffer) {
  const id = randomUUID();
  const artifactId = randomUUID();
  const key = `artifacts/${artifactId}`;
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  objects.set(key, bytes);
  const s3 = { send: async () => ({ Body: Readable.from([objects.get(key)!]) }) } as unknown as S3Client;
  await createArtifactIfAbsent(client, {
    id: artifactId,
    contentType: 'application/pdf',
    storageUri: `s3://${BUCKET}/${key}`,
    checksum,
    sizeBytes: bytes.length,
    metadata: { importState: 'complete' },
  });
  const item = (await createIntakeItemIfAbsent(client, {
    id,
    source: 'email',
    sourceReceivedAt: new Date().toISOString(),
    status: 'new',
    title: 'Synthetic invoice attachment',
    summary: '',
    receivedChannels: ['email'],
    linkRefs: [],
    fileRefs: [],
    artifactRefs: [{ artifactId, type: 'invoice' }],
    taskIds: [],
    cardIds: [],
    relatedIntakeItemIds: [],
    tags: [],
    priority: 'normal',
    dataClass: 'sensitive',
    metadata: { recipientRoute: 'invoice' },
    history: [],
  })).item;
  return { item, s3 };
}

function pendingInvoice(id: string, counterparty: string, number: string, checksum: string, accountContext: string): Invoice {
  const at = new Date().toISOString();
  return {
    id,
    revision: 1,
    status: 'pending',
    fields: { counterparty, invoiceNumber: number, accountContext, amount: '70.44', currency: 'EUR' },
    extraction: { method: 'synthetic-test', evidence: [], issues: [] },
    source: { intakeItemIds: [], artifactId: `artifact-${id.slice(0, 8)}`, checksum },
    destinations: {
      dropbox: { state: 'pending', operationId: `dropbox-${id}` },
      sheets: { state: 'pending', operationId: `sheets-${id}` },
    },
    audit: [],
    createdAt: at,
    updatedAt: at,
  };
}

before(async () => {
  ({ client } = await useTestDatabase());
  process.env.IS_LOCAL = 'true';
  process.env.EMAIL_DOCUMENTS_BUCKET = BUCKET;
  process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX = 'artifacts/';
});

beforeEach(async () => {
  await truncateTestTables(client);
  objects = new Map();
  setInvoiceServiceForTests({});
});

after(() => {
  setInvoiceServiceForTests({});
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('invoice intake persists the actual extraction exception on its draft', async () => {
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1200, 32)]);
  const { item, s3 } = await intakeWithPdf(bytes);
  setInvoiceServiceForTests({
    s3,
    financeExtract: async () => { throw new Error('synthetic-pdf-reader-failure'); },
  });

  const result = await processInvoiceIntake(client, item.id);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].extraction.issues, ['PDF extraction failed: synthetic-pdf-reader-failure']);
  assert.equal(result.items[0].extraction.needsReview, true);
  const stored = await getInvoice(client, result.items[0].id);
  assert.deepEqual(stored?.extraction.issues, ['PDF extraction failed: synthetic-pdf-reader-failure']);
});

test('blank conversion is stored and returned as a visible review flag', async () => {
  const blank = Buffer.from('%PDF-1.4\n% synthetic empty PDF fixture\n');
  const { item, s3 } = await intakeWithPdf(blank);
  setInvoiceServiceForTests({ s3 });

  const result = await processInvoiceIntake(client, item.id);
  const record = result.items[0];
  assert.equal(record.extraction.blankConversion, true);
  assert.deepEqual(record.extraction.issues, ['Blank conversion — original needed']);

  const list = await handleInvoiceRoutes('/api/bookkeeping/invoices', 'GET', {} as never, client, true);
  const listed = JSON.parse(list.body).items.find((value: Invoice) => value.id === record.id);
  assert.equal(listed.extraction.blankConversion, true);
  assert.deepEqual(listed.extraction.issues, ['Blank conversion — original needed']);
  const detail = await handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}`, 'GET', {} as never, client, true);
  assert.equal(JSON.parse(detail.body).extraction.blankConversion, true);
});

test('vendor and invoice number duplicate flags are read-only and ignore checksum/account context', async () => {
  const first = pendingInvoice(createHash('sha256').update(randomUUID()).digest('hex'), 'Contabo', '300639000P261021', 'sha256:first-copy', 'merchant-account-a');
  const second = pendingInvoice(createHash('sha256').update(randomUUID()).digest('hex'), ' contabo ', '300639000P261021', 'sha256:second-copy', 'merchant-account-b');
  await createInvoice(client, first);
  await createInvoice(client, second);

  const response = await handleInvoiceRoutes('/api/bookkeeping/invoices', 'GET', {} as never, client, true);
  const rows = JSON.parse(response.body).items as Array<Invoice & { duplicateInvoiceIds: string[] }>;
  const flaggedFirst = rows.find(record => record.id === first.id)!;
  const flaggedSecond = rows.find(record => record.id === second.id)!;
  assert.deepEqual(flaggedFirst.duplicateInvoiceIds, [second.id]);
  assert.deepEqual(flaggedSecond.duplicateInvoiceIds, [first.id]);
  assert.equal(flaggedFirst.status, 'pending');
  assert.equal(flaggedSecond.status, 'pending');

  const detail = await handleInvoiceRoutes(`/api/bookkeeping/invoices/${first.id}`, 'GET', {} as never, client, true);
  assert.deepEqual(JSON.parse(detail.body).duplicateInvoiceIds, [second.id]);
  assert.equal((await getInvoice(client, first.id))?.status, 'pending');
  assert.equal((await getInvoice(client, second.id))?.status, 'pending');
});
