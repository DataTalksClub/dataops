import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { useTestDatabase } from './helpers/db';
import { createArtifactIfAbsent, getArtifact } from '../src/db/artifacts';
import { createInvoice, getInvoice } from '../src/invoices/store';
import type { Invoice } from '../src/invoices/model';
import { pdfText, extractInvoiceText } from '../src/invoices/extract';
import { decodeInvoiceDocument, replaceInvoiceDocument, setInvoiceDocumentForTests, MAX_INVOICE_DOCUMENT_BYTES } from '../src/invoices/replaceDocument';
import { setInvoiceServiceForTests, reextractInvoice } from '../src/invoices/service';
import { handleInvoiceRoutes } from '../src/routes/invoices';
import { handler } from '../src/handler';
import { createUserWithId } from '../src/db/users';
import { createApiToken } from '../src/db/cliAuth';

let client: DynamoDBDocumentClient;
const objects = new Map<string, Buffer>();
const puts: PutObjectCommand[] = [];
let failUpload = false;
let token: string;
const envNames = ['SKIP_AUTH', 'IS_LOCAL', 'WORK_ENGINE_AUTH_MODE', 'INVOICE_READER_TOKEN_SHA256', 'EMAIL_DOCUMENTS_BUCKET', 'EMAIL_DOCUMENTS_KMS_KEY', 'EMAIL_DOCUMENT_DESTINATION_PREFIX'];
const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));

// A real, text-bearing PDF exercises the production parser as well as upload.
function pdf(lines: string[]): Buffer {
  const stream = `BT /F1 12 Tf 20 750 Td ${lines.map((line, i) => `${i ? '0 -18 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${value}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
const replacement = pdf(['TEST Replacement GmbH', 'Invoice number: TEST-NEW-2', 'Invoice date: 2026-10-25', 'Date paid: 2026-10-26', 'Total: EUR 23.45', 'VAT-ID: DE123456789']);
const payload = (revision = 1, extra = {}) => ({ revision, filename: 'TEST-replacement.pdf', contentType: 'application/pdf', contentBase64: replacement.toString('base64'), ...extra });
before(async () => {
  process.env.IS_LOCAL = 'true';
  ({ client } = await useTestDatabase());
  Object.assign(process.env, { EMAIL_DOCUMENTS_BUCKET: 'synthetic-invoice-documents', EMAIL_DOCUMENTS_KMS_KEY: 'synthetic-kms-key', EMAIL_DOCUMENT_DESTINATION_PREFIX: 'artifacts/' });
  const s3 = { send: async (command: PutObjectCommand | GetObjectCommand) => {
    if (command instanceof PutObjectCommand) {
      puts.push(command);
      if (failUpload) throw new Error('synthetic-storage-failure');
      assert.equal(command.input.IfNoneMatch, '*');
      assert.equal(objects.has(command.input.Key!), false);
      objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
      return {};
    }
    return { Body: Readable.from([objects.get(command.input.Key!)!]) };
  } } as unknown as S3Client;
  setInvoiceDocumentForTests({ s3 });
  setInvoiceServiceForTests({ s3 });
  await createUserWithId(client, 'test-orin', { name: 'Test Orin', email: 'orin@example.test', role: 'operator' });
  token = (await createApiToken(client, { userId: 'test-orin', label: 'Invoice replacement test', source: 'manual' })).token;
});
after(() => {
  setInvoiceDocumentForTests(); setInvoiceServiceForTests({});
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});
async function draft(status: Invoice['status'] = 'pending') {
  const id = createHash('sha256').update(randomUUID()).digest('hex');
  const old = pdf(['TEST Old GmbH', `Invoice number: ${id}`, 'Invoice date: 2026-10-01', 'Total: EUR 10.00']);
  const checksum = `sha256:${createHash('sha256').update(old).digest('hex')}`;
  const artifactId = `old-${id}`;
  objects.set(`artifacts/${artifactId}`, old);
  await createArtifactIfAbsent(client, { id: artifactId, contentType: 'application/pdf', storageUri: `s3://synthetic-invoice-documents/artifacts/${artifactId}`, checksum, sizeBytes: old.length, metadata: { importState: 'complete' } });
  const at = new Date().toISOString();
  const record: Invoice = { id, revision: 1, status, source: { artifactId, checksum, intakeItemIds: ['test-intake'] },
    fields: { counterparty: 'TEST Old GmbH', invoiceNumber: 'TEST-OLD-1', transactionDate: '2026-10-01', amount: '10.00', currency: 'EUR', vatId: 'DE000000000', amountEur: '11.00', paymentEvidence: 'TEST operator bank evidence', comment: 'TEST draft' },
    extraction: { method: 'manual', evidence: [], issues: [] },
    destinations: { dropbox: { state: 'pending', operationId: `dropbox-${id}` }, sheets: { state: 'pending', operationId: `sheets-${id}` } },
    audit: [{ action: 'corrected', actor: 'test-operator', revision: 1, at }], createdAt: at, updatedAt: at };
  return createInvoice(client, record);
}
async function request(record: Invoice, body: object, authorized = true) {
  return handleInvoiceRoutes(`/api/bookkeeping/invoices/${record.id}/replace-document`, 'POST', { headers: { 'x-user-id': 'test-operator' }, body: JSON.stringify(body) }, client, authorized);
}
test('PDF decoding rejects non-PDF, invalid encoding, filenames, flags and oversized uploads', () => {
  for (const extra of [{ contentBase64: Buffer.from('not a pdf').toString('base64') }, { contentBase64: payload().contentBase64 + '!' }, { filename: '../bad.pdf' }, { contentType: 'text/plain' }, { reextract: 'true' }, { contentBase64: '' }])
    assert.throws(() => decodeInvoiceDocument(payload(1, extra)), /PDF|base64|boolean/);
  assert.throws(() => decodeInvoiceDocument(payload(1, { contentBase64: Buffer.alloc(MAX_INVOICE_DOCUMENT_BYTES + 1).toString('base64') })), /limit/);
});
test('real PDF extraction includes new amounts, dates, invoice number and VAT-ID', async () => {
  const parsed = extractInvoiceText(await pdfText(replacement));
  assert.equal(parsed.fields.amount, '23.45'); assert.equal(parsed.fields.transactionDate, '2026-10-25');
  assert.equal(parsed.fields.paidDate, '2026-10-26'); assert.equal(parsed.fields.invoiceNumber, 'TEST-NEW-2');
  assert.equal(parsed.fields.vatId, 'DE123456789');
  const aws = extractInvoiceText('Amazon Web Services\nVAT Invoice Number: EUINDE00-1234567\nVAT Invoice Date: October 1, 2026\nTOTAL AMOUNT USD 120.50\nVAT-ID: DE123456789');
  assert.equal(aws.extraction.method, 'deterministic-aws');
  assert.equal(aws.fields.vatId, 'DE123456789');
});
test('API preserves id, fields and original object/artifact; appends both document references', async () => {
  const record = await draft(); const oldBytes = objects.get(`artifacts/${record.source.artifactId}`);
  const response = await request(record, payload()); assert.equal(response.statusCode, 200);
  const next = JSON.parse(response.body) as Invoice;
  assert.equal(next.id, record.id); assert.equal(next.revision, 2); assert.equal(next.status, 'pending');
  assert.deepEqual(next.fields, record.fields); assert.deepEqual(next.extraction, record.extraction);
  assert.deepEqual(next.source.intakeItemIds, record.source.intakeItemIds);
  assert.notEqual(next.source.artifactId, record.source.artifactId);
  assert.deepEqual(next.audit.at(-1)?.oldDocument, { artifactId: record.source.artifactId, checksum: record.source.checksum });
  assert.deepEqual(next.audit.at(-1)?.newDocument, { artifactId: next.source.artifactId, checksum: next.source.checksum });
  assert.equal(next.audit.at(-1)?.actor, 'test-operator'); assert.equal(next.audit.at(-1)?.reextracted, false);
  assert.ok(await getArtifact(client, record.source.artifactId));
  assert.deepEqual(objects.get(`artifacts/${record.source.artifactId}`), oldBytes);
  const artifact = (await getArtifact(client, next.source.artifactId))!;
  assert.equal(artifact.metadata?.importState, 'complete'); assert.equal(artifact.checksum, next.source.checksum);
  assert.match(artifact.storageUri!, /^s3:\/\/synthetic-invoice-documents\/artifacts\/invoices\//);
  assert.equal(puts.at(-1)?.input.ServerSideEncryption, 'aws:kms');
  await assert.rejects(reextractInvoice(client, next, 'intake'), /operator-corrected/);
});
test('explicit re-extraction replaces document fields on corrected drafts and retains actual bank evidence', async () => {
  const record = await draft();
  const next = await replaceInvoiceDocument(client, record, payload(1, { reextract: true }), 'test-operator');
  assert.equal(next.fields.amount, '23.45'); assert.equal(next.fields.transactionDate, '2026-10-25');
  assert.equal(next.fields.invoiceNumber, 'TEST-NEW-2'); assert.equal(next.fields.vatId, 'DE123456789');
  assert.equal(next.fields.counterparty, 'TEST Replacement GmbH'); assert.equal(next.fields.amountEur, '11.00');
  assert.equal(next.fields.paymentEvidence, record.fields.paymentEvidence); assert.equal(next.fields.comment, 'TEST draft');
  assert.equal(next.audit.at(-1)?.reextracted, true);
});
test('re-extraction clears stale document values that the replacement does not contain', async () => {
  const record = await draft();
  const next = await replaceInvoiceDocument(client, record, payload(1, {
    reextract: true,
    contentBase64: pdf(['TEST Replacement GmbH', 'Total: EUR 23.45']).toString('base64'),
  }), 'test-operator');
  assert.equal(next.fields.amount, '23.45');
  for (const field of ['transactionDate', 'paidDate', 'invoiceNumber', 'vatId'] as const)
    assert.equal(next.fields[field], undefined);
  assert.equal(next.fields.paymentEvidence, record.fields.paymentEvidence);
});
test('API stale revision, forbidden status, malformed PDF and unauthorized calls do not upload', async () => {
  const record = await draft(); const before = puts.length;
  assert.equal((await request(record, payload(0))).statusCode, 409);
  assert.equal((await request(record, payload(), false)).statusCode, 401);
  assert.equal((await request(record, payload(1, { contentBase64: Buffer.from('%PDF-broken').toString('base64') }))).statusCode, 400);
  for (const status of ['confirmed', 'rejected'] as const) assert.equal((await request(await draft(status), payload())).statusCode, 409);
  assert.equal(puts.length, before); assert.deepEqual((await getInvoice(client, record.id))?.source, record.source);
});
test('concurrent same-revision replacements allow one save and return a clear 409 for the other', async () => {
  const record = await draft();
  const result = await Promise.all([request(record, payload()), request(record, payload())]);
  assert.deepEqual(result.map(response => response.statusCode).sort(), [200, 409]);
  assert.match(result.find(response => response.statusCode === 409)!.body, /changed/);
  assert.equal((await getInvoice(client, record.id))?.audit.filter(event => event.action === 'document-replaced').length, 1);
});
test('storage failure leaves original invoice and history unchanged', async () => {
  const record = await draft(); failUpload = true;
  try { assert.equal((await request(record, payload())).statusCode, 503); }
  finally { failUpload = false; }
  assert.deepEqual(await getInvoice(client, record.id), record);
});
test('operator API token uses the same authenticated route as invoice edit; anonymous and reader are refused', async () => {
  process.env.SKIP_AUTH = 'false'; process.env.WORK_ENGINE_AUTH_MODE = 'standalone';
  const record = await draft();
  const invoke = (credential?: string) => handler({ httpMethod: 'POST', path: `/work/api/bookkeeping/invoices/${record.id}/replace-document`, headers: credential ? { authorization: `Bearer ${credential}` } : {}, body: JSON.stringify(payload()) }, {});
  assert.equal((await invoke()).statusCode, 401);
  assert.equal((await invoke(`dops_svc_${'a'.repeat(64)}`)).statusCode, 401);
  const reader = `dops_svc_${'b'.repeat(64)}`;
  process.env.INVOICE_READER_TOKEN_SHA256 = createHash('sha256').update(reader).digest('hex');
  assert.equal((await invoke(reader)).statusCode, 403);
  const response = await invoke(token); assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).audit.at(-1).actor, 'test-orin');
});
