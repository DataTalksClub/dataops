import crypto from 'crypto';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createArtifactIfAbsent, getArtifact } from '../db/artifacts';
import {
  acquireMailingExportLease,
  createMailingExport,
  getMailingExport,
  listMailingExports,
  putMailingExport,
} from '../db/mailingExports';
import { getTask, updateTask } from '../db/tasks';
import { saveFile } from '../storage';
import { MailingExportProviderError } from './mailchimp';
import { readDapierMailchimpCredential, type MailingExportCredentialReader } from './credentials';
import { defaultMailingExportProviderRegistry, MailingExportProviderRegistry } from './registry';
import type {
  MailingExportConfig,
  MailingExportErrorCategory,
  MailingExportJob,
  MailingExportProvider,
} from './types';

const LEASE_MS = 120_000;

export interface MailingExportDependencies {
  provider?: MailingExportProvider;
  registry?: MailingExportProviderRegistry;
  readCredential?: MailingExportCredentialReader;
  store?: (key: string, body: Buffer) => Promise<string>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export function loadMailingExportConfigs(): MailingExportConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(process.env.DATAOPS_MAILING_EXPORTS_CONFIG || '[]'); }
  catch { throw new Error('DATAOPS_MAILING_EXPORTS_CONFIG must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('DATAOPS_MAILING_EXPORTS_CONFIG must be a JSON array');
  return parsed.filter(item => item && typeof item === 'object' && (item as { enabled?: boolean }).enabled !== false).map(item => {
    const value = item as Record<string, unknown>;
    if ('secretName' in value) throw new Error('Mailing export configuration secretName is not supported');
    for (const field of ['id', 'provider', 'account', 'credentialId']) {
      if (typeof value[field] !== 'string' || !String(value[field]).trim()) throw new Error(`Mailing export configuration ${field} is required`);
    }
    if (value.provider === 'mailchimp' && value.credentialId !== 'mailchimp') {
      throw new Error('Mailchimp mailing export configuration credentialId must be mailchimp');
    }
    const scopeLabel = typeof value.scopeLabel === 'string' && value.scopeLabel.trim()
      ? value.scopeLabel.trim()
      : typeof value.audience === 'string' && value.audience.trim() ? value.audience.trim() : 'All audiences';
    return {
      id: String(value.id), provider: String(value.provider), account: String(value.account), scopeLabel,
      credentialId: String(value.credentialId), enabled: true,
      taskId: typeof value.taskId === 'string' && value.taskId ? value.taskId : undefined,
    };
  });
}

export function publicMailingExportConfigs(configs = loadMailingExportConfigs()): Array<Omit<MailingExportConfig, 'credentialId'>> {
  return configs.map(({ credentialId: _credentialId, ...config }) => config);
}

async function defaultStore(key: string, body: Buffer): Promise<string> {
  const bucket = process.env.DATAOPS_MAILING_EXPORTS_BUCKET;
  if (bucket) {
    await new S3Client({}).send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: 'application/zip', ServerSideEncryption: 'AES256',
      Metadata: { sha256: crypto.createHash('sha256').update(body).digest('hex') },
    }));
    return `s3://${bucket}/${key}`;
  }
  if (process.env.NODE_ENV === 'test' || process.env.IS_LOCAL) return `local://${saveFile('mailing-exports', key.replaceAll('/', '_'), body)}`;
  throw new Error('Private export storage is not configured');
}

function classifyFailure(error: unknown): { category: MailingExportErrorCategory; message: string; nextAction: MailingExportJob['nextAction']; retryAfter?: string } {
  if (error instanceof MailingExportProviderError) {
    const messages: Record<string, string> = {
      authorization: 'Provider authorization failed. Fix the configured credential or account-wide API access.',
      'provider-api': 'The provider export API failed. Retry after checking provider availability.',
      'provider-timeout': 'The provider timed out. Retry to continue the durable export run.',
      'provider-concurrency': 'Another account export is active or the 24-hour limit applies. Wait, then retry this run.',
      'download-integrity': 'The completed provider download was not a valid ZIP archive. Retry the download.',
    };
    return {
      category: error.category,
      message: messages[error.category],
      nextAction: error.category === 'authorization' ? 'fix-authorization' : error.category === 'provider-concurrency' ? 'wait' : 'retry',
      retryAfter: error.retryAfter,
    };
  }
  if (error instanceof Error && /storage|bucket|s3/i.test(error.message)) {
    return { category: 'storage', message: 'Private export storage failed. Fix bucket access, then retry.', nextAction: 'fix-storage' };
  }
  return { category: 'persistence', message: 'The export state could not be saved. Retry with the same run key.', nextAction: 'retry' };
}

function isZip(body: Buffer): boolean {
  return body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b
    && ((body[2] === 0x03 && body[3] === 0x04) || (body[2] === 0x05 && body[3] === 0x06) || (body[2] === 0x07 && body[3] === 0x08));
}

function safeFilename(value: string | undefined, config: MailingExportConfig, runKey: string): string {
  const fallback = `${config.provider}-${config.id}-${runKey}.zip`;
  const candidate = path.posix.basename(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '-');
  return candidate.toLowerCase().endsWith('.zip') ? candidate : `${candidate}.zip`;
}

function audit(deps: MailingExportDependencies, job: MailingExportJob, transition: string): void {
  (deps.log || (entry => console.info(JSON.stringify(entry))))({
    event: 'mailing-export-transition', configId: job.configId, runId: job.id, status: job.status, transition,
    ...(job.errorCode ? { errorCategory: job.errorCode } : {}),
  });
}

async function persist(
  client: DynamoDBDocumentClient, job: MailingExportJob, owner: string, deps: MailingExportDependencies, transition: string,
): Promise<MailingExportJob> {
  job.leaseExpiresAt = 0;
  await putMailingExport(client, job, owner);
  audit(deps, job, transition);
  return job;
}

async function attachTask(
  client: DynamoDBDocumentClient, config: MailingExportConfig, job: MailingExportJob,
): Promise<void> {
  if (!config.taskId) { job.taskLinkStatus = 'not-configured'; return; }
  const task = await getTask(client, config.taskId);
  if (!task) {
    Object.assign(job, {
      taskLinkStatus: 'missing', errorCode: 'task-link',
      errorMessage: 'The export is stored, but the configured recurring task no longer exists.', nextAction: 'fix-task-link',
    });
    return;
  }
  const artifact = job.artifactId ? await getArtifact(client, job.artifactId) : null;
  if (!artifact) throw new Error('Stored artifact metadata is unavailable');
  try {
    await updateTask(client, config.taskId, {
      artifactRefs: [...(task.artifactRefs || []).filter(ref => ref.artifactId !== artifact.id), {
        artifactId: artifact.id, type: artifact.type, title: artifact.title,
        status: artifact.status,
      }],
    });
    job.taskLinkStatus = 'linked';
  } catch {
    Object.assign(job, {
      taskLinkStatus: 'failed', errorCode: 'task-link',
      errorMessage: 'The export is stored, but linking it to the recurring task failed.', nextAction: 'fix-task-link',
    });
  }
}

export async function runMailingExport(
  client: DynamoDBDocumentClient,
  inputConfig: MailingExportConfig,
  runKey: string,
  deps: MailingExportDependencies = {},
): Promise<MailingExportJob> {
  if (!runKey.trim() || runKey.length > 120) throw new Error('runKey must be 1-120 characters');
  const config = { ...inputConfig, scopeLabel: inputConfig.scopeLabel || 'All audiences' };
  const id = crypto.createHash('sha256').update(`${config.id}:${runKey}`).digest('hex').slice(0, 32);
  const clock = deps.now || (() => new Date());
  const nowDate = clock();
  const now = nowDate.toISOString();
  const owner = crypto.randomUUID();

  let job = await getMailingExport(client, id);
  if (job?.status === 'completed' && (!config.taskId || job.taskLinkStatus === 'linked' || job.taskLinkStatus === 'not-configured')) return job;

  if (!job) {
    const initial: MailingExportJob = {
      id, configId: config.id, provider: config.provider, account: config.account, scopeLabel: config.scopeLabel,
      runKey, taskId: config.taskId, status: 'requested', requestedAt: now, createdAt: now, updatedAt: now,
      nextAction: 'wait', leaseOwner: owner, leaseExpiresAt: nowDate.getTime() + LEASE_MS,
    };
    const claimed = await createMailingExport(client, initial);
    job = claimed.job;
    if (!claimed.created) {
      const leased = await acquireMailingExportLease(client, id, owner, nowDate.getTime(), LEASE_MS);
      if (!leased) return job;
      job = leased;
    }
  } else {
    const leased = await acquireMailingExportLease(client, id, owner, nowDate.getTime(), LEASE_MS);
    if (!leased) return job;
    job = leased;
  }

  try {
    if (job.status === 'completed' && job.artifactId) {
      await attachTask(client, config, job);
      job.updatedAt = now;
      return await persist(client, job, owner, deps, 'task-link-retry');
    }

    const registry = deps.registry || defaultMailingExportProviderRegistry;
    const minimumIntervalMs = deps.provider?.minimumIntervalMs ?? registry.minimumIntervalMs(config.provider);
    const recent = minimumIntervalMs > 0 ? (await listMailingExports(client)).find(item =>
      item.id !== id && item.configId === config.id && item.status === 'completed' && item.completedAt
      && nowDate.getTime() - new Date(item.completedAt).getTime() < minimumIntervalMs,
    ) : undefined;
    if (!job.providerJobId && recent?.completedAt) {
      const retryAfter = new Date(new Date(recent.completedAt).getTime() + minimumIntervalMs).toISOString();
      if (new Date(retryAfter).getTime() > nowDate.getTime()) {
        Object.assign(job, {
          status: 'pending', errorCode: 'provider-concurrency',
          errorMessage: 'Mailchimp allows one completed account export per 24 hours. Wait, then retry this run.',
          nextAction: 'wait', retryAfter, updatedAt: now,
        });
        return await persist(client, job, owner, deps, 'daily-limit');
      }
    }
    if (job.retryAfter && new Date(job.retryAfter).getTime() > nowDate.getTime()) {
      return await persist(client, job, owner, deps, 'waiting');
    }

    delete job.errorCode; delete job.errorMessage; delete job.retryAfter;
    const credential = deps.provider ? undefined : await (deps.readCredential || readDapierMailchimpCredential)(config.credentialId);
    const provider = deps.provider || registry.create(config.provider, credential!);
    const result = job.providerJobId ? await provider.checkExport(job.providerJobId) : await provider.requestExport();
    job.providerJobId = result.providerJobId;
    job.updatedAt = now;
    if (result.status === 'pending' || !result.downloadUrl) {
      Object.assign(job, { status: 'pending', nextAction: 'wait', retryAfter: result.retryAfter });
      return await persist(client, job, owner, deps, 'pending');
    }

    const body = await provider.download(result.downloadUrl);
    if (!isZip(body)) throw new MailingExportProviderError('download-integrity', 'Provider download was not a ZIP');
    const checksum = crypto.createHash('sha256').update(body).digest('hex');
    const filename = safeFilename(result.filename, config, runKey);
    const objectKey = path.posix.join('mailing-exports', config.provider, config.id, id, filename);
    let storageUri: string;
    try { storageUri = await (deps.store || defaultStore)(objectKey, body); }
    catch { throw new Error('Private export storage failed'); }
    const artifactId = `mailing-export-${id}`;
    const { artifact } = await createArtifactIfAbsent(client, {
      id: artifactId, type: 'report', title: `${config.provider} account audiences export`, status: 'approved',
      storageProvider: storageUri.startsWith('s3://') ? 's3' : 'local-dev', storageUri,
      dataClass: 'private', visibility: 'private', sourceType: 'system', filename,
      contentType: 'application/zip', checksum, sizeBytes: body.length, taskId: config.taskId,
      metadata: {
        provider: config.provider, account: config.account, scopeLabel: config.scopeLabel,
        requestedAt: job.requestedAt, providerJobId: result.providerJobId,
      },
    });
    Object.assign(job, {
      status: 'completed', completedAt: now, filename, contentType: 'application/zip', sizeBytes: body.length,
      checksum, artifactId: artifact.id, updatedAt: now, nextAction: 'download',
    });
    await attachTask(client, config, job);
    return await persist(client, job, owner, deps, 'completed');
  } catch (error) {
    const failure = classifyFailure(error);
    Object.assign(job, {
      status: failure.category === 'provider-concurrency' ? 'pending' : 'failed',
      errorCode: failure.category, errorMessage: failure.message, nextAction: failure.nextAction,
      retryAfter: failure.retryAfter, updatedAt: now,
    });
    try { return await persist(client, job, owner, deps, 'failed'); }
    catch { throw new Error(`Mailing export persistence failed for run ${id}`); }
  }
}

export async function runConfiguredMailingExports(
  client: DynamoDBDocumentClient, runKey: string, deps: MailingExportDependencies = {},
): Promise<MailingExportJob[]> {
  const jobs = await listMailingExports(client);
  const results: MailingExportJob[] = [];
  for (const config of loadMailingExportConfigs()) {
    const unfinished = jobs.find(job => job.configId === config.id && job.status !== 'completed');
    results.push(await runMailingExport(client, config, unfinished?.runKey || runKey, deps));
  }
  return results;
}

export { listMailingExports };
