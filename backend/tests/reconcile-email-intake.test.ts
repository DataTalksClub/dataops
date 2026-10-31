import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { listUndismissedNotifications } from '../src/db/notifications';
import { resetEmailDocumentIntakeStateForTests, setEmailDocumentIntakeClientsForTests } from '../src/routes/emailDocuments';
import { setStatementIntakeStorageForTests } from '../src/reconcile/statementIntake';

const SECRET = 'reconcile-email-intake-secret';
const OPERATOR = 'reconcile-email-operator';
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'reconcile', name));
const files: Record<string, { bytes: Buffer; type: string }> = {
  'revolut_2026-10_all-accounts.csv': { bytes: fixture('revolut-business-all-accounts.csv'), type: 'text/csv' },
  'finom_2026-10_main.csv': { bytes: fixture('finom-main.csv'), type: 'text/csv' },
  'notes.csv': { bytes: Buffer.from('Date,Description,Amount\n2026-10-01,Something,1.00\n'), type: 'text/csv' },
};
const checksum = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Transfer bucket (head/copy, as the intake does) plus the copied artifacts the statement import reads back. */
class FakeS3 {
  readonly stored = new Map<string, Buffer>();
  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof HeadObjectCommand) {
      const name = String(command.input.Key).replace(/^transfer\//, '');
      const file = files[name];
      if (!file) throw new Error('NoSuchKey');
      return { ContentLength: file.bytes.length, ContentType: file.type, Metadata: { sha256: checksum(file.bytes).slice(7) } };
    }
    if (command instanceof CopyObjectCommand) {
      const name = String(command.input.CopySource).split('/transfer/')[1];
      this.stored.set(String(command.input.Key), files[decodeURIComponent(name)].bytes);
      return { CopyObjectResult: {} };
    }
    if (command instanceof GetObjectCommand) {
      const bytes = this.stored.get(String(command.input.Key));
      if (!bytes) throw new Error('NoSuchKey');
      return { Body: Readable.from(bytes) };
    }
    throw new Error('Unexpected S3 command');
  }
}

const attachment = (name: string) => ({ kind: 'attachment', storageUri: `s3://email-documents-test/transfer/${name}`, filename: name, contentType: files[name].type, sizeBytes: files[name].bytes.length, checksum: checksum(files[name].bytes) });

describe('bank statements sent to the invoice intake address', () => {
  let handler: typeof import('../src/handler').handler;
  const s3 = new FakeS3();

  before(async () => {
    const port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, OPERATOR, { name: 'Operator', email: 'operator@datatalks.club', role: 'operator' });
    process.env.IS_LOCAL = 'true';
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.EMAIL_DOCUMENTS_BUCKET = 'email-documents-test';
    process.env.EMAIL_DOCUMENTS_KMS_KEY = 'test-key';
    process.env.EMAIL_DOCUMENT_SOURCE_PREFIX = 'transfer/';
    process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX = 'artifacts/';
    process.env.EMAIL_DOCUMENT_RECIPIENT_ROUTES = 'invoice';
    process.env.EMAIL_DOCUMENT_RATE_LIMIT = '1000';
    handler = (await import('../src/handler')).handler;
    resetEmailDocumentIntakeStateForTests();
    setEmailDocumentIntakeClientsForTests({ s3: s3 as unknown as S3Client });
    setStatementIntakeStorageForTests(s3 as unknown as S3Client);
  });

  after(async () => {
    await stopLocal();
    for (const key of Object.keys(process.env)) if (key.startsWith('EMAIL_DOCUMENT')) delete process.env[key];
    delete process.env.IS_LOCAL;
  });

  it('detects, parses, stores and reconciles both banks with no flags, and reports an unknown CSV', async () => {
    const sent = await handler({
      httpMethod: 'POST', path: '/api/v1/intake/email-documents', headers: { 'x-dataops-intake-secret': SECRET },
      body: JSON.stringify({
        version: '2026-07-01', messageId: 'october-statements', recipientRoute: 'invoice', from: 'owner@example.test', subject: 'October statements', receivedAt: '2026-10-31T08:00:00Z',
        documents: [attachment('revolut_2026-10_all-accounts.csv'), attachment('finom_2026-10_main.csv'), attachment('notes.csv')],
      }),
    }, {});
    assert.equal(sent.statusCode, 202, sent.body);
    const body = JSON.parse(sent.body);
    assert.deepEqual(body.statements, [
      { account: 'revolut', months: ['2026-10'], rows: 5 },
      { account: 'finom', months: ['2026-10'], rows: 7 },
    ]);
    assert.deepEqual(body.statementIssues, ['attachment 3: CSV is not a recognized Finom or Revolut statement export']);
    // Statements are never drafted as invoices.
    assert.deepEqual(body.invoices, []);

    const monthResponse = await handler({ httpMethod: 'GET', path: '/api/reconcile/months/2026-10', headers: { 'x-user-id': OPERATOR } }, {});
    assert.equal(monthResponse.statusCode, 200, monthResponse.body);
    const month = JSON.parse(monthResponse.body);
    assert.equal(month.statements.length, 2);
    const kinds = month.rows.map((row: { exception?: { kind: string } }) => row.exception?.kind).filter(Boolean);
    assert.deepEqual(kinds.filter((kind: string) => kind === 'internal_transfer').length, 2, 'the Revolut EUR→USD exchange legs');
    assert.ok(month.rows.every((row: { status: string }) => ['no-invoice', 'matched', 'needs-review'].includes(row.status)));
    assert.match(month.rows.find((row: { counterparty: string }) => row.counterparty === 'Sponsor Two GmbH').missing, /no ledger row or invoice/);

    const balances = JSON.parse((await handler({ httpMethod: 'GET', path: '/api/reconcile/balances', headers: { 'x-user-id': OPERATOR }, queryStringParameters: { account: 'finom' } }, {})).body);
    assert.deepEqual(balances.items.map((item: { amount: string; asOf: string }) => [item.amount, item.asOf]), [['3210.55', '2026-10-31']]);

    const notifications = await listUndismissedNotifications(await getClient());
    const summaries = notifications.filter((item) => item.type === 'reconcile-month');
    assert.equal(summaries.length, 2);
    assert.match(String(summaries[0].message), /Reconciliation 2026-10 \(open\)/);

    // Sending the same mail again changes nothing.
    const replay = await handler({
      httpMethod: 'POST', path: '/api/v1/intake/email-documents', headers: { 'x-dataops-intake-secret': SECRET },
      body: JSON.stringify({
        version: '2026-07-01', messageId: 'october-statements', recipientRoute: 'invoice', from: 'owner@example.test', subject: 'October statements', receivedAt: '2026-10-31T08:00:00Z',
        documents: [attachment('revolut_2026-10_all-accounts.csv'), attachment('finom_2026-10_main.csv'), attachment('notes.csv')],
      }),
    }, {});
    assert.equal(replay.statusCode, 200);
    const again = JSON.parse((await handler({ httpMethod: 'GET', path: '/api/reconcile/months/2026-10', headers: { 'x-user-id': OPERATOR } }, {})).body);
    assert.equal(again.rows.length, month.rows.length);
  });
});
