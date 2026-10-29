import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import type { Card, Task, Template } from '../src/types';
import {
  TABLE_AUDIT_EVENTS,
  TABLE_CARDS,
  TABLE_TASKS,
  TABLE_TEMPLATES,
  TABLE_USERS,
} from '../src/db/tableNames';
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
import {
  disableLocalTransactionEmulation,
  enableLocalTransactionEmulation,
} from '../src/db/client';

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
    templateDefinitionSnapshot: templateCardDefinitionSnapshot(source, (source.taskDefinitions || []).map(({ refId }) => refId)),
    selectedOptionalGroups: [],
    tags: structuredClone(source.tags),
    sourceDocIds: structuredClone(source.sourceDocIds),
    references: structuredClone(source.references),
    cardLinks: [
      { name: 'Registration', url: 'https://example.invalid/register' },
      { name: 'Recording', url: '' },
      { name: 'Operator notes', url: 'https://example.invalid/notes' },
    ],
    stage: 'preparation',
    status: 'active',
    taskCount: 3,
    openTaskCount: 3,
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
  it('a Template that stops naming a person leaves Task assignees alone', async () => {
    // Stored snapshots from when the Template named a person for every Task.
    const source = template(1);
    source.taskDefinitions = source.taskDefinitions!.map((definition) => ({ ...definition, assigneeId: 'former-default' }));
    const target = template(2);
    target.taskDefinitions = target.taskDefinitions!.map((definition) => (
      definition.refId === 'host' ? { ...definition, description: 'Host live session' } : definition
    ));
    const card = cardFrom(source);
    const tasks = tasksFrom(source);

    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    for (const change of plan.preview.taskChanges) {
      assert.ok(!change.changes.some(({ field }) => field === 'assigneeId'), change.taskRef);
    }

    const writes: Task[] = [];
    const fake = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) {
          for (const item of command.input.TransactItems || []) {
            if (item.Put?.TableName === TABLE_TASKS) writes.push(item.Put.Item as unknown as Task);
          }
          return {};
        }
        throw new Error('Unexpected command');
      },
    } as any;
    disableLocalTransactionEmulation();
    await applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator');
    assert.ok(writes.length > 0, 'the update rewrote Tasks');
    for (const task of writes) assert.equal(task.assigneeId, 'former-default', task.id);
  });

  it('captures newly authored episode stages in the Card snapshot even when the stage Task is done', async () => {
    const source = template(1);
    const target = template(2);
    target.taskDefinitions = target.taskDefinitions!.map((definition) => (
      definition.refId === 'host' ? { ...definition, episodeStage: 'recorded' as const } : definition
    ));
    const card = cardFrom(source);
    assert.equal(card.templateDefinitionSnapshot!.episodeStages, undefined, 'a Template that marks no stages leaves none');
    const tasks = tasksFrom(source);
    tasks[1].status = 'done';

    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    assert.equal(plan.preview.state, 'update-available');
    assert.deepEqual(plan.targetCardSnapshot.episodeStages, { recorded: 'host' });

    const cards: Card[] = [];
    const fake = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand) return {};
        if (command instanceof TransactWriteCommand) {
          for (const item of command.input.TransactItems || []) {
            if (String(item.Put?.Item?.PK).startsWith('CARD#')) cards.push(item.Put.Item as unknown as Card);
          }
          return {};
        }
        throw new Error('Unexpected command');
      },
    } as any;
    disableLocalTransactionEmulation();
    await applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator');
    assert.deepEqual(cards[0]?.templateDefinitionSnapshot?.episodeStages, { recorded: 'host' });
  });

  it('propagates a new browser requirement to the open Task the Template owns', () => {
    const source = template(1);
    const target = template(2);
    target.taskDefinitions = target.taskDefinitions!.map((definition) => (
      definition.refId === 'host' ? { ...definition, browserRequirement: 'headless' as const } : definition
    ));
    const card = cardFrom(source);
    const tasks = tasksFrom(source);

    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    const hostUpdate = plan.taskUpdates.find((update) => update.taskRef === 'host');
    assert.ok(hostUpdate, 'the classified definition is part of the plan');
    assert.equal(hostUpdate.action, 'update');
    assert.ok(hostUpdate.changedFields.includes('browserRequirement'));
    const change = plan.preview.taskChanges
      .find((task) => task.taskRef === 'host')!
      .changes.find(({ field }) => field === 'browserRequirement');
    assert.equal(change?.after, 'headless');
    // The stored snapshot a refreshed projection would carry the claim too.
    assert.equal(hostUpdate.target?.browserRequirement, 'headless');
  });

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
      skipped: 1,
      removed: 0,
      retainedCompleted: 1,
      reordered: 2,
      operatorOverrides: 0,
    });
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'host')?.action, 'retain-completed');
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'follow-up')?.action, 'skip-removed');
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'publish')?.action, 'add');
    const announce = plan.preview.taskChanges.find((change) => change.taskRef === 'announce');
    assert.equal(announce?.action, 'update');
    assert.deepEqual(announce?.changes.map(({ field }) => field), ['templateTaskOrder', 'instructionDocId']);
    assert.deepEqual(announce?.operatorOverrideFields, []);
  });

  it('retains an operator-skipped Task the new Template version removed', () => {
    const source = template(1);
    const target = {
      ...template(2),
      taskDefinitions: (source.taskDefinitions || []).filter(({ refId }) => refId !== 'follow-up'),
    };
    const tasks = tasksFrom(source);
    const followUp = tasks.find(({ templateTaskRef }) => templateTaskRef === 'follow-up')!;
    followUp.status = 'skipped';
    followUp.skipReason = 'Synthetic: no follow-up needed';
    followUp.skippedAt = '2026-04-14T12:00:00.000Z';
    followUp.skippedBy = 'operator-one';

    const plan = buildCardTemplateUpdatePlan(cardFrom(source), tasks, target);
    assert.equal(plan.preview.counts.skipped, 0);
    assert.equal(
      plan.preview.taskChanges.find((change) => change.taskRef === 'follow-up')?.action,
      'retain-completed',
    );
  });

  it('ignores unselected optional groups when planning Template updates', () => {
    const source = template(1);
    const target = {
      ...template(2),
      taskDefinitions: [
        ...(source.taskDefinitions || []),
        { refId: 'extra-selected', description: 'Extra selected', offsetDays: 3, optionalGroup: 'secondary' },
        { refId: 'extra-skipped', description: 'Extra skipped', offsetDays: 4, optionalGroup: 'standalone' },
      ],
    };
    const card = { ...cardFrom(source), selectedOptionalGroups: ['secondary'] };
    const tasks = tasksFrom(source);
    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'extra-selected')?.action, 'add');
    assert.equal(plan.preview.taskChanges.find((change) => change.taskRef === 'extra-skipped'), undefined);
  });

  it('treats Tasks not instantiated from the Template as the Card\'s own and adds only new definitions', () => {
    // A Card linked after the fact: its Tasks came from elsewhere (a Trello
    // checklist), and it accounts for every definition of the version it records.
    const source = template(1);
    const card = cardFrom(source);
    const imported: Task[] = ['Announce on Slack', 'Host'].map((description, index) => ({
      id: `imported-${index}`,
      version: 1,
      taskHistory: [],
      description,
      date: '2026-04-15',
      status: index === 0 ? 'done' : 'todo',
      source: 'import',
      cardId: card.id,
      templateTaskRef: `trello-checklist-item-${index}`,
      createdAt: CREATED,
      updatedAt: CREATED,
    } as Task));

    const current = buildCardTemplateUpdatePlan(card, imported, source);
    assert.equal(current.preview.state, 'current');
    assert.deepEqual(current.preview.taskChanges, []);

    const target = template(2);
    target.taskDefinitions = [...target.taskDefinitions!, { refId: 'recap', description: 'Publish recap', offsetDays: 5 }];
    const plan = buildCardTemplateUpdatePlan(card, imported, target);
    assert.deepEqual(
      plan.preview.taskChanges.map(({ action, taskRef }) => [action, taskRef]),
      [['add', 'recap']],
    );
    assert.deepEqual(plan.targetCardSnapshot.taskRefs, ['announce', 'follow-up', 'host', 'recap']);
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

  it('rejects missing provenance instead of offering a baseline compatibility state', () => {
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

    assert.throws(
      () => buildCardTemplateUpdatePlan(card, tasks, source),
      /Card .* has no canonical Template provenance/,
    );
  });

  it('preserves populated and operator-added Card links while applying link definitions', () => {
    const source = template(1);
    const target = template(2);
    target.cardLinkDefinitions = [{ name: 'Registration' }, { name: 'Slides' }];
    const card = cardFrom(source);

    assert.deepEqual(projectedCardLinks(
      card.cardLinks,
      card.templateDefinitionSnapshot,
      templateCardDefinitionSnapshot(target, []),
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
        if (table === TABLE_AUDIT_EVENTS) return {};
        if (table === TABLE_CARDS) return { Item: { ...card, ...key } };
        if (table === TABLE_TEMPLATES) return { Item: { ...target, ...key } };
        if (table === TABLE_TASKS) {
          const task = tasks.find(({ id }) => `TASK#${id}` === key.PK)!;
          const { version: _version, ...versionless } = task;
          return { Item: { ...versionless, ...key } };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    } as any;

    enableLocalTransactionEmulation();
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
      disableLocalTransactionEmulation();
    }
  });

  it('applies additions after omitted groups with the reviewed order and leaves the preview current', async () => {
    const source = template(1);
    const target = template(2);
    target.taskDefinitions = [
      ...target.taskDefinitions!,
      { refId: 'skipped', description: 'Unchecked group step', offsetDays: 2, optionalGroup: 'secondary' },
      { refId: 'required', description: 'New required step', offsetDays: 3 },
    ];
    const card = { ...cardFrom(source), selectedOptionalGroups: [] };
    const tasks = tasksFrom(source);
    const plan = buildCardTemplateUpdatePlan(card, tasks, target);
    assert.equal(plan.taskUpdates.find(({ taskRef }) => taskRef === 'required')?.target?.templateTaskOrder, 3);
    const fake = {
      send: async (command: unknown) => {
        if (command instanceof GetCommand || command instanceof TransactWriteCommand) return {};
        throw new Error('Unexpected command');
      },
    } as any;
    disableLocalTransactionEmulation();
    try {
      const result = await applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator');
      const added = result.tasks.find(({ templateTaskRef }) => templateTaskRef === 'required');
      assert.equal(added?.templateTaskOrder, 3);
      assert.equal(added?.templateDefinitionSnapshot?.templateTaskOrder, 3);
      assert.equal(result.tasks.some(({ templateTaskRef }) => templateTaskRef === 'skipped'), false);
      const next = buildCardTemplateUpdatePlan(result.card, result.tasks, target).preview;
      assert.equal(next.state, 'current');
      assert.deepEqual(next.taskChanges, []);
    } finally {
      disableLocalTransactionEmulation();
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
    disableLocalTransactionEmulation();
    try {
      const result = await applyCardTemplateUpdate(
        fake, card, tasks, target, token, 'operator-transaction-proof',
      );
      assert.equal(result.applied, true);
    } finally {
      disableLocalTransactionEmulation();
    }

    // Reads: the prior audit, then the workspace default assignee for the added Task.
    assert.equal(commands.length, 3);
    assert.ok(commands[0] instanceof GetCommand);
    assert.ok(commands[1] instanceof GetCommand);
    assert.equal((commands[1] as GetCommand).input.TableName, TABLE_USERS);
    assert.ok(commands[2] instanceof TransactWriteCommand);
    const items = (commands[2] as TransactWriteCommand).input.TransactItems || [];
    assert.ok(items.some((item) => item.ConditionCheck?.TableName === TABLE_TEMPLATES));
    assert.ok(items.some((item) => item.Put?.TableName === TABLE_CARDS));
    assert.ok(items.some((item) => item.Put?.TableName === TABLE_TASKS));
    assert.ok(items.some((item) => item.Put?.TableName === TABLE_AUDIT_EVENTS));
  });
});

describe('manual task adoption', () => {
  for (const status of ['todo', 'waiting'] as const) {
    it(`adopts one ${status} manual match without losing operator fields, then is a no-op`, async () => {
      const source = template(1);
      const target = template(2);
      target.taskDefinitions!.push({ refId: 'collect-x-stats', description: 'Collect stats from X post', offsetDays: 7, assigneeId: 'template-assignee' });
      const card = cardFrom(source);
      const manual: Task = {
        id: 'manual-stats', version: 1, status, source: 'manual', cardId: card.id,
        ...(status === 'waiting' ? { templateId: source.id } : {}),
        description: '  collect STATS from X post  ', date: '2026-04-22',
        comment: 'Keep this', notesLog: [{ id: 'note', text: 'Earlier note', createdAt: CREATED }],
        assigneeId: 'operator-assignee', link: 'https://example.invalid/proof',
        taskHistory: [{ id: 'history', taskId: 'manual-stats', action: 'noted', note: 'Existing history', createdAt: CREATED }],
        createdAt: CREATED, updatedAt: CREATED,
      };
      const tasks = [...tasksFrom(source), manual];
      const plan = buildCardTemplateUpdatePlan(card, tasks, target);
      assert.equal(plan.taskUpdates.find(({ taskRef }) => taskRef === 'collect-x-stats')?.action, 'adopt');
      const commands: unknown[] = [];
      const fake = { send: async (command: unknown) => { commands.push(command); return {}; } } as any;
      disableLocalTransactionEmulation();
      const result = await applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator');
      const adopted = result.tasks.filter(({ description }) => description.trim().toLowerCase() === 'collect stats from x post');
      assert.equal(adopted.length, 1);
      const { templateId, templateTaskRef, templateVersion, templateSourceRevision, templateDefinitionSnapshot, version, updatedAt, ...preserved } = adopted[0];
      const { version: oldVersion, updatedAt: oldUpdated, templateId: oldTemplate, ...original } = manual;
      assert.deepEqual(preserved, original);
      assert.equal(templateId, target.id);
      assert.equal(templateTaskRef, 'collect-x-stats');
      assert.equal(templateVersion, target.version);
      assert.equal(templateDefinitionSnapshot?.description, 'Collect stats from X post');
      const next = buildCardTemplateUpdatePlan(result.card, result.tasks, target);
      assert.equal(next.preview.state, 'current');
      const retry = await applyCardTemplateUpdate(fake, result.card, result.tasks, target, next.preview.previewToken, 'operator');
      assert.equal(retry.applied, false);
      assert.equal(commands.filter((command) => command instanceof TransactWriteCommand).length, 1);
      const retriedOriginal = { send: async () => ({ Item: result.auditEvent }) } as any;
      assert.equal((await applyCardTemplateUpdate(retriedOriginal, result.card, result.tasks, target, plan.preview.previewToken, 'operator')).idempotent, true);
    });
  }
  for (const status of ['done', 'skipped', 'ambiguous'] as const) {
    it(`surfaces a ${status} manual match as a conflict and refuses any writes`, async () => {
      const source = template(1);
      const target = template(2);
      target.taskDefinitions!.push({ refId: 'collect-x-stats', description: 'Collect stats from X post', offsetDays: 7 });
      const card = cardFrom(source);
      const manual = { ...tasksFrom(source)[0], id: 'manual', description: 'Collect stats from X post', status: status === 'ambiguous' ? 'todo' : status } as Task;
      delete manual.templateId;
      delete manual.templateTaskRef;
      const tasks = [...tasksFrom(source), manual, ...(status === 'ambiguous' ? [{ ...manual, id: 'second-manual' }] : [])];
      const plan = buildCardTemplateUpdatePlan(card, tasks, target);
      assert.equal(plan.preview.taskChanges.find(({ taskRef }) => taskRef === 'collect-x-stats')?.action, 'conflict');
      const fake = { send: async (command: unknown) => { assert.ok(command instanceof GetCommand); return {}; } } as any;
      await assert.rejects(() => applyCardTemplateUpdate(fake, card, tasks, target, plan.preview.previewToken, 'operator'), CardTemplateUpdateConflictError);
      assert.equal(manual.status, status === 'ambiguous' ? 'todo' : status);
    });
  }
});
