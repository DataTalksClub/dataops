import assert from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { route } from '../src/router';
import { createCard } from '../src/db/cards';
import { createFile } from '../src/db/files';
import { createMailingExport } from '../src/db/mailingExports';
import {
  createNotification,
  listAllNotifications,
  listUndismissedNotifications,
} from '../src/db/notifications';
import { createTask } from '../src/db/tasks';
import { createUserWithId } from '../src/db/users';
import { TABLE_TASKS } from '../src/db/tableNames';
import type { MailingExportJob } from '../src/mailingExports/types';
import type { LambdaEvent, LambdaResponse } from '../src/types';
import { truncateTestTables, useTestDatabase } from './helpers/db';

const TEST_SECRET = 'synthetic-collection-route-pagination-secret';
const MAILING_CONFIG = {
  id: 'synthetic-mailing-config',
  provider: 'mailchimp',
  account: 'Synthetic account',
  scopeLabel: 'Synthetic mailing scope',
  credentialId: 'mailchimp',
};

const environment = {
  NODE_ENV: process.env.NODE_ENV,
  SKIP_AUTH: process.env.SKIP_AUTH,
  IS_LOCAL: process.env.IS_LOCAL,
  WORK_ENGINE_PORTAL_SECRET: process.env.WORK_ENGINE_PORTAL_SECRET,
  DATAOPS_MAILING_EXPORTS_CONFIG: process.env.DATAOPS_MAILING_EXPORTS_CONFIG,
};

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH = 'true';
process.env.IS_LOCAL = 'true';
process.env.WORK_ENGINE_PORTAL_SECRET = TEST_SECRET;
process.env.DATAOPS_MAILING_EXPORTS_CONFIG = JSON.stringify([MAILING_CONFIG]);

let client: DynamoDBDocumentClient;

before(async () => {
  ({ client } = await useTestDatabase());
});

function restoreEnvironmentVariable(name: keyof typeof environment): void {
  const value = environment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(() => {
  restoreEnvironmentVariable('NODE_ENV');
  restoreEnvironmentVariable('SKIP_AUTH');
  restoreEnvironmentVariable('IS_LOCAL');
  restoreEnvironmentVariable('WORK_ENGINE_PORTAL_SECRET');
  restoreEnvironmentVariable('DATAOPS_MAILING_EXPORTS_CONFIG');
});

function request(
  method: string,
  path: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<LambdaResponse> {
  const event: LambdaEvent = {
    httpMethod: method,
    path,
    headers,
    body: null,
    queryStringParameters: Object.keys(query).length > 0 ? query : null,
  };
  return route(event, client);
}

function cardData(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Synthetic Card ${id}`,
    ...overrides,
  };
}

function taskData(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    id,
    version: 1,
    description: `Synthetic Task ${id}`,
    date: '2026-08-01',
    status: 'todo',
    taskHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function userData(id: string): Record<string, unknown> {
  return {
    name: `Synthetic ${id}`,
    email: `${id}@example.invalid`,
    role: 'operator',
  };
}

function fileData(index: number): Record<string, unknown> {
  const id = `file-${String(index).padStart(3, '0')}`;
  const taskId = index % 2 === 0 ? 'files-task' : 'other-task';
  return {
    taskId,
    filename: `${id}.txt`,
    category: index % 3 === 0 ? 'image' : index % 3 === 1 ? 'invoice' : 'document',
    tags: index % 4 === 0 ? ['target', 'shared'] : ['shared'],
    storagePath: `synthetic-files/${id}.txt`,
    storageProvider: 'local-dev',
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
  };
}

function notificationData(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = `notification-${String(index).padStart(3, '0')}`;
  return {
    message: `Synthetic notification ${id}`,
    dismissed: index % 5 === 0,
    createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    ...overrides,
  };
}

function mailingExportData(index: number): MailingExportJob {
  const id = `mailing-export-${String(index).padStart(3, '0')}`;
  const requestedAt = new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString();
  return {
    id,
    configId: MAILING_CONFIG.id,
    runKey: `synthetic-run-${index}`,
    provider: 'mailchimp',
    account: 'Synthetic account',
    scopeLabel: 'Synthetic mailing scope',
    status: 'completed',
    requestedAt,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    leaseOwner: 'synthetic-private-lease-owner',
    leaseExpiresAt: 1_999_999_999_999,
  };
}

function ceilingTask(id: string, sequence: number): Record<string, unknown> {
  return {
    id,
    version: 1,
    description: `Synthetic ceiling Task ${sequence}`,
    date: '2026-08-01',
    status: 'todo',
    taskHistory: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

type CollectionRow = Record<string, unknown>;

async function collectPages(
  path: string,
  envelopeKey: 'cards' | 'files' | 'notifications' | 'exports',
  query: Record<string, string>,
  inspect?: (body: Record<string, unknown>, page: CollectionRow[]) => void,
): Promise<CollectionRow[]> {
  const requestedLimit = Number(query.limit);
  const rows: CollectionRow[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const pageQuery = cursor ? { ...query, cursor } : query;
    const response = await request('GET', path, pageQuery);
    assert.strictEqual(response.statusCode, 200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    const envelope = body[envelopeKey];
    assert.ok(envelope && typeof envelope === 'object' && !Array.isArray(envelope));
    const envelopeRecord = envelope as Record<string, unknown>;
    const page = envelopeRecord.items;
    assert.ok(Array.isArray(page));
    assert.ok(page.length <= requestedLimit);

    const pageRows = page as CollectionRow[];
    for (const row of pageRows) {
      assert.strictEqual(typeof row.id, 'string');
      assert.strictEqual(seen.has(row.id as string), false);
      seen.add(row.id as string);
      rows.push(row);
    }

    // Successful pages are public projections. Check the entire envelope, not
    // just individual rows, so secret and lease-only values cannot enter nested metadata.
    const serializedBody = JSON.stringify(body);
    assert.strictEqual(serializedBody.includes(TEST_SECRET), false);
    assert.strictEqual(serializedBody.includes('synthetic-private-lease-owner'), false);
    if (envelopeRecord.nextCursor !== undefined) {
      const cursor = String(envelopeRecord.nextCursor);
      assert.match(cursor, /^[A-Za-z0-9_-]+$/);
      assert.ok(cursor.length >= 32 && cursor.length <= 4096);
    }
    inspect?.(body, pageRows);

    const nextCursor = envelopeRecord.nextCursor;
    if (nextCursor === undefined) return rows;
    assert.strictEqual(typeof nextCursor, 'string');
    assert.ok((nextCursor as string).length > 0);
    cursor = nextCursor as string;
  }

  assert.fail('pagination did not terminate within the bounded test traversal');
}

function ids(rows: CollectionRow[]): Set<string> {
  return new Set(rows.map((row) => row.id as string));
}

describe('collection route pagination', () => {
  beforeEach(async () => {
    await truncateTestTables(client);
  });

  it('paginates Cards and joins Tasks from a bounded-complete read', async () => {
    await createUserWithId(client, 'card-assignee-a', userData('card-assignee-a'));
    await createUserWithId(client, 'card-assignee-b', userData('card-assignee-b'));
    await createCard(client, cardData('card-join'));
    for (let index = 0; index < 4; index += 1) {
      await createCard(client, cardData(`card-page-${index}`));
    }

    await createTask(client, taskData('task-join-a', {
      cardId: 'card-join',
      assigneeId: 'card-assignee-a',
    }));
    await createTask(client, taskData('task-join-b', {
      cardId: 'card-join',
      assigneeId: 'card-assignee-b',
    }));

    // Keep this fixture synthetic while making the complete Task scan cross
    // DynamoDB's physical response boundary. The route must still project
    // both assignees on the Card page that contains card-join.
    const padding = 'synthetic task padding '.repeat(2_000);
    for (let index = 0; index < 36; index += 1) {
      await createTask(client, taskData(`task-padding-${String(index).padStart(3, '0')}`, {
        comment: padding,
      }));
    }

    const cards = await collectPages('/api/cards', 'cards', { limit: '1' });
    assert.strictEqual(cards.length, 5);
    assert.deepStrictEqual(ids(cards), new Set([
      'card-join',
      'card-page-0',
      'card-page-1',
      'card-page-2',
      'card-page-3',
    ]));

    const joined = cards.find((card) => card.id === 'card-join');
    assert.ok(joined);
    const assignees = joined.taskAssignees;
    assert.ok(Array.isArray(assignees));
    assert.deepStrictEqual(
      new Set((assignees as CollectionRow[]).map((assignee) => assignee.id)),
      new Set(['card-assignee-a', 'card-assignee-b']),
    );
  });

  it('traverses general, category, tag, and task-index Files pages without relying on global order', async () => {
    const files: CollectionRow[] = [];
    for (let index = 0; index < 36; index += 1) {
      files.push(await createFile(client, fileData(index)));
    }

    const general = await collectPages('/api/files', 'files', { limit: '5' });
    assert.deepStrictEqual(ids(general), ids(files));

    const category = await collectPages('/api/files', 'files', { category: 'image', limit: '3' });
    assert.deepStrictEqual(ids(category), ids(files.filter((file) => file.category === 'image')));

    const tag = await collectPages('/api/files', 'files', { tag: 'target', limit: '2' });
    assert.deepStrictEqual(ids(tag), ids(files.filter((file) => file.tags?.includes('target'))));

    const taskFiles = await collectPages('/api/files', 'files', { taskId: 'files-task', limit: '4' });
    assert.deepStrictEqual(ids(taskFiles), ids(files.filter((file) => file.taskId === 'files-task')));
  });

  it('paginates default and all Notifications in their nested envelope', async () => {
    const notifications: CollectionRow[] = [];
    for (let index = 0; index < 36; index += 1) {
      notifications.push(await createNotification(client, notificationData(index)));
    }

    const defaultNotifications = await collectPages(
      '/api/notifications',
      'notifications',
      { limit: '3' },
    );
    assert.strictEqual(defaultNotifications.length, 28);
    assert.ok(defaultNotifications.every((notification) => notification.dismissed === false));

    const allNotifications = await collectPages(
      '/api/notifications',
      'notifications',
      { all: 'true', limit: '4' },
    );
    assert.strictEqual(allNotifications.length, 36);
    assert.deepStrictEqual(ids(allNotifications), ids(notifications));
  });

  it('dismisses all Notifications across bounded physical scan pages', async () => {
    const padding = 'synthetic notification padding '.repeat(2_000);
    const total = 36;
    const active = Array.from({ length: total }, (_, index) => index).filter((index) => index % 4 !== 0).length;
    for (let index = 0; index < total; index += 1) {
      await createNotification(client, notificationData(index, {
        message: padding,
        dismissed: index % 4 === 0,
      }));
    }

    const response = await request('PUT', '/api/notifications/dismiss-all');
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { count: active });
    assert.strictEqual((await listUndismissedNotifications(client)).length, 0);
    assert.strictEqual((await listAllNotifications(client)).length, total);
  });

  it('continues Mailing Exports and omits lease fields from every nested page', async () => {
    const total = 31;
    for (let index = 0; index < total; index += 1) {
      await createMailingExport(client, mailingExportData(index));
    }

    const exports = await collectPages(
      '/api/mailing-exports',
      'exports',
      { limit: '5' },
      (body, page) => {
        const configs = body.configs;
        assert.ok(Array.isArray(configs));
        assert.strictEqual((configs as CollectionRow[]).some((config) => 'credentialId' in config), false);
        for (const item of page) {
          assert.strictEqual('leaseOwner' in item, false);
          assert.strictEqual('leaseExpiresAt' in item, false);
        }
      },
    );
    assert.strictEqual(exports.length, total);
    assert.deepStrictEqual(ids(exports), new Set(
      Array.from({ length: total }, (_, index) => `mailing-export-${String(index).padStart(3, '0')}`),
    ));
  });
});

describe('collection route pagination rejection envelopes', () => {
  beforeEach(async () => {
    await truncateTestTables(client);
  });

  it('returns the same sanitized 400 response for invalid cursors and limits on all four GET collections', async () => {
    const expected = {
      error: 'Invalid pagination input',
      code: 'invalid_pagination_input',
    };
    const paths = ['/api/cards', '/api/files', '/api/notifications', '/api/mailing-exports'];

    for (const path of paths) {
      for (const query of [{ cursor: 'not a cursor' }, { limit: '0' }]) {
        const response = await request('GET', path, query);
        assert.strictEqual(response.statusCode, 400);
        assert.deepStrictEqual(JSON.parse(response.body), expected);
        assert.strictEqual(response.body.includes(TEST_SECRET), false);
        assert.strictEqual(response.body.includes('synthetic-private-lease-owner'), false);
      }
    }
  });

  it('rejects a cursor when its collection, filters, or principal changes', async () => {
    await createFile(client, fileData(0));
    await createFile(client, fileData(3));

    const firstImagePage = await request('GET', '/api/files', {
      category: 'image',
      limit: '1',
    });
    assert.strictEqual(firstImagePage.statusCode, 200);
    const cursor = (JSON.parse(firstImagePage.body) as {
      files: { nextCursor?: string };
    }).files.nextCursor;
    assert.ok(cursor);
    const expected = {
      error: 'Invalid pagination input',
      code: 'invalid_pagination_input',
    };

    const changedBindingRequests: Array<Promise<LambdaResponse>> = [
      request('GET', '/api/cards', { cursor }),
      request('GET', '/api/files', { category: 'document', cursor }),
      request('GET', '/api/files', { category: 'image', cursor }, { 'x-user-id': 'synthetic-other-viewer' }),
    ];
    for (const responsePromise of changedBindingRequests) {
      const response = await responsePromise;
      assert.strictEqual(response.statusCode, 400);
      assert.deepStrictEqual(JSON.parse(response.body), expected);
    }
  });

  it('fails a Cards response loudly when the bounded Task join reaches its ceiling', async () => {
    let taskPages = 0;
    const boundedTaskClient = new Proxy(client, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver);
        return async (command: unknown) => {
          if (
            command instanceof ScanCommand
            && command.input.TableName === TABLE_TASKS
          ) {
            taskPages += 1;
            const taskId = `task-ceiling-${String(taskPages).padStart(3, '0')}`;
            return {
              Items: [ceilingTask(taskId, taskPages)],
              LastEvaluatedKey: { continuation: taskId },
            };
          }
          return target.send(command as never);
        };
      },
    });

    const response = await route({
      httpMethod: 'GET',
      path: '/api/cards',
      headers: {},
      body: null,
      queryStringParameters: { limit: '1' },
    }, boundedTaskClient);

    assert.strictEqual(response.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: 'Internal server error',
    });
    assert.strictEqual(taskPages, 200);
    assert.strictEqual(response.body.includes('task-ceiling'), false);
  });
});
