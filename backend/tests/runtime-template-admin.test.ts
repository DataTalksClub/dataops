import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient, startLocal, stopLocal } from '../src/db/client';
import {
  createTables,
  TABLE_AUDIT_EVENTS,
  TABLE_CARDS,
  TABLE_CALENDAR,
  TABLE_NOTIFICATIONS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
} from '../src/db/setup';
import { createSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import {
  countTemplateReferences,
  deleteTemplateWithAudit,
  getTemplate,
  listTemplateAuditEvents,
} from '../src/db/templates';
import type { LambdaResponse } from '../src/types';

const ADMIN_ID = 'template-admin';
const OPERATOR_ID = 'template-operator';
const DISABLED_ADMIN_ID = 'template-disabled-admin';

describe('runtime-template administration security and consistency', () => {
  let client: DynamoDBDocumentClient;
  let adminToken: string;
  let operatorToken: string;
  let disabledAdminToken: string;
  const priorSkipAuth = process.env.SKIP_AUTH;

  before(async () => {
    process.env.SKIP_AUTH = 'false';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Template admin', email: 'admin@example.test', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Template operator', email: 'operator@example.test', role: 'operator' });
    await createUserWithId(client, DISABLED_ADMIN_ID, { name: 'Disabled admin', email: 'disabled@example.test', role: 'admin', disabled: true });
    adminToken = (await createSession(client, ADMIN_ID)).token;
    operatorToken = (await createSession(client, OPERATOR_ID)).token;
    disabledAdminToken = (await createSession(client, DISABLED_ADMIN_ID)).token;
  });

  after(async () => {
    if (priorSkipAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = priorSkipAuth;
    await stopLocal();
  });

  function invoke(method: string, path: string, body?: unknown, token?: string, spoof = false): Promise<LambdaResponse> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spoof) {
      headers['x-user-id'] = ADMIN_ID;
      headers['x-user-role'] = 'admin';
      headers['x-portal-auth'] = 'true';
    }
    return handler({
      httpMethod: method,
      path,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }, {});
  }

  const minimal = (name: string) => ({
    name,
    type: 'workflow',
    taskDefinitions: [{ refId: 'one', description: 'First task', offsetDays: 0 }],
  });

  async function createAsAdmin(name: string) {
    const response = await invoke('POST', '/api/templates', minimal(name), adminToken);
    assert.strictEqual(response.statusCode, 201, response.body);
    return JSON.parse(response.body).template;
  }

  it('allows active admins and denies operator, unauthenticated, disabled, and spoofed mutations without mutation', async () => {
    const auditBefore = (await listTemplateAuditEvents(client)).length;
    for (const [token, expected, spoof] of [
      [operatorToken, 403, false],
      [undefined, 401, false],
      [disabledAdminToken, 401, false],
      [operatorToken, 403, true],
    ] as Array<[string | undefined, number, boolean]>) {
      const denied = await invoke('POST', '/api/templates', minimal(`Denied ${expected}-${spoof}`), token, spoof);
      assert.strictEqual(denied.statusCode, expected, denied.body);
      assert.deepStrictEqual(Object.keys(JSON.parse(denied.body)), ['error']);
    }

    const target = await createAsAdmin('Mutation denial target');
    for (const method of ['PUT', 'DELETE']) {
      for (const [token, expected, spoof] of [
        [operatorToken, 403, false],
        [undefined, 401, false],
        [operatorToken, 403, true],
      ] as Array<[string | undefined, number, boolean]>) {
        const denied = await invoke(method, `/api/templates/${target.id}`, method === 'PUT'
          ? { expectedVersion: 1, name: 'Must not persist' }
          : { expectedVersion: 1 }, token, spoof);
        assert.strictEqual(denied.statusCode, expected, denied.body);
        const unchanged = await getTemplate(client, target.id);
        assert.strictEqual(unchanged?.name, 'Mutation denial target');
        assert.strictEqual(unchanged?.version, 1);
      }
    }
    const audits = await listTemplateAuditEvents(client);
    assert.strictEqual(audits.length, auditBefore + 1);
    assert.strictEqual(audits.at(-1)?.outcome, 'success');
  });

  it('creates at version 1, upgrades versionless rows, and gives exactly one concurrent writer the next version', async () => {
    const created = await createAsAdmin('Versioned template');
    assert.strictEqual(created.version, 1);

    const missing = await invoke('PUT', `/api/templates/${created.id}`, { name: 'Missing version' }, adminToken);
    assert.strictEqual(missing.statusCode, 409);
    assert.deepStrictEqual(JSON.parse(missing.body).code, 'version_conflict');

    const [left, right] = await Promise.all([
      invoke('PUT', `/api/templates/${created.id}`, { expectedVersion: 1, name: 'Writer left' }, adminToken),
      invoke('PUT', `/api/templates/${created.id}`, { expectedVersion: 1, name: 'Writer right' }, adminToken),
    ]);
    assert.deepStrictEqual([left.statusCode, right.statusCode].sort(), [200, 409]);
    assert.strictEqual((await getTemplate(client, created.id))?.version, 2);

    const legacyId = 'versionless-template';
    const now = new Date().toISOString();
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: { PK: `TEMPLATE#${legacyId}`, SK: `TEMPLATE#${legacyId}`, id: legacyId, ...minimal('Versionless'), createdAt: now, updatedAt: now },
    }));
    const legacyRead = await invoke('GET', `/api/templates/${legacyId}`, undefined, operatorToken);
    assert.strictEqual(JSON.parse(legacyRead.body).template.version, 1);
    const upgraded = await invoke('PUT', `/api/templates/${legacyId}`, { expectedVersion: 1, name: 'Upgraded' }, adminToken);
    assert.strictEqual(upgraded.statusCode, 200, upgraded.body);
    assert.strictEqual(JSON.parse(upgraded.body).template.version, 2);
  });

  it('blocks referenced deletion and archives an eligible template as a versioned retained tombstone', async () => {
    const referenced = await createAsAdmin('Referenced template private name');
    const rows = [
      [TABLE_CARDS, 'CARD#reference', { templateId: referenced.id }],
      [TABLE_TASKS, 'TASK#reference', { templateId: referenced.id }],
      [TABLE_TASKS, 'RECURRING#reference', { templateId: referenced.id }],
      [TABLE_TASKS, 'SCHEDULE#reference', { templateId: referenced.id }],
      [TABLE_CALENDAR, 'CALENDAR#reference', { templateId: referenced.id }],
      [TABLE_NOTIFICATIONS, 'NOTIFICATION#reference', { metadata: { templateId: referenced.id } }],
    ] as const;
    for (const [table, key, data] of rows) {
      await client.send(new PutCommand({ TableName: table, Item: { PK: key, SK: key, ...data } }));
    }
    const blocked = await invoke('DELETE', `/api/templates/${referenced.id}`, { expectedVersion: 1 }, adminToken);
    assert.strictEqual(blocked.statusCode, 409, blocked.body);
    const blockedBody = JSON.parse(blocked.body);
    assert.strictEqual(blockedBody.code, 'template_in_use');
    assert.deepStrictEqual(blockedBody.references, {
      total: 6,
      categories: { cards: 1, tasks: 1, recurrences: 1, schedules: 1, calendar: 1, notifications: 1 },
    });
    const serialized = JSON.stringify(blockedBody);
    assert.ok(!serialized.includes(referenced.id));
    assert.ok(!serialized.includes(referenced.name));
    assert.ok(await getTemplate(client, referenced.id));
    const rejectedAudit = (await listTemplateAuditEvents(client, referenced.id)).at(-1)!;
    assert.strictEqual(rejectedAudit.outcome, 'rejected');
    assert.strictEqual(rejectedAudit.reason, 'template_in_use');

    const eligible = await createAsAdmin('Eligible template');
    const stale = await invoke('DELETE', `/api/templates/${eligible.id}`, { expectedVersion: 2 }, adminToken);
    assert.strictEqual(stale.statusCode, 409);
    assert.ok(await getTemplate(client, eligible.id));
    const deleted = await invoke('DELETE', `/api/templates/${eligible.id}`, { expectedVersion: 1 }, adminToken);
    assert.strictEqual(deleted.statusCode, 204, deleted.body);
    assert.strictEqual(await getTemplate(client, eligible.id), null);
    const retained = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${eligible.id}`, SK: `TEMPLATE#${eligible.id}` },
    }));
    assert.strictEqual(retained.Item?.id, eligible.id);
    assert.strictEqual(retained.Item?.version, 2);
    assert.strictEqual(retained.Item?.archivedBy, ADMIN_ID);
    assert.ok(typeof retained.Item?.archivedAt === 'string');
    const deleteAudit = (await listTemplateAuditEvents(client, eligible.id)).at(-1)!;
    assert.strictEqual(deleteAudit.action, 'delete');
    assert.strictEqual(deleteAudit.priorVersion, 1);
    assert.strictEqual(deleteAudit.resultVersion, 2);
  });

  it('paginates scans beyond 1 MB and retains a resolvable tombstone across the reference race window', async () => {
    const paginated = await createAsAdmin('Paginated reference target');
    const padding = 'x'.repeat(5_000);
    for (let batchStart = 0; batchStart < 225; batchStart += 25) {
      await client.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_CARDS]: Array.from({ length: 25 }, (_, offset) => {
            const index = batchStart + offset;
            const key = `CARD#pagination-${String(index).padStart(3, '0')}`;
            return { PutRequest: { Item: { PK: key, SK: key, templateId: paginated.id, padding } } };
          }),
        },
      }));
    }
    const paginatedCounts = await countTemplateReferences(client, paginated.id);
    assert.strictEqual(paginatedCounts.cards, 225);
    assert.strictEqual(paginatedCounts.total, 225);

    const racing = await createAsAdmin('Reference race target');
    assert.strictEqual((await countTemplateReferences(client, racing.id)).total, 0);
    const raceKey = 'CARD#inserted-after-reference-scan';
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: { PK: raceKey, SK: raceKey, id: 'inserted-after-reference-scan', templateId: racing.id },
    }));
    await deleteTemplateWithAudit(client, racing.id, racing.version, ADMIN_ID);

    assert.strictEqual(await getTemplate(client, racing.id), null);
    const retained = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES,
      Key: { PK: `TEMPLATE#${racing.id}`, SK: `TEMPLATE#${racing.id}` },
    }));
    assert.strictEqual(retained.Item?.id, racing.id);
    assert.ok(retained.Item?.archivedAt);
    const racedReference = await client.send(new GetCommand({
      TableName: TABLE_CARDS,
      Key: { PK: raceKey, SK: raceKey },
    }));
    assert.strictEqual(racedReference.Item?.templateId, retained.Item?.id);

    const deniedCard = await invoke('POST', '/api/cards', {
      title: 'Must not use archived template', anchorDate: '2026-09-10', templateId: racing.id,
    }, operatorToken);
    assert.strictEqual(deniedCard.statusCode, 404, deniedCard.body);
    const deniedTask = await invoke('POST', '/api/tasks', {
      description: 'Must not use archived template', date: '2026-09-10', templateId: racing.id,
    }, operatorToken);
    assert.strictEqual(deniedTask.statusCode, 404, deniedTask.body);
    const deniedCalendar = await invoke('POST', '/api/calendar-items', {
      activityType: 'other', title: 'Must not use archived template', status: 'confirmed', allDay: true,
      startDate: '2026-09-10', endDate: '2026-09-10', templateId: racing.id,
    }, operatorToken);
    assert.strictEqual(deniedCalendar.statusCode, 404, deniedCalendar.body);
  });

  it('round-trips the full saved definition and instantiates exact ordered task values from persistence', async () => {
    const definition = {
      name: 'Fidelity template',
      type: 'workflow',
      emoji: '🧪',
      tags: ['synthetic', 'fidelity'],
      defaultAssigneeId: OPERATOR_ID,
      triggerType: 'manual',
      triggerSchedule: '',
      triggerLeadDays: 3,
      triggerEnabled: true,
      phases: [{ id: 'prepare', name: 'Preparation', stage: 'preparation' }],
      sourceDocIds: ['synthetic.process'],
      references: [{ name: 'Source', url: 'https://example.test/source' }],
      cardLinkDefinitions: [{ name: 'Result' }],
      taskDefinitions: [
        {
          refId: 'second-first', description: 'Reordered first', offsetDays: -2, phase: 'prepare',
          assigneeId: ADMIN_ID, instructionsUrl: 'https://example.test/instructions', instructionDocId: 'synthetic.sop', instructionStepId: '2',
          systems: ['example-system'], validation: { requiredCardLinks: ['Result'] }, proofRequirement: { type: 'comment', label: 'Note', required: true },
          requiredLinkName: 'Result', requiresFile: true, isMilestone: true, stageOnComplete: 'announced',
          artifactRefs: [{ artifactId: 'artifact-synthetic', type: 'report' }], assistantJobRefs: [{ assistantJobId: 'assistant-synthetic', status: 'approved' }],
          auditEventRefs: [{ auditEventId: 'audit-synthetic', action: 'reviewed' }], intakeRefs: [{ intakeItemId: 'intake-synthetic', source: 'manual' }],
        },
        { refId: 'first-second', description: 'Reordered second', offsetDays: 4, phase: 'prepare' },
      ],
    };
    const createdResponse = await invoke('POST', '/api/templates', definition, adminToken);
    assert.strictEqual(createdResponse.statusCode, 201, createdResponse.body);
    const created = JSON.parse(createdResponse.body).template;
    const reloadedResponse = await invoke('GET', `/api/templates/${created.id}`, undefined, operatorToken);
    const reloaded = JSON.parse(reloadedResponse.body).template;
    assert.deepStrictEqual(reloaded.taskDefinitions, definition.taskDefinitions);
    assert.deepStrictEqual(reloaded.sourceDocIds, definition.sourceDocIds);

    const cardResponse = await invoke('POST', '/api/cards', {
      title: 'Persisted fidelity card', anchorDate: '2026-09-10', templateId: reloaded.id,
    }, operatorToken);
    assert.strictEqual(cardResponse.statusCode, 201, cardResponse.body);
    const { card, tasks } = JSON.parse(cardResponse.body);
    assert.deepStrictEqual(tasks.map((task: Record<string, unknown>) => task.templateTaskRef), ['second-first', 'first-second']);
    assert.deepStrictEqual(tasks.map((task: Record<string, unknown>) => task.templateOffsetDays), [-2, 4]);
    assert.deepStrictEqual(tasks.map((task: Record<string, unknown>) => task.date), ['2026-09-08', '2026-09-14']);
    for (const key of ['description', 'phase', 'assigneeId', 'instructionsUrl', 'instructionDocId', 'instructionStepId', 'systems', 'validation', 'proofRequirement', 'requiredLinkName', 'requiresFile', 'isMilestone', 'stageOnComplete', 'artifactRefs', 'assistantJobRefs', 'auditEventRefs', 'intakeRefs']) {
      assert.deepStrictEqual(tasks[0][key], definition.taskDefinitions[0][key as keyof typeof definition.taskDefinitions[0]], key);
    }
    assert.deepStrictEqual(card.references, definition.references);
    assert.deepStrictEqual(card.cardLinks, [{ name: 'Result', url: '' }]);
    assert.deepStrictEqual(card.sourceDocIds, definition.sourceDocIds);
    assert.deepStrictEqual(tasks.map((task: Record<string, unknown>) => task.sourceDocIds), [definition.sourceDocIds, definition.sourceDocIds]);
  });

  it('stores privacy-safe audits and compensates a mutation when the audit store fails', async () => {
    const created = await createAsAdmin('Audit privacy template');
    const update = await invoke('PUT', `/api/templates/${created.id}`, {
      expectedVersion: 1,
      name: 'Audit privacy updated',
      taskDefinitions: [{ refId: 'safe', description: 'Sensitive-looking definition must not enter audit', offsetDays: 0 }],
    }, adminToken);
    assert.strictEqual(update.statusCode, 200, update.body);
    const audits = await listTemplateAuditEvents(client, created.id);
    assert.deepStrictEqual(audits.map((event) => event.action), ['create', 'update']);
    assert.deepStrictEqual(audits[1].changedFields, ['name', 'taskDefinitions']);
    const serialized = JSON.stringify(audits);
    assert.ok(!serialized.includes('Sensitive-looking definition'));
    assert.ok(!serialized.includes('taskDefinitions":['));

    await client.send(new DeleteTableCommand({ TableName: TABLE_AUDIT_EVENTS }));
    const failed = await invoke('PUT', `/api/templates/${created.id}`, { expectedVersion: 2, name: 'Must roll back' }, adminToken);
    assert.strictEqual(failed.statusCode, 500);
    const rolledBack = await getTemplate(client, created.id);
    assert.strictEqual(rolledBack?.name, 'Audit privacy updated');
    assert.strictEqual(rolledBack?.version, 2);
    for (;;) {
      try {
        await client.send(new DescribeTableCommand({ TableName: TABLE_AUDIT_EVENTS }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if ((error as Error).name === 'ResourceNotFoundException') break;
        throw error;
      }
    }
    await client.send(new CreateTableCommand({
      TableName: TABLE_AUDIT_EVENTS,
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
  });
});
