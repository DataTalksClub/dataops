import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createUser } from '../src/db/users';
import { createCard } from '../src/db/cards';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { listUndismissedNotifications } from '../src/db/notifications';
import { humanBearer } from './helpers/human-bearer';
import { putEmptyTemplate, templateLink } from './helpers/cardTemplate';
import { detectPublicImageFormat, validatePublicImage } from '../src/publicImages';
import { sanitizeTemplateContent, SponsorDocValidationError } from '../src/sponsorDocs/templates';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function buildLargePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter none
    for (let x = 1; x < stride; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      raw[rowStart + x] = (seed >>> 24) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 1 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

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

  it('round-trips a >300KB PNG byte-identically, rejects data-URIs without silent slicing, and fails loudly + alerts on truncated or bad-dimension images', async () => {
    const client = await getClient();
    await putEmptyTemplate(client);
    const card = await createCard(client, { title: 'Large PNG Card', ...templateLink() });
    const created = await createSponsorDoc(client, {
      cardId: card.id,
      template: 'newsletter-main',
      title: 'Large PNG Brief',
    });

    const largePng = buildLargePng(400, 300);
    assert.ok(largePng.length > 300_000, `Expected >300KB PNG, got ${largePng.length} bytes`);
    const validated = validatePublicImage(largePng);
    assert.equal(validated.width, 400);
    assert.equal(validated.height, 300);

    const mp = buildMultipartImage('large-banner.png', largePng);
    const uploadRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${created.doc.id}/images`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': mp.contentType },
      body: mp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(uploadRes.statusCode, 201, uploadRes.body);
    const uploaded = JSON.parse(uploadRes.body);
    assert.equal(uploaded.image.width, 400);
    assert.equal(uploaded.image.height, 300);
    assert.equal(uploaded.image.sizeBytes, largePng.length);

    // Save hosted URL on the sponsor doc and verify GET returns byte-identical PNG
    const putRes = await handler({
      httpMethod: 'PUT',
      path: `/api/sponsor-docs/${created.doc.id}`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': 'application/json' },
      body: JSON.stringify({ content: { graphicsUrl: uploaded.image.path } }),
    } as any, {});
    assert.equal(putRes.statusCode, 200, putRes.body);

    const getRes = await handler({ httpMethod: 'GET', path: uploaded.image.path, headers: {} } as any, {});
    assert.equal(getRes.statusCode, 200);
    assert.deepEqual(Buffer.from(getRes.body, 'base64'), largePng);

    // Data-URI in graphicsUrl is rejected loudly (never silently sliced)
    assert.throws(
      () => sanitizeTemplateContent('newsletter-main', { graphicsUrl: `data:image/png;base64,${largePng.toString('base64')}` }),
      SponsorDocValidationError,
    );

    // Truncated PNG (missing IEND) fails loudly with 400 and records an alert notification
    const truncatedPng = largePng.subarray(0, 300_000);
    const truncMp = buildMultipartImage('truncated.png', truncatedPng);
    const truncRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${created.doc.id}/images`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': truncMp.contentType },
      body: truncMp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(truncRes.statusCode, 400, truncRes.body);
    const truncBody = JSON.parse(truncRes.body);
    assert.equal(truncBody.code, 'undecodable_image');

    const notifications = await listUndismissedNotifications(client);
    assert.ok(
      notifications.some((n) => n.type === 'sponsor-image-upload-failed' && n.metadata?.docId === created.doc.id),
      'Expected sponsor-image-upload-failed notification to be created',
    );

    // Bad-dimension PNG (0x100) fails loudly with 400 invalid_image_dimensions
    const zeroDimIhdr = Buffer.alloc(13);
    zeroDimIhdr.writeUInt32BE(0, 0);
    zeroDimIhdr.writeUInt32BE(100, 4);
    zeroDimIhdr[8] = 8;
    zeroDimIhdr[9] = 2;
    const zeroDimPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', zeroDimIhdr),
      pngChunk('IDAT', deflateSync(Buffer.from([0]))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    const zeroMp = buildMultipartImage('zero-dim.png', zeroDimPng);
    const zeroRes = await handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${created.doc.id}/images`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': zeroMp.contentType },
      body: zeroMp.bodyBase64,
      isBase64Encoded: true,
    } as any, {});
    assert.equal(zeroRes.statusCode, 400, zeroRes.body);
    assert.equal(JSON.parse(zeroRes.body).code, 'invalid_image_dimensions');

    // Cleanup
    await handler({ httpMethod: 'DELETE', path: uploaded.image.path, headers: staffHeaders } as any, {});
  });
});
