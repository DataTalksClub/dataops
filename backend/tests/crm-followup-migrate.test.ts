import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MARKER, taskNoteLine } from '../scripts/crm-followup-migrate';

describe('crm-followup-migrate helpers', () => {
  it('builds an idempotency marker note line from a task', () => {
    const line = taskNoteLine({ id: 'task-1', description: 'Revisit pricing', notesLog: [{ body: 'per-company note' }] });
    assert.ok(line.includes(MARKER('task-1')));
    assert.ok(line.includes('Revisit pricing'));
    assert.ok(line.includes('per-company note'));
  });

  it('bounds the note line so records stay within the note budget', () => {
    const line = taskNoteLine({ id: 'task-2', description: 'x'.repeat(5000) });
    assert.ok(line.length <= 400);
    assert.ok(line.includes(MARKER('task-2')));
  });
});
