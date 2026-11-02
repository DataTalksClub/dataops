import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.mjs';

test('invoice PDF CLI saves private output without exposing base64 or overwriting a file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'invoice-pdf-'));
  const oldFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  const out = [], errors = [], calls = [];
  const io = { log: value => out.push(value), error: value => errors.push(value) };
  const bytes = Buffer.from('%PDF-synthetic');
  process.env.DATAOPS_TOKEN = 'synthetic-token';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify(url.endsWith('/render') ? { contentType: 'application/pdf', contentBase64: bytes.toString('base64'), total: '0.30', currency: 'EUR' } : { id: 'synthetic-template', items: [] }));
  };
  try {
    const file = path.join(dir, 'input.json'), output = path.join(dir, 'invoice.pdf');
    await writeFile(file, JSON.stringify({ invoiceNumber: 'synthetic', templateId: 'injected' }));
    for (const args of [['templates'], ['create-template', '--file', file], ['render', '--template-id', 'selected', '--file', file, '--output', output]])
      assert.equal(await run(['invoice-pdfs', ...args, '--json'], io), 0);
    assert.deepEqual(await readFile(output), bytes);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(calls.at(-1).body.templateId, 'selected');
    assert.equal(await run(['invoice-pdfs', 'render', '--template-id', 'selected', '--file', file, '--output', output], io), 1);
    const correction = path.join(dir, 'correction.json'), reissue = path.join(dir, 'reissue.pdf');
    await writeFile(correction, JSON.stringify({ invoiceNumber: '202606/30', issueDate: '2026-06-01', servicePeriod: 'May 2026', items: [{ description: 'Newsletter Sponsorship (25 May 2026)', amount: '1500.00' }] }));
    assert.equal(await run(['invoice-pdfs', 'reissue', '--template-id', 'selected', '--file', correction, '--output', reissue, '--reason', 'Correct newsletter sponsorship date', '--json'], io), 0);
    assert.deepEqual(await readFile(reissue), bytes);
    const auditFile = `${reissue}.reissue.json`;
    const audit = JSON.parse(await readFile(auditFile, 'utf8'));
    assert.equal(audit.reason, 'Correct newsletter sponsorship date');
    assert.equal(audit.invoiceNumber, '202606/30');
    assert.equal(audit.templateId, 'selected');
    assert.equal((await stat(auditFile)).mode & 0o777, 0o600);
    assert.equal(calls.at(-1).body.invoiceNumber, '202606/30');
    assert.equal(calls.at(-1).body.items[0].description, 'Newsletter Sponsorship (25 May 2026)');
    assert.equal(calls.at(-1).body.templateId, 'selected');
    assert.equal(await run(['invoice-pdfs', 'reissue', '--template-id', 'selected', '--file', correction, '--output', path.join(dir, 'missing-reason.pdf'), '--json'], io), 1);
    assert.equal(await run(['invoice-pdfs', 'reissue', '--template-id', 'selected', '--file', correction, '--output', reissue, '--reason', 'Another reason', '--json'], io), 1);
    assert.ok(!out.join('').includes(bytes.toString('base64')));
    assert.ok(calls.every(call => call.url.includes('/api/bookkeeping/invoice-generation/')));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    await rm(dir, { recursive: true, force: true });
  }
});
