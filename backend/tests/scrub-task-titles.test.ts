import { describe, it } from 'node:test';
import assert from 'node:assert';

import { scrubTaskTitle, scrubStoredTaskTitles } from '../scripts/scrub-task-titles';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTask, getTask } from '../src/db/tasks';
import type { Task } from '../src/types';

// ---------------------------------------------------------------------------
// Pure scrubber — covers the display-layer rule mirrored in frontend/src/app.js
// ---------------------------------------------------------------------------

describe('scrubTaskTitle', () => {
  it('strips a leaked lowercase shortLink suffix', () => {
    assert.strictEqual(
      scrubTaskTitle('Collect guest bio and topic p3by19'),
      'Collect guest bio and topic'
    );
  });

  it('strips a leaked mixed-case shortLink suffix', () => {
    assert.strictEqual(
      scrubTaskTitle('Collect guest bio and topic qVB6fAUG'),
      'Collect guest bio and topic'
    );
  });

  it('strips a leaked uppercase suffix', () => {
    assert.strictEqual(
      scrubTaskTitle('Review the draft Q1ABC9'),
      'Review the draft'
    );
  });

  it('leaves an all-letters trailing word intact', () => {
    assert.strictEqual(
      scrubTaskTitle('Schedule posts overview after the event'),
      'Schedule posts overview after the event'
    );
    assert.strictEqual(scrubTaskTitle('Reach out to the guest'), 'Reach out to the guest');
    assert.strictEqual(scrubTaskTitle('Meet with Alice'), 'Meet with Alice');
  });

  it('leaves an all-digits trailing word intact', () => {
    assert.strictEqual(scrubTaskTitle('Podcast 2026'), 'Podcast 2026');
    assert.strictEqual(scrubTaskTitle('Episode 7'), 'Episode 7');
  });

  it('leaves a trailing word intact even when digits appear earlier in the title', () => {
    assert.strictEqual(scrubTaskTitle('Order 2026 widget'), 'Order 2026 widget');
    assert.strictEqual(scrubTaskTitle('Week 12 report'), 'Week 12 report');
  });

  it('returns the title unchanged when there is no token to strip', () => {
    assert.strictEqual(scrubTaskTitle('Just a normal task'), 'Just a normal task');
  });

  it('does not blank a standalone token with no preceding sentence', () => {
    assert.strictEqual(scrubTaskTitle('p3by19'), 'p3by19');
    assert.strictEqual(scrubTaskTitle('a1b2c3'), 'a1b2c3');
  });

  it('handles null/undefined/empty without throwing', () => {
    assert.strictEqual(scrubTaskTitle(null), '');
    assert.strictEqual(scrubTaskTitle(undefined), '');
    assert.strictEqual(scrubTaskTitle(''), '');
  });

  it('coerces a numeric description to a string and leaves it unchanged', () => {
    assert.strictEqual(scrubTaskTitle(2026), '2026');
    assert.strictEqual(scrubTaskTitle(0), '0');
  });
});

// ---------------------------------------------------------------------------
// Idempotent DB scrubber
// ---------------------------------------------------------------------------

describe('scrubStoredTaskTitles', () => {
  it('plans changes without a DB client (dry-run)', async () => {
    const tasks: Task[] = [
      { id: 't1', description: 'Collect guest bio and topic p3by19', date: '2026-06-01', status: 'todo' },
      { id: 't2', description: 'Clean task title', date: '2026-06-01', status: 'todo' },
    ];
    const report = await scrubStoredTaskTitles(null, tasks);
    assert.strictEqual(report.dryRun, true);
    assert.strictEqual(report.scanned, 2);
    assert.strictEqual(report.changed, 1);
    assert.deepStrictEqual(report.changedTaskIds, ['t1']);
  });

  it('reports zero changes for already-clean data (idempotent planning)', async () => {
    const tasks: Task[] = [
      { id: 't1', description: 'Collect guest bio and topic', date: '2026-06-01', status: 'todo' },
      { id: 't2', description: 'Schedule posts overview', date: '2026-06-01', status: 'todo' },
    ];
    const report = await scrubStoredTaskTitles(null, tasks);
    assert.strictEqual(report.changed, 0);
    assert.deepStrictEqual(report.changedTaskIds, []);
  });

  it('scrubs stored descriptions and is idempotent across real DB writes', async () => {
    const port = await startLocal();
    const client = await getClient(port);
    try {
      await createTables(client);

      const leaked = await createTask(client, {
        description: 'Collect guest bio and topic p3by19',
        date: '2026-06-01',
      });
      const clean = await createTask(client, {
        description: 'Schedule posts overview after the event',
        date: '2026-06-01',
      });

      // First run: the leaked suffix is stripped, the clean title is untouched.
      const first = await scrubStoredTaskTitles(client);
      assert.strictEqual(first.scanned, 2);
      assert.strictEqual(first.changed, 1);
      assert.deepStrictEqual(first.changedTaskIds, [leaked.id]);

      const afterFirst = await getTask(client, leaked.id);
      assert.strictEqual(afterFirst?.description, 'Collect guest bio and topic');
      const cleanAfter = await getTask(client, clean.id);
      assert.strictEqual(cleanAfter?.description, 'Schedule posts overview after the event');

      // Second run on already-scrubbed data: no writes (idempotent).
      const second = await scrubStoredTaskTitles(client);
      assert.strictEqual(second.scanned, 2);
      assert.strictEqual(second.changed, 0);
      assert.deepStrictEqual(second.changedTaskIds, []);

      const afterSecond = await getTask(client, leaked.id);
      assert.strictEqual(afterSecond?.description, 'Collect guest bio and topic');
    } finally {
      await stopLocal();
    }
  });
});
