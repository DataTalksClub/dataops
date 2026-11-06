import { after, before, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createCard, getCardConsistent } from '../src/db/cards';
import { createArtifact, getArtifact, listArtifacts } from '../src/db/artifacts';
import { TABLE_PEOPLE, TABLE_FILES } from '../src/db/tableNames';
import { templateLink } from './helpers/cardTemplate';
import { requestBanner, renderBannerJob, bannerFailureCode } from '../src/banners/service';
import { getBannerJob, transitionBannerJob } from '../src/banners/jobs';
import { parseBannerInput, composeBanner, checksum, type BannerJob, type BannerTemplate } from '../src/banners/model';
import { handleCardBannerRoutes } from '../src/routes/cardBanners';
import { handleArtifactRoutes, setArtifactDownloadSignerForTests } from '../src/routes/artifacts';

let client: DynamoDBDocumentClient;
const objects = new Map<string, Buffer>();
let renderCount = 0;
let queueFails = false;
let rendererFails = false;
const png = Buffer.alloc(24);
png.write('89504e470d0a1a0a', 0, 'hex'); png.write('IHDR', 12); png.writeUInt32BE(2400, 16); png.writeUInt32BE(1350, 20);
const template: BannerTemplate = { id: 'synthetic-workshop', eventType: 'workshop', layout: 'landscape', speakerCount: 1, width: 2400, height: 1350, html: '<h1>{{title}}</h1><p>{{speaker1Name}}</p><img src="{{speaker1Portrait}}">' };
const input = parseBannerInput({ eventType: 'workshop', layout: 'landscape', speakers: [{ personId: 'speaker', portraitFileId: 'portrait' }], revision: 'test-v1' });

before(async () => {
  client = await getClient(await startLocal()); await createTables(client);
  Object.assign(process.env, { NODE_ENV: 'test', SKIP_AUTH: 'true', TASK_FILES_BUCKET: 'synthetic-files', KNOWLEDGE_BUCKET: 'synthetic-knowledge', BANNER_TEMPLATE_BUNDLE_KEY: 'templates/immutable.json', BANNER_RENDERER_ARN: 'synthetic-renderer', BANNER_QUEUE_URL: 'synthetic-queue' });
  const sponsored = { ...template, id: 'synthetic-approved-logo', sponsorTreatment: 'approved-logo', html: `${template.html}<img class="sponsor" src="{{sponsorLogo}}">` };
  const bundle = Buffer.from(JSON.stringify({ schema: 'dataops.banner-templates.v1', sourceRevision: 'synthetic-commit', templates: [template, sponsored, { ...template, id: "synthetic-three", speakerCount: 3, html: template.html + "<p>{{speaker2Name}}</p><img src=\"{{speaker2Portrait}}\"><p>{{speaker3Name}}</p><img src=\"{{speaker3Portrait}}\">" }] }));
  const bundleKey = `banner-templates/${checksum(bundle).slice(7)}/bundle.json`;
  process.env.BANNER_TEMPLATE_BUNDLE_KEY = bundleKey;
  objects.set(bundleKey, bundle);
  objects.set('tasks/task/portrait.png', png);
  mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, Buffer.from(command.input.Body as string)); return {}; }
    if (command instanceof GetObjectCommand) { const bytes = objects.get(command.input.Key!); if (!bytes) throw new Error('Missing synthetic object'); return { Body: { transformToByteArray: async () => bytes } }; }
    throw new Error('Unexpected S3 command');
  });
  mock.method(SQSClient.prototype, 'send', async () => { if (queueFails) throw new Error('secret-provider-url-must-not-leak'); return {}; });
  mock.method(LambdaClient.prototype, 'send', async (command: { input: { Payload: Uint8Array } }) => {
    renderCount++; if (rendererFails) throw Object.assign(new Error('secret-cold-provider-detail'), { name: 'CodeArtifactUserPendingException' });
    const job = JSON.parse(Buffer.from(command.input.Payload).toString());
    objects.set(job.output.key, png);
    return { Payload: Buffer.from(JSON.stringify({ schema: 'html-renderer.completed.v1', job_id: job.job_id, output: job.output })) };
  });
  await createCard(client, { id: 'card', title: 'Build <a> reliable media agent', people: ['speaker'], ...templateLink(), selectedOptionalGroups: [] });
  await createCard(client, { id: 'other-card', title: 'Other Card', ...templateLink(), selectedOptionalGroups: [] });
  await client.send(new PutCommand({ TableName: TABLE_PEOPLE, Item: { PK: 'PERSON#speaker', SK: 'PERSON#speaker', id: 'speaker', name: 'Synthetic & Speaker', version: 1 } }));
  await client.send(new PutCommand({ TableName: TABLE_FILES, Item: { PK: 'FILE#portrait', SK: 'FILE#portrait', id: 'portrait', cardId: 'card', taskId: 'task', category: 'image', contentType: 'image/png', checksum: checksum(png), storageProvider: 's3', storagePath: 'tasks/task/portrait.png', storageUri: 's3://synthetic-files/tasks/task/portrait.png' } }));
  await client.send(new PutCommand({ TableName: TABLE_FILES, Item: { PK: 'FILE#logo', SK: 'FILE#logo', id: 'logo', cardId: 'card', taskId: 'task', category: 'image', contentType: 'application/octet-stream', checksum: checksum(png), storageProvider: 's3', storagePath: 'tasks/task/portrait.png', storageUri: 's3://synthetic-files/tasks/task/portrait.png' } }));
});
after(async () => { mock.restoreAll(); await stopLocal(); });

test('queues durable progress, saves one Card image with provenance and preserves approved assets', async () => {
  await createArtifact(client, { id: 'approved-cover', cardId: 'card', status: 'approved', title: 'Approved older cover' });
  const job = await requestBanner(client, 'card', input, 'operator');
  assert.equal(job.state, 'queued');
  await renderBannerJob(client, job.id);
  const completed = (await getBannerJob(client, job.id))!;
  assert.equal(completed.state, 'succeeded');
  const artifact = (await getArtifact(client, completed.artifactId!))!;
  assert.equal(artifact.cardId, 'card'); assert.equal(artifact.status, 'needs-review');
  assert.equal(artifact.checksum, checksum(png)); assert.equal(artifact.metadata?.width, 2400);
  assert.equal(artifact.metadata?.templateSourceRevision, 'synthetic-commit');
  assert.equal((await getCardConsistent(client, 'card'))?.artifactRefs?.filter(ref => ref.artifactId === artifact.id).length, 1);
  assert.equal((await getArtifact(client, 'approved-cover'))?.status, 'approved');
  setArtifactDownloadSignerForTests(async (_client, command) => {
    assert.equal((command as GetObjectCommand).input.Key, `cards/card/banners/${job.id}/banner.png`);
    return 'https://synthetic-storage.test/private-image';
  });
  const download = await handleArtifactRoutes({ httpMethod: 'GET', path: `/api/artifacts/${artifact.id}/download` });
  assert.equal(download?.statusCode, 200);
  assert.equal(JSON.parse(download!.body).expiresIn, 300);
  await createArtifact(client, { id: 'mismatched-banner', cardId: 'other-card', sourceType: 'system', metadata: { bannerJobId: job.id }, storageUri: artifact.storageUri });
  assert.equal((await handleArtifactRoutes({ httpMethod: 'GET', path: '/api/artifacts/mismatched-banner/download' }))?.statusCode, 409);
  const before = renderCount;
  assert.equal((await requestBanner(client, 'card', input, 'operator')).id, job.id);
  await renderBannerJob(client, job.id); assert.equal(renderCount, before);
  const wrongCard = await handleCardBannerRoutes({ path: `/api/cards/other-card/banners/${job.id}`, httpMethod: 'GET' }, client);
  assert.equal(wrongCard?.statusCode, 404);
});
test('cold activation is actionable and retry keeps job identity', async () => {
  const request = { ...input, revision: 'cold' };
  const job = await requestBanner(client, 'card', request, 'operator');
  rendererFails = true; await renderBannerJob(client, job.id); rendererFails = false;
  const failed = (await getBannerJob(client, job.id))!;
  assert.equal(failed.error, 'renderer-cold-activating'); assert.equal(failed.state, 'failed');
  assert.equal(JSON.stringify(failed).includes('secret-cold-provider-detail'), false);
  const retry = await requestBanner(client, 'card', request, 'operator'); assert.equal(retry.id, job.id);
  await renderBannerJob(client, job.id); assert.equal((await getBannerJob(client, job.id))?.state, 'succeeded');
});
test('expired worker lease recovers and interrupted attachment repairs a single artifact', async () => {
  const request = { ...input, revision: 'interruption' };
  const job = await requestBanner(client, 'card', request, 'operator');
  await transitionBannerJob(client, job, 'rendering', { leaseUntil: Date.now() - 1 });
  const send = client.send.bind(client);
  let breakCardUpdate = true;
  const restore = mock.method(client, 'send', async (command: { input: { TableName?: string; UpdateExpression?: string } }, ...args: unknown[]) => {
    if (breakCardUpdate && command.input.TableName?.endsWith('cards') && command.input.UpdateExpression) { breakCardUpdate = false; throw new Error('Synthetic interrupted attachment'); }
    return (send as (...parameters: unknown[]) => Promise<unknown>)(command, ...args);
  });
  await renderBannerJob(client, job.id); restore.mock.restore();
  assert.equal((await getBannerJob(client, job.id))?.error, 'attachment-failed');
  assert.ok(await getArtifact(client, `banner-${job.id}`));
  await requestBanner(client, 'card', request, 'operator'); await renderBannerJob(client, job.id);
  assert.equal((await getBannerJob(client, job.id))?.state, 'succeeded');
  assert.equal((await listArtifacts(client, { cardId: 'card' })).filter(item => item.id === `banner-${job.id}`).length, 1);
  assert.equal((await getCardConsistent(client, 'card'))?.artifactRefs?.filter(ref => ref.artifactId === `banner-${job.id}`).length, 1);
});
test('queue failure is durable, invalid speaker ownership rejected, HTML escaped', async () => {
  queueFails = true; const job = await requestBanner(client, 'card', { ...input, revision: 'queue' }, 'operator'); queueFails = false;
  assert.equal(job.state, 'failed'); assert.equal(job.error, 'queue-delivery-failed');
  await assert.rejects(requestBanner(client, 'other-card', input, 'operator'), /linked to this Card/);
  assert.throws(() => parseBannerInput({ ...input, speakers: [...input.speakers, ...input.speakers] }));
  const html = composeBanner(template, { title: '<script>', input, speakers: [{ name: 'A & B' }] } as BannerJob, ['data:image/png;base64,AA']);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /A &amp; B/);
  assert.equal(bannerFailureCode({ name: 'AccessDeniedException', message: 'secret' }, 'renderer'), 'renderer-access-denied');
});
test('sponsor logo needs explicit treatment, is Card-scoped, immutable and separately attributed', async () => {
  assert.throws(() => parseBannerInput({ ...input, sponsorLogoFileId: 'logo' }), /explicit approved-logo/);
  const sponsored = parseBannerInput({ ...input, revision: 'logo-test', sponsorLogoFileId: 'logo', sponsorTreatment: 'approved-logo' });
  const job = await requestBanner(client, 'card', sponsored, 'operator');
  assert.deepEqual(job.sponsorLogo, { fileId: 'logo', checksum: checksum(png), treatment: 'approved-logo' });
  await renderBannerJob(client, job.id);
  const completed = (await getBannerJob(client, job.id))!;
  assert.equal(completed.state, 'succeeded');
  const artifact = (await getArtifact(client, completed.artifactId!))!;
  assert.deepEqual(artifact.metadata?.sponsorLogo, job.sponsorLogo);
  const html = objects.get(`cards/card/banners/${job.id}/input.html`)!.toString();
  assert.match(html, /class="sponsor" src="data:image\/png/);
  assert.equal((await requestBanner(client, 'card', sponsored, 'operator')).id, job.id);
  assert.notEqual((await requestBanner(client, 'card', { ...input, revision: 'logo-test' }, 'operator')).id, job.id);
  await assert.rejects(requestBanner(client, 'card', { ...sponsored, sponsorLogoFileId: 'portrait-from-another-card' }, 'operator'), /saved on this Card/);
  const pending = await requestBanner(client, 'card', { ...sponsored, revision: 'logo-mutates' }, 'operator');
  await client.send(new PutCommand({ TableName: TABLE_FILES, Item: { PK: 'FILE#logo', SK: 'FILE#logo', id: 'logo', cardId: 'other-card', category: 'image', checksum: checksum(png) } }));
  await renderBannerJob(client, pending.id);
  assert.equal((await getBannerJob(client, pending.id))?.error, 'sponsor-logo-changed');
});
test('rejects a known event-type contradiction without guessing from title or company', async () => {
  await createCard(client, { id: 'classified', title: 'Synthetic event', tags: [' Workshop '], ...templateLink(), selectedOptionalGroups: [] });
  await assert.rejects(requestBanner(client, 'classified', { ...input, eventType: 'webinar' }, 'operator'), /contradicts.*workshop/);
  await createCard(client, { id: 'ambiguous', title: 'Workshop mentioned in a title', tags: ['Workshop', 'Webinar'], ...templateLink(), selectedOptionalGroups: [] });
  await assert.rejects(requestBanner(client, 'ambiguous', { ...input, eventType: 'webinar' }, 'operator'), /speaker must be linked/);
});


test('three speakers pass Card ownership, template composition and durable artifact provenance', async () => {
  const selections = [1, 2, 3].map(n => ({ personId: `panelist-${n}`, portraitFileId: `panelist-photo-${n}` }));
  await createCard(client, { id: 'panel-card', title: 'Synthetic panel', people: selections.map(s => s.personId), ...templateLink(), selectedOptionalGroups: [] });
  for (const [i, selection] of selections.entries()) {
    await client.send(new PutCommand({ TableName: TABLE_PEOPLE, Item: { PK: `PERSON#${selection.personId}`, SK: `PERSON#${selection.personId}`, id: selection.personId, name: `Panelist ${i + 1}`, version: 1 } }));
    await client.send(new PutCommand({ TableName: TABLE_FILES, Item: { PK: `FILE#${selection.portraitFileId}`, SK: `FILE#${selection.portraitFileId}`, id: selection.portraitFileId, cardId: 'panel-card', taskId: 'panel-task', category: 'image', checksum: checksum(png), storageProvider: 's3', storagePath: 'tasks/task/portrait.png', storageUri: 's3://synthetic-files/tasks/task/portrait.png' } }));
  }
  const panel = parseBannerInput({ ...input, speakers: selections, revision: 'panel' });
  const job = await requestBanner(client, 'panel-card', panel, 'operator');
  await renderBannerJob(client, job.id);
  const completed = (await getBannerJob(client, job.id))!;
  assert.equal(completed.state, 'succeeded', completed.error);
  const artifact = (await getArtifact(client, completed.artifactId!))!;
  assert.equal(artifact.metadata?.templateId, 'synthetic-three');
  assert.equal((artifact.metadata?.speakers as unknown[]).length, 3);
  const renderedInput = objects.get(`cards/panel-card/banners/${job.id}/input.html`)!.toString();
  for (const n of [1, 2, 3]) assert.match(renderedInput, new RegExp(`Panelist ${n}`));
  assert.throws(() => parseBannerInput({ ...panel, speakers: [...selections, { personId: 'fourth', portraitFileId: 'fourth-photo' }] }));
});
