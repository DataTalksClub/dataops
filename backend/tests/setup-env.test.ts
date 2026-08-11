import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'child_process';
import path from 'path';

function runSetupProbe(env: Record<string, string>): Record<string, unknown> {
  const workDir = path.resolve(__dirname, '..');
  const script = `
    import('./src/db/setup.ts').then((setup) => {
      const mod = setup.default || setup;
      console.log(JSON.stringify({
        tasks: mod.TABLE_TASKS,
        bundles: mod.TABLE_BUNDLES,
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
        autoCreate: mod.shouldAutoCreateTables(),
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
    assert.strictEqual(setup.bundles, 'Projects');
    assert.strictEqual(setup.templates, 'Templates');
    assert.strictEqual(setup.users, 'Users');
    assert.strictEqual(setup.files, 'Files');
    assert.strictEqual(setup.artifacts, 'Artifacts');
    assert.strictEqual(setup.assistantJobs, 'AssistantJobs');
    assert.strictEqual(setup.auditEvents, 'AuditEvents');
    assert.strictEqual(setup.intake, 'IntakeItems');
    assert.strictEqual(setup.notifications, 'Notifications');
    assert.strictEqual(setup.sessions, 'Sessions');
    assert.strictEqual(setup.autoCreate, false);
  });

  it('uses production table names from DATAOPS environment variables', () => {
    const setup = runSetupProbe({
      DATAOPS_TASKS_TABLE: 'prod-tasks',
      DATAOPS_BUNDLES_TABLE: 'prod-bundles',
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
    assert.strictEqual(setup.bundles, 'prod-bundles');
    assert.strictEqual(setup.templates, 'prod-templates');
    assert.strictEqual(setup.users, 'prod-users');
    assert.strictEqual(setup.files, 'prod-files');
    assert.strictEqual(setup.artifacts, 'prod-artifacts');
    assert.strictEqual(setup.assistantJobs, 'prod-assistant-jobs');
    assert.strictEqual(setup.auditEvents, 'prod-audit-events');
    assert.strictEqual(setup.intake, 'prod-intake');
    assert.strictEqual(setup.notifications, 'prod-notifications');
    assert.strictEqual(setup.sessions, 'prod-sessions');
    assert.strictEqual(setup.autoCreate, false);
  });

  it('derives production table names from the CloudFormation stack name', () => {
    const setup = runSetupProbe({ DATAOPS_STACK_NAME: 'dataops-v1' });

    assert.strictEqual(setup.tasks, 'dataops-v1-tasks');
    assert.strictEqual(setup.bundles, 'dataops-v1-bundles');
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
    assert.strictEqual(setup.autoCreate, false);
  });

  it('allows table auto-creation only for local, test, or explicit setup', () => {
    assert.strictEqual(runSetupProbe({ NODE_ENV: 'test' }).autoCreate, true);
    assert.strictEqual(runSetupProbe({ IS_LOCAL: 'true' }).autoCreate, true);
    assert.strictEqual(runSetupProbe({ DATAOPS_AUTO_CREATE_TABLES: 'true' }).autoCreate, true);
  });
});
