import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { listUndismissedNotifications } from '../src/db/notifications';
import { putEmptyTemplate, templateLink } from './helpers/cardTemplate';
import {
  assertGuestPhoto,
  GUEST_PHOTO_TOO_SMALL_MESSAGE,
  GuestPhotoError,
  hostedPublicImageId,
  MIN_GUEST_PHOTO_SIDE,
} from '../src/guestPhoto';
import { getSponsorDocTemplate } from '../src/sponsorDocs/templates';

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A flat grey PNG of the given size: decodes fully and stays small on the wire. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((1 + width) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (1 + width)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function multipart(content: Buffer) {
  const boundary = '----GuestPhotoBoundary' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat([head, content, tail]).toString('base64') };
}

describe('guest photo rule: shorter side at least 800 px', () => {
  let uploadDir = '';
  let prevUploadDir: string | undefined;
  let prevProvider: string | undefined;

  before(async () => {
    const client = await getClient(await startLocal());
    await createTables(client);
    await putEmptyTemplate(client);
    prevUploadDir = process.env.UPLOAD_DIR;
    prevProvider = process.env.DATAOPS_FILE_STORAGE_PROVIDER;
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-guest-photo-'));
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

  async function upload(docId: string, accessCode: string, image: Buffer, field?: string) {
    const mp = multipart(image);
    return handler({
      httpMethod: 'POST',
      path: `/api/sponsor-docs/${docId}/images`,
      headers: { 'x-sponsor-doc-code': accessCode, 'content-type': mp.contentType },
      queryStringParameters: field ? { field } : {},
      body: mp.body,
      isBase64Encoded: true,
    } as any, {});
  }

  async function guestDoc(template: 'webinar' | 'workshop' | 'podcast' = 'webinar') {
    const client = await getClient();
    const card = await createCard(client, { title: `Guest photo ${template} ${Math.random()}`, ...templateLink() });
    return createSponsorDoc(client, { cardId: card.id, template, title: `Guest ${template} form` });
  }

  it('measures the shorter side and accepts only JPG, PNG and WebP', () => {
    assert.equal(MIN_GUEST_PHOTO_SIDE, 800);
    assert.doesNotThrow(() => assertGuestPhoto({ ext: 'jpg', width: 800, height: 800 }));
    assert.doesNotThrow(() => assertGuestPhoto({ ext: 'webp', width: 1200, height: 800 }));
    assert.throws(() => assertGuestPhoto({ ext: 'png', width: 2000, height: 799 }), (error: unknown) =>
      error instanceof GuestPhotoError && error.code === 'guest_photo_too_small'
      && error.message.startsWith(GUEST_PHOTO_TOO_SMALL_MESSAGE) && error.message.includes('2000 × 799'));
    assert.throws(() => assertGuestPhoto({ ext: 'gif', width: 1000, height: 1000 }), (error: unknown) =>
      error instanceof GuestPhotoError && error.code === 'guest_photo_format');
  });

  it('recognises DataOps-hosted photo URLs only', () => {
    const id = '11111111-1111-4111-8111-111111111111.png';
    assert.equal(hostedPublicImageId(`https://ops.example.test/api/public-images/${id}`), id);
    assert.equal(hostedPublicImageId(`/api/public-images/${id}`), id);
    assert.equal(hostedPublicImageId('https://media.licdn.com/dms/image/shrink_100_100/photo.jpg'), null);
    assert.equal(hostedPublicImageId(''), null);
  });

  it('every guest form states the requirement next to the photo field', () => {
    for (const type of ['podcast', 'webinar', 'workshop'] as const) {
      const field = getSponsorDocTemplate(type).sections.flatMap(section => section.fields).find(f => f.key === 'photoUrl')!;
      assert.match(field.helpText || '', /800 × 800 pixels/, type);
      assert.match(field.helpText || '', /JPG, PNG or WebP/, type);
    }
  });

  it('rejects a too-small guest form photo upload with the guest-facing message and no ops alert', async () => {
    const created = await guestDoc('webinar');
    const small = await upload(created.doc.id, created.accessCode, png(128, 128), 'photoUrl');
    assert.equal(small.statusCode, 400, small.body);
    const body = JSON.parse(small.body);
    assert.equal(body.code, 'guest_photo_too_small');
    assert.ok(body.error.startsWith(GUEST_PHOTO_TOO_SMALL_MESSAGE), body.error);
    assert.match(body.error, /128 × 128/);
    const notifications = await listUndismissedNotifications(await getClient());
    assert.ok(!notifications.some(n => n.metadata?.docId === created.doc.id), 'a guest photo rejection is not an upload failure alert');

    const ok = await upload(created.doc.id, created.accessCode, png(800, 1000), 'photoUrl');
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(JSON.parse(ok.body).image.width, 800);

    // Other visuals on the same form keep their own rules.
    const otherVisual = await upload(created.doc.id, created.accessCode, png(128, 128));
    assert.equal(otherVisual.statusCode, 201, otherVisual.body);
  });

  it('refuses a guest form save that points the photo at a small hosted image, and keeps an unchanged one', async () => {
    const created = await guestDoc('podcast');
    const smallUpload = JSON.parse((await upload(created.doc.id, created.accessCode, png(400, 400))).body).image;
    const bigUpload = JSON.parse((await upload(created.doc.id, created.accessCode, png(900, 900), 'photoUrl')).body).image;
    const save = (photoUrl: string, extra: Record<string, string> = {}) => handler({
      httpMethod: 'PUT',
      path: `/api/sponsor-docs/${created.doc.id}`,
      headers: { 'x-sponsor-doc-code': created.accessCode, 'content-type': 'application/json' },
      body: JSON.stringify({ content: { photoUrl, ...extra } }),
    } as any, {});

    const refused = await save(smallUpload.url);
    assert.equal(refused.statusCode, 422, refused.body);
    assert.ok(JSON.parse(refused.body).fields.photoUrl.startsWith(GUEST_PHOTO_TOO_SMALL_MESSAGE));

    assert.equal((await save(bigUpload.url)).statusCode, 200);
    // A link to a photo hosted elsewhere cannot be measured and is saved for review.
    assert.equal((await save('https://example.com/headshot.jpg')).statusCode, 200);

    // A stored small photo does not block saving the rest of the form.
    const client = await getClient();
    const { updateSponsorDoc } = await import('../src/db/sponsorDocs');
    await updateSponsorDoc(client, created.doc.id, { content: { photoUrl: smallUpload.url }, actorKind: 'staff' });
    assert.equal((await save(smallUpload.url, { guestName: 'Ada Example' })).statusCode, 200);
  });

  it('applies the rule to a People register photo hosted by DataOps', async () => {
    const created = await guestDoc('workshop');
    const small = JSON.parse((await upload(created.doc.id, created.accessCode, png(128, 128))).body).image;
    const big = JSON.parse((await upload(created.doc.id, created.accessCode, png(1000, 800), 'photoUrl')).body).image;
    const invoke = (method: string, url: string, body: unknown) =>
      handler({ httpMethod: method, path: url, headers: {}, queryStringParameters: {}, body: JSON.stringify(body) } as any, {});

    const refused = await invoke('POST', '/api/people', { name: 'Photo Small', slug: 'photo-small', photoUrl: small.url });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.ok(JSON.parse(refused.body).error.startsWith(GUEST_PHOTO_TOO_SMALL_MESSAGE));

    const person = await invoke('POST', '/api/people', { name: 'Photo Big', slug: 'photo-big', photoUrl: big.url });
    assert.equal(person.statusCode, 201, person.body);
    const { id, version } = JSON.parse(person.body);
    const downgrade = await invoke('PUT', `/api/people/${id}`, { version, photoUrl: small.url });
    assert.equal(downgrade.statusCode, 400, downgrade.body);
    const external = await invoke('PUT', `/api/people/${id}`, { version, photoUrl: 'https://example.com/headshot.jpg' });
    assert.equal(external.statusCode, 200, external.body);
  });
});
