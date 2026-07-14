import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal, stopLocal } from '../src/db/client';
import { getArtifact, listArtifacts } from '../src/db/artifacts';
import { listIntakeItems } from '../src/db/intake';
import { resetEmailDocumentIntakeStateForTests, setEmailDocumentIntakeClientsForTests } from '../src/routes/emailDocuments';
import { setArtifactDownloadSignerForTests } from '../src/routes/artifacts';
import { route } from '../src/router';

const SECRET = 'email-documents-test-secret';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function request(messageId: string, documents: unknown[] = [], recipientRoute = 'invoice') {
  return {
    httpMethod: 'POST', path: '/api/v1/intake/email-documents', headers: { 'x-dataops-intake-secret': SECRET },
    body: JSON.stringify({ version: '2026-07-01', messageId, recipientRoute, from: 'billing@example.test', subject: `Mail ${messageId}`, receivedAt: '2026-07-12T10:00:00Z', documents }),
  };
}

function attachment(name = 'invoice.pdf', checksum = HASH_A, kind: 'attachment' | 'rendered-email-pdf' = 'attachment') {
  return { kind, storageUri: `s3://email-documents-test/transfer/${name}`, filename: name, contentType: 'application/pdf', sizeBytes: 1234, checksum };
}

class FakeS3 {
  readonly copies: Array<{ source?: string; key?: string }> = [];
  readonly sources = new Map<string, { size: number; type: string; checksum: string }>();
  failCopyKey = '';

  add(name: string, checksum = HASH_A): void {
    this.sources.set(`transfer/${name}`, { size: 1234, type: 'application/pdf', checksum });
  }

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof HeadObjectCommand) {
      const source = this.sources.get(String(command.input.Key));
      if (!source) throw new Error('NoSuchKey: private-value-must-not-leak');
      return { ContentLength: source.size, ContentType: source.type, Metadata: { sha256: source.checksum.slice(7) } };
    }
    if (command instanceof CopyObjectCommand) {
      if (String(command.input.CopySource).includes(this.failCopyKey) && this.failCopyKey) {
        this.failCopyKey = '';
        throw new Error('AccessDenied: private-value-must-not-leak');
      }
      this.copies.push({ source: command.input.CopySource, key: command.input.Key });
      return { CopyObjectResult: {} };
    }
    throw new Error('Unexpected S3 command');
  }
}

describe('POST /api/v1/intake/email-documents', () => {
  let handler: typeof import('../src/handler').handler;
  let s3: FakeS3;

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.EMAIL_DOCUMENTS_BUCKET = 'email-documents-test';
    process.env.EMAIL_DOCUMENTS_KMS_KEY = 'test-key';
    process.env.EMAIL_DOCUMENT_SOURCE_PREFIX = 'transfer/';
    process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX = 'artifacts/';
    process.env.EMAIL_DOCUMENT_RECIPIENT_ROUTES = 'invoice,receipts,todo';
    process.env.EMAIL_DOCUMENT_RATE_LIMIT = '1000';
    handler = (await import('../src/handler')).handler;
    await handler({ httpMethod: 'GET', path: '/api/health' }, {});
  });

  beforeEach(() => {
    resetEmailDocumentIntakeStateForTests();
    s3 = new FakeS3();
    setEmailDocumentIntakeClientsForTests({ s3: s3 as unknown as S3Client });
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = SECRET;
    process.env.EMAIL_DOCUMENT_RATE_LIMIT = '1000';
  });

  after(async () => {
    await stopLocal();
    for (const key of Object.keys(process.env)) if (key.startsWith('EMAIL_DOCUMENT')) delete process.env[key];
    delete process.env.IS_LOCAL;
  });

  it('accepts a metadata-only TODO email as one sensitive intake without artifacts', async () => {
    const result = await handler(request('todo-email-109', [], 'todo'), {});
    assert.strictEqual(result.statusCode, 202);
    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body.artifacts, []);
    const item = (await listIntakeItems(await getClient(), { source: 'email' })).find((candidate) => candidate.id === body.intakeItemId);
    assert.strictEqual(item?.dataClass, 'sensitive');
    assert.strictEqual(item?.status, 'new');
    assert.deepStrictEqual(item?.artifactRefs, []);
  });

  it('verifies, copies, registers, and links attachment/rendered/multiple documents privately', async () => {
    s3.add('one.pdf'); s3.add('rendered.pdf', HASH_B); s3.add('three.pdf', HASH_B);
    const documents = [attachment('one.pdf'), attachment('rendered.pdf', HASH_B, 'rendered-email-pdf'), attachment('three.pdf', HASH_B)];
    const result = await handler(request('documents-109', documents), {});
    assert.strictEqual(result.statusCode, 202);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.artifacts.length, 3);
    assert.strictEqual(s3.copies.length, 3);
    assert.ok(!result.body.includes('s3://'));
    for (const summary of body.artifacts) {
      const artifact = await getArtifact(await getClient(), summary.artifactId);
      assert.strictEqual(artifact?.status, 'needs-review');
      assert.strictEqual(artifact?.dataClass, 'sensitive');
      assert.strictEqual(artifact?.visibility, 'sensitive');
      assert.ok(artifact?.storageUri.startsWith('s3://email-documents-test/artifacts/'));
      assert.strictEqual(artifact?.metadata?.importState, 'complete');
    }
  });

  it('makes exact and concurrent replay idempotent and rejects changed immutable content', async () => {
    s3.add('concurrent.pdf');
    const event = request('concurrent-109', [attachment('concurrent.pdf')]);
    const [first, second] = await Promise.all([handler(event, {}), handler(event, {})]);
    assert.deepStrictEqual([first.statusCode, second.statusCode].sort(), [200, 202]);
    assert.strictEqual(JSON.parse(first.body).intakeItemId, JSON.parse(second.body).intakeItemId);
    assert.strictEqual(s3.copies.length, 1);
    const item = (await listIntakeItems(await getClient(), { source: 'email' })).find((candidate) => candidate.id === JSON.parse(first.body).intakeItemId);
    assert.strictEqual(item?.artifactRefs.length, 1);
    assert.strictEqual(item?.history.filter((entry) => entry.action === 'email-document-completed').length, 1);

    const conflict = request('concurrent-109', [attachment('concurrent.pdf')]);
    conflict.body = conflict.body.replace('Mail concurrent-109', 'Changed subject');
    const conflictResult = await handler(conflict, {});
    assert.strictEqual(conflictResult.statusCode, 409);
    assert.strictEqual(JSON.parse(conflictResult.body).error.code, 'idempotency-conflict');
  });

  it('preserves successful links on partial copy failure and exact retry completes once', async () => {
    s3.add('partial-one.pdf'); s3.add('partial-two.pdf', HASH_B);
    s3.failCopyKey = 'partial-two.pdf';
    const event = request('partial-109', [attachment('partial-one.pdf'), attachment('partial-two.pdf', HASH_B)]);
    const partial = await handler(event, {});
    assert.strictEqual(partial.statusCode, 207);
    assert.deepStrictEqual(JSON.parse(partial.body).failures, [{ index: 1, code: 'copy-failed' }]);
    const retry = await handler(event, {});
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(JSON.parse(retry.body).artifacts.length, 2);
    assert.strictEqual(s3.copies.length, 2);
    const item = (await listIntakeItems(await getClient(), { source: 'email' })).find((candidate) => candidate.id === JSON.parse(retry.body).intakeItemId);
    assert.strictEqual(item?.status, 'new');
    assert.strictEqual(item?.blockedReason, undefined);
  });

  it('repairs a missing intake link from the completed artifact after the transfer source is gone', async () => {
    s3.add('link-recovery.pdf');
    const event = request('link-recovery-109', [attachment('link-recovery.pdf')]);
    const realClient = await getClient();
    let failedLinkWrite = false;
    const failingClient = {
      send(command: unknown) {
        if (!failedLinkWrite && command instanceof UpdateCommand && String(command.input.Key?.PK || '').startsWith('INTAKE#')) {
          failedLinkWrite = true;
          throw new Error('synthetic intake link persistence failure');
        }
        return realClient.send(command as never);
      },
    };
    const partial = await route(event, failingClient as never);
    assert.strictEqual(partial.statusCode, 207);
    assert.deepStrictEqual(JSON.parse(partial.body).failures, [{ index: -1, code: 'link-persistence-failed' }]);
    assert.strictEqual(s3.copies.length, 1);

    s3.sources.delete('transfer/link-recovery.pdf');
    const retry = await handler(event, {});
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(JSON.parse(retry.body).artifacts.length, 1);
    assert.strictEqual(s3.copies.length, 1);
    const item = (await listIntakeItems(realClient, { source: 'email' })).find((candidate) => candidate.id === JSON.parse(retry.body).intakeItemId);
    assert.strictEqual(item?.status, 'new');
    assert.strictEqual(item?.artifactRefs.length, 1);
  });

  it('rejects authentication, schema, payload, allowlist, metadata, and object limits without unsafe persistence', async () => {
    const beforeCount = (await listIntakeItems(await getClient())).length;
    const unauthorized = request('unauthorized-109'); unauthorized.headers['x-dataops-intake-secret'] = 'wrong';
    const wrongResult = await handler(unauthorized, {});
    assert.strictEqual(wrongResult.statusCode, 401);
    const missingCredential = request('missing-credential-109'); missingCredential.headers = {} as typeof missingCredential.headers;
    const missingResult = await handler(missingCredential, {});
    assert.strictEqual(missingResult.statusCode, 401);
    const sameLengthCredential = request('same-length-credential-109'); sameLengthCredential.headers['x-dataops-intake-secret'] = 'x'.repeat(SECRET.length);
    const sameLengthResult = await handler(sameLengthCredential, {});
    assert.strictEqual(sameLengthResult.statusCode, 401);
    const longCredential = request('long-credential-109'); longCredential.headers['x-dataops-intake-secret'] = 'x'.repeat(SECRET.length * 4);
    const longResult = await handler(longCredential, {});
    assert.strictEqual(longResult.statusCode, 401);
    assert.strictEqual(missingResult.body, wrongResult.body);
    assert.strictEqual(sameLengthResult.body, wrongResult.body);
    assert.strictEqual(longResult.body, wrongResult.body);
    const malformed = request('malformed-109'); malformed.body = '{';
    assert.strictEqual((await handler(malformed, {})).statusCode, 400);
    const version = request('version-109'); version.body = version.body.replace('2026-07-01', 'v2');
    assert.strictEqual((await handler(version, {})).statusCode, 400);
    const unknown = request('unknown-109'); unknown.body = unknown.body.replace('"documents":[]', '"documents":[],"rawEmail":"private"');
    assert.strictEqual((await handler(unknown, {})).statusCode, 400);
    const unknownDocument = request('unknown-document-109', [{ ...attachment(), extra: true }]);
    assert.strictEqual((await handler(unknownDocument, {})).statusCode, 400);
    const duplicate = request('duplicate-doc-109', [attachment(), attachment()]);
    assert.strictEqual((await handler(duplicate, {})).statusCode, 400);
    assert.strictEqual((await handler(request('document-count-109', Array.from({ length: 26 }, (_, index) => attachment(`${index}.pdf`, index % 2 ? HASH_A : HASH_B))), {})).statusCode, 400);
    const zero = request('zero-109', [{ ...attachment(), sizeBytes: 0 }]);
    assert.strictEqual((await handler(zero, {})).statusCode, 400);
    const tooLarge = request('large-doc-109', [{ ...attachment(), sizeBytes: 25 * 1024 * 1024 + 1 }]);
    assert.strictEqual((await handler(tooLarge, {})).statusCode, 400);
    const signed = request('signed-109', [{ ...attachment(), storageUri: 'https://example.test/a?X-Amz-Signature=private' }]);
    assert.strictEqual((await handler(signed, {})).statusCode, 400);
    const bytes = request('bytes-109', [{ ...attachment(), base64: 'private' }]);
    assert.strictEqual((await handler(bytes, {})).statusCode, 400);
    const renderedType = request('rendered-type-109', [{ ...attachment(), kind: 'rendered-email-pdf', contentType: 'text/html' }]);
    assert.strictEqual((await handler(renderedType, {})).statusCode, 400);
    const impossibleTime = request('time-109'); impossibleTime.body = impossibleTime.body.replace('2026-07-12T10:00:00Z', '2026-99-99T10:00:00Z');
    assert.strictEqual((await handler(impossibleTime, {})).statusCode, 400);
    const normalizedImpossibleTime = request('normalized-time-109'); normalizedImpossibleTime.body = normalizedImpossibleTime.body.replace('2026-07-12T10:00:00Z', '2026-02-30T00:00:00Z');
    assert.strictEqual((await handler(normalizedImpossibleTime, {})).statusCode, 400);
    const badChecksum = request('checksum-109', [{ ...attachment(), checksum: 'sha256:ABC' }]);
    assert.strictEqual((await handler(badChecksum, {})).statusCode, 400);
    const uppercaseChecksum = request('uppercase-checksum-109', [{ ...attachment(), checksum: `sha256:${'A'.repeat(64)}` }]);
    assert.strictEqual((await handler(uppercaseChecksum, {})).statusCode, 400);
    const oversized = request('oversized-109'); oversized.body = 'x'.repeat(256 * 1024 + 1);
    assert.strictEqual((await handler(oversized, {})).statusCode, 413);
    assert.strictEqual((await listIntakeItems(await getClient())).length, beforeCount);

    s3.add('mismatch.pdf');
    const mismatch = await handler(request('mismatch-109', [{ ...attachment('mismatch.pdf'), sizeBytes: 999 }]), {});
    assert.strictEqual(mismatch.statusCode, 400);
    assert.strictEqual(JSON.parse(mismatch.body).failures[0].code, 'size-mismatch');
    const mediaMismatch = await handler(request('media-mismatch-109', [{ ...attachment('mismatch.pdf'), contentType: 'image/png' }]), {});
    assert.strictEqual(mediaMismatch.statusCode, 400);
    assert.strictEqual(JSON.parse(mediaMismatch.body).failures[0].code, 'media-type-mismatch');
    const checksumMismatch = await handler(request('checksum-mismatch-109', [attachment('mismatch.pdf', HASH_B)]), {});
    assert.strictEqual(checksumMismatch.statusCode, 400);
    assert.strictEqual(JSON.parse(checksumMismatch.body).failures[0].code, 'checksum-mismatch');
    const outside = await handler(request('outside-109', [{ ...attachment(), storageUri: 's3://email-documents-test/outside/private.pdf' }]), {});
    assert.strictEqual(outside.statusCode, 400);
    assert.strictEqual(JSON.parse(outside.body).failures[0].code, 'source-not-allowed');
    assert.strictEqual(s3.copies.length, 0);
    assert.strictEqual((await listIntakeItems(await getClient())).length, beforeCount);
  });

  it('returns configuration errors without attempting persistence', async () => {
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
    const beforeCount = (await listIntakeItems(await getClient())).length;
    const result = await handler(request('not-configured-109'), {});
    assert.strictEqual(result.statusCode, 503);
    assert.strictEqual(JSON.parse(result.body).error.code, 'authentication-not-configured');
    assert.strictEqual((await listIntakeItems(await getClient())).length, beforeCount);
  });

  it('refreshes a rotated secret on mismatch and throttles by non-secret credential id', async () => {
    delete process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME = 'configured-secret-arn';
    let active = JSON.stringify({ id: 'sender-a', credential: 'old-secret-value' });
    const fakeSecrets = { send: async () => ({ SecretString: active }) } as unknown as SecretsManagerClient;
    resetEmailDocumentIntakeStateForTests();
    setEmailDocumentIntakeClientsForTests({ secrets: fakeSecrets, s3: s3 as unknown as S3Client });
    const old = request('rotation-old-109', [], 'todo'); old.headers['x-dataops-intake-secret'] = 'old-secret-value';
    assert.strictEqual((await handler(old, {})).statusCode, 202);
    active = JSON.stringify({ id: 'sender-a', credential: 'new-secret-value' });
    const fresh = request('rotation-new-109', [], 'todo'); fresh.headers['x-dataops-intake-secret'] = 'new-secret-value';
    assert.strictEqual((await handler(fresh, {})).statusCode, 202);
    const stale = request('rotation-stale-109', [], 'todo'); stale.headers['x-dataops-intake-secret'] = 'old-secret-value';
    assert.strictEqual((await handler(stale, {})).statusCode, 401);

    process.env.EMAIL_DOCUMENT_RATE_LIMIT = '1';
    active = JSON.stringify({ id: 'sender-rate-sequential', credential: 'new-secret-value' });
    resetEmailDocumentIntakeStateForTests();
    setEmailDocumentIntakeClientsForTests({ secrets: fakeSecrets });
    const one = request('rate-one-109', [], 'todo'); one.headers['x-dataops-intake-secret'] = 'new-secret-value';
    const two = request('rate-two-109', [], 'todo'); two.headers['x-dataops-intake-secret'] = 'new-secret-value';
    assert.strictEqual((await handler(one, {})).statusCode, 202);
    const limited = await handler(two, {});
    assert.strictEqual(limited.statusCode, 429);
    assert.ok(Number(limited.headers?.['Retry-After']) > 0);
  });

  it('enforces one atomic shared rate window across concurrent callers', async () => {
    const atomicSecret = 'atomic-rate-limit-secret';
    process.env.EMAIL_DOCUMENT_INTAKE_SECRET = JSON.stringify({ id: `atomic-${Date.now()}`, credential: atomicSecret });
    process.env.EMAIL_DOCUMENT_RATE_LIMIT = '3';
    const events = Array.from({ length: 8 }, (_, index) => {
      const event = request(`atomic-rate-${index}-109`, [], 'todo');
      event.headers['x-dataops-intake-secret'] = atomicSecret;
      return event;
    });
    const results = await Promise.all(events.map((event) => handler(event, {})));
    assert.strictEqual(results.filter((result) => result.statusCode === 202).length, 3);
    const limited = results.filter((result) => result.statusCode === 429);
    assert.strictEqual(limited.length, 5);
    assert.ok(limited.every((result) => Number(result.headers?.['Retry-After']) > 0));
  });

  it('keeps responses and structured audit logs free of envelope/document secrets', async () => {
    s3.add('private-name.pdf');
    const logs: string[] = [];
    const original = console.info;
    console.info = (...values: unknown[]) => logs.push(values.join(' '));
    try {
      const result = await handler(request('private-message-id-109', [attachment('private-name.pdf')]), {});
      const combined = `${result.body}\n${logs.join('\n')}`;
      for (const privateValue of ['billing@example.test', 'private-message-id-109', 'private-name.pdf', 's3://', HASH_A, SECRET]) assert.ok(!combined.includes(privateValue));
      assert.ok(logs.every((line) => line.includes('credentialId') && line.includes('correlation')));
    } finally { console.info = original; }
  });

  it('uses the authenticated generic artifact route for a five-minute private download', async () => {
    s3.add('download.pdf');
    const accepted = await handler(request('download-109', [attachment('download.pdf')]), {});
    const artifactId = JSON.parse(accepted.body).artifacts[0].artifactId;
    setArtifactDownloadSignerForTests(async (_client, _command, options) => {
      assert.strictEqual(options?.expiresIn, 300);
      return 'https://signed.example.test/private';
    });
    const result = await handler({ httpMethod: 'GET', path: `/api/artifacts/${artifactId}/download` }, {});
    assert.strictEqual(result.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(result.body), { downloadUrl: 'https://signed.example.test/private', expiresIn: 300 });
  });
});
