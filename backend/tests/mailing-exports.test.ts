import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { getClient, startLocal, stopLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTask, getTask, updateTask } from '../src/db/tasks';
import { createBundle, updateBundle } from '../src/db/bundles';
import { getArtifact, listArtifacts } from '../src/db/artifacts';
import { MailchimpProvider, MailingExportProviderError } from '../src/mailingExports/mailchimp';
import { MailingExportProviderRegistry } from '../src/mailingExports/registry';
import { runConfiguredMailingExports, runMailingExport } from '../src/mailingExports/service';
import { setArtifactDownloadSignerForTests } from '../src/routes/artifacts';
import { route } from '../src/router';
import type { MailingExportConfig, MailingExportProvider, ProviderExportResult } from '../src/mailingExports/types';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
let sequence = 0;
const config = (suffix: string, extra: Partial<MailingExportConfig> = {}): MailingExportConfig => ({
  id: `mailchimp-${suffix}-${++sequence}`, provider: 'mailchimp', account: 'Synthetic account',
  scopeLabel: 'All audiences (account export)', secretName: 'placeholder/mailchimp', ...extra,
});

class FakeProvider implements MailingExportProvider {
  readonly minimumIntervalMs = 24 * 60 * 60 * 1000;
  requests = 0;
  checks = 0;
  downloads = 0;
  constructor(
    private delayed = false,
    private failure?: Error,
    private bytes = ZIP,
    private gate?: Promise<void>,
  ) {}
  async requestExport(): Promise<ProviderExportResult> {
    this.requests++;
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    return this.delayed
      ? { status: 'pending', providerJobId: 'provider-1' }
      : { status: 'completed', providerJobId: 'provider-1', downloadUrl: 'https://signed.example.test/export', filename: 'members.zip' };
  }
  async checkExport(): Promise<ProviderExportResult> {
    this.checks++;
    if (this.failure) throw this.failure;
    return { status: 'completed', providerJobId: 'provider-1', downloadUrl: 'https://signed.example.test/export', filename: 'members.zip' };
  }
  async download(): Promise<Buffer> { this.downloads++; return this.bytes; }
}

describe('mailing-list export service', () => {
  let client: Awaited<ReturnType<typeof startLocal>>;
  before(async () => {
    process.env.NODE_ENV = 'test'; process.env.SKIP_AUTH = 'true';
    const port = await startLocal(); client = await getClient(port); await createTables(client);
  });
  after(async () => {
    await stopLocal();
    for (const key of ['NODE_ENV', 'SKIP_AUTH', 'DATAOPS_MAILING_EXPORTS_CONFIG', 'DATAOPS_MAILING_EXPORTS_BUCKET']) delete process.env[key];
  });

  const deps = (
    provider: MailingExportProvider,
    store = async (key: string) => `s3://mailing-private/${key}`,
    now = () => new Date('2026-07-12T09:00:00Z'),
  ) => ({ provider, store, getSecret: async () => ({ apiKey: 'placeholder-us1' }), now, log: () => undefined });

  it('stores a valid ZIP as one deterministic private artifact with complete metadata', async () => {
    const cfg = config('success');
    const job = await runMailingExport(client, cfg, '2026-07-12', deps(new FakeProvider()));
    assert.strictEqual(job.status, 'completed');
    assert.strictEqual(job.filename, 'members.zip');
    assert.strictEqual(job.contentType, 'application/zip');
    assert.strictEqual(job.sizeBytes, ZIP.length);
    assert.match(job.checksum || '', /^[a-f0-9]{64}$/);
    const artifact = await getArtifact(client, job.artifactId!);
    assert.strictEqual(artifact?.dataClass, 'private');
    assert.strictEqual(artifact?.metadata?.scopeLabel, 'All audiences (account export)');
    assert.ok(!JSON.stringify(job).includes('signed.example.test'));
  });

  it('persists delayed completion and polls without a second provider request', async () => {
    const cfg = config('delayed');
    const provider = new FakeProvider(true);
    const first = await runMailingExport(client, cfg, 'delayed', deps(provider));
    const second = await runMailingExport(client, cfg, 'delayed', deps(provider));
    assert.strictEqual(first.status, 'pending');
    assert.strictEqual(second.status, 'completed');
    assert.strictEqual(provider.requests, 1);
    assert.strictEqual(provider.checks, 1);
  });

  it('conditionally serializes concurrent delivery and replays the completed result', async () => {
    const cfg = config('concurrent');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = new FakeProvider(false, undefined, ZIP, gate);
    const first = runMailingExport(client, cfg, 'same-key', deps(provider));
    await new Promise(resolve => setTimeout(resolve, 20));
    const overlap = await runMailingExport(client, cfg, 'same-key', deps(provider));
    assert.strictEqual(overlap.status, 'requested');
    release();
    const completed = await first;
    const replay = await runMailingExport(client, cfg, 'same-key', deps(provider));
    assert.strictEqual(completed.status, 'completed');
    assert.strictEqual(replay.artifactId, completed.artifactId);
    assert.strictEqual(provider.requests, 1);
    assert.strictEqual((await listArtifacts(client, {})).filter(item => item.id === completed.artifactId).length, 1);
  });

  it('attaches exactly one reference and reports a stale task without losing the export', async () => {
    const task = await createTask(client, { description: 'Synthetic backup', date: '2026-07-12' });
    const linkedCfg = config('task', { taskId: task.id });
    const linked = await runMailingExport(client, linkedCfg, 'linked', deps(new FakeProvider()));
    await runMailingExport(client, linkedCfg, 'linked', deps(new FakeProvider()));
    assert.strictEqual(linked.taskLinkStatus, 'linked');
    const linkedTask = await getTask(client, task.id);
    assert.strictEqual(linkedTask?.artifactRefs?.length, 1);
    assert.ok(!JSON.stringify(linkedTask?.artifactRefs).includes('s3://'));

    const missing = await runMailingExport(client, config('missing-task', { taskId: 'stale-task' }), 'missing', deps(new FakeProvider()));
    assert.strictEqual(missing.status, 'completed');
    assert.strictEqual(missing.taskLinkStatus, 'missing');
    assert.strictEqual(missing.errorCode, 'task-link');
    assert.ok(await getArtifact(client, missing.artifactId!));
  });

  it('records safe authorization, integrity, and storage categories and resumes after storage failure', async () => {
    const authProvider = new FakeProvider(false, new MailingExportProviderError('authorization', 'private api key'));
    const auth = await runMailingExport(client, config('auth'), 'auth', deps(authProvider));
    assert.strictEqual(auth.errorCode, 'authorization');
    assert.strictEqual(auth.nextAction, 'fix-authorization');
    assert.ok(!JSON.stringify(auth).includes('private api key'));

    const integrity = await runMailingExport(client, config('integrity'), 'integrity', deps(new FakeProvider(false, undefined, Buffer.from('not zip'))));
    assert.strictEqual(integrity.errorCode, 'download-integrity');

    const storageCfg = config('storage');
    const storageProvider = new FakeProvider();
    const failed = await runMailingExport(client, storageCfg, 'storage', deps(storageProvider, async () => { throw new Error('S3 secret detail'); }));
    const resumed = await runMailingExport(client, storageCfg, 'storage', deps(storageProvider));
    assert.strictEqual(failed.errorCode, 'storage');
    assert.strictEqual(resumed.status, 'completed');
    assert.strictEqual(storageProvider.requests, 1);
    assert.strictEqual(storageProvider.checks, 1);
  });

  it('turns provider concurrency and the completed-export 24-hour window into a wait state', async () => {
    const providerLimited = await runMailingExport(
      client, config('provider-limit'), 'limit',
      deps(new FakeProvider(false, new MailingExportProviderError('provider-concurrency', 'private', '2026-07-12T10:00:00Z'))),
    );
    assert.strictEqual(providerLimited.status, 'pending');
    assert.strictEqual(providerLimited.nextAction, 'wait');

    const cfg = config('daily');
    const provider = new FakeProvider();
    await runMailingExport(client, cfg, 'day-one', deps(provider));
    const blocked = await runMailingExport(client, cfg, 'day-two', deps(provider, undefined, () => new Date('2026-07-13T08:00:00Z')));
    assert.strictEqual(blocked.status, 'pending');
    assert.strictEqual(blocked.errorCode, 'provider-concurrency');
    assert.strictEqual(provider.requests, 1);
  });

  it('scheduled delivery advances the unfinished durable run', async () => {
    const cfg = config('scheduled');
    process.env.DATAOPS_MAILING_EXPORTS_CONFIG = JSON.stringify([cfg]);
    const provider = new FakeProvider(true);
    const first = await runConfiguredMailingExports(client, '2026-07-12', deps(provider));
    const next = await runConfiguredMailingExports(client, '2026-07-13', deps(provider));
    assert.strictEqual(next[0].id, first[0].id);
    assert.strictEqual(next[0].status, 'completed');
  });

  it('exposes authenticated sanitized list/replay APIs and a five-minute controlled download', async () => {
    const cfg = config('api');
    process.env.DATAOPS_MAILING_EXPORTS_CONFIG = JSON.stringify([cfg]);
    process.env.DATAOPS_MAILING_EXPORTS_BUCKET = 'mailing-private';
    const completed = await runMailingExport(client, cfg, 'api-key', deps(new FakeProvider()));

    const listed = await route({ httpMethod: 'GET', path: '/api/mailing-exports' }, client);
    assert.strictEqual(listed.statusCode, 200);
    assert.ok(!listed.body.includes('placeholder/mailchimp'));
    assert.ok(!listed.body.includes('leaseOwner'));
    const replay = await route({ httpMethod: 'POST', path: '/api/mailing-exports/run', body: JSON.stringify({ configId: cfg.id, runKey: 'api-key' }) }, client);
    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(JSON.parse(replay.body).export.artifactId, completed.artifactId);
    const artifactMetadata = await route({ httpMethod: 'GET', path: `/api/artifacts/${completed.artifactId}` }, client);
    assert.ok(!artifactMetadata.body.includes('s3://'));
    const artifactList = await route({ httpMethod: 'GET', path: '/api/artifacts' }, client);
    assert.ok(!artifactList.body.includes(`mailing-private/mailing-exports/mailchimp/${cfg.id}`));

    const task = await createTask(client, { description: 'Synthetic privacy task', date: '2026-07-14' });
    const bundle = await createBundle(client, { title: 'Synthetic privacy bundle', anchorDate: '2026-07-14' });
    const updatedArtifact = await route({
      httpMethod: 'PUT', path: `/api/artifacts/${completed.artifactId}`,
      body: JSON.stringify({ description: 'Safe operator description' }),
    }, client);
    assert.strictEqual(updatedArtifact.statusCode, 200);
    assert.ok(!updatedArtifact.body.includes('s3://'));
    const attached = await route({
      httpMethod: 'PUT', path: `/api/artifacts/${completed.artifactId}/attach`,
      body: JSON.stringify({ taskId: task.id, bundleId: bundle.id }),
    }, client);
    assert.strictEqual(attached.statusCode, 200);
    assert.ok(!attached.body.includes('s3://'));
    assert.ok(!JSON.stringify((await getTask(client, task.id))?.artifactRefs).includes('s3://'));

    // The HTTP-edge privacy guard also protects legacy references already stored before this fix.
    await updateTask(client, task.id, { artifactRefs: [{ artifactId: completed.artifactId, storageUri: 's3://mailing-private/private-key' }] });
    await updateBundle(client, bundle.id, { artifactRefs: [{ artifactId: completed.artifactId, storageUri: 's3://mailing-private/private-key' }] });
    const { handler } = await import('../src/handler');
    const taskRead = await handler({ httpMethod: 'GET', path: `/api/tasks/${task.id}` }, {});
    const bundleRead = await handler({ httpMethod: 'GET', path: `/api/bundles/${bundle.id}` }, {});
    assert.ok('body' in taskRead && !taskRead.body.includes('s3://'));
    assert.ok('body' in bundleRead && !bundleRead.body.includes('s3://'));

    setArtifactDownloadSignerForTests(async (_client, _command, options) => {
      assert.strictEqual(options?.expiresIn, 300);
      return 'https://signed.example.test/private';
    });
    const download = await route({ httpMethod: 'GET', path: `/api/artifacts/${completed.artifactId}/download` }, client);
    assert.deepStrictEqual(JSON.parse(download.body), { downloadUrl: 'https://signed.example.test/private', expiresIn: 300 });

    process.env.SKIP_AUTH = 'false';
    assert.strictEqual((await route({ httpMethod: 'GET', path: '/api/mailing-exports' }, client)).statusCode, 401);
    assert.strictEqual((await route({ httpMethod: 'POST', path: '/api/mailing-exports/run', body: '{}' }, client)).statusCode, 401);
    assert.strictEqual((await route({ httpMethod: 'GET', path: `/api/artifacts/${completed.artifactId}/download` }, client)).statusCode, 401);
    process.env.SKIP_AUTH = 'true';
  });
});

describe('Mailchimp account-export adapter and provider registry', () => {
  it('requests the account-wide audiences stage and parses export_id/finished/download_url', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/account-exports')) return new Response(JSON.stringify({ export_id: 'exp-1' }), { status: 200 });
      return new Response(JSON.stringify({ export_id: 'exp-1', finished: true, download_url: 'https://signed.example.test/file' }), { status: 200 });
    };
    const provider = new MailchimpProvider({ apiKey: 'placeholder-us19' }, fetcher as typeof fetch);
    assert.strictEqual((await provider.requestExport()).status, 'pending');
    assert.strictEqual((await provider.checkExport('exp-1')).status, 'completed');
    assert.strictEqual(calls[0].url, 'https://us19.api.mailchimp.com/3.0/account-exports');
    assert.deepStrictEqual(JSON.parse(String(calls[0].init?.body)), { include_stages: ['audiences'] });
    assert.ok(String((calls[0].init?.headers as Record<string, string>).Authorization).startsWith('Basic '));
  });

  it('validates derived/explicit server prefixes and maps limits/malformed completion safely', async () => {
    assert.throws(() => new MailchimpProvider({ apiKey: 'placeholder-us1', server: 'eu2' }), /does not match/);
    assert.throws(() => new MailchimpProvider({ apiKey: 'placeholder', server: 'bad.example.test' }), /invalid/);
    const limited = new MailchimpProvider({ apiKey: 'placeholder-us1' }, (async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })) as typeof fetch);
    await assert.rejects(limited.requestExport(), (error: MailingExportProviderError) => error.category === 'provider-concurrency');
    const malformed = new MailchimpProvider({ apiKey: 'placeholder-us1' }, (async () => new Response(JSON.stringify({ export_id: 'x', finished: true }), { status: 200 })) as typeof fetch);
    await assert.rejects(malformed.requestExport(), (error: MailingExportProviderError) => error.category === 'provider-api');
  });

  it('allows a second provider to be registered without changing shared orchestration', () => {
    const fake = new FakeProvider();
    const registry = new MailingExportProviderRegistry().register('synthetic', () => fake);
    assert.strictEqual(registry.create('synthetic', {}), fake);
    assert.throws(() => registry.create('missing', {}), /Unsupported/);
  });
});
