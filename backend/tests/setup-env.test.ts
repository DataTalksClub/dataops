import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'child_process';
import path from 'path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

function runSetupProbe(env: Record<string, string>): Record<string, unknown> {
  const workDir = path.resolve(__dirname, '..');
  const script = `
    import('./src/db/tableNames.ts').then((setup) => {
      const mod = setup.default || setup;
      console.log(JSON.stringify({
        tasks: mod.TABLE_TASKS,
        cards: mod.TABLE_CARDS,
        templates: mod.TABLE_TEMPLATES,
        users: mod.TABLE_USERS,
        files: mod.TABLE_FILES,
        artifacts: mod.TABLE_ARTIFACTS,
        assistantJobs: mod.TABLE_ASSISTANT_JOBS,
        auditEvents: mod.TABLE_AUDIT_EVENTS,
        intake: mod.TABLE_INTAKE,
        notifications: mod.TABLE_NOTIFICATIONS,
        sessions: mod.TABLE_SESSIONS,
        bookkeeping: mod.TABLE_BOOKKEEPING,
        sponsorCrm: mod.TABLE_SPONSOR_CRM,
        newsletterSlots: mod.TABLE_NEWSLETTER_SLOTS,
        calendar: mod.TABLE_CALENDAR,
        conversationalState: mod.TABLE_CONVERSATIONAL_STATE,
      }));
    });
  `;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      ...env,
    },
    encoding: 'utf8',
  });

  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe('DynamoDB table setup environment', () => {
  it('uses local prototype table names by default', () => {
    const setup = runSetupProbe({});

    assert.strictEqual(setup.tasks, 'Tasks');
    assert.strictEqual(setup.cards, 'Projects');
    assert.strictEqual(setup.templates, 'Templates');
    assert.strictEqual(setup.users, 'Users');
    assert.strictEqual(setup.files, 'Files');
    assert.strictEqual(setup.artifacts, 'Artifacts');
    assert.strictEqual(setup.assistantJobs, 'AssistantJobs');
    assert.strictEqual(setup.auditEvents, 'AuditEvents');
    assert.strictEqual(setup.intake, 'IntakeItems');
    assert.strictEqual(setup.notifications, 'Notifications');
    assert.strictEqual(setup.sessions, 'Sessions');
  });

  it('uses production table names from DATAOPS environment variables', () => {
    const setup = runSetupProbe({
      DATAOPS_TASKS_TABLE: 'prod-tasks',
      DATAOPS_CARDS_TABLE: 'prod-cards',
      DATAOPS_TEMPLATES_TABLE: 'prod-templates',
      DATAOPS_USERS_TABLE: 'prod-users',
      DATAOPS_FILES_TABLE: 'prod-files',
      DATAOPS_ARTIFACTS_TABLE: 'prod-artifacts',
      DATAOPS_ASSISTANT_JOBS_TABLE: 'prod-assistant-jobs',
      DATAOPS_AUDIT_EVENTS_TABLE: 'prod-audit-events',
      DATAOPS_INTAKE_TABLE: 'prod-intake',
      DATAOPS_NOTIFICATIONS_TABLE: 'prod-notifications',
      DATAOPS_SESSIONS_TABLE: 'prod-sessions',
    });

    assert.strictEqual(setup.tasks, 'prod-tasks');
    assert.strictEqual(setup.cards, 'prod-cards');
    assert.strictEqual(setup.templates, 'prod-templates');
    assert.strictEqual(setup.users, 'prod-users');
    assert.strictEqual(setup.files, 'prod-files');
    assert.strictEqual(setup.artifacts, 'prod-artifacts');
    assert.strictEqual(setup.assistantJobs, 'prod-assistant-jobs');
    assert.strictEqual(setup.auditEvents, 'prod-audit-events');
    assert.strictEqual(setup.intake, 'prod-intake');
    assert.strictEqual(setup.notifications, 'prod-notifications');
    assert.strictEqual(setup.sessions, 'prod-sessions');
  });

  it('derives production table names from the CloudFormation stack name', () => {
    const setup = runSetupProbe({ DATAOPS_TABLE_PREFIX: 'dataops-v1' });

    assert.strictEqual(setup.tasks, 'dataops-v1-tasks');
    assert.strictEqual(setup.cards, 'dataops-v1-cards');
    assert.strictEqual(setup.templates, 'dataops-v1-templates');
    assert.strictEqual(setup.users, 'dataops-v1-users');
    assert.strictEqual(setup.files, 'dataops-v1-files');
    assert.strictEqual(setup.artifacts, 'dataops-v1-artifacts');
    assert.strictEqual(setup.assistantJobs, 'dataops-v1-assistant-jobs');
    assert.strictEqual(setup.auditEvents, 'dataops-v1-audit-events');
    assert.strictEqual(setup.intake, 'dataops-v1-intake');
    assert.strictEqual(setup.notifications, 'dataops-v1-notifications');
    assert.strictEqual(setup.sessions, 'dataops-v1-sessions');
    assert.strictEqual(setup.bookkeeping, 'dataops-v1-bookkeeping');
    assert.strictEqual(setup.sponsorCrm, 'dataops-v1-sponsor-crm');
    assert.strictEqual(setup.newsletterSlots, 'dataops-v1-newsletter-slots');
    assert.strictEqual(setup.calendar, 'dataops-v1-calendar');
    assert.strictEqual(setup.conversationalState, 'dataops-v1-conversational-state');
  });

  it('has no way for the application to create its own tables', async () => {
    const names = await readFile(new URL('../src/db/tableNames.ts', import.meta.url), 'utf8');
    const client = await readFile(new URL('../src/db/client.ts', import.meta.url), 'utf8');
    const handler = await readFile(new URL('../src/handler.ts', import.meta.url), 'utf8');
    for (const [name, source] of [['tableNames.ts', names], ['client.ts', client], ['handler.ts', handler]]) {
      assert.ok(!/CreateTableCommand|DeleteTableCommand|dynalite|startLocal|createTables/.test(source), `${name} must not create local infrastructure`);
    }
    assert.ok(!/createTables/.test(handler), 'the request handler must never create tables');

    const localSetup = await readFile(new URL('../scripts/local-dynamodb.ts', import.meta.url), 'utf8');
    assert.match(localSetup, /CreateTableCommand/);
    assert.match(localSetup, /DeleteTableCommand/);
    assert.match(localSetup, /dynalite/);
  });
});

describe('missing infrastructure fails loudly', () => {
  it('names the table and says the application does not create it', async () => {
    // Wrap a stub exactly the way getClient does without reaching AWS.
    const lib = await import('@aws-sdk/lib-dynamodb');
    const { failLoudlyOnMissingTable } = await import('../src/db/client');
    const notFound = Object.assign(new Error('Requested resource not found'), {
      name: 'ResourceNotFoundException',
    });
    const stub = Object.create(lib.DynamoDBDocumentClient.prototype) as { send: unknown };
    stub.send = async () => { throw notFound; };

    const wrapped = failLoudlyOnMissingTable(stub as unknown as DynamoDBDocumentClient);
    await assert.rejects(
      () => wrapped.send({ input: { TableName: 'dataops-v1-cards' } } as never),
      (error: Error) => {
        assert.match(error.message, /dataops-v1-cards/);
        assert.match(error.message, /never created by the application/);
        assert.strictEqual(error.name, 'ResourceNotFoundException');
        return true;
      },
    );
  });
});
