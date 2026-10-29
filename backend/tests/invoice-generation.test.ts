import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { validateTemplate, validateValues, renderInvoice, invoiceTotal } from '../src/invoiceGeneration/pdf';
import { pdfText } from '../src/invoices/extract';
import { handleBookkeepingRoutes } from '../src/routes/bookkeeping';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const template = { name: 'Synthetic contractor', issuer: 'Synthetic Contractor\nExample Street 1', recipient: 'Synthetic Customer\nExample Street 2', paymentDetails: 'Synthetic bank reference', taxNote: 'Approved tax treatment supplied by operator', currency: 'EUR' };
const values = { invoiceNumber: '202610-1', issueDate: '2026-10-29', servicePeriod: 'September - October 2026', items: [{ description: 'Synthetic newsletter', amount: '0.10' }, { description: 'Synthetic social media', amount: '0.20' }] };
test('PDF contains every supplied field and exact decimal total', async () => {
  const bytes = await renderInvoice(validateTemplate(template), validateValues(values));
  assert.equal(invoiceTotal(values), '0.30');
  const text = await pdfText(Buffer.from(bytes));
  for (const expected of ['202610-1', '2026-10-29', 'September - October 2026', 'Synthetic Contractor', 'Synthetic Customer', 'Synthetic newsletter', 'Synthetic social media', 'Invoice total: 0.30 EUR', template.paymentDetails, template.taxNote]) assert.ok(text.includes(expected), expected);
});
test('long text and fifty line items flow to additional pages with final total intact', async () => {
  const invoice = validateValues({ ...values, items: Array.from({ length: 50 }, (_, i) => ({ description: `Item ${i} ` + 'Long text '.repeat(50), amount: '99999999.99' })) });
  const bytes = await renderInvoice(validateTemplate(template), invoice);
  assert.ok((await PDFDocument.load(bytes)).getPageCount() > 3);
  assert.ok((await pdfText(Buffer.from(bytes))).includes('Invoice total: 4999999999.50 EUR'));
});
test('rejects malformed dates, amounts, unsupported text, empty and unbounded input', () => {
  for (const issueDate of ['2026-02-30', '2026-13-01', '29.10.2026']) assert.throws(() => validateValues({ ...values, issueDate }));
  for (const amount of ['-1', '0', 'NaN', '1e3', '1.005', '01.2', 10, '100000000']) assert.throws(() => validateValues({ ...values, items: [{ description: 'Service', amount }] }));
  for (const items of [[], Array(51).fill(values.items[0])]) assert.throws(() => validateValues({ ...values, items }));
  assert.throws(() => validateTemplate({ ...template, issuer: 'Unsupported 😀' }));
  assert.throws(() => validateTemplate({ ...template, issuer: '' }));
  assert.throws(() => validateTemplate({ ...template, currency: 'XYZ' }));
});

let client: DynamoDBDocumentClient;
before(async () => { client = await getClient(await startLocal()); await createTables(client); });
after(stopLocal);
const base = '/api/bookkeeping/invoice-generation';
const request = (method: string, path: string, body?: unknown, auth = true) => handleBookkeepingRoutes(path, method, { httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, client, auth);
test('authenticated template round trip, PDF generation, and invalid input boundaries', async () => {
  assert.equal((await request('GET', `${base}/templates`, undefined, false)).statusCode, 401);
  assert.equal((await request('POST', `${base}/render`, values, false)).statusCode, 401);
  assert.equal((await request('POST', `${base}/templates`, {})).statusCode, 400);
  const created = await request('POST', `${base}/templates`, { ...template, PK: 'injected', id: 'injected' });
  assert.equal(created.statusCode, 201);
  const saved = JSON.parse(created.body);
  assert.notEqual(saved.id, 'injected');
  assert.equal(saved.PK, undefined);
  const listed = JSON.parse((await request('GET', `${base}/templates`)).body);
  assert.deepEqual(listed.items[0].template, template);
  const response = await request('POST', `${base}/render`, { ...values, templateId: saved.id, invoiceNumber: '../../synthetic' });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.total, '0.30');
  assert.ok(!result.filename.includes('/'));
  assert.equal((await PDFDocument.load(Buffer.from(result.contentBase64, 'base64'))).getPageCount(), 1);
  assert.equal((await request('POST', `${base}/render`, { ...values, templateId: saved.id, issueDate: '2026-02-30' })).statusCode, 400);
  assert.equal((await request('POST', `${base}/render`, { ...values, templateId: '00000000-0000-0000-0000-000000000000' })).statusCode, 404);
});
