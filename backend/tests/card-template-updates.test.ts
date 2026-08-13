import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});
