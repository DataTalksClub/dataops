// Covers the one-off scripts/migrate-archived-tasks.ts; delete together with it.
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { planArchivedTaskMigrations } from '../scripts/migrate-archived-tasks';
import type { Task } from '../src/types';

const NOW = '2026-10-14T20:00:00.000Z';

function task(id: string, extra: Partial<Task> & Record<string, unknown> = {}): Task {
  return {
    id,
    version: 2,
    description: `Synthetic ${id}`,
    date: '2026-09-01',
    status: 'todo',
    taskHistory: [],
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-10-13T07:55:37.000Z',
    ...extra,
  } as Task;
}

describe('archived Task migration plan', () => {
  it('turns every archived Task into a reasoned skip and leaves the rest alone', () => {
    const plan = planArchivedTaskMigrations([
      task('open'),
      task('retired', {
        status: 'archived' as Task['status'],
        cardId: 'card-1',
        templateRetiredReason: 'removed',
        templateRetiredAt: '2026-10-01T10:00:00.000Z',
      }),
      task('legacy', { status: 'archived' as Task['status'] }),
      task('already', { status: 'skipped', skipReason: 'x', skippedAt: NOW, skippedBy: 'u' }),
    ], NOW);

    assert.deepStrictEqual(plan.map(({ id, skipReason, skippedAt, skippedBy }) => ({ id, skipReason, skippedAt, skippedBy })), [
      {
        id: 'retired',
        skipReason: 'Removed from the Card Template',
        skippedAt: '2026-10-01T10:00:00.000Z',
        skippedBy: 'system:migration',
      },
      {
        id: 'legacy',
        skipReason: 'Archived before Skip existed',
        skippedAt: '2026-10-13T07:55:37.000Z',
        skippedBy: 'system:migration',
      },
    ]);
    assert.strictEqual(plan[0].historyEvent.cardId, 'card-1');
    assert.strictEqual(plan[0].historyEvent.action, 'skipped');
    assert.strictEqual(plan[1].historyEvent.cardId, undefined);
    assert.strictEqual(plan[1].historyEvent.createdAt, NOW);
  });
});
