import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_SCHEMA, extractWithLlm, extractionModel } from '../src/invoices/llm';

const answer = { docType: 'credit_note', direction: 'income', counterparty: 'Example Assist, LLC', invoiceNumber: 'A1B2C3D4-0059-CN-01', date: '2026-10-30', currency: 'USD', net: null, vat: null, gross: '646.63', vatRate: null, reverseCharge: false, paymentChannel: 'card', description: 'Unused time', confidence: 'high', uncertainFields: [] };
const fakeApi = (calls: any[], reply: { status?: number; body: unknown }) => async (url: string, init: any) => {
  calls.push({ url, ...init, body: JSON.parse(init.body) });
  return { ok: (reply.status || 200) < 400, status: reply.status || 200, json: async () => reply.body };
};

test('sends the document text with the strict schema and returns fields, usage and latency', async () => {
  const calls: any[] = [];
  const result = await extractWithLlm({ text: 'Refund\n'.repeat(30), hints: { subject: 'refund' } }, { model: 'gpt-5.4-nano', apiKey: 'test-key', fetchImpl: fakeApi(calls, { body: { model: 'gpt-5.4-nano', output_text: JSON.stringify(answer), usage: { input_tokens: 900, output_tokens: 120 } } }) });
  assert.deepEqual(result.fields, answer);
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 120 });
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'gpt-5.4-nano');
  assert.equal(calls[0].body.text.format.strict, true);
  assert.deepEqual(calls[0].body.text.format.schema, EXTRACTION_SCHEMA);
  const user = calls[0].body.input[1].content;
  assert.match(user[0].text, /^Document text:\nRefund/);
  assert.match(user[1].text, /not a description/);
});

test('a scanned PDF without a text layer is sent as a file', async () => {
  const calls: any[] = [];
  await extractWithLlm({ text: '  ', pdf: Buffer.from('%PDF-1.4 scanned') }, { apiKey: 'k', fetchImpl: fakeApi(calls, { body: { output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] } }) });
  const part = calls[0].body.input[1].content[0];
  assert.equal(part.type, 'input_file');
  assert.match(part.file_data, /^data:application\/pdf;base64,/);
});

test('API errors keep only the status and code, never the body', async () => {
  await assert.rejects(
    extractWithLlm({ text: 'x'.repeat(200) }, { apiKey: 'k', fetchImpl: fakeApi([], { status: 401, body: { error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-abc...' } } }) }),
    (error: Error) => error.message === 'openai-401-invalid_api_key',
  );
});

test('the model comes from configuration', () => {
  const saved = process.env.DATAOPS_EXTRACTION_MODEL;
  process.env.DATAOPS_EXTRACTION_MODEL = 'gpt-6-luna';
  assert.equal(extractionModel(), 'gpt-6-luna');
  if (saved === undefined) delete process.env.DATAOPS_EXTRACTION_MODEL; else process.env.DATAOPS_EXTRACTION_MODEL = saved;
});
