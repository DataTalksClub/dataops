import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import { getPerson } from '../db/people';
import { getFile } from '../db/files';
import { getTemplate } from '../db/templates';
import { createArtifactIfAbsent } from '../db/artifacts';
import { readFile } from '../storage';
import { getBannerJob, putBannerJob, transitionBannerJob } from './jobs';
import { BannerInputError, bannerId, checksum, composeBanner, pngDimensions, portraitContentType, type BannerInput, type BannerSpeaker, type BannerJob, type BannerBundle, type BannerLogo } from './model';

const s3 = new S3Client({});
const lambda = new LambdaClient({});
const sqs = new SQSClient({});
class BannerFailure extends Error { constructor(readonly code: string) { super(code); } }
export function bannerFailureCode(error: unknown, stage: string): string {
  if (error instanceof BannerFailure) return error.code;
  const name = (error as { name?: string })?.name;
  if (name === 'CodeArtifactUserPendingException' || name === 'ResourceNotReadyException') return 'renderer-cold-activating';
  if (name === 'AccessDeniedException' || name === 'AccessDenied') return `${stage}-access-denied`;
  if (name === 'TooManyRequestsException' || name === 'TimeoutError' || name === 'ServiceException') return `${stage}-temporarily-unavailable`;
  return `${stage}-failed`;
}
export function bannerConfig() {
  const bucket = process.env.TASK_FILES_BUCKET;
  const bundleBucket = process.env.KNOWLEDGE_BUCKET;
  const bundleKey = process.env.BANNER_TEMPLATE_BUNDLE_KEY;
  const renderer = process.env.BANNER_RENDERER_ARN;
  const queueUrl = process.env.BANNER_QUEUE_URL;
  if (!bucket || !bundleBucket || !bundleKey || !renderer || !queueUrl) throw new BannerInputError('Card banner generation is not configured on this deployment.');
  return { bucket, bundleBucket, bundleKey, renderer, queueUrl };
}
export async function requestBanner(client: DynamoDBDocumentClient, cardId: string, input: BannerInput, actorId: string): Promise<BannerJob> {
  const config = bannerConfig();
  const card = await getCardConsistent(client, cardId);
  if (!card?.title?.trim()) throw new BannerInputError('The Card must exist and have a title.');
  if (card.title.length > 180) throw new BannerInputError('Card title exceeds the banner limit of 180 characters.');
  const cardTemplate = await getTemplate(client, card.templateId);
  const classifications = new Set([cardTemplate?.type, ...(card.tags || [])]
    .map(value => value?.trim().toLowerCase()).filter(value => ['workshop', 'webinar', 'podcast'].includes(value || '')));
  if (classifications.size === 1 && !classifications.has(input.eventType)) {
    throw new BannerInputError(`Event type contradicts this Card's ${[...classifications][0]} classification. Confirm/correct Card facts before choosing the icon.`);
  }
  const speakers: BannerSpeaker[] = [];
  for (const selection of input.speakers) {
    if (!card.people?.includes(selection.personId)) throw new BannerInputError('Each speaker must be linked to this Card in the People register.');
    const person = await getPerson(client, selection.personId);
    const file = await getFile(client, selection.portraitFileId);
    if (!person || person.name.length > 70 || !file || file.cardId !== cardId || file.category !== 'image'
      || !file.checksum) {
      throw new BannerInputError('Each speaker needs a registered name and a verified PNG/JPEG/WebP portrait file belonging to this Card.');
    }
    speakers.push({ ...selection, name: person.name, personVersion: person.version, checksum: file.checksum });
  }
  let sponsorLogo: BannerLogo | undefined;
  if (input.sponsorLogoFileId) {
    const file = await getFile(client, input.sponsorLogoFileId);
    if (!file || file.cardId !== cardId || file.category !== 'image' || !file.checksum) throw new BannerInputError('The approved sponsor logo must be an image file saved on this Card.');
    sponsorLogo = { fileId: file.id, checksum: file.checksum, treatment: 'approved-logo' };
  }
  const id = bannerId(card, input, speakers, config.bundleKey, sponsorLogo);
  const now = new Date().toISOString();
  const job = await putBannerJob(client, { id, cardId, title: card.title, input, speakers, ...(sponsorLogo ? { sponsorLogo } : {}), state: 'queued', createdBy: actorId, createdAt: now, updatedAt: now, bundleKey: config.bundleKey });
  if (job.state === 'succeeded' || job.state === 'rendering') return job;
  // Failed delivery/render retries retain the same immutable renderer output key.
  if (job.state === 'failed') {
    if (!await transitionBannerJob(client, job, 'queued', { error: '' })) return (await getBannerJob(client, id))!;
  }
  try { await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify({ schema: 'dataops.card-banner.v1', jobId: id }) })); }
  catch { await transitionBannerJob(client, { ...job, state: 'queued' }, 'failed', { error: 'queue-delivery-failed' }); }
  return (await getBannerJob(client, id))!;
}
async function objectBytes(bucket: string, key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error('Missing object body');
  return Buffer.from(await result.Body.transformToByteArray());
}
export async function renderBannerJob(client: DynamoDBDocumentClient, id: string): Promise<void> {
  const config = bannerConfig();
  const job = await getBannerJob(client, id);
  if (!job || job.state === 'succeeded' || job.state === 'failed') return;
  if (job.state === 'rendering' && (job.leaseUntil || 0) > Date.now()) throw new Error('Banner job lease is active');
  const leaseUntil = Date.now() + 150_000;
  if (!await transitionBannerJob(client, job, 'rendering', { leaseUntil, attempt: (job.attempt || 0) + 1 })) throw new Error('Banner job was claimed concurrently');
  const claimed = { ...job, state: 'rendering' as const, leaseUntil };
  let stage = 'template';
  try {
    const bundleBytes = await objectBytes(config.bundleBucket, job.bundleKey);
    const bundleHash = /^banner-templates\/([a-f0-9]{64})\/bundle.json$/.exec(job.bundleKey)?.[1];
    if (!bundleHash || checksum(bundleBytes) !== `sha256:${bundleHash}`) throw new BannerFailure('template-checksum-mismatch');
    const bundle = JSON.parse(bundleBytes.toString('utf8')) as BannerBundle;
    if (bundle.schema !== 'dataops.banner-templates.v1' || !bundle.sourceRevision) throw new BannerFailure('invalid-template-bundle');
    const template = bundle.templates.find(t => t.eventType === job.input.eventType && t.layout === job.input.layout && t.speakerCount === job.speakers.length && t.sponsorTreatment === job.input.sponsorTreatment);
    if (!template || template.width < 1 || template.height < 1 || template.width > 4000 || template.height > 4000) throw new BannerFailure('unsupported-template');
    stage = 'portrait';
    const portraits: string[] = [];
    for (const speaker of job.speakers) {
      const file = await getFile(client, speaker.portraitFileId);
      if (!file || file.cardId !== job.cardId || file.checksum !== speaker.checksum) throw new BannerFailure('portrait-changed');
      const bytes = await readFile(file);
      if (checksum(bytes) !== speaker.checksum) throw new BannerFailure('portrait-checksum-mismatch');
      portraits.push(`data:${portraitContentType(bytes)};base64,${bytes.toString('base64')}`);
    }
    let logoData: string | undefined;
    if (job.sponsorLogo) {
      stage = 'sponsor-logo';
      const file = await getFile(client, job.sponsorLogo.fileId);
      if (!file || file.cardId !== job.cardId || file.category !== 'image' || file.checksum !== job.sponsorLogo.checksum) throw new BannerFailure('sponsor-logo-changed');
      const bytes = await readFile(file);
      if (checksum(bytes) !== job.sponsorLogo.checksum) throw new BannerFailure('sponsor-logo-checksum-mismatch');
      logoData = `data:${portraitContentType(bytes)};base64,${bytes.toString('base64')}`;
    }
    const html = composeBanner(template, job, portraits, bundle.assets, logoData);
    const prefix = `cards/${job.cardId}/banners/${id}`;
    const inputKey = `${prefix}/input.html`;
    const outputKey = `${prefix}/banner.png`;
    stage = 'renderer';
    await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: inputKey, Body: html, ContentType: 'text/html; charset=utf-8' }));
    const result = await lambda.send(new InvokeCommand({ FunctionName: config.renderer, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({
      schema: 'html-renderer.job.v1', job_id: id,
      input: { bucket: config.bucket, key: inputKey }, output: { bucket: config.bucket, key: outputKey },
      format: 'png', viewport: { width: template.width, height: template.height },
    })) }));
    if (result.FunctionError || !result.Payload) throw new BannerFailure('renderer-invocation-failed');
    const completion = JSON.parse(Buffer.from(result.Payload).toString('utf8'));
    if (completion.schema !== 'html-renderer.completed.v1' || completion.job_id !== id || completion.output?.bucket !== config.bucket || completion.output?.key !== outputKey) throw new BannerFailure('renderer-invalid-completion');
    stage = 'integrity';
    const bytes = await objectBytes(config.bucket, outputKey);
    const dimensions = pngDimensions(bytes);
    if (dimensions.width !== template.width || dimensions.height !== template.height) throw new BannerFailure('output-dimensions-mismatch');
    stage = 'attachment';
    const card = await getCardConsistent(client, job.cardId);
    if (!card) throw new BannerFailure('card-deleted');
    const artifactId = `banner-${id}`;
    const { artifact } = await createArtifactIfAbsent(client, {
      id: artifactId, cardId: job.cardId, type: 'other', title: `${job.title} — ${job.input.layout} ${job.input.eventType} cover`,
      status: 'needs-review', storageProvider: 's3', storageUri: `s3://${config.bucket}/${outputKey}`,
      filename: `${job.input.eventType}-${job.input.layout}-${id.slice(0, 12)}.png`, contentType: 'image/png',
      checksum: checksum(bytes), sizeBytes: bytes.length, visibility: 'private', dataClass: 'internal',
      sourceType: 'system', createdBy: job.createdBy,
      metadata: { bannerJobId: id, ...dimensions, format: 'png', templateId: template.id, templateSourceRevision: bundle.sourceRevision, templateBundleChecksum: checksum(bundleBytes), inputChecksum: checksum(Buffer.from(html)), eventType: job.input.eventType, layout: job.input.layout, title: job.title, speakers: job.speakers, ...(job.sponsorLogo ? { sponsorLogo: job.sponsorLogo } : {}) },
    });
    await updateCardAdditive(client, card, current => ({ artifactRefs: [...(current.artifactRefs || []).filter(ref => ref.artifactId !== artifactId), { artifactId, type: artifact.type, title: artifact.title, status: artifact.status }] }));
    await transitionBannerJob(client, claimed, 'succeeded', { artifactId, error: '' });
  } catch (error) {
    // Deliberately exclude provider errors/URLs/payloads from durable status and logs.
    await transitionBannerJob(client, claimed, 'failed', { error: bannerFailureCode(error, stage) });
  }
}
