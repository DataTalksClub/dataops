import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BatchGetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createCard } from '../src/db/cards';
import { createTask, listTasksByCardConsistent, updateTask } from '../src/db/tasks';
import { TABLE_TASKS } from '../src/db/tableNames';
import { templateLink } from './helpers/cardTemplate';
import { truncateTestTables, useTestDatabase } from './helpers/db';

type Send = (command: unknown) => Promise<unknown>;

/**
 * listTasksByCardConsistent used to be a full-table ConsistentRead Scan on
 * every call. It now reads GSI-Card for candidates, re-reads them strongly
 * consistent from the base table, and proves completeness against the Card's
 * taskCount aggregate; only a failed proof falls back to the Scan.
 */
describe('listTasksByCardConsistent', () => {
  let client: DynamoDBDocumentClient;
  let commands: unknown[];
  let restore: () => void;

  before(async () => {
    client = (await useTestDatabase()).client;
  });

  beforeEach(async () => {
    restore?.();
    await truncateTestTables(client);
  });

  /** Record every command and let `rewrite` replace selected responses. */
  function intercept(rewrite: (command: unknown, result: unknown) => unknown = (_command, result) => result): void {
    const target = client as unknown as { send: Send };
    const original = target.send.bind(client);
    commands = [];
    target.send = async (command: unknown) => {
      commands.push(command);
      return rewrite(command, await original(command));
    };
    restore = () => { target.send = original; };
  }

  const isCardQuery = (command: unknown) => command instanceof QueryCommand && command.input.IndexName === 'GSI-Card';
  const scans = () => commands.filter((command) => command instanceof ScanCommand);

  async function cardWithTasks(count: number) {
    const card = await createCard(client, { ...templateLink(), title: 'Card', anchorDate: '2026-10-01' });
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      tasks.push(await createTask(client, { description: `Task ${index}`, date: `2026-10-0${index + 1}`, cardId: card.id }));
    }
    return { card, tasks };
  }

  it('answers from GSI-Card plus a consistent BatchGet without scanning the table', async () => {
    const { card, tasks } = await cardWithTasks(3);
    const other = await createCard(client, { ...templateLink(), title: 'Other', anchorDate: '2026-10-01' });
    await createTask(client, { description: 'Other card', date: '2026-10-01', cardId: other.id });
    intercept();

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.deepEqual(listed.map((task) => task.id), tasks.map((task) => task.id));
    assert.equal(scans().length, 0);
    const batchGets = commands.filter((command) => command instanceof BatchGetCommand) as BatchGetCommand[];
    assert.equal(batchGets.length, 1);
    assert.equal(batchGets[0].input.RequestItems?.[TABLE_TASKS]?.ConsistentRead, true);
  });

  it('returns current content when the index still holds an older copy', async () => {
    const { card, tasks } = await cardWithTasks(2);
    const staleIndexItems = (await client.send(new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Card',
      KeyConditionExpression: 'cardId = :cardId',
      ExpressionAttributeValues: { ':cardId': card.id },
    }))).Items;
    await updateTask(client, tasks[0].id, { expectedVersion: 1, patch: { status: 'done' } });
    intercept((command, result) => (isCardQuery(command) ? { Items: staleIndexItems } : result));

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.equal(listed.find((task) => task.id === tasks[0].id)?.status, 'done');
    assert.equal(scans().length, 0);
  });

  it('falls back to the consistent Scan when the index is missing a fresh Task', async () => {
    const { card, tasks } = await cardWithTasks(3);
    intercept((command, result) => (
      isCardQuery(command)
        ? { Items: ((result as { Items: Array<{ id: string }> }).Items).filter((item) => item.id !== tasks[2].id) }
        : result
    ));

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.deepEqual(listed.map((task) => task.id).sort(), tasks.map((task) => task.id).sort());
    assert.equal(scans().length, 1);
    assert.equal((scans()[0] as ScanCommand).input.ConsistentRead, true);
  });

  it('leaves out a Task the index still lists after it moved to another Card', async () => {
    const { card, tasks } = await cardWithTasks(2);
    const staleIndexItems = (await client.send(new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Card',
      KeyConditionExpression: 'cardId = :cardId',
      ExpressionAttributeValues: { ':cardId': card.id },
    }))).Items;
    const other = await createCard(client, { ...templateLink(), title: 'Other', anchorDate: '2026-10-01' });
    await updateTask(client, tasks[1].id, { expectedVersion: 1, patch: { cardId: other.id } });
    intercept((command, result) => (isCardQuery(command) ? { Items: staleIndexItems } : result));

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.deepEqual(listed.map((task) => task.id), [tasks[0].id]);
    assert.equal(scans().length, 0);
  });

  it('falls back to the Scan when the Card changes while its Tasks are read', async () => {
    const { card, tasks } = await cardWithTasks(2);
    let late: Awaited<ReturnType<typeof createTask>> | undefined;
    intercept();
    const target = client as unknown as { send: Send };
    const recording = target.send;
    target.send = async (command: unknown) => {
      const result = await recording(command);
      if (command instanceof BatchGetCommand && !late) {
        late = await createTask(client, { description: 'Late', date: '2026-10-09', cardId: card.id });
      }
      return result;
    };

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.ok(late);
    assert.deepEqual(listed.map((task) => task.id).sort(), [...tasks.map((task) => task.id), late.id].sort());
    assert.equal(scans().length, 1);
  });

  it('falls back to the Scan when the Card row has no aggregate to prove completeness', async () => {
    // Not reachable through createTask, which requires the Card row.
    const orphan = { id: 'orphan', description: 'Orphan', date: '2026-10-01', status: 'todo', cardId: 'missing-card', version: 1, taskHistory: [] };
    await client.send(new PutCommand({ TableName: TABLE_TASKS, Item: { PK: 'TASK#orphan', SK: 'TASK#orphan', ...orphan } }));
    intercept();

    const listed = await listTasksByCardConsistent(client, 'missing-card');

    assert.deepEqual(listed.map((task) => task.id), [orphan.id]);
    assert.equal(scans().length, 1);
  });

  it('falls back to the Scan when the stored aggregate disagrees with the rows', async () => {
    const { card, tasks } = await cardWithTasks(2);
    const { TABLE_CARDS } = await import('../src/db/tableNames');
    await client.send(new UpdateCommand({
      TableName: TABLE_CARDS,
      Key: { PK: `CARD#${card.id}`, SK: `CARD#${card.id}` },
      UpdateExpression: 'SET taskCount = :count, openTaskCount = :count',
      ExpressionAttributeValues: { ':count': 3 },
    }));
    intercept();

    const listed = await listTasksByCardConsistent(client, card.id);

    assert.equal(listed.length, tasks.length);
    assert.equal(scans().length, 1);
  });
});
