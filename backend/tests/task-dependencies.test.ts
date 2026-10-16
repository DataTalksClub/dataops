import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createCard } from '../src/db/cards';
import { templateLink } from './helpers/cardTemplate';
import { CardLifecycleConflictError, createTask, deleteTask, getTask, updateTask } from '../src/db/tasks';
import { TABLE_TASKS } from '../src/db/tableNames';
import { TaskDependencyError } from '../src/db/taskDependencies';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

type Json = Record<string, any>;

describe('Task dependencies', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let cardId: string;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const [pathname, query] = path.split('?');
    const queryStringParameters = query ? Object.fromEntries(new URLSearchParams(query)) : undefined;
    const res = await handler({
      httpMethod: method,
      path: pathname,
      queryStringParameters,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, {});
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }

  async function makeTask(description: string, extra: Json = {}, card: string = cardId) {
    const res = await call('POST', '/api/tasks', { description, date: '2026-10-01', cardId: card, ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  async function fresh(id: string) {
    const task = await getTask(client, id);
    assert.ok(task);
    return task;
  }

  async function put(id: string, patch: Json) {
    const task = await fresh(id);
    return call('PUT', `/api/tasks/${id}`, { expectedVersion: task.version, ...patch });
  }

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function newCard(title: string): Promise<string> {
    return (await createCard(client, { ...templateLink(), title, anchorDate: '2026-10-01' })).id;
  }

  describe('graph validation', () => {
    it('rejects self, missing, duplicate, cross-card and cardless dependencies', async () => {
      cardId = await newCard('Validation');
      const other = await newCard('Other');
      const task = await makeTask('Subject');
      const foreign = await makeTask('Foreign', {}, other);

      const self = await put(task.id, { dependsOn: [task.id] });
      assert.equal(self.status, 400);
      assert.equal(self.body.code, 'self-dependency');

      const missing = await put(task.id, { dependsOn: ['no-such-task'] });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.code, 'missing-dependency');

      const duplicate = await put(task.id, { dependsOn: [foreign.id, foreign.id] });
      assert.equal(duplicate.status, 400);
      assert.equal(duplicate.body.code, 'duplicate-dependency');

      const crossCard = await put(task.id, { dependsOn: [foreign.id] });
      assert.equal(crossCard.status, 400);
      assert.equal(crossCard.body.code, 'cross-card-dependency');

      const malformed = await put(task.id, { dependsOn: 'abc' });
      assert.equal(malformed.status, 400);

      const cardless = await call('POST', '/api/tasks', { description: 'Loose', date: '2026-10-01', dependsOn: [task.id] });
      assert.equal(cardless.status, 400);
      assert.equal(cardless.body.code, 'dependencies-require-card');

      assert.equal((await fresh(task.id)).dependsOn, undefined);
    });

    it('rejects direct and transitive cycles', async () => {
      cardId = await newCard('Cycles');
      const a = await makeTask('A');
      const b = await makeTask('B', { dependsOn: [a.id] });
      const c = await makeTask('C', { dependsOn: [b.id] });

      const direct = await put(a.id, { dependsOn: [b.id] });
      assert.equal(direct.status, 400);
      assert.equal(direct.body.code, 'cyclic-dependency');

      const transitive = await put(a.id, { dependsOn: [c.id] });
      assert.equal(transitive.status, 400);
      assert.equal(transitive.body.code, 'cyclic-dependency');

      assert.equal((await fresh(a.id)).dependsOn, undefined);
    });

    it('clears dependencies with an empty list', async () => {
      cardId = await newCard('Clear');
      const a = await makeTask('A');
      const b = await makeTask('B', { dependsOn: [a.id] });
      const cleared = await put(b.id, { dependsOn: [] });
      assert.equal(cleared.status, 200);
      assert.equal((await fresh(b.id)).dependsOn, undefined);
    });

    it('serializes concurrent edits that would together form a cycle', async () => {
      cardId = await newCard('Cycle race');
      const a = await makeTask('A');
      const b = await makeTask('B');
      const results = await Promise.allSettled([
        updateTask(client, a.id, { expectedVersion: a.version, patch: { dependsOn: [b.id] } }),
        updateTask(client, b.id, { expectedVersion: b.version, patch: { dependsOn: [a.id] } }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const [finalA, finalB] = await Promise.all([fresh(a.id), fresh(b.id)]);
      assert.equal(Boolean(finalA.dependsOn) && Boolean(finalB.dependsOn), false);
    });
  });

  describe('completion', () => {
    it('blocks completion until every prerequisite is done, on every completion path', async () => {
      cardId = await newCard('Completion');
      const first = await makeTask('Verify Spotify episode');
      const second = await makeTask('Review transcript');
      const page = await makeTask('Publish podcast page', { dependsOn: [first.id, second.id] });

      const early = await put(page.id, { status: 'done' });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'prerequisites-incomplete');
      assert.deepEqual(early.body.tasks.map((task: Json) => task.id).sort(), [first.id, second.id].sort());
      assert.match(early.body.error, /Verify Spotify episode/);

      assert.equal((await put(first.id, { status: 'done' })).status, 200);
      const stillBlocked = await put(page.id, { status: 'done' });
      assert.equal(stillBlocked.status, 409);
      assert.deepEqual(stillBlocked.body.tasks.map((task: Json) => task.id), [second.id]);

      // The wait-resolution action is a second completion path.
      const waitingPage = await fresh(page.id);
      const marked = await call('POST', `/api/tasks/${page.id}/actions/mark-waiting`, {
        expectedVersion: waitingPage.version,
        waitingFor: 'Host',
        channel: 'email',
        note: 'Asked the host',
        followUpAt: '2026-10-05',
      });
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      assert.equal((await fresh(page.id)).status, 'waiting');
      const viaAction = await call('POST', `/api/tasks/${page.id}/actions/resolve-done`, {
        expectedVersion: (await fresh(page.id)).version,
        note: 'Host confirmed',
      });
      assert.equal(viaAction.status, 409, JSON.stringify(viaAction.body));
      assert.equal(viaAction.body.code, 'prerequisites-incomplete');

      // Creating a Task already done is a third.
      const createdDone = await call('POST', '/api/tasks', {
        description: 'Born done', date: '2026-10-01', cardId, status: 'done', dependsOn: [second.id],
      });
      assert.equal(createdDone.status, 409, JSON.stringify(createdDone.body));
      assert.equal(createdDone.body.code, 'prerequisites-incomplete');

      assert.equal((await put(second.id, { status: 'done' })).status, 200);
      const waiting = await fresh(page.id);
      assert.equal(waiting.status, 'waiting');
      const resolved = await call('POST', `/api/tasks/${page.id}/actions/resolve-done`, {
        expectedVersion: waiting.version,
        note: 'Host confirmed',
      });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      assert.equal(resolved.body.status, 'done');
    });

    it('accepts a skipped prerequisite as resolved', async () => {
      cardId = await newCard('Skipped prerequisite');
      const prerequisite = await makeTask('Prerequisite');
      const other = await makeTask('Other prerequisite');
      const dependent = await makeTask('Dependent', { dependsOn: [prerequisite.id, other.id] });
      const skipped = await call('POST', `/api/tasks/${prerequisite.id}/actions/skip`, {
        expectedVersion: prerequisite.version,
        reason: 'Not applicable this time',
      });
      assert.equal(skipped.status, 200);

      // Only the open prerequisite still blocks.
      const blocked = await put(dependent.id, { status: 'done' });
      assert.equal(blocked.status, 409);
      assert.deepEqual(blocked.body.tasks.map((task: Json) => task.id), [other.id]);
      assert.equal((await put(other.id, { status: 'done' })).status, 200);
      const read = await call('GET', `/api/tasks/${dependent.id}`);
      assert.equal(read.body.blocked, false);

      assert.equal((await put(dependent.id, { status: 'done' })).status, 200);

      // Unskipping a prerequisite of a completed Task reopens it, which is refused.
      const unskip = await call('POST', `/api/tasks/${prerequisite.id}/actions/unskip`, {
        expectedVersion: (await fresh(prerequisite.id)).version,
      });
      assert.equal(unskip.status, 409, JSON.stringify(unskip.body));
      assert.equal(unskip.body.code, 'prerequisite-of-completed-task');
    });

    it('reports a prerequisite deleted behind the edge as missing and blocks completion', async () => {
      cardId = await newCard('Dangling');
      const prerequisite = await makeTask('Gone');
      const dependent = await makeTask('Dependent', { dependsOn: [prerequisite.id] });
      // Simulate the stale-index race: remove the row without the dependents check.
      const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
      const { TABLE_TASKS } = await import('../src/db/tableNames');
      await client.send(new DeleteCommand({
        TableName: TABLE_TASKS,
        Key: { PK: `TASK#${prerequisite.id}`, SK: `TASK#${prerequisite.id}` },
      }));
      const blocked = await put(dependent.id, { status: 'done' });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.tasks[0].status, 'missing');
      const read = await call('GET', `/api/tasks/${dependent.id}`);
      assert.equal(read.body.blocked, true);
      assert.equal(read.body.prerequisites[0].status, 'missing');
    });

    it('rejects completion in the database layer without going through a route', async () => {
      cardId = await newCard('DB layer');
      const prerequisite = await createTask(client, { description: 'P', date: '2026-10-01', cardId });
      const dependent = await createTask(client, {
        description: 'D', date: '2026-10-01', cardId, dependsOn: [prerequisite.id],
      });
      await assert.rejects(
        updateTask(client, dependent.id, { expectedVersion: dependent.version, patch: { status: 'done' } }),
        (error: unknown) => error instanceof TaskDependencyError && error.code === 'prerequisites-incomplete',
      );
    });
  });

  describe('protecting completed dependents', () => {
    it('refuses to reopen or delete a prerequisite of a completed Task', async () => {
      cardId = await newCard('Protect');
      const prerequisite = await makeTask('Prerequisite');
      const dependent = await makeTask('Dependent', { dependsOn: [prerequisite.id] });
      assert.equal((await put(prerequisite.id, { status: 'done' })).status, 200);
      assert.equal((await put(dependent.id, { status: 'done' })).status, 200);

      const reopen = await put(prerequisite.id, { status: 'todo' });
      assert.equal(reopen.status, 409);
      assert.equal(reopen.body.code, 'prerequisite-of-completed-task');
      assert.equal(reopen.body.tasks[0].id, dependent.id);
      assert.equal((await fresh(prerequisite.id)).status, 'done');

      const task = await fresh(prerequisite.id);
      const deleted = await call('DELETE', `/api/tasks/${prerequisite.id}`, { expectedVersion: task.version });
      assert.equal(deleted.status, 409);
      assert.equal(deleted.body.code, 'prerequisite-of-completed-task');
      assert.ok(await getTask(client, prerequisite.id));

      // Reopening the dependent first releases the prerequisite.
      assert.equal((await put(dependent.id, { status: 'todo' })).status, 200);
      assert.equal((await put(prerequisite.id, { status: 'todo' })).status, 200);
    });

    it('refuses to delete any Task other Tasks depend on, and allows it once the edge is gone', async () => {
      cardId = await newCard('Delete');
      const prerequisite = await makeTask('Prerequisite');
      const dependent = await makeTask('Dependent', { dependsOn: [prerequisite.id] });

      await assert.rejects(
        deleteTask(client, prerequisite.id, prerequisite.version),
        (error: unknown) => error instanceof TaskDependencyError && error.code === 'has-dependents',
      );
      assert.equal((await put(dependent.id, { dependsOn: [] })).status, 200);
      await deleteTask(client, prerequisite.id, prerequisite.version);
      assert.equal(await getTask(client, prerequisite.id), null);
    });

    it('locks the prerequisites of a completed Task and the Card of a Task with edges', async () => {
      cardId = await newCard('Locks');
      const other = await newCard('Elsewhere');
      const a = await makeTask('A');
      const b = await makeTask('B');
      const c = await makeTask('C', { dependsOn: [a.id] });
      assert.equal((await put(a.id, { status: 'done' })).status, 200);
      assert.equal((await put(c.id, { status: 'done' })).status, 200);

      const edit = await put(c.id, { dependsOn: [a.id, b.id] });
      assert.equal(edit.status, 409);
      assert.equal(edit.body.code, 'dependencies-locked');

      const moveDependent = await put(b.id, { cardId: other });
      assert.equal(moveDependent.status, 200);
      const movePrerequisite = await put(a.id, { cardId: other });
      assert.equal(movePrerequisite.status, 409);
    });

    it('never leaves a completed Task behind an open prerequisite under concurrent writes', async () => {
      for (let round = 0; round < 5; round += 1) {
        cardId = await newCard(`Race ${round}`);
        const prerequisite = await makeTask('Prerequisite');
        const dependent = await makeTask('Dependent', { dependsOn: [prerequisite.id] });
        const done = await updateTask(client, prerequisite.id, {
          expectedVersion: prerequisite.version, patch: { status: 'done' },
        });
        await Promise.allSettled([
          updateTask(client, dependent.id, { expectedVersion: dependent.version, patch: { status: 'done' } }),
          updateTask(client, prerequisite.id, {
            expectedVersion: done.version, patch: { status: 'todo', completedAt: null, completedBy: null },
          }),
        ]);
        const [finalPrerequisite, finalDependent] = await Promise.all([
          fresh(prerequisite.id), fresh(dependent.id),
        ]);
        assert.ok(
          finalDependent.status !== 'done' || finalPrerequisite.status === 'done',
          `round ${round}: dependent ${finalDependent.status}, prerequisite ${finalPrerequisite.status}`,
        );
      }
    });
  });

  describe('projection', () => {
    it('reports prerequisite names, statuses and the blocked state', async () => {
      cardId = await newCard('Projection');
      const prerequisite = await makeTask('Verify Spotify episode');
      const dependent = await makeTask('Publish podcast page', { dependsOn: [prerequisite.id] });

      const read = await call('GET', `/api/tasks/${dependent.id}`);
      assert.equal(read.body.blocked, true);
      assert.deepEqual(read.body.prerequisites, [
        { id: prerequisite.id, description: 'Verify Spotify episode', status: 'todo' },
      ]);

      const list = await call('GET', `/api/tasks?cardId=${cardId}`);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const listed = list.body.tasks.find((task: Json) => task.id === dependent.id);
      assert.equal(listed.blocked, true);
      assert.equal(list.body.tasks.find((task: Json) => task.id === prerequisite.id).prerequisites, undefined);

      await put(prerequisite.id, { status: 'done' });
      const unblocked = await call('GET', `/api/tasks/${dependent.id}`);
      assert.equal(unblocked.body.blocked, false);
      assert.equal(unblocked.body.prerequisites[0].status, 'done');
    });

    it('filters a list by blocked state, so the queue never lists work nobody can do yet', async () => {
      cardId = await newCard('Blocked filter');
      const first = await makeTask('Edit the transcript');
      const second = await makeTask('Publish the transcript page', { dependsOn: [first.id] });
      const plain = await makeTask('Upload the registrant emails');
      const ids = async (query: string) => {
        const res = await call('GET', `/api/tasks?cardId=${cardId}${query}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        return res.body.tasks.map((task: Json) => task.id).sort();
      };

      assert.deepEqual(await ids(''), [first.id, second.id, plain.id].sort());
      assert.deepEqual(await ids('&blocked=false'), [first.id, plain.id].sort());
      assert.deepEqual(await ids('&blocked=true'), [second.id]);
      // The date lanes the queue loads narrow the same way.
      const lane = await call('GET', '/api/tasks?date=2026-10-01&blocked=false');
      assert.equal(lane.body.tasks.some((task: Json) => task.id === second.id), false);
      assert.equal(lane.body.tasks.some((task: Json) => task.id === first.id), true);

      // A skipped prerequisite resolves the edge as completing it does.
      const skipped = await call('POST', `/api/tasks/${first.id}/actions/skip`, { expectedVersion: (await fresh(first.id)).version, reason: 'Not needed' });
      assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
      assert.deepEqual(await ids('&blocked=false'), [first.id, second.id, plain.id].sort());
      assert.deepEqual(await ids('&blocked=true'), []);

      const invalid = await call('GET', `/api/tasks?cardId=${cardId}&blocked=maybe`);
      assert.equal(invalid.status, 400);
      assert.match(invalid.body.error, /blocked must be true or false/);
    });
  });
});

describe('Task dependency races', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(stopLocal);

  type Send = (command: unknown) => Promise<unknown>;

  /** Run `interleave` once, right after the first read that matches `trigger` returns. */
  function interleaveAfter(trigger: (command: unknown) => boolean, interleave: () => Promise<void>): () => void {
    const target = client as unknown as { send: Send };
    const original = target.send.bind(client);
    let fired = false;
    target.send = async (command: unknown) => {
      const result = await original(command);
      if (!fired && trigger(command)) {
        fired = true;
        target.send = original;
        await interleave();
      }
      return result;
    };
    return () => { target.send = original; };
  }

  const cardWith = async (title: string) => (await createCard(client, { ...templateLink(), title, anchorDate: '2026-10-01' })).id;
  const task = (cardId: string, description: string, extra: Json = {}) => (
    createTask(client, { description, date: '2026-10-01', cardId, ...extra })
  );
  const status = async (id: string) => (await getTask(client, id))!.status;
  const isGet = (id: string) => (command: unknown) => (
    command instanceof GetCommand && command.input.Key?.PK === `TASK#${id}`
  );
  const isTaskScan = (command: unknown) => command instanceof ScanCommand && command.input.TableName === TABLE_TASKS;

  it('refuses to reopen a prerequisite whose completed dependent is missing from GSI-Card', async () => {
    const cardId = await cardWith('Stale index');
    const prerequisite = await task(cardId, 'Prerequisite');
    const dependent = await task(cardId, 'Dependent', { dependsOn: [prerequisite.id] });
    const done = await updateTask(client, prerequisite.id, { expectedVersion: 1, patch: { status: 'done' } });
    await updateTask(client, dependent.id, { expectedVersion: 1, patch: { status: 'done' } });

    // The index knows nothing about the dependent, as when it was written milliseconds ago.
    const target = client as unknown as { send: Send };
    const original = target.send.bind(client);
    target.send = async (command: unknown) => {
      if (command instanceof QueryCommand && command.input.IndexName === 'GSI-Card') {
        return { Items: [] };
      }
      return original(command);
    };
    try {
      await assert.rejects(
        updateTask(client, prerequisite.id, {
          expectedVersion: done.version, patch: { status: 'todo', completedAt: null, completedBy: null },
        }),
        (error: unknown) => error instanceof TaskDependencyError && error.code === 'prerequisite-of-completed-task',
      );
      await assert.rejects(
        deleteTask(client, prerequisite.id, done.version),
        (error: unknown) => error instanceof TaskDependencyError,
      );
    } finally {
      target.send = original;
    }
    assert.equal(await status(prerequisite.id), 'done');
  });

  it('cancels a reopen when the dependent completes after the dependents were read', async () => {
    const cardId = await cardWith('Reopen vs complete');
    const prerequisite = await task(cardId, 'Prerequisite');
    const dependent = await task(cardId, 'Dependent', { dependsOn: [prerequisite.id] });
    const done = await updateTask(client, prerequisite.id, { expectedVersion: 1, patch: { status: 'done' } });
    interleaveAfter(isTaskScan, async () => {
      await updateTask(client, dependent.id, { expectedVersion: 1, patch: { status: 'done' } });
    });
    await assert.rejects(updateTask(client, prerequisite.id, {
      expectedVersion: done.version, patch: { status: 'todo', completedAt: null, completedBy: null },
    }), CardLifecycleConflictError);
    assert.deepEqual([await status(prerequisite.id), await status(dependent.id)], ['done', 'done']);
  });

  it('cancels a completion when its prerequisite is reopened after it was read as done', async () => {
    const cardId = await cardWith('Complete vs reopen');
    const prerequisite = await task(cardId, 'Prerequisite');
    const dependent = await task(cardId, 'Dependent', { dependsOn: [prerequisite.id] });
    const done = await updateTask(client, prerequisite.id, { expectedVersion: 1, patch: { status: 'done' } });
    interleaveAfter(isGet(prerequisite.id), async () => {
      await updateTask(client, prerequisite.id, {
        expectedVersion: done.version, patch: { status: 'todo', completedAt: null, completedBy: null },
      });
    });
    await assert.rejects(
      updateTask(client, dependent.id, { expectedVersion: 1, patch: { status: 'done' } }),
      CardLifecycleConflictError,
    );
    assert.deepEqual([await status(prerequisite.id), await status(dependent.id)], ['todo', 'todo']);
  });

  it('cancels an edge edit when a competing edge closes a cycle after the closure was read', async () => {
    const cardId = await cardWith('Cycle interleave');
    const a = await task(cardId, 'A');
    const b = await task(cardId, 'B');
    interleaveAfter(isGet(b.id), async () => {
      await updateTask(client, b.id, { expectedVersion: 1, patch: { dependsOn: [a.id] } });
    });
    await assert.rejects(
      updateTask(client, a.id, { expectedVersion: 1, patch: { dependsOn: [b.id] } }),
      CardLifecycleConflictError,
    );
    assert.equal((await getTask(client, a.id))!.dependsOn, undefined);
  });

  it('cancels a delete when a dependent edge is inserted after the dependents were read', async () => {
    const cardId = await cardWith('Delete vs new dependent');
    const prerequisite = await task(cardId, 'Prerequisite');
    const other = await task(cardId, 'Later dependent');
    interleaveAfter(isTaskScan, async () => {
      await updateTask(client, other.id, { expectedVersion: 1, patch: { dependsOn: [prerequisite.id] } });
    });
    await assert.rejects(
      deleteTask(client, prerequisite.id, prerequisite.version),
      CardLifecycleConflictError,
    );
    assert.ok(await getTask(client, prerequisite.id));
  });

  it('keeps many concurrent completions and reopens consistent with the graph', async () => {
    const cardId = await cardWith('Churn');
    const first = await task(cardId, 'First');
    const middle = await task(cardId, 'Middle', { dependsOn: [first.id] });
    const last = await task(cardId, 'Last', { dependsOn: [middle.id] });
    await updateTask(client, first.id, { expectedVersion: 1, patch: { status: 'done' } });
    for (let round = 0; round < 6; round += 1) {
      const [f, m, l] = await Promise.all([first, middle, last].map((t) => getTask(client, t.id).then((x) => x!)));
      await Promise.allSettled([
        updateTask(client, l.id, { expectedVersion: l.version, patch: { status: l.status === 'done' ? 'todo' : 'done' } }),
        updateTask(client, m.id, { expectedVersion: m.version, patch: { status: m.status === 'done' ? 'todo' : 'done' } }),
        updateTask(client, f.id, { expectedVersion: f.version, patch: { status: f.status === 'done' ? 'todo' : 'done' } }),
      ]);
      const [nf, nm, nl] = await Promise.all([first, middle, last].map((t) => status(t.id)));
      assert.ok(nl !== 'done' || nm === 'done', `round ${round}: last done behind ${nm}`);
      assert.ok(nm !== 'done' || nf === 'done', `round ${round}: middle done behind ${nf}`);
    }
  });
});
