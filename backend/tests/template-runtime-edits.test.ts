import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { useTestDatabase, truncateTestTables } from './helpers/db';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createTemplate,
  createCardFromTemplate,
  deleteCustomTemplate,
  replaceSeedTemplate,
  TemplateRevisionConflictError,
} from '../src/db/templates';
import { getTemplateIdByType, invalidateTemplateTypeMap } from '../src/cards/createCard';
import { createUserWithId } from '../src/db/users';
import { TABLE_TEMPLATES } from '../src/db/tableNames';
import { reconcileAuthoredTemplates } from '../src/templates/authoredTemplates';
import { templateFromYaml } from '../src/templates/yamlTemplates';
import type { LambdaResponse } from '../src/types';

const OPERATOR_ID = 'template-op';
const ADMIN_ID = 'template-admin';

function authored(type: string, tasks: unknown[], rev = 'rev-1', extra: Record<string, unknown> = {}) {
  const doc = { type, name: `Name ${type}`, trigger: { mode: 'manual' }, tasks, ...extra };
  return {
    ...(templateFromYaml(doc as Record<string, unknown>) as Record<string, unknown>),
    type,
    name: (doc as Record<string, unknown>).name,
    sourcePath: `workflow-templates/${type}.yaml`,
    sourceRevision: rev,
  };
}

const TWO_TASKS = [
  { id: 'a', name: 'Task A', schedule: { offset_days: 0 } },
  { id: 'b', name: 'Task B', schedule: { offset_days: 7 }, depends_on: ['a'] },
];

function validCustomDefinition(type: string, tasks: unknown[] = TWO_TASKS) {
  return { name: `Name ${type}`, type, trigger: { mode: 'manual' }, tasks };
}

describe('Templates runtime editing', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    ({ client } = await useTestDatabase());
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@example.test', role: 'operator' });
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@example.test', role: 'admin' });
  });

  beforeEach(async () => {
    await truncateTestTables(client);
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@example.test', role: 'operator' });
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@example.test', role: 'admin' });
  });

  function call(method: string, path: string, body?: unknown, userId?: string, query?: Record<string, string>) {
    return handler({
      httpMethod: method,
      path,
      headers: userId ? { 'x-user-id': userId } : {},
      queryStringParameters: query || null,
      body: body === undefined ? null : JSON.stringify(body),
    }, {});
  }

  const get = (path: string, userId?: string, query?: Record<string, string>) => call('GET', path, undefined, userId, query);
  const bodyOf = (response: LambdaResponse) => JSON.parse(response.body);

  async function createCustom(type: string, tasks: unknown[] = TWO_TASKS, userId?: string) {
    const response = await call('POST', '/api/templates', validCustomDefinition(type, tasks), userId);
    assert.equal(response.statusCode, 201, response.body);
    return bodyOf(response).template;
  }

  it('creates a custom template with identity metadata and lists it without guard rows', async () => {
    const template = await createCustom('custom-one');
    assert.equal(template.origin, 'custom');
    assert.equal(template.pinned, false);
    assert.equal(template.version, 1);
    assert.ok(typeof template.revision === 'string' && template.revision.length > 0);
    const listed = bodyOf(await get('/api/templates'));
    assert.equal(listed.templates.length, 1);
    const guard = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES, Key: { PK: 'TEMPLATE_TYPE#custom-one', SK: 'TEMPLATE_TYPE#custom-one' },
    }));
    assert.equal(guard.Item?.templateId, template.id);
  });

  it('rejects invalid definitions with shared validator issues', async () => {
    for (const [tasks, match] of [
      [[{ id: 'a', name: 'A', schedule: { offset_days: 0 } }, { id: 'a', name: 'Dup', schedule: { offset_days: 1 } }], /duplicate/i],
      [[{ id: 'a', name: 'A', schedule: { offset_days: 0 }, depends_on: ['missing'] }], /unknown task/i],
      [
        [
          { id: 'a', name: 'A', schedule: { offset_days: 0 }, depends_on: ['b'] },
          { id: 'b', name: 'B', schedule: { offset_days: 1 }, depends_on: ['a'] },
        ],
        /cycle/i,
      ],
      [[{ id: 'a', name: 'A' }], /offset_days/i],
    ] as const) {
      const response = await call('POST', '/api/templates', validCustomDefinition('bad-def', tasks as unknown[]));
      assert.equal(response.statusCode, 422, response.body);
      const body = bodyOf(response);
      assert.equal(body.code, 'invalid-template');
      assert.match(JSON.stringify(body.issues), match);
    }
    const typeResponse = await call('POST', '/api/templates', { name: 'No type', trigger: { mode: 'manual' }, tasks: TWO_TASKS });
    assert.equal(typeResponse.statusCode, 422);
    const owned = await call('POST', '/api/templates', { ...validCustomDefinition('owned'), id: 'nope' });
    assert.equal(owned.statusCode, 400);
  });

  it('refuses duplicate types and names the conflict', async () => {
    await createCustom('dup-type');
    const response = await call('POST', '/api/templates', validCustomDefinition('dup-type'));
    assert.equal(response.statusCode, 409);
    assert.equal(bodyOf(response).code, 'duplicate-type');
  });

  it('gates create/delete on admin but lets operators pin and reset', async () => {
    assert.equal((await call('POST', '/api/templates', validCustomDefinition('op-create'), OPERATOR_ID)).statusCode, 403);
    const template = await createCustom('op-pin');
    const pinned = await call('PUT', `/api/templates/${template.id}`, {
      expectedVersion: 1, revision: template.revision,
      definition: { ...validCustomDefinition('op-pin'), trigger: { mode: 'manual' }, taskDefinitions: [{ refId: 'a', description: 'A', offsetDays: 3 }] },
    }, OPERATOR_ID);
    assert.equal(pinned.statusCode, 200, pinned.body);
    const reset = await call('POST', `/api/templates/${template.id}/reset`, {
      expectedVersion: 2, revision: template.revision,
    }, OPERATOR_ID);
    // Custom templates have no Git base to restore.
    assert.equal(reset.statusCode, 409);
    assert.equal(bodyOf(reset).code, 'cannot-reset-custom-template');
    const deleted = await call('DELETE', `/api/templates/${template.id}`, {
      expectedVersion: 2, revision: template.revision,
    }, OPERATOR_ID);
    assert.equal(deleted.statusCode, 403);
  });

  it('pins a whole definition, enforces CAS, and supports dry runs', async () => {
    const template = await createCustom('pin-me');
    const update = {
      expectedVersion: 1,
      revision: template.revision,
      definition: {
        ...validCustomDefinition('pin-me'),
        taskDefinitions: [
          { refId: 'a', description: 'Task A renamed', offsetDays: 5 },
          { refId: 'c', description: 'Task C new', offsetDays: 9 },
        ],
      },
    };
    const dry = await call('PUT', `/api/templates/${template.id}`, update, undefined, { dryRun: 'true' });
    assert.equal(dry.statusCode, 200);
    assert.equal(bodyOf(dry).dryRun, true);
    assert.equal(bodyOf(await get(`/api/templates/${template.id}`)).template.version, 1);

    const pinned = await call('PUT', `/api/templates/${template.id}`, update);
    assert.equal(pinned.statusCode, 200, pinned.body);
    assert.equal(bodyOf(pinned).template.version, 2);
    const effective = bodyOf(await get(`/api/templates/${template.id}`)).template;
    assert.equal(effective.pinned, false);
    assert.deepEqual(effective.taskDefinitions.map((task: { refId: string }) => task.refId), ['a', 'c']);

    const stale = await call('PUT', `/api/templates/${template.id}`, update);
    assert.equal(stale.statusCode, 409);
    const conflict = bodyOf(stale);
    assert.equal(conflict.code, 'template_version_conflict');
    assert.equal(conflict.currentVersion, 2);
    assert.equal(conflict.currentTemplate.version, 2);

    const wrongRevision = await call('PUT', `/api/templates/${template.id}`, { ...update, expectedVersion: 2, revision: 'nope' });
    assert.equal(wrongRevision.statusCode, 409);

    const renamed = await call('PUT', `/api/templates/${template.id}`, {
      expectedVersion: 2, revision: template.revision,
      definition: { ...validCustomDefinition('other-type'), taskDefinitions: [{ refId: 'a', description: 'A', offsetDays: 0 }] },
    });
    assert.equal(renamed.statusCode, 422);
    assert.equal(bodyOf(renamed).code, 'immutable-template-type');

    assert.equal((await call('PUT', '/api/templates/missing', update)).statusCode, 404);
  });

  it('instantiates from the pinned effective definition and freezes existing snapshots', async () => {
    const template = await createCustom('instantiate-me');
    const cardRes = await call('POST', '/api/cards', {
      title: 'Before pin', anchorDate: '2026-08-10', templateId: template.id, stage: 'preparation',
    });
    assert.equal(cardRes.statusCode, 201, cardRes.body);
    const before = bodyOf(cardRes);

    await call('PUT', `/api/templates/${template.id}`, {
      expectedVersion: 1, revision: template.revision,
      definition: {
        ...validCustomDefinition('instantiate-me'),
        taskDefinitions: [
          { refId: 'a', description: 'Task A moved', offsetDays: 5 },
          { refId: 'z', description: 'Task Z new', offsetDays: 1 },
        ],
      },
    });

    const afterRes = await call('POST', '/api/cards', {
      title: 'After pin', anchorDate: '2026-08-10', templateId: template.id, stage: 'preparation',
    });
    assert.equal(afterRes.statusCode, 201, afterRes.body);
    const afterTasks = bodyOf(afterRes).tasks;
    assert.deepEqual(afterTasks.map((task: { templateTaskRef: string }) => task.templateTaskRef).sort(), ['a', 'z']);
    assert.equal(afterTasks.find((task: { templateTaskRef: string }) => task.templateTaskRef === 'a').date, '2026-08-15');

    const frozen = bodyOf(await get(`/api/cards/${before.card.id}`)).card;
    assert.equal(frozen.templateVersion, 1);
    const oldTasks = bodyOf(await get('/api/tasks', undefined, { cardId: before.card.id }));
    const tasks = Array.isArray(oldTasks?.tasks) ? oldTasks.tasks : oldTasks;
    assert.ok(tasks.every((task: { templateTaskRef: string }) => task.templateTaskRef !== 'z'));
  });

  it('deletes unused custom templates, refuses Git rows and in-use rows, and releases the type', async () => {
    const template = await createCustom('delete-me');
    const gitSeeded = await reconcileAuthoredTemplates(client, [authored('git-kept', TWO_TASKS, 'rev-1')]);
    assert.deepEqual(Object.keys(gitSeeded).sort(), ['created', 'total', 'unchanged', 'updated']);
    const git = bodyOf(await get('/api/templates')).templates.find((entry: { type: string }) => entry.type === 'git-kept');

    const gitDelete = await call('DELETE', `/api/templates/${git.id}`, { expectedVersion: 1, revision: git.revision });
    assert.equal(gitDelete.statusCode, 409);
    assert.equal(bodyOf(gitDelete).code, 'cannot-delete-git-template');

    const cardRes = await call('POST', '/api/cards', {
      title: 'Uses template', anchorDate: '2026-08-10', templateId: template.id, stage: 'preparation',
    });
    assert.equal(cardRes.statusCode, 201, cardRes.body);
    const inUse = await call('DELETE', `/api/templates/${template.id}`, { expectedVersion: 1, revision: template.revision });
    assert.equal(inUse.statusCode, 409);
    assert.equal(bodyOf(inUse).code, 'template-in-use');

    const stale = await call('DELETE', `/api/templates/${template.id}`, { expectedVersion: 99, revision: template.revision });
    assert.equal(stale.statusCode, 409);

    // A card created from a pinned copy does not block deleting an unused twin.
    const twin = await createCustom('delete-twin');
    const removed = await call('DELETE', `/api/templates/${twin.id}`, { expectedVersion: 1, revision: twin.revision });
    assert.equal(removed.statusCode, 200);
    assert.equal((await get(`/api/templates/${twin.id}`)).statusCode, 404);
    const recreated = await createCustom('delete-twin');
    assert.notEqual(recreated.id, twin.id);
    // The in-use template survived its refused deletion.
    assert.equal((await get(`/api/templates/${template.id}`)).statusCode, 200);
  });

  async function putRawTemplate(item: Record<string, unknown>): Promise<string> {
    const id = String(item.id || randomUUID());
    const now = new Date().toISOString();
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: {
        PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}`, id,
        createdAt: now, updatedAt: now, ...item, version: 1,
      },
    }));
    return id;
  }

  async function seedGit(type: string, tasks: unknown[] = TWO_TASKS, rev = 'rev-1') {
    const report = await reconcileAuthoredTemplates(client, [authored(type, tasks, rev)]);
    assert.deepStrictEqual(report, { total: 1, created: 1, updated: 0, unchanged: 0 });
    return bodyOf(await get('/api/templates')).templates.find((entry: { type: string }) => entry.type === type);
  }

  it('requires revision on every mutation', async () => {
    const template = await createCustom('rev-required');
    for (const [method, path, body] of [
      ['PUT', `/api/templates/${template.id}`, { expectedVersion: 1, definition: validCustomDefinition('rev-required') }],
      ['POST', `/api/templates/${template.id}/reset`, { expectedVersion: 1 }],
      ['DELETE', `/api/templates/${template.id}`, { expectedVersion: 1 }],
    ] as const) {
      const response = await call(method, path, body);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(bodyOf(response).code, 'invalid-body');
    }
    assert.equal(bodyOf(await get(`/api/templates/${template.id}`)).template.version, 1);
  });

  it('fails closed on unmigrated rows without writing and refuses deleting a row with revision but missing canonical origin', async () => {
    const id = await putRawTemplate({
      name: 'Unmigrated', type: 'unmigrated-row', triggerType: 'manual',
      taskDefinitions: [{ refId: 'a', description: 'A', offsetDays: 0 }],
      sourcePath: 'workflow-templates/unmigrated-row.yaml', sourceRevision: 'rev-1',
    });
    const before = bodyOf(await get(`/api/templates/${id}`)).template;
    assert.equal(before.revision, undefined);
    for (const [method, path, body] of [
      ['PUT', `/api/templates/${id}`, { expectedVersion: 1, revision: 'whatever', definition: validCustomDefinition('unmigrated-row') }],
      ['POST', `/api/templates/${id}/reset`, { expectedVersion: 1, revision: 'whatever' }],
      ['DELETE', `/api/templates/${id}`, { expectedVersion: 1, revision: 'whatever' }],
    ] as const) {
      const response = await call(method, path, body);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(bodyOf(response).code, 'template_version_conflict');
    }
    assert.deepStrictEqual(bodyOf(await get(`/api/templates/${id}`)).template, before);

    // A raw row with a valid version+revision pair but missing canonical origin
    // (and no sourcePath/sourceRevision) must fail closed on DELETE rather than
    // falling back to custom.
    const rawWithRevId = await putRawTemplate({
      name: 'Missing Origin With Revision',
      type: 'missing-origin-rev',
      triggerType: 'manual',
      revision: 'rev-present-1',
      taskDefinitions: [{ refId: 'a', description: 'A', offsetDays: 0 }],
    });
    const beforeRawWithRev = bodyOf(await get(`/api/templates/${rawWithRevId}`)).template;
    const deleteRes = await call('DELETE', `/api/templates/${rawWithRevId}`, {
      expectedVersion: 1,
      revision: 'rev-present-1',
    });
    assert.equal(deleteRes.statusCode, 409, deleteRes.body);
    assert.equal(bodyOf(deleteRes).code, 'cannot-delete-git-template');
    assert.deepStrictEqual(bodyOf(await get(`/api/templates/${rawWithRevId}`)).template, beforeRawWithRev);
  });

  it('fails closed before writing on legacy Git-provenance rows lacking canonical origin', async () => {
    const legacyId = await putRawTemplate({
      name: 'Name premig-row', type: 'premig-row', triggerType: 'manual',
      taskDefinitions: [
        { refId: 'a', description: 'Task A', offsetDays: 0 },
        { refId: 'b', description: 'Task B', offsetDays: 7, dependsOn: ['a'] },
      ],
      sourcePath: 'workflow-templates/premig-row.yaml', sourceRevision: 'rev-1',
    });
    const beforeLegacy = bodyOf(await get(`/api/templates/${legacyId}`)).template;
    await assert.rejects(
      reconcileAuthoredTemplates(client, [
        authored('fresh-before-fail', TWO_TASKS, 'rev-1'),
        authored('premig-row', TWO_TASKS, 'rev-1'),
      ]),
      new RegExp(`Unclassified runtime workflow template ${legacyId}: missing or invalid canonical origin`),
    );
    const listed = bodyOf(await get('/api/templates')).templates;
    assert.deepStrictEqual(listed.map((t: { id: string }) => t.id), [legacyId]);
    assert.deepStrictEqual(bodyOf(await get(`/api/templates/${legacyId}`)).template, beforeLegacy);
    for (const guardType of ['premig-row', 'fresh-before-fail']) {
      const guard = await client.send(new GetCommand({
        TableName: TABLE_TEMPLATES, Key: { PK: `TEMPLATE_TYPE#${guardType}`, SK: `TEMPLATE_TYPE#${guardType}` },
      }));
      assert.equal(guard.Item, undefined);
    }
  });

  for (const [label, fields] of [
    ['missing revision', { origin: 'git', pinned: false, base: { name: 'X' } }],
    ['missing boolean pinned', { origin: 'git', revision: 'rev-ok', base: { name: 'X' } }],
    ['missing base map', { origin: 'git', revision: 'rev-ok', pinned: false }],
  ] as const) {
    it(`fails closed before writing on malformed canonical Git row (${label})`, async () => {
      const type = `malformed-${label.replace(/\s+/g, '-')}`;
      const otherType = `other-before-${label.replace(/\s+/g, '-')}`;
      const id = await putRawTemplate({
        name: `Name ${type}`, type, triggerType: 'manual',
        taskDefinitions: [{ refId: 'a', description: 'Task A', offsetDays: 0 }],
        sourcePath: `workflow-templates/${type}.yaml`, sourceRevision: 'rev-1',
        ...fields,
      });
      const before = bodyOf(await get(`/api/templates/${id}`)).template;
      await assert.rejects(
        reconcileAuthoredTemplates(client, [
          authored(otherType, TWO_TASKS, 'rev-1'),
          authored(type, TWO_TASKS, 'rev-1'),
        ]),
        new RegExp(`Malformed canonical Git workflow template ${id}: missing revision, pinned, or base`),
      );
      const listed = bodyOf(await get('/api/templates')).templates;
      assert.deepStrictEqual(listed.map((t: { id: string }) => t.id), [id]);
      assert.deepStrictEqual(bodyOf(await get(`/api/templates/${id}`)).template, before);
      for (const guardType of [type, otherType]) {
        const guard = await client.send(new GetCommand({
          TableName: TABLE_TEMPLATES, Key: { PK: `TEMPLATE_TYPE#${guardType}`, SK: `TEMPLATE_TYPE#${guardType}` },
        }));
        assert.equal(guard.Item, undefined);
      }
    });
  }

  it('replaceSeedTemplate fails closed with zero writes when existing revision is missing or empty', async () => {
    for (const [label, extra] of [
      ['missing', {}],
      ['empty', { revision: '' }],
    ] as const) {
      const id = await putRawTemplate({
        name: `Legacy ${label}`, type: `replace-seed-${label}`, triggerType: 'manual',
        taskDefinitions: [{ refId: 'a', description: 'Task A', offsetDays: 0 }],
        sourcePath: `workflow-templates/replace-seed-${label}.yaml`, sourceRevision: 'rev-1',
        ...extra,
      });
      const beforeRaw = (await client.send(new GetCommand({
        TableName: TABLE_TEMPLATES, Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` }, ConsistentRead: true,
      }))).Item;
      await assert.rejects(
        replaceSeedTemplate(client, id, authored(`replace-seed-${label}`, TWO_TASKS, 'rev-2'), 1),
        (error: unknown) => error instanceof TemplateRevisionConflictError,
      );
      const afterRaw = (await client.send(new GetCommand({
        TableName: TABLE_TEMPLATES, Key: { PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}` }, ConsistentRead: true,
      }))).Item;
      assert.deepStrictEqual(afterRaw, beforeRaw);
      assert.equal(afterRaw?.version, 1);
      assert.equal(afterRaw?.revision, extra.revision);
    }
  });

  it('replaceSeedTemplate preserves canonical revision on valid Git replacement', async () => {
    const seeded = await seedGit('replace-seed-canonical', [{ id: 'a', name: 'Task A', schedule: { offset_days: 0 } }], 'rev-1');
    const replaced = await replaceSeedTemplate(
      client,
      seeded.id,
      authored('replace-seed-canonical', TWO_TASKS, 'rev-2'),
      1,
    );
    assert.equal(replaced.id, seeded.id);
    assert.equal(replaced.version, 2);
    assert.equal(replaced.revision, seeded.revision);
    assert.equal(replaced.origin, 'git');
    assert.equal(replaced.pinned, false);
    assert.equal(replaced.baseSourceRevision, 'rev-2');
    assert.deepStrictEqual(replaced.taskDefinitions.map((task: { refId: string }) => task.refId), ['a', 'b']);
  });

  it('preserves pins across seeds and keeps custom rows', async () => {
    const seeded = await seedGit('pin-kept', TWO_TASKS, 'rev-git-1');
    await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 1, revision: seeded.revision,
      definition: {
        ...validCustomDefinition('pin-kept'),
        taskDefinitions: [{ refId: 'only', description: 'Only task', offsetDays: 2 }],
      },
    });
    const adopted = await reconcileAuthoredTemplates(client, [authored('pin-kept', TWO_TASKS, 'rev-git-1')]);
    assert.deepStrictEqual(adopted, { total: 1, created: 0, updated: 0, unchanged: 1 });
    const effective = bodyOf(await get(`/api/templates/${seeded.id}`)).template;
    assert.equal(effective.id, seeded.id);
    assert.equal(effective.origin, 'git');
    assert.equal(effective.pinned, true);
    assert.deepStrictEqual(effective.taskDefinitions.map((task: { refId: string }) => task.refId), ['only']);

    // A seed with a new base advances the base but never the pin.
    const rebased = await reconcileAuthoredTemplates(client, [authored('pin-kept', [
      { id: 'a', name: 'Task A', schedule: { offset_days: 30 } },
      { id: 'b', name: 'Task B', schedule: { offset_days: 31 }, depends_on: ['a'] },
    ], 'rev-git-2')]);
    assert.deepStrictEqual(rebased, { total: 1, created: 0, updated: 1, unchanged: 0 });
    const afterSeed = bodyOf(await get(`/api/templates/${seeded.id}`)).template;
    assert.deepStrictEqual(afterSeed.taskDefinitions.map((task: { refId: string }) => task.refId), ['only']);
    assert.equal(afterSeed.baseSourceRevision, 'rev-git-2');

    // An identical seed is a no-op.
    const same = await reconcileAuthoredTemplates(client, [authored('pin-kept', [
      { id: 'a', name: 'Task A', schedule: { offset_days: 30 } },
      { id: 'b', name: 'Task B', schedule: { offset_days: 31 }, depends_on: ['a'] },
    ], 'rev-git-2')]);
    assert.deepStrictEqual(same, { total: 1, created: 0, updated: 0, unchanged: 1 });

    // Custom rows whose type is absent from Git survive.
    await createCustom('custom-kept');
    const keptSeed = await reconcileAuthoredTemplates(client, [authored('pin-kept', [
      { id: 'a', name: 'Task A', schedule: { offset_days: 30 } },
      { id: 'b', name: 'Task B', schedule: { offset_days: 31 }, depends_on: ['a'] },
    ], 'rev-git-2')]);
    assert.deepStrictEqual(keptSeed, { total: 1, created: 0, updated: 0, unchanged: 1 });
    assert.ok(bodyOf(await get('/api/templates')).templates.some((entry: { type: string }) => entry.type === 'custom-kept'));
  });

  it('fails closed loudly on stale Git rows', async () => {
    await seedGit('pin-kept', TWO_TASKS, 'rev-git-2');
    await createTemplate(client, { name: 'Stale', type: 'stale-git', sourcePath: 'workflow-templates/stale-git.yaml', sourceRevision: 'rev-1' });
    await assert.rejects(
      reconcileAuthoredTemplates(client, [authored('pin-kept', TWO_TASKS, 'rev-git-2')]),
      /absent from Git: stale-git/,
    );
  });

  it('fails closed loudly on explicit custom collisions, leaving the row alone', async () => {
    const collision = await createCustom('collision-x');
    await assert.rejects(
      reconcileAuthoredTemplates(client, [authored('collision-x', TWO_TASKS, 'rev-1')]),
      /collides with custom template: collision-x/,
    );
    const intact = bodyOf(await get(`/api/templates/${collision.id}`)).template;
    assert.equal(intact.origin, 'custom');
    assert.equal(intact.version, 1);
  });

  it('fails closed loudly on unclassified typed rows', async () => {
    await seedGit('pin-kept', TWO_TASKS, 'rev-git-2');
    // Unclassified rows (no canonical origin) fail loudly before any write.
    const mysteryId = await putRawTemplate({ name: 'Mystery', type: 'mystery-type' });
    await assert.rejects(
      reconcileAuthoredTemplates(client, [
        authored('fresh-unwritten', TWO_TASKS, 'rev-git-2'),
        authored('pin-kept', TWO_TASKS, 'rev-git-2'),
      ]),
      new RegExp(`Unclassified runtime workflow template ${mysteryId}: missing or invalid canonical origin`),
    );
    assert.equal(
      bodyOf(await get('/api/templates')).templates.some((t: { type?: string }) => t.type === 'fresh-unwritten'),
      false,
    );
  });

  it('fails closed loudly on unclassified untyped rows before writing', async () => {
    const untypedId = await putRawTemplate({ name: 'Untyped mystery' });
    const before = bodyOf(await get(`/api/templates/${untypedId}`)).template;
    await assert.rejects(
      reconcileAuthoredTemplates(client, [authored('fresh-unwritten', TWO_TASKS, 'rev-git-1')]),
      new RegExp(`Unclassified runtime workflow template ${untypedId}: missing or invalid canonical origin`),
    );
    const listed = bodyOf(await get('/api/templates')).templates;
    assert.deepStrictEqual(listed.map((t: { id: string }) => t.id), [untypedId]);
    assert.deepStrictEqual(bodyOf(await get(`/api/templates/${untypedId}`)).template, before);
    const guard = await client.send(new GetCommand({
      TableName: TABLE_TEMPLATES, Key: { PK: 'TEMPLATE_TYPE#fresh-unwritten', SK: 'TEMPLATE_TYPE#fresh-unwritten' },
    }));
    assert.equal(guard.Item, undefined);
  });

  it('resets a pinned Git template to its base and reports idempotent resets', async () => {
    const seeded = await seedGit('reset-me', TWO_TASKS, 'rev-git-1');
    await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 1, revision: seeded.revision,
      definition: {
        ...validCustomDefinition('reset-me'),
        taskDefinitions: [{ refId: 'only', description: 'Only', offsetDays: 2 }],
      },
    });
    const pinned = bodyOf(await get(`/api/templates/${seeded.id}`)).template;
    assert.equal(pinned.pinned, true);
    const reset = await call('POST', `/api/templates/${seeded.id}/reset`, { expectedVersion: 2, revision: pinned.revision });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(bodyOf(reset).applied, true);
    const restored = bodyOf(reset).template;
    assert.equal(restored.pinned, false);
    assert.deepStrictEqual(restored.taskDefinitions.map((task: { refId: string }) => task.refId), ['a', 'b']);
    const again = await call('POST', `/api/templates/${seeded.id}/reset`, { expectedVersion: 3, revision: pinned.revision });
    assert.equal(bodyOf(again).applied, false);
  });

  it('reset dry runs validate the pair and Git origin without writing', async () => {
    const seeded = await seedGit('reset-dry', TWO_TASKS, 'rev-git-1');
    await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 1, revision: seeded.revision,
      definition: {
        ...validCustomDefinition('reset-dry'),
        taskDefinitions: [{ refId: 'only', description: 'Only', offsetDays: 2 }],
      },
    });
    const pinned = bodyOf(await get(`/api/templates/${seeded.id}`)).template;
    const staleDry = await call('POST', `/api/templates/${seeded.id}/reset`, {
      expectedVersion: 1, revision: pinned.revision,
    }, undefined, { dryRun: 'true' });
    assert.equal(staleDry.statusCode, 409, staleDry.body);
    assert.equal(bodyOf(staleDry).code, 'template_version_conflict');
    assert.equal(bodyOf(staleDry).currentVersion, 2);

    const custom = await createCustom('reset-dry-custom');
    const customDry = await call('POST', `/api/templates/${custom.id}/reset`, {
      expectedVersion: 1, revision: custom.revision,
    }, undefined, { dryRun: 'true' });
    assert.equal(customDry.statusCode, 409);
    assert.equal(bodyOf(customDry).code, 'cannot-reset-custom-template');

    const valid = await call('POST', `/api/templates/${seeded.id}/reset`, {
      expectedVersion: 2, revision: pinned.revision,
    }, undefined, { dryRun: 'true' });
    assert.equal(valid.statusCode, 200, valid.body);
    assert.equal(bodyOf(valid).dryRun, true);
    assert.equal(bodyOf(await get(`/api/templates/${seeded.id}`)).template.version, 2);
  });

  it('loses a seed-vs-edit race exactly once with a 409 for the loser', async () => {
    const seeded = await seedGit('race-me', TWO_TASKS, 'rev-git-1');
    await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 1, revision: seeded.revision,
      definition: validCustomDefinition('race-me'),
    });
    await reconcileAuthoredTemplates(client, [authored('race-me', [
      { id: 'a', name: 'Task A', schedule: { offset_days: 30 } },
      { id: 'b', name: 'Task B', schedule: { offset_days: 31 }, depends_on: ['a'] },
    ], 'rev-git-2')]);
    const loser = await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 2, revision: seeded.revision,
      definition: validCustomDefinition('race-me'),
    });
    assert.equal(loser.statusCode, 409);
    assert.equal(bodyOf(loser).currentVersion, 3);
  });

  it('keeps the canonical revision stable across writes and seeds', async () => {
    const template = await createCustom('rev-stable');
    const first = await call('PUT', `/api/templates/${template.id}`, {
      expectedVersion: 1, revision: template.revision,
      definition: validCustomDefinition('rev-stable'),
    });
    assert.equal(bodyOf(first).template.version, 2);
    const second = await call('PUT', `/api/templates/${template.id}`, {
      expectedVersion: 2, revision: template.revision,
      definition: validCustomDefinition('rev-stable'),
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(bodyOf(second).template.version, 3);
    assert.equal(bodyOf(second).template.revision, template.revision);
  });

  it('stale type-map entries cannot create cards against a deleted template', async () => {    const template = await createCustom('stale-cache');
    assert.equal((await getTemplateIdByType(client)).get('stale-cache'), template.id);
    const fetched = bodyOf(await get(`/api/templates/${template.id}`)).template;
    // A cross-Lambda delete bypasses this process's invalidation, leaving the
    // warmed map stale on purpose.
    const deleted = await deleteCustomTemplate(client, template.id, 1, fetched.revision);
    assert.ok(deleted);
    assert.equal((await getTemplateIdByType(client)).get('stale-cache'), template.id);
    // The route's existence pre-check refuses first (fail closed)...
    const cardRes = await call('POST', '/api/cards', {
      title: 'Must not exist', anchorDate: '2026-08-10', templateId: template.id, stage: 'preparation',
    });
    assert.equal(cardRes.statusCode, 404, cardRes.body);
    // ...and the transactional fence refuses a stale in-hand definition too,
    // which is what a concurrent delete racing creation would hit.
    await assert.rejects(
      createCardFromTemplate(
        client,
        { title: 'Must not exist', anchorDate: '2026-08-10', stage: 'preparation' },
        fetched,
        '2026-08-10',
      ),
      /Template version conflict/,
    );
    invalidateTemplateTypeMap();
    assert.equal((await getTemplateIdByType(client)).get('stale-cache'), undefined);
  });

  it('a stale reset reports the current template for retry', async () => {
    const seeded = await seedGit('reset-conflict', TWO_TASKS, 'rev-git-1');
    await call('PUT', `/api/templates/${seeded.id}`, {
      expectedVersion: 1, revision: seeded.revision,
      definition: {
        ...validCustomDefinition('reset-conflict'),
        taskDefinitions: [{ refId: 'only', description: 'Only', offsetDays: 2 }],
      },
    });
    await reconcileAuthoredTemplates(client, [authored('reset-conflict', [
      { id: 'a', name: 'Task A', schedule: { offset_days: 30 } },
      { id: 'b', name: 'Task B', schedule: { offset_days: 31 }, depends_on: ['a'] },
    ], 'rev-git-2')]);
    const pinned = bodyOf(await get(`/api/templates/${seeded.id}`)).template;
    const stale = await call('POST', `/api/templates/${seeded.id}/reset`, {
      expectedVersion: 2, revision: pinned.revision,
    });
    assert.equal(stale.statusCode, 409, stale.body);
    const conflict = bodyOf(stale);
    assert.equal(conflict.code, 'template_version_conflict');
    assert.equal(conflict.currentVersion, 3);
    assert.equal(conflict.currentTemplate.version, 3);
    assert.equal(conflict.currentTemplate.id, seeded.id);
  });
});
