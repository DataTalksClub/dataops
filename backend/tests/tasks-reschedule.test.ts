import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { templateLink } from './helpers/cardTemplate';
import { createTask, getTask } from '../src/db/tasks';

describe('API — dependent rescheduling', () => {
  let port: number;
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    port = await startLocal();
    await createTables(await getClient(port));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function chain() {
    const client = await getClient(port);
    const card = await createCard(client, { ...templateLink(), title: 'Chain card', anchorDate: '2026-03-10' });
    const parent = await createTask(client, { description: 'Parent', date: '2026-03-10', cardId: card.id });
    const child = await createTask(client, {
      description: 'Child', date: '2026-03-12', cardId: card.id, dependsOn: [parent.id],
      notBeforeAt: '2026-03-12T09:00:00.000Z',
    });
    const grandchild = await createTask(client, {
      description: 'Grandchild', date: '2026-03-13', cardId: card.id, dependsOn: [child.id],
    });
    return { card, parent, child, grandchild };
  }

  async function move(task: { id: string; version: number }, body: Record<string, unknown>) {
    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ expectedVersion: task.version, ...body }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.body);
  }

  it('shifts dates transitively by the same offset and reports the ids', async () => {
    const { parent, child, grandchild } = await chain();
    const updated = await move(parent, { date: '2026-03-12' });
    assert.deepStrictEqual(updated.rescheduled, [child.id, grandchild.id]);

    assert.strictEqual((await getTask(await getClient(port), child.id))?.date, '2026-03-14');
    assert.strictEqual((await getTask(await getClient(port), grandchild.id))?.date, '2026-03-15');

    const childAfter = await getTask(await getClient(port), child.id);
    assert.strictEqual(childAfter?.taskHistory.at(-1)?.action, 'scheduled');
    assert.match(childAfter?.taskHistory.at(-1)?.note || '', /shifted by the same offset/);
  });

  it('shifts set moments by the same milliseconds', async () => {
    const { parent, child, grandchild } = await chain();
    // A fresh moment with no old reference shifts nothing: no offset to keep.
    const first = await move(parent, { notBeforeAt: '2026-03-10T09:00:00.000Z' });
    assert.strictEqual(first.rescheduled, undefined);
    assert.strictEqual(
      (await getTask(await getClient(port), child.id))?.notBeforeAt,
      '2026-03-12T09:00:00.000Z',
    );

    const updated = await move(
      { id: parent.id, version: first.version },
      { notBeforeAt: '2026-03-10T12:00:00.000Z' },
    );
    assert.deepStrictEqual(updated.rescheduled, [child.id]);

    assert.strictEqual(
      (await getTask(await getClient(port), child.id))?.notBeforeAt,
      '2026-03-12T12:00:00.000Z',
    );
    // A dependent with no moment keeps none; its date still follows the move.
    assert.strictEqual((await getTask(await getClient(port), grandchild.id))?.notBeforeAt, undefined);
  });

  it('moves dates back by the same offset and leaves done tasks alone', async () => {
    const { parent, child, grandchild } = await chain();
    const client = await getClient(port);
    const parentDone = await move(parent, { status: 'done' });
    const childDone = await move(child, { status: 'done' });
    assert.strictEqual(childDone.status, 'done');

    const updated = await move({ id: parent.id, version: parentDone.version }, { date: '2026-03-08' });
    // The done child is traversed but untouched; the open grandchild follows.
    assert.deepStrictEqual(updated.rescheduled, [grandchild.id]);
    assert.strictEqual((await getTask(client, child.id))?.date, '2026-03-12');
    assert.strictEqual((await getTask(client, grandchild.id))?.date, '2026-03-11');
  });

  it('does nothing without a card or without a real move', async () => {
    const solo = await createTask(await getClient(port), { description: 'Solo', date: '2026-03-10' });
    const same = await move(solo, { date: '2026-03-10' });
    assert.strictEqual(same.rescheduled, undefined);

    const moved = await move({ id: solo.id, version: same.version }, { date: '2026-03-11' });
    assert.strictEqual(moved.rescheduled, undefined);
  });
});
