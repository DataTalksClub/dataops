import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createUser } from '../src/db/users';
import { createCard } from '../src/db/cards';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { humanBearer } from './helpers/human-bearer';
import { putEmptyTemplate, templateLink } from './helpers/cardTemplate';
import { detectPublicImageFormat } from '../src/publicImages';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

function buildMultipartImage(filename: string, content: Buffer, contentType = 'image/png') {
  const boundary = '----PublicImageBoundary' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    bodyBase64: Buffer.concat([head, content, tail]).toString('base64'),
  };
}

describe('Shared durable public image hosting (/api/public-images and /api/sponsor-docs/:id/images)', () => {
  let uploadDir = '';
  let staffHeaders: Record<string, string> = {};
  let prevUploadDir: string | undefined;
  let prevProvider: string | undefined;

  before(async () => {
    const port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    const user = await createUser(client, { email: 'staff-img@example.test', name: 'Staff Img', passwordHash: 'unused', role: 'admin' });
    const token = await humanBearer(client, user.id);
    staffHeaders = { authorization: `Bearer ${token}` };
    prevUploadDir = process.env.UPLOAD_DIR;
    prevProvider = process.env.DATAOPS_FILE_STORAGE_PROVIDER;
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-public-img-'));
    process.env.UPLOAD_DIR = uploadDir;
    process.env.DATAOPS_FILE_STORAGE_PROVIDER = 'local-dev';
  });

  after(async () => {
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    if (prevProvider === undefined) delete process.env.DATAOPS_FILE_STORAGE_PROVIDER;
    else process.env.DATAOPS_FILE_STORAGE_PROVIDER = prevProvider;
    if (uploadDir) await fs.rm(uploadDir, { recursive: true, force: true });
    await stopLocal();
  });

  it('detects PNG/JPEG/GIF/WebP magic bytes and rejects SVG/HTML', () => {
    assert.deepEqual(detectPublicImageFormat(VALID_PNG), { ext: 'png', contentType: 'image/png' });
    assert.equal(detectPublicImageFormat(Buffer.from('<svg><script>alert(1)</script></svg>')), null);
  });

  it('allows staff to upload, anyone to fetch publicly, and staff to delete via /api/public-images', async () => {
    const mp = buildMultipartImage('test.png', VALID_PNG);
    const uploadRes = await handler({
      httpMethod: 'POST',
      path: '/api/public-images',
      headers: { ...staffHeaders, 'content-type': mp.contentType },
      body: mp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(uploadRes.statusCode, 201, uploadRes.body);
    const uploaded = JSON.parse(uploadRes.body);
    assert.match(uploaded.image.path, /^\/api\/public-images\/[0-9a-f-]+\.png$/);
    assert.equal(uploaded.image.contentType, 'image/png');

    // Public GET without any auth headers
    const getRes = await handler({
      httpMethod: 'GET',
      path: uploaded.image.path,
      headers: {},
    } as any, {});
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.isBase64Encoded, true);
    assert.equal(getRes.headers?.['Content-Type'], 'image/png');
    assert.equal(getRes.headers?.['X-Content-Type-Options'], 'nosniff');
    assert.deepEqual(Buffer.from(getRes.body, 'base64'), VALID_PNG);

    // Rejects non-image upload
    const badMp = buildMultipartImage('evil.svg', Buffer.from('<svg></svg>'), 'image/svg+xml');
    const badRes = await handler({
      httpMethod: 'POST',
      path: '/api/public-images',
      headers: { ...staffHeaders, 'content-type': badMp.contentType },
      body: badMp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(badRes.statusCode, 400);

    // Staff DELETE cleans up
    const delRes = await handler({
      httpMethod: 'DELETE',
      path: uploaded.image.path,
      headers: staffHeaders,
    } as any, {});
    assert.equal(delRes.statusCode, 200);

    const afterDel = await handler({
      httpMethod: 'GET',
      path: uploaded.image.path,
      headers: {},
    } as any, {});
    assert.equal(afterDel.statusCode, 404);
  });

  it('allows sponsor/guest brief image upload via access code and staff auth on /api/sponsor-docs/:id/images', async () => {
    const client = await getClient();
    await putEmptyTemplate(client);
    const card = await createCard(client, { title: 'Test Brief Card', ...templateLink() });
    const created = await createSponsorDoc(client, {
      cardId: card.id,
      template: 'newsletter-main',
      title: 'Test Sponsor Brief',
    });

    // External access code upload succeeds
    const mp = buildMultipartImage('brief-visual.png', VALID_PNG);
    const extRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${created.doc.id}/images`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': mp.contentType },
      body: mp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(extRes.statusCode, 201, extRes.body);
    const extJson = JSON.parse(extRes.body);
    assert.match(extJson.image.path, /^\/api\/public-images\/[0-9a-f-]+\.png$/);

    // Public GET serves it
    const getRes = await handler({ httpMethod: 'GET', path: extJson.image.path, headers: {} } as any, {});
    assert.equal(getRes.statusCode, 200);

    // Wrong access code is rejected with 403
    const wrongRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${created.doc.id}/images`,
      headers: { 'x-sponsor-doc-code': 'WRNG-WRNG-WRNG-WRNG', 'content-type': mp.contentType },
      body: mp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(wrongRes.statusCode, 403);

    // Cleanup
    await handler({ httpMethod: 'DELETE', path: extJson.image.path, headers: staffHeaders } as any, {});
  });
});
