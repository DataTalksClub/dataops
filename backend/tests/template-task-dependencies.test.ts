import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient, disableLocalTransactionEmulation } from '../src/db/client';
import { getTask, listTasksByCard } from '../src/db/tasks';
import { createCardFromTemplate, createTemplate, instantiateTemplate } from '../src/db/templates';
import { createCard } from '../src/db/cards';
import { applyCardTemplateUpdate } from '../src/db/cardTemplateUpdates';
import {
  templateCardDefinitionSnapshot,
  templateTaskDefinitionSnapshot,
} from '../src/templates/cardTemplateProjection';
import { buildCardTemplateUpdatePlan, CardTemplateUpdateInvalidStateError } from '../src/templates/cardTemplateUpdates';
import { prerequisitesFirst, templateDependencyIssues } from '../src/templates/taskDependencyGraph';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import type { Card, Task, Template } from '../src/types';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { syntheticAuthoredTemplate } from './helpers/authoredTemplates';

const CREATED = '2026-01-01T00:00:00.000Z';

function podcastTemplate(version = 1, withDependency = true): Template {
  return {
    id: 'template-podcast',
    name: 'Podcast',
    type: 'podcast',
    version,
    sourceRevision: `revision-${version}`,
    taskDefinitions: [
      { refId: 'page', description: 'Publish page', offsetDays: 2, ...(withDependency ? { dependsOn: ['spotify', 'transcript'] } : {}) },
      { refId: 'spotify', description: 'Verify Spotify episode', offsetDays: 1 },
      { refId: 'transcript', description: 'Review transcript', offsetDays: 1 },
    ],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

describe('template dependency graph rules', () => {
  const definition = (refId: string, dependsOn?: string[], optionalGroup?: string) => ({ refId, dependsOn, optionalGroup });

  it('accepts a diamond and rejects self, unknown, duplicate and cyclic refs', () => {
    assert.deepEqual(templateDependencyIssues([
      definition('a'), definition('b', ['a']), definition('c', ['a']), definition('d', ['b', 'c']),
    ]), []);
    assert.match(templateDependencyIssues([definition('a', ['a'])]).join(), /cannot depend on itself/);
    assert.match(templateDependencyIssues([definition('a', ['zzz'])]).join(), /unknown task 'zzz'/);
    assert.match(templateDependencyIssues([definition('a'), definition('b', ['a', 'a'])]).join(), /more than once/);
    assert.match(
      templateDependencyIssues([definition('a', ['c']), definition('b', ['a']), definition('c', ['b'])]).join(),
      /cycle: a -> c -> b -> a/,
    );
  });

  it('keeps a dependency from crossing an optional group boundary', () => {
    assert.match(
      templateDependencyIssues([definition('a', undefined, 'extra'), definition('b', ['a'])]).join(),
      /optional group 'extra'/,
    );
    assert.deepEqual(templateDependencyIssues([
      definition('a', undefined, 'extra'), definition('b', ['a'], 'extra'), definition('c', ['b'], 'extra'),
    ]), []);
    assert.deepEqual(templateDependencyIssues([definition('a'), definition('b', ['a'], 'extra')]), []);
  });

  it('orders prerequisites before dependents', () => {
    const ordered = prerequisitesFirst([definition('d', ['b', 'c']), definition('b', ['a']), definition('c'), definition('a')]);
    assert.deepEqual(ordered.map(({ refId }) => refId), ['a', 'b', 'c', 'd']);
  });
});

describe('authored YAML dependencies', () => {
  it('round-trips depends_on and validates the graph', () => {
    const authored = syntheticAuthoredTemplate();
    const tasks = authored.tasks as Record<string, unknown>[];
    tasks.push({ ...structuredClone(tasks[0]), id: 'dependent-task', name: 'Dependent', depends_on: [tasks[0].id] });
    assert.deepEqual(validateAuthoredTemplate(authored), []);
    const runtime = templateFromYaml(authored);
    const dependent = (runtime.taskDefinitions as Record<string, unknown>[]).find(({ refId }) => refId === 'dependent-task');
    assert.deepEqual(dependent?.dependsOn, [tasks[0].id]);
    assert.deepEqual(templateToYaml(runtime), authored);

    tasks[0].depends_on = ['dependent-task'];
    assert.match(validateAuthoredTemplate(authored).map(({ message }) => message).join(), /cycle/);
    tasks[0].depends_on = ['missing'];
    assert.match(validateAuthoredTemplate(authored).map(({ message }) => message).join(), /unknown task 'missing'/);
    tasks[0].depends_on = 'not-a-list';
    assert.match(validateAuthoredTemplate(authored).map(({ message }) => message).join(), /depends_on must be a string list/);
  });
});

function withoutId(template: Template): Record<string, unknown> {
  const { id: _id, ...rest } = template;
  return rest;
}

describe('instantiation resolves refs to Task ids', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(stopLocal);

  const byRef = (tasks: Task[]) => new Map(tasks.map((task) => [task.templateTaskRef!, task]));

  it('creates a Template Card whose Tasks depend on their prerequisites by id', async () => {
    const template = await createTemplate(client, withoutId(podcastTemplate()));
    const { tasks } = await createCardFromTemplate(
      client,
      { id: 'dependency-card', title: 'Episode', anchorDate: '2026-10-01', templateId: template.id },
      template,
      '2026-10-01',
    );
    const refs = byRef(tasks);
    assert.deepEqual(refs.get('page')!.dependsOn, [refs.get('spotify')!.id, refs.get('transcript')!.id]);
    assert.equal(refs.get('spotify')!.dependsOn, undefined);
    // The ref list stays in the snapshot only; the Task stores ids.
    assert.equal((refs.get('page') as Record<string, unknown>).dependsOnRefs, undefined);
    assert.deepEqual(refs.get('page')!.templateDefinitionSnapshot?.dependsOnRefs, ['spotify', 'transcript']);
    const stored = await getTask(client, refs.get('page')!.id);
    assert.deepEqual(stored?.dependsOn, refs.get('page')!.dependsOn);
  });

  it('refuses to instantiate a Template whose dependencies are invalid', async () => {
    const cyclic = await createTemplate(client, {
      name: 'Cyclic',
      taskDefinitions: [
        { refId: 'a', description: 'A', offsetDays: 0, dependsOn: ['b'] },
        { refId: 'b', description: 'B', offsetDays: 0, dependsOn: ['a'] },
      ],
    });
    await assert.rejects(
      createCardFromTemplate(client, { id: 'cyclic-card', title: 'Cyclic', anchorDate: '2026-10-01' }, cyclic, '2026-10-01'),
      /dependencies are invalid.*cycle/,
    );
  });

  it('recovers missing Tasks with edges to Tasks that already exist', async () => {
    const template = await createTemplate(client, withoutId(podcastTemplate()));
    const card = await createCard(client, {
      title: 'Recovered', anchorDate: '2026-10-01', templateId: template.id, selectedOptionalGroups: [],
    });
    const created = await instantiateTemplate(client, template.id, card.id, '2026-10-01');
    assert.equal(created.length, 3);
    const refs = byRef(await listTasksByCard(client, card.id));
    assert.deepEqual(refs.get('page')!.dependsOn, [refs.get('spotify')!.id, refs.get('transcript')!.id]);
    // Running recovery again adds nothing and keeps the edges.
    assert.equal((await instantiateTemplate(client, template.id, card.id, '2026-10-01')).length, 0);
  });
});

describe('Card Template sync of dependencies', () => {
  function cardFrom(source: Template): Card {
    return {
      id: 'card-podcast', version: 3, title: 'Episode', anchorDate: '2026-10-01',
      templateId: source.id, templateVersion: source.version, templateSourceRevision: source.sourceRevision,
      templateDefinitionSnapshot: templateCardDefinitionSnapshot(source),
      tags: [], sourceDocIds: [], references: [], cardLinks: [],
      stage: 'preparation', status: 'active', taskCount: 3, openTaskCount: 3,
      createdAt: CREATED, updatedAt: CREATED,
    };
  }

  function tasksFrom(source: Template): Task[] {
    const ids = new Map((source.taskDefinitions || []).map(({ refId }) => [refId, `task-${refId}`]));
    return (source.taskDefinitions || []).map((definition, order) => {
      const snapshot = templateTaskDefinitionSnapshot(source, definition, order, '2026-10-01');
      const { dependsOnRefs, ...fields } = structuredClone(snapshot);
      return {
        id: ids.get(definition.refId)!, version: 2, taskHistory: [], ...fields,
        ...(dependsOnRefs ? { dependsOn: dependsOnRefs.map((ref) => ids.get(ref)!) } : {}),
        status: 'todo', source: 'template', cardId: 'card-podcast', templateId: source.id,
        templateTaskRef: definition.refId, templateVersion: source.version,
        templateSourceRevision: source.sourceRevision, templateDefinitionSnapshot: snapshot,
        createdAt: CREATED, updatedAt: CREATED,
      } as Task;
    });
  }

  async function apply(card: Card, tasks: Task[], target: Template): Promise<Task[]> {
    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    const writes: Task[] = [];
    const fake = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) {
          for (const item of command.input.TransactItems || []) {
            if (item.Put?.TableName === 'Tasks') writes.push(item.Put.Item as unknown as Task);
          }
          return {};
        }
        throw new Error('Unexpected command');
      },
    } as unknown as DynamoDBDocumentClient;
    disableLocalTransactionEmulation();
    await applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator');
    return writes;
  }

  it('previews and applies a dependency a newer Template adds to an existing Task', async () => {
    const source = podcastTemplate(1, false);
    const target = podcastTemplate(2, true);
    const plan = buildCardTemplateUpdatePlan(cardFrom(source), tasksFrom(source), target);
    const change = plan.preview.taskChanges.find(({ taskRef }) => taskRef === 'page')!;
    assert.deepEqual(
      change.changes.map(({ field, after }) => [field, after]),
      [['dependsOnRefs', ['spotify', 'transcript']]],
    );
    assert.deepEqual(
      plan.preview.taskChanges.filter(({ changes }) => changes.length > 0).map(({ taskRef }) => taskRef),
      ['page'],
      'only the dependent has a definition change',
    );

    const writes = await apply(cardFrom(source), tasksFrom(source), target);
    const page = writes.find(({ id }) => id === 'task-page')!;
    assert.deepEqual(page.dependsOn, ['task-spotify', 'task-transcript']);
    assert.equal((page as Record<string, unknown>).dependsOnRefs, undefined);
    assert.deepEqual(page.templateDefinitionSnapshot?.dependsOnRefs, ['spotify', 'transcript']);
  });

  it('removes an edge the Template dropped and keeps edges of unrelated updates', async () => {
    const source = podcastTemplate(1, true);
    const dropped = podcastTemplate(2, false);
    const writes = await apply(cardFrom(source), tasksFrom(source), dropped);
    assert.equal(writes.find(({ id }) => id === 'task-page')!.dependsOn, undefined);

    // An operator's own edge survives an update that does not touch dependencies.
    const tasks = tasksFrom(source);
    tasks.find(({ id }) => id === 'task-spotify')!.dependsOn = ['task-transcript'];
    const renamed = podcastTemplate(2, true);
    renamed.taskDefinitions![1] = { ...renamed.taskDefinitions![1], description: 'Verify the Spotify episode' };
    const rewritten = await apply(cardFrom(source), tasks, renamed);
    assert.deepEqual(rewritten.find(({ id }) => id === 'task-spotify')!.dependsOn, ['task-transcript']);
  });

  it('wires an added Task into the edges of the same update', async () => {
    const source = podcastTemplate(1, false);
    const target = podcastTemplate(2, true);
    target.taskDefinitions!.push({ refId: 'promo', description: 'Promote', offsetDays: 3, dependsOn: ['page'] });
    const writes = await apply(cardFrom(source), tasksFrom(source), target);
    const promo = writes.find(({ templateTaskRef }) => templateTaskRef === 'promo')!;
    assert.deepEqual(promo.dependsOn, ['task-page']);
  });

  it('rejects a Template edge that closes a cycle with an edge the operator added', () => {
    const source = podcastTemplate(1, false);
    const tasks = tasksFrom(source);
    // Operator made "Verify Spotify episode" wait for the page; the Template now makes the page wait for it.
    tasks.find(({ id }) => id === 'task-spotify')!.dependsOn = ['task-page'];
    assert.throws(
      () => buildCardTemplateUpdatePlan(cardFrom(source), tasks, podcastTemplate(2, true)),
      (error: unknown) => error instanceof CardTemplateUpdateInvalidStateError && /cycle/.test(error.message),
    );
  });
});
