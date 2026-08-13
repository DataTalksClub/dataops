import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import type { Card, Task, Template } from '../src/types';
import {
  templateCardDefinitionSnapshot,
  templateTaskDefinitionSnapshot,
} from '../src/templates/cardTemplateProjection';
import {
  buildCardTemplateUpdatePlan,
  CardTemplateUpdateInvalidStateError,
  projectedCardLinks,
} from '../src/templates/cardTemplateUpdates';
import {
  applyCardTemplateUpdate,
  CardTemplateUpdateConflictError,
} from '../src/db/cardTemplateUpdates';

const CREATED = '2026-01-01T00:00:00.000Z';

function template(version = 1): Template {
  return {
    id: 'template-event',
    name: 'Event',
    type: 'event',
    version,
    sourceRevision: `revision-${version}`,
    tags: ['event'],
    sourceDocIds: ['process.event'],
    references: [{ name: 'Process', url: '/content/process.event' }],
    cardLinkDefinitions: [{ name: 'Registration' }, { name: 'Recording' }],
    defaultAssigneeId: 'operator-default',
    taskDefinitions: [
      { refId: 'announce', description: 'Announce', offsetDays: -7, instructionDocId: 'process.event' },
      { refId: 'host', description: 'Host', offsetDays: 0, proofRequirement: { type: 'text' } },
      { refId: 'follow-up', description: 'Follow up', offsetDays: 2 },
    ],
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function cardFrom(source: Template): Card {
  return {
    id: 'card-event',
    version: 3,
    title: 'Synthetic event',
    anchorDate: '2026-04-15',
    templateId: source.id,
    templateVersion: source.version,
    templateSourceRevision: source.sourceRevision,
    templateDefinitionSnapshot: templateCardDefinitionSnapshot(source),
    emoji: source.emoji,
    tags: structuredClone(source.tags),
    sourceDocIds: structuredClone(source.sourceDocIds),
    references: structuredClone(source.references),
    cardLinks: [
      { name: 'Registration', url: 'https://example.invalid/register' },
      { name: 'Recording', url: '' },
      { name: 'Operator notes', url: 'https://example.invalid/notes' },
    ],
    status: 'active',
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function tasksFrom(source: Template): Task[] {
  return (source.taskDefinitions || []).map((definition, order) => {
    const snapshot = templateTaskDefinitionSnapshot(source, definition, order, '2026-04-15');
    return {
      id: `task-${definition.refId}`,
      version: 2,
      taskHistory: [],
      ...structuredClone(snapshot),
      status: 'todo',
      source: 'template',
      cardId: 'card-event',
      templateId: source.id,
      templateTaskRef: definition.refId,
      templateVersion: source.version,
      templateSourceRevision: source.sourceRevision,
      templateDefinitionSnapshot: snapshot,
      createdAt: CREATED,
      updatedAt: CREATED,
    };
  });
}

describe('Card Template update planning', () => {
  it('categorizes additions, removals, reordering, changes and completed retention', () => {
    const source = template(1);
    const target = {
      ...template(2),
      taskDefinitions: [
        { refId: 'host', description: 'Host live session', offsetDays: 1, proofRequirement: { type: 'link' as const } },
        { refId: 'announce', description: 'Announce', offsetDays: -7, instructionDocId: 'process.event-v2' },
        { refId: 'publish', description: 'Publish recording', offsetDays: 3 },
      ],
    };
    const card = cardFrom(source);
    const tasks = tasksFrom(source);
    tasks[0].description = 'Operator-specific announcement';
    tasks[0].comment = 'Keep this note';
    tasks[1].status = 'done';
    tasks[1].completedAt = '2026-04-15T12:00:00.000Z';
    tasks[1].artifactRefs = [{ artifactId: 'artifact-proof' }];
    tasks[2].waitingFor = 'Reply';

    const plan = buildCardTemplateUpdatePlan(card, tasks, target);

    assert.equal(plan.preview.state, 'update-available');
    assert.deepEqual(plan.preview.counts, {
      cardFields: 0,
      added: 1,
      updated: 1,
      archived: 1,
      retainedCompleted: 1,
      reordered: 2,
      operatorOverrides: 0,
    });
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'host')?.action, 'retain-completed');
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'follow-up')?.action, 'archive-removed');
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'publish')?.action, 'add');
    const announce = plan.preview.taskChanges.find((change) => change.taskRef === 'announce');
    assert.equal(announce?.action, 'update');
    assert.deepEqual(announce?.changes.map(({ field }) => field), ['templateTaskOrder', 'instructionDocId']);
    assert.deepEqual(announce?.operatorOverrideFields, []);
  });

  it('marks an override only when its definition field also changes', () => {
    const source = template(1);
    const target = template(2);
    target.taskDefinitions![0] = { ...target.taskDefinitions![0], description: 'Announce everywhere' };
    const card = cardFrom(source);
    const tasks = tasksFrom(source);
    tasks[0].description = 'Operator-specific announcement';

    const preview = buildCardTemplateUpdatePlan(card, tasks, target).preview;
    const announce = preview.taskChanges.find((change) => change.taskRef === 'announce');
    assert.deepEqual(announce?.operatorOverrideFields, ['description']);
    assert.equal(preview.counts.operatorOverrides, 1);
  });

  it('does not call a same-revision operator override an available update', () => {
    const source = template(1);
    const card = cardFrom(source);
    const tasks = tasksFrom(source);
    tasks[0].description = 'Operator-specific announcement';

    const preview = buildCardTemplateUpdatePlan(card, tasks, source).preview;
    assert.equal(preview.state, 'current');
    assert.equal(preview.taskChanges.length, 0);
  });

  it('treats missing provenance as a reviewed baseline instead of current', () => {
    const source = template(1);
    const card = cardFrom(source);
    delete card.templateVersion;
    delete card.templateSourceRevision;
    delete card.templateDefinitionSnapshot;
    const tasks = tasksFrom(source);
    for (const task of tasks) {
      delete task.templateVersion;
      delete task.templateSourceRevision;
      delete task.templateDefinitionSnapshot;
    }

    const preview = buildCardTemplateUpdatePlan(card, tasks, source).preview;
    assert.equal(preview.state, 'baseline-required');
    assert.equal(preview.sourceTemplateVersion, null);
    assert.ok(preview.previewToken.match(/^[a-f0-9]{64}$/));
  });

  it('preserves populated and operator-added Card links while applying link definitions', () => {
    const source = template(1);
    const target = template(2);
    target.cardLinkDefinitions = [{ name: 'Registration' }, { name: 'Slides' }];
    const card = cardFrom(source);

    assert.deepEqual(projectedCardLinks(
      card.cardLinks,
      card.templateDefinitionSnapshot,
      templateCardDefinitionSnapshot(target),
    ), [
      { name: 'Registration', url: 'https://example.invalid/register' },
      { name: 'Slides', url: '' },
      { name: 'Operator notes', url: 'https://example.invalid/notes' },
    ]);
  });

  it('rejects duplicate stable task refs rather than choosing one', () => {
    const source = template(1);
    const tasks = tasksFrom(source);
    tasks.push({ ...structuredClone(tasks[0]), id: 'task-announce-duplicate' });
    assert.throws(
      () => buildCardTemplateUpdatePlan(cardFrom(source), tasks, source),
      CardTemplateUpdateInvalidStateError,
    );
  });

  it('rejects a versionless Task instead of producing a fallback preview token', () => {
    const source = template(1);
    const tasks = tasksFrom(source);
    delete (tasks[0] as Partial<Task>).version;

    assert.throws(
      () => buildCardTemplateUpdatePlan(cardFrom(source), tasks, source),
      (error: unknown) => (
        error instanceof CardTemplateUpdateInvalidStateError
        && error.message === 'Task task-announce has an invalid optimistic-concurrency version'
      ),
    );
  });

  it('makes the test transaction reject a versionless stored Task like DynamoDB does', async () => {
    const source = template(1);
    const target = template(2);
    const card = cardFrom(source);
    const tasks = tasksFrom(source);
    const previewToken = buildCardTemplateUpdatePlan(card, tasks, target).preview.previewToken;
    const fake = {
      send: async (command: unknown) => {
        if (!(command instanceof GetCommand)) throw new Error('Unexpected write');
        const table = command.input.TableName;
        const key = command.input.Key as Record<string, unknown>;
        if (table === 'AuditEvents') return {};
        if (table === 'Projects') return { Item: { ...card, ...key } };
        if (table === 'Templates') return { Item: { ...target, ...key } };
        if (table === 'Tasks') {
          const task = tasks.find(({ id }) => `TASK#${id}` === key.PK)!;
          const { version: _version, ...versionless } = task;
          return { Item: { ...versionless, ...key } };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as any;

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      await assert.rejects(
        () => applyCardTemplateUpdate(
          fake,
          card,
          tasks,
          target,
          previewToken,
          'operator-version-check',
        ),
        CardTemplateUpdateConflictError,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('uses one real DynamoDB transaction outside the test environment', async () => {
    const source = template(1);
    const target = template(2);
    target.taskDefinitions = [
      ...target.taskDefinitions!,
      { refId: 'publish', description: 'Publish', offsetDays: 3 },
    ];
    const card = cardFrom(source);
    const tasks = tasksFrom(source);
    const token = buildCardTemplateUpdatePlan(card, tasks, target).preview.previewToken;
    const commands: unknown[] = [];
    const fake = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) return {};
        throw new Error('Unexpected command');
      },
    } as any;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await applyCardTemplateUpdate(
        fake, card, tasks, target, token, 'operator-transaction-proof',
      );
      assert.equal(result.applied, true);
    } finally {
      process.env.NODE_ENV = previous;
    }

    assert.equal(commands.length, 2);
    assert.ok(commands[0] instanceof GetCommand);
    assert.ok(commands[1] instanceof TransactWriteCommand);
    const items = (commands[1] as TransactWriteCommand).input.TransactItems || [];
    assert.ok(items.some((item) => item.ConditionCheck?.TableName === 'Templates'));
    assert.ok(items.some((item) => item.Put?.TableName === 'Projects'));
    assert.ok(items.some((item) => item.Put?.TableName === 'Tasks'));
    assert.ok(items.some((item) => item.Put?.TableName === 'AuditEvents'));
  });
});
