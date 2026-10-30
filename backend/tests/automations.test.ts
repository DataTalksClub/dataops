/**
 * The automations overview: a hardcoded registry held to the schedules that
 * infrastructure declares, the next and last run of each entry, and who may
 * edit the settings it reads. Real bearer identity, because `canEdit` is part
 * of the contract. All people are synthetic (`example.test`).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { AUTOMATIONS } from '../src/automations/registry';
import { templateScheduleWords } from '../src/automations/cards';
import { recordAutomationRun } from '../src/automations/runs';
import { automationsOverview, dailyCronTime, nextRunAt, scheduleLabel } from '../src/automations/view';
import { runCron } from '../src/cron/runner';
import { getClient } from '../src/db/client';
import { createSession } from '../src/db/sessions';
import { createTemplate } from '../src/db/templates';
import { createUserWithId } from '../src/db/users';
import { route } from '../src/router';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import type { LambdaResponse } from '../src/types';

const TEMPLATE = readFileSync(resolve(__dirname, '../../infra/template.full.yaml'), 'utf8');

/** The schedule expression `Resource` or `Resource.Event` declares in the application stack. */
function declaredSchedule(reference: string): string | null {
  const [resource, event] = reference.split('.');
  const start = TEMPLATE.indexOf(`\n  ${resource}:\n`);
  if (start < 0) return null;
  const rest = TEMPLATE.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z]/);
  let block = end < 0 ? rest : rest.slice(0, end + 1);
  if (event) {
    const eventStart = block.indexOf(`\n        ${event}:\n`);
    if (eventStart < 0) return null;
    block = block.slice(eventStart);
  }
  return block.match(/Schedule(?:Expression)?: (\S.*)/)?.[1].trim() || null;
}

describe('automation registry', () => {
  it('names each Lambda schedule exactly as infrastructure declares it', () => {
    const scheduled = AUTOMATIONS.filter((automation) => automation.infraSchedule);
    assert.ok(scheduled.length >= 6);
    for (const automation of scheduled) {
      const declared = declaredSchedule(automation.infraSchedule!);
      const expected = automation.schedule.kind === 'cron'
        ? automation.schedule.expression
        : automation.schedule.kind === 'interval' ? `rate(${automation.schedule.minutes} minutes)` : null;
      assert.strictEqual(declared, expected, `${automation.id} schedule drifted from ${automation.infraSchedule}`);
    }
  });

  it('has unique ids', () => {
    assert.strictEqual(new Set(AUTOMATIONS.map((automation) => automation.id)).size, AUTOMATIONS.length);
  });
});

describe('automation card schedules', () => {
  it('reads common template trigger schedules in plain words', () => {
    assert.strictEqual(templateScheduleWords('0 9 * * *'), 'Every morning (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 * * 2'), 'Weekly on Tuesdays (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('30 10 * * 0'), 'Weekly on Sundays (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 1 * *'), 'Monthly on the 1st (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 22 * *'), 'Monthly on the 22nd (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 3 * *'), 'Monthly on the 3rd (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 29 2 *'), 'Yearly on February 29th (Europe/Berlin)');
    assert.strictEqual(templateScheduleWords('0 9 1,15 * *'), null);
    assert.strictEqual(templateScheduleWords('not a cron'), null);
  });
});

describe('automation schedules', () => {
  it('reads EventBridge and GitHub daily crons', () => {
    assert.deepStrictEqual(dailyCronTime('cron(0 6 * * ? *)'), { hour: 6, minute: 0 });
    assert.deepStrictEqual(dailyCronTime('17 3 * * *'), { hour: 3, minute: 17 });
    assert.strictEqual(dailyCronTime('0 9 * * 1'), null);
  });

  it('says when and computes the next run in UTC', () => {
    const daily = { kind: 'cron', expression: 'cron(30 8 * * ? *)' } as const;
    assert.strictEqual(scheduleLabel(daily), 'Daily at 08:30 UTC');
    assert.strictEqual(nextRunAt(daily, new Date('2026-10-16T08:29:00Z')), '2026-10-16T08:30:00.000Z');
    assert.strictEqual(nextRunAt(daily, new Date('2026-10-16T08:30:00Z')), '2026-10-17T08:30:00.000Z');
    assert.strictEqual(scheduleLabel({ kind: 'interval', minutes: 2 }), 'Every 2 minutes');
    assert.strictEqual(nextRunAt({ kind: 'interval', minutes: 2 }, new Date()), null);
    assert.strictEqual(scheduleLabel({ kind: 'event', trigger: 'Push to main' }), 'Push to main');
  });
});

describe('GET /api/automations', () => {
  let client: DynamoDBDocumentClient;
  let savedSkipAuth: string | undefined;
  const sessions: Record<string, string> = {};

  function invoke(bearer: string, method = 'GET', path = '/api/automations', body?: unknown): Promise<LambdaResponse> {
    return route({
      httpMethod: method,
      path,
      queryStringParameters: null,
      headers: { authorization: `Bearer ${bearer}` },
      body: body === undefined ? null : JSON.stringify(body),
    }, client);
  }

  before(async () => {
    savedSkipAuth = process.env.SKIP_AUTH;
    process.env.SKIP_AUTH = 'false';
    client = await getClient(await startLocal());
    await createTables(client);
    await createUserWithId(client, 'ada-admin', { name: 'Ada Admin', email: 'ada@example.test', role: 'admin' });
    await createUserWithId(client, 'otto-operator', { name: 'Otto Operator', email: 'otto@example.test', role: 'operator' });
    sessions.admin = (await createSession(client, 'ada-admin')).token;
    sessions.operator = (await createSession(client, 'otto-operator')).token;
  });

  after(async () => {
    if (savedSkipAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = savedSkipAuth;
    await stopLocal();
  });

  it('lists every automation and lets only an admin edit settings', async () => {
    const operator = await invoke(sessions.operator);
    assert.strictEqual(operator.statusCode, 200);
    const body = JSON.parse(operator.body);
    assert.deepStrictEqual(body.automations.map((automation: { id: string }) => automation.id), AUTOMATIONS.map((automation) => automation.id));
    assert.strictEqual(body.canEdit, false);
    assert.strictEqual(typeof body.settingsVersion, 'number');
    assert.strictEqual(JSON.parse((await invoke(sessions.admin)).body).canEdit, true);
  });

  it('requires a signed-in person', async () => {
    assert.strictEqual((await invoke('not-a-session')).statusCode, 401);
  });

  it('shows the last run the daily job records for each of its parts', async () => {
    const quiet = async () => ({ created: 0, resolved: 0 });
    await runCron(client, new Date('2026-10-16T08:00:00Z'), {
      bookingAlerts: quiet,
      financeAlerts: async () => { throw new Error('finance offline'); },
      communicationSuggestions: quiet,
    });
    const overview = await automationsOverview(client, {
      now: new Date('2026-10-16T09:00:00Z'),
      readCheckpoint: async (job) => (job === 'knowledge-mirror' ? { at: '2026-10-16T04:00:05.000Z' } : null),
    });
    const byId = new Map(overview.automations.map((automation) => [automation.id, automation]));
    assert.deepStrictEqual(
      { ok: byId.get('recurring-tasks')!.lastRun?.ok, summary: byId.get('recurring-tasks')!.lastRun?.summary },
      { ok: true, summary: '0 tasks created' },
    );
    assert.strictEqual(byId.get('automatic-template-cards')!.lastRun?.summary, '0 cards created');
    assert.strictEqual(byId.get('calendar-hold-expiry')!.lastRun?.summary, '0 holds expired');
    assert.strictEqual(byId.get('sponsor-booking-alerts')!.lastRun?.summary, 'created 0, resolved 0');
    assert.deepStrictEqual(
      { ok: byId.get('sponsor-finance-alerts')!.lastRun?.ok, summary: byId.get('sponsor-finance-alerts')!.lastRun?.summary },
      { ok: false, summary: 'Failed: finance offline' },
    );
    assert.strictEqual(byId.get('recurring-tasks')!.lastRun?.at, '2026-10-16T08:00:00.000Z');
    assert.strictEqual(byId.get('recurring-tasks')!.nextRunAt, '2026-10-17T06:00:00.000Z');
    assert.strictEqual(byId.get('knowledge-mirror')!.lastRun?.source, 'knowledge-checkpoint');
    assert.strictEqual(byId.get('knowledge-backup')!.lastRun, null);
    assert.deepStrictEqual(byId.get('newsletter-cards')!.settings.map(({ key, value }) => ({ key, value })), [{ key: 'newsletterCardLeadDays', value: 21 }]);
    assert.strictEqual(byId.get('knowledge-publish')!.lastRun, null);
    assert.match(byId.get('knowledge-publish')!.link || '', /^https:\/\/github\.com\//);
  });

  it('keeps only the latest run of an automation', async () => {
    await recordAutomationRun(client, 'dynamo-backup', { ok: false, summary: 'Failed: first' }, new Date('2026-10-15T09:00:00Z'));
    await recordAutomationRun(client, 'dynamo-backup', { ok: true, summary: '10 items from 2 tables' }, new Date('2026-10-16T09:00:00Z'));
    const overview = await automationsOverview(client, { readCheckpoint: async () => null });
    const backup = overview.automations.find((automation) => automation.id === 'dynamo-backup')!;
    assert.deepStrictEqual(backup.lastRun, { at: '2026-10-16T09:00:00.000Z', ok: true, summary: '10 items from 2 tables', source: 'recorded' });
  });

  it('shows the sponsor reminder timing an admin sets on /api/workspace-settings', async () => {
    const before = JSON.parse((await invoke(sessions.admin)).body);
    const alerts = before.automations.find((automation: { id: string }) => automation.id === 'sponsor-booking-alerts');
    assert.deepStrictEqual(
      alerts.settings.map(({ key, value }: { key: string; value: unknown }) => ({ key, value })),
      [{ key: 'sponsorMaterialsReminderDays', value: [14, 10, 3] }, { key: 'sponsorFollowUpDays', value: 7 }],
    );
    for (const body of [
      { sponsorMaterialsReminderDays: [3, -1] }, { sponsorMaterialsReminderDays: '14,10' },
      { sponsorMaterialsReminderDays: Array.from({ length: 11 }, (_, index) => index) },
      { sponsorFollowUpDays: 0 }, { sponsorFollowUpDays: 400 },
    ]) {
      const response = await invoke(sessions.admin, 'PUT', '/api/workspace-settings', { ...body, expectedVersion: before.settingsVersion });
      assert.strictEqual(response.statusCode, 400, JSON.stringify(body));
    }
    const saved = await invoke(sessions.admin, 'PUT', '/api/workspace-settings', {
      sponsorMaterialsReminderDays: [7, 21, 7],
      sponsorFollowUpDays: 10,
      expectedVersion: before.settingsVersion,
    });
    assert.strictEqual(saved.statusCode, 200, saved.body);
    const after = JSON.parse((await invoke(sessions.operator)).body);
    const suggestions = after.automations.find((automation: { id: string }) => automation.id === 'sponsor-communication-suggestions');
    assert.deepStrictEqual(suggestions.settings.map(({ value }: { value: unknown }) => value), [[21, 7], 10]);
    assert.strictEqual(after.settingsVersion, before.settingsVersion + 1);
  });

  it('lists the automatically created cards from the live rules, and flags system jobs', async () => {
    const newsletter = await createTemplate(client, {
      name: 'Newsletter',
      type: 'newsletter',
      taskDefinitions: [],
    });
    const tax = await createTemplate(client, {
      name: 'Tax Report',
      type: 'tax-report',
      triggerType: 'automatic',
      triggerSchedule: '0 9 1 * *',
      triggerLeadDays: 0,
      taskDefinitions: [],
    });
    await recordAutomationRun(client, 'newsletter-cards', { ok: true, summary: '0 cards created' }, new Date('2026-10-16T08:00:00Z'));
    await recordAutomationRun(client, 'automatic-template-cards', { ok: true, summary: '0 cards created' }, new Date('2026-10-16T08:00:00Z'));
    const overview = await automationsOverview(client, {
      now: new Date('2026-10-16T09:00:00Z'),
      readCheckpoint: async () => null,
    });
    assert.deepStrictEqual(overview.cards.map((card) => card.id), ['newsletter-weekly', `template-${tax.id}`]);
    const [weekly, taxCard] = overview.cards;
    assert.strictEqual(weekly.name, 'Weekly newsletter issue card');
    assert.strictEqual(weekly.scheduleLabel, 'Every morning (Europe/Berlin)');
    assert.match(weekly.leadTime, /21 days before the send date/);
    assert.strictEqual(weekly.skipRule, 'One Card per issue; skipped when the issue already has one');
    assert.strictEqual(weekly.nextRunAt, '2026-10-17T06:00:00.000Z');
    assert.strictEqual(weekly.lastRun?.summary, '0 cards created');
    assert.strictEqual(weekly.templateLink, `/templates?templateId=${newsletter.id}`);
    assert.strictEqual(taxCard.name, 'Tax Report card');
    assert.strictEqual(taxCard.scheduleLabel, 'Monthly on the 1st (Europe/Berlin)');
    assert.strictEqual(taxCard.leadTime, 'Created on the scheduled date');
    assert.match(taxCard.skipRule, /One Card per anchor date/);
    // 2026-11-01 is a Sunday, so the anchor (and its creation pass) moves to Monday.
    assert.strictEqual(taxCard.nextRunAt, '2026-11-02T06:00:00.000Z');
    assert.strictEqual(taxCard.lastRun?.summary, '0 cards created');
    assert.strictEqual(taxCard.templateLink, `/templates?templateId=${tax.id}`);
    const byId = new Map(overview.automations.map((automation) => [automation.id, automation]));
    assert.strictEqual(byId.get('recurring-tasks')!.system, false);
    for (const id of ['execution-export', 'dynamo-backup', 'knowledge-backup', 'knowledge-mirror', 'knowledge-publish', 'knowledge-repo-backup']) {
      assert.strictEqual(byId.get(id)!.system, true, id);
    }
    assert.ok(!byId.has('sponsor-email-send') && !byId.has('sponsor-send-recovery') && !byId.has('sponsor-email-events'));
  });
});
