import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import {
  MAX_DEAL_ATTACHMENT_BYTES,
  DOWNLOAD_URL_SECONDS,
  setFileStorageClientForTests,
  setFileDownloadSignerForTests,
} from '../src/storage';
import type { S3Client } from '@aws-sdk/client-s3';

const TEST_UPLOAD_DIR = path.join(__dirname, '..', 'test-uploads-deal-attachments-' + process.pid);

function buildMultipart(
  fields: Record<string, string>,
  file?: { fieldName: string; filename: string; content: Buffer; contentType: string },
): { body: string; contentType: string } {
  const boundary = '----DealAttachBoundary' + Date.now();
  let body = '';
  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }
  if (file) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\n`;
    body += `Content-Type: ${file.contentType}\r\n\r\n`;
    body += file.content.toString('binary');
    body += '\r\n';
  }
  body += `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('CRM deal attachments API', () => {
  let handler: typeof import('../src/handler').handler;
  let dealId: string;

  before(async () => {
    process.env.UPLOAD_DIR = TEST_UPLOAD_DIR;
    const localPort = await startLocal();
    await createTables(await getClient(localPort));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const orgRes = await handler({
      httpMethod: 'POST',
      path: '/api/sponsor-crm/organizations',
      headers: { 'x-user-id': 'test-admin' },
      body: JSON.stringify({ displayName: 'Vivix Test Org', domain: 'vivix-test.example' }),
    }, {});
    assert.equal(orgRes.statusCode, 201);
    const org = JSON.parse(orgRes.body);

    const dealRes = await handler({
      httpMethod: 'POST',
      path: '/api/sponsor-crm/deals',
      headers: { 'x-user-id': 'test-admin' },
      body: JSON.stringify({ organizationId: org.id, status: 'agreed', title: 'Content Production Agreement' }),
    }, {});
    assert.equal(dealRes.statusCode, 201);
    dealId = JSON.parse(dealRes.body).id;
  });

  after(async () => {
    setFileStorageClientForTests(undefined);
    setFileDownloadSignerForTests(undefined);
    delete process.env.TASK_FILES_BUCKET;
    delete process.env.DATAOPS_FILE_STORAGE_PROVIDER;
    if (fs.existsSync(TEST_UPLOAD_DIR)) {
      fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
    }
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.UPLOAD_DIR;
  });

  it('uploads, lists, downloads via signed URL, deletes, and audits all three actions', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    const expectedChecksum = `sha256:${crypto.createHash('sha256').update(pdfBytes).digest('hex')}`;
    const { body, contentType } = buildMultipart(
      { note: 'Signed via DocuSign' },
      { fieldName: 'file', filename: 'signed-contract.pdf', content: pdfBytes, contentType: 'application/pdf' },
    );

    // Upload
    const uploadRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-crm/deals/${dealId}/attachments`,
      headers: { 'content-type': contentType, 'x-user-id': 'alice' },
      body,
    }, {});
    assert.equal(uploadRes.statusCode, 201);
    const uploaded = JSON.parse(uploadRes.body).attachment;
    assert.ok(uploaded.id);
    assert.equal(uploaded.dealId, dealId);
    assert.equal(uploaded.filename, 'signed-contract.pdf');
    assert.equal(uploaded.contentType, 'application/pdf');
    assert.equal(uploaded.sizeBytes, pdfBytes.length);
    assert.equal(uploaded.checksum, expectedChecksum);
    assert.equal(uploaded.note, 'Signed via DocuSign');
    assert.equal(uploaded.uploadedBy, 'alice');
    // Private storage: never leak storagePath, storageUri, or a publicUrl
    assert.equal(uploaded.storagePath, undefined);
    assert.equal(uploaded.storageUri, undefined);
    assert.equal(uploaded.publicUrl, undefined);
    assert.equal(uploaded.url, undefined);

    // List endpoint
    const listRes = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}/attachments`,
      headers: { 'x-user-id': 'alice' },
    }, {});
    assert.equal(listRes.statusCode, 200);
    const listed = JSON.parse(listRes.body).items;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, uploaded.id);

    // Deal detail also includes attachments metadata
    const dealRes = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}`,
      headers: { 'x-user-id': 'alice' },
    }, {});
    assert.equal(dealRes.statusCode, 200);
    const dealBody = JSON.parse(dealRes.body);
    assert.equal(dealBody.attachments.length, 1);
    assert.equal(dealBody.attachments[0].filename, 'signed-contract.pdf');

    // Download mints short-lived signed URL
    const dlRes = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}/attachments/${uploaded.id}/download`,
      headers: { 'x-user-id': 'bob' },
    }, {});
    assert.equal(dlRes.statusCode, 200);
    assert.equal(dlRes.headers?.['Cache-Control'], 'private, no-store');
    const dlBody = JSON.parse(dlRes.body);
    assert.equal(dlBody.expiresIn, DOWNLOAD_URL_SECONDS);
    assert.match(dlBody.downloadUrl, /\/content\?expires=\d+&mac=[0-9a-f]+$/);

    // Fetch via signed URL returns exact bytes with private headers
    const parsedUrl = new URL(dlBody.downloadUrl, 'http://localhost');
    const contentRes = await handler({
      httpMethod: 'GET',
      path: parsedUrl.pathname,
      queryStringParameters: Object.fromEntries(parsedUrl.searchParams.entries()),
    }, {});
    assert.equal(contentRes.statusCode, 200);
    assert.equal(contentRes.isBase64Encoded, true);
    assert.equal(contentRes.headers?.['Content-Type'], 'application/pdf');
    assert.equal(contentRes.headers?.['Cache-Control'], 'private, no-store');
    assert.match(String(contentRes.headers?.['Content-Disposition']), /^attachment;/);
    assert.deepEqual(Buffer.from(contentRes.body, 'base64'), pdfBytes);

    // Tampered signed URL is rejected (403)
    const tamperedRes = await handler({
      httpMethod: 'GET',
      path: parsedUrl.pathname,
      queryStringParameters: { expires: parsedUrl.searchParams.get('expires') || '', mac: '0'.repeat(64) },
    }, {});
    assert.equal(tamperedRes.statusCode, 403);

    // Delete
    const delRes = await handler({
      httpMethod: 'DELETE',
      path: `/api/sponsor-crm/deals/${dealId}/attachments/${uploaded.id}`,
      headers: { 'x-user-id': 'carol' },
    }, {});
    assert.equal(delRes.statusCode, 204);

    // Confirm deleted from list
    const listAfter = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}/attachments`,
      headers: { 'x-user-id': 'carol' },
    }, {});
    assert.equal(JSON.parse(listAfter.body).items.length, 0);

    // Audit trail contains uploaded, downloaded, deleted with actors
    const auditRes = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}/attachments/audit`,
      headers: { 'x-user-id': 'alice' },
    }, {});
    assert.equal(auditRes.statusCode, 200);
    const auditItems = JSON.parse(auditRes.body).items;
    const actions = auditItems.map((e: { action: string }) => e.action);
    assert.ok(actions.includes('uploaded'));
    assert.ok(actions.includes('downloaded'));
    assert.ok(actions.includes('deleted'));
    assert.equal(auditItems.find((e: { action: string }) => e.action === 'uploaded')?.actorId, 'alice');
    assert.equal(auditItems.find((e: { action: string }) => e.action === 'downloaded')?.actorId, 'bob');
    assert.equal(auditItems.find((e: { action: string }) => e.action === 'deleted')?.actorId, 'carol');
  });

  it('rejects over-limit uploads loudly with 413 and persists nothing', async () => {
    const oversized = Buffer.alloc(MAX_DEAL_ATTACHMENT_BYTES + 1, 0x41);
    const { body, contentType } = buildMultipart(
      {},
      { fieldName: 'file', filename: 'too-big.pdf', content: oversized, contentType: 'application/pdf' },
    );
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-crm/deals/${dealId}/attachments`,
      headers: { 'content-type': contentType, 'x-user-id': 'alice' },
      body,
    }, {});
    assert.equal(res.statusCode, 413);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.code, 'file_too_large');
    assert.match(parsed.error, /4 MiB/);
    assert.equal(parsed.maxBytes, MAX_DEAL_ATTACHMENT_BYTES);

    const listRes = await handler({
      httpMethod: 'GET',
      path: `/api/sponsor-crm/deals/${dealId}/attachments`,
      headers: { 'x-user-id': 'alice' },
    }, {});
    assert.equal(JSON.parse(listRes.body).items.length, 0);
  });

  it('uses private S3 storage under crm-deals/ prefix and presigned short-lived GET URLs', async () => {
    const sentCommands: Array<{ name: string; input: Record<string, unknown> }> = [];
    const signedCalls: Array<{ input: Record<string, unknown>; expiresIn: number }> = [];

    process.env.TASK_FILES_BUCKET = 'private-task-files-bucket';
    process.env.DATAOPS_FILE_STORAGE_PROVIDER = 's3';
    setFileStorageClientForTests({
      send: async (cmd: unknown) => {
        const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
        sentCommands.push({ name: c.constructor.name, input: c.input });
        return {};
      },
    } as unknown as Pick<S3Client, 'send'>);
    setFileDownloadSignerForTests(async (_client, cmd, options) => {
      signedCalls.push({ input: (cmd as unknown as { input: Record<string, unknown> }).input, expiresIn: options.expiresIn });
      return 'https://private-task-files-bucket.s3.amazonaws.com/signed?X-Amz-Signature=deadbeef&X-Amz-Expires=300';
    });

    try {
      const docBytes = Buffer.from('signed agreement text');
      const { body, contentType } = buildMultipart(
        {},
        { fieldName: 'file', filename: 'agreement.docx', content: docBytes, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      );

      const uploadRes = await handler({
        httpMethod: 'POST',
        path: `/api/sponsor-crm/deals/${dealId}/attachments`,
        headers: { 'content-type': contentType, 'x-user-id': 'alice' },
        body,
      }, {});
      assert.equal(uploadRes.statusCode, 201);
      const attachment = JSON.parse(uploadRes.body).attachment;

      const put = sentCommands.find(c => c.name === 'PutObjectCommand');
      assert.ok(put, 'must put object into private S3 bucket');
      assert.equal(put.input.Bucket, 'private-task-files-bucket');
      assert.match(String(put.input.Key), new RegExp(`^crm-deals/${dealId}/[0-9a-f-]+/agreement\\.docx$`));
      assert.equal(put.input.IfNoneMatch, '*');
      assert.equal(put.input.ACL, undefined, 'must never set public ACL');

      const dlRes = await handler({
        httpMethod: 'GET',
        path: `/api/sponsor-crm/deals/${dealId}/attachments/${attachment.id}/download`,
        headers: { 'x-user-id': 'alice' },
      }, {});
      assert.equal(dlRes.statusCode, 200);
      const dl = JSON.parse(dlRes.body);
      assert.equal(dl.expiresIn, DOWNLOAD_URL_SECONDS);
      assert.match(dl.downloadUrl, /X-Amz-Signature=/);
      assert.equal(signedCalls.length, 1);
      assert.equal(signedCalls[0].input.Bucket, 'private-task-files-bucket');
      assert.equal(signedCalls[0].expiresIn, DOWNLOAD_URL_SECONDS);

      const delRes = await handler({
        httpMethod: 'DELETE',
        path: `/api/sponsor-crm/deals/${dealId}/attachments/${attachment.id}`,
        headers: { 'x-user-id': 'alice' },
      }, {});
      assert.equal(delRes.statusCode, 204);
      const del = sentCommands.find(c => c.name === 'DeleteObjectCommand');
      assert.ok(del, 'must delete object from private S3 bucket');
      assert.equal(del.input.Key, put.input.Key);
    } finally {
      setFileStorageClientForTests(undefined);
      setFileDownloadSignerForTests(undefined);
      delete process.env.TASK_FILES_BUCKET;
      delete process.env.DATAOPS_FILE_STORAGE_PROVIDER;
    }
  });
});
