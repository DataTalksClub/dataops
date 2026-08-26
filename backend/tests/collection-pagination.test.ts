import assert from 'node:assert';
import { before, describe, it } from 'node:test';
import type {
  DynamoDBDocumentClient,
  QueryCommandInput,
  ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH = 'true';
process.env.WORK_ENGINE_PORTAL_SECRET = 'collection-pagination-test-secret';

import { readCollectionPage } from '../src/db/collectionPage';
import {
  CollectionCursorError,
  decodeCollectionCursor,
  encodeCollectionCursor,
} from '../src/db/collectionPagination';
import type { CursorBinding, ExclusiveStartKey } from '../src/db/collectionPagination';
import { createFile } from '../src/db/files';
import type { FileRecord } from '../src/types';
import { truncateTestTables, useTestDatabase } from './helpers/db';

interface RecordedCommand {
  readonly name: string;
  readonly input: QueryCommandInput | ScanCommandInput;
}

interface FilesEnvelope {
  readonly files: {
    readonly items: FileRecord[];
    readonly nextCursor?: string;
  };
}

function fakeClient(
  pages: Array<{ Items?: unknown; LastEvaluatedKey?: unknown }>,
  calls: RecordedCommand[],
) {
  return {
    async send(command: { constructor: Function; input: unknown }) {
      const input = command.input as QueryCommandInput | ScanCommandInput;
      calls.push({
        name: command.constructor.name,
        input,
      });
      const page = pages[calls.length - 1];
      if (!page) throw new Error('Unexpected extra DynamoDB page');
      return {
        ...page,
        ...(Array.isArray(page.Items)
          ? { Items: page.Items.slice(0, input.Limit ?? page.Items.length) }
          : {}),
      };
    },
  } as unknown as DynamoDBDocumentClient;
}

function fileItem(
  sequence: number,
  overrides: Partial<FileRecord> = {},
): FileRecord {
  const id = `file-${String(sequence).padStart(2, '0')}`;
  return {
    id,
    taskId: 'pagination-task',
    filename: `${id}.txt`,
    category: sequence % 2 === 0 ? 'image' : 'document',
    storagePath: `pagination-task/${id}.txt`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
    ...overrides,
  };
}

function withoutId<T extends { id: string }>({ id: _id, ...data }: T): Omit<T, 'id'> {
  return data;
}

describe('collection pagination helpers', () => {
  const binding: CursorBinding = {
    collection: 'test-collection',
    filters: { kind: 'query' },
    principal: 'viewer-1',
  };

  it('continues a query across physical DynamoDB pages without over-returning', async () => {
    const items = [
      fileItem(1),
      fileItem(2),
      fileItem(3),
      fileItem(4),
      fileItem(5),
      fileItem(6),
    ];
    const calls: RecordedCommand[] = [];
    const client = fakeClient([
      { Items: items.slice(0, 2), LastEvaluatedKey: { continuation: 'physical-page-1' } },
      { Items: items.slice(2, 4), LastEvaluatedKey: { continuation: 'physical-page-2' } },
      { Items: items.slice(3), LastEvaluatedKey: { continuation: 'physical-page-3' } },
      { Items: [] },
    ], calls);
    const request = {
      client,
      tableName: 'files',
      kind: 'query' as const,
      command: {
        IndexName: 'GSI-Task',
        KeyConditionExpression: 'taskId = :taskId',
        ExpressionAttributeValues: { ':taskId': 'pagination-task' },
      },
      binding,
      physicalPageSize: 2,
      keyFor: (file: FileRecord) => ({
        continuation: `logical-page-after-${file.id}`,
        task: file.taskId,
      }),
      cleanItem: (file) => file as FileRecord,
    };

    const first = await readCollectionPage<FileRecord>({
      ...request,
      input: { limit: '3' },
    });
    assert.deepStrictEqual(first.items.map(({ id }) => id), ['file-01', 'file-02', 'file-03']);
    assert.deepEqual(first.nextExclusiveStartKey, {
      continuation: 'logical-page-after-file-03',
      task: 'pagination-task',
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].name, 'QueryCommand');
    assert.strictEqual((calls[0].input as QueryCommandInput).IndexName, 'GSI-Task');
    assert.strictEqual(calls[0].input.Limit, 2);
    assert.strictEqual(calls[0].input.ExclusiveStartKey, undefined);
    assert.deepEqual(calls[1].input.ExclusiveStartKey, { continuation: 'physical-page-1' });

    const cursor = await encodeCollectionCursor(binding, first.nextExclusiveStartKey!);
    const second = await readCollectionPage<FileRecord>({
      ...request,
      input: { limit: '3', cursor },
    });
    assert.deepStrictEqual(second.items.map(({ id }) => id), ['file-04', 'file-05']);
    assert.strictEqual(second.nextExclusiveStartKey, undefined);
    assert.strictEqual(calls.length, 4);
    assert.deepEqual(calls[2].input.ExclusiveStartKey, first.nextExclusiveStartKey);
  });

  it('keeps scanning when an entire physical page is filtered out', async () => {
    const visible = [fileItem(2), fileItem(4)];
    const hidden = [fileItem(1), fileItem(3)];
    const calls: RecordedCommand[] = [];
    const client = fakeClient([
      { Items: [hidden[0], visible[0]], LastEvaluatedKey: { continuation: 'physical-filter-page-1' } },
      { Items: [hidden[1]], LastEvaluatedKey: { continuation: 'physical-filter-page-2' } },
      { Items: [visible[1]] },
    ], calls);

    const page = await readCollectionPage<FileRecord>({
      client,
      tableName: 'files',
      kind: 'scan',
      command: {
        FilterExpression: 'attribute_exists(id)',
      },
      binding,
      input: { limit: '10' },
      physicalPageSize: 2,
      keyFor: (file) => ({ continuation: `visible-${file.id}` }),
      matches: (file) => file.category === 'image',
      cleanItem: (file) => file as FileRecord,
    });

    assert.deepStrictEqual(page.items.map(({ id }) => id), ['file-02', 'file-04']);
    assert.strictEqual(page.nextExclusiveStartKey, undefined);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls.every(({ name }) => name === 'ScanCommand'), true);
    assert.deepEqual(calls[1].input.ExclusiveStartKey, { continuation: 'physical-filter-page-1' });
    assert.deepEqual(calls[2].input.ExclusiveStartKey, { continuation: 'physical-filter-page-2' });
  });

  it('rejects a cursor when its collection binding changes', async () => {
    const startKey: ExclusiveStartKey = { continuation: 'synthetic-page-handle' };
    const cursor = await encodeCollectionCursor(binding, startKey);

    await assert.rejects(
      decodeCollectionCursor({ ...binding, filters: { kind: 'scan' } }, cursor),
      (error: unknown) => error instanceof CollectionCursorError && error.code === 'cursor-binding-mismatch',
    );
    await assert.rejects(
      decodeCollectionCursor({ ...binding, principal: 'viewer-2' }, cursor),
      (error: unknown) => error instanceof CollectionCursorError && error.code === 'cursor-binding-mismatch',
    );
  });
});

describe('collection pagination routes', () => {
  let handler: typeof import('../src/handler').handler;
  const taskId = 'route-pagination-task';
  let routeFileIds: string[] = [];

  before(async () => {
    process.env.IS_LOCAL = 'true';
    const { client } = await useTestDatabase();
    await truncateTestTables(client);
    routeFileIds = [];
    for (let sequence = 0; sequence < 26; sequence += 1) {
      const created = await createFile(client, withoutId(fileItem(sequence, { taskId })));
      routeFileIds.push(created.id);
    }
    ({ handler } = await import('../src/handler'));
  });

  it('returns an object envelope and traverses a real GSI across pages', async () => {
    const firstResponse = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId, limit: '1' },
    }, {});
    assert.strictEqual(firstResponse.statusCode, 200);
    const firstBody = JSON.parse(firstResponse.body) as FilesEnvelope;
    assert.strictEqual(firstBody.files.items.length, 1);
    assert.strictEqual(routeFileIds.includes(firstBody.files.items[0].id), true);
    assert.strictEqual(typeof firstBody.files.nextCursor, 'string');

    const secondResponse = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId, cursor: firstBody.files.nextCursor },
    }, {});
    assert.strictEqual(secondResponse.statusCode, 200);
    const secondBody = JSON.parse(secondResponse.body) as FilesEnvelope;
    assert.strictEqual(secondBody.files.items.length, 25);
    assert.strictEqual(secondBody.files.nextCursor, undefined);
  });

  it('rejects invalid limits with the stable pagination envelope', async () => {
    const response = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId, limit: '0' },
    }, {});
    assert.strictEqual(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      error: 'Invalid pagination input',
      code: 'invalid_pagination_input',
    });
  });

  it('uses an object envelope for an empty result', async () => {
    const response = await handler({
      httpMethod: 'GET',
      path: '/api/files',
      queryStringParameters: { taskId: 'no-route-files' },
    }, {});
    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body) as FilesEnvelope;
    assert.deepEqual(body.files, { items: [] });
    assert.strictEqual(body.files.nextCursor, undefined);
  });
});
