import assert from 'node:assert';
import { before, describe, it } from 'node:test';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
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
import { TABLE_FILES } from '../src/db/tableNames';
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
): FileRecord & { PK: string; SK: string } {
  const id = `file-${String(sequence).padStart(2, '0')}`;
  return {
    PK: `FILE#${id}`,
    SK: `FILE#${id}`,
    id,
    taskId: 'pagination-task',
    filename: `${id}.txt`,
    category: sequence % 2 === 0 ? 'image' : 'document',
    storagePath: `pagination-task/${id}.txt`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
    ...overrides,
  };
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
      { Items: items.slice(0, 2), LastEvaluatedKey: { PK: items[1].PK, SK: items[1].SK } },
      { Items: items.slice(2, 4), LastEvaluatedKey: { PK: items[3].PK, SK: items[3].SK } },
      { Items: items.slice(3), LastEvaluatedKey: { PK: items[5].PK, SK: items[5].SK } },
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
        PK: `FILE#${file.id}`,
        SK: `FILE#${file.id}`,
        taskId: file.taskId,
      }),
      cleanItem: ({ PK: _partition, SK: _sort, ...file }) => file as FileRecord,
    };

    const first = await readCollectionPage<FileRecord>({
      ...request,
      input: { limit: '3' },
    });
    assert.deepStrictEqual(first.items.map(({ id }) => id), ['file-01', 'file-02', 'file-03']);
    assert.deepEqual(first.nextExclusiveStartKey, {
      PK: 'FILE#file-03',
      SK: 'FILE#file-03',
      taskId: 'pagination-task',
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].name, 'QueryCommand');
    assert.strictEqual((calls[0].input as QueryCommandInput).IndexName, 'GSI-Task');
    assert.strictEqual(calls[0].input.Limit, 2);
    assert.strictEqual(calls[0].input.ExclusiveStartKey, undefined);
    assert.deepEqual(calls[1].input.ExclusiveStartKey, {
      PK: 'FILE#file-02',
      SK: 'FILE#file-02',
    });

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
      { Items: [hidden[0], visible[0]], LastEvaluatedKey: { PK: visible[0].PK, SK: visible[0].SK } },
      { Items: [hidden[1]], LastEvaluatedKey: { PK: hidden[1].PK, SK: hidden[1].SK } },
      { Items: [visible[1]] },
    ], calls);

    const page = await readCollectionPage<FileRecord>({
      client,
      tableName: 'files',
      kind: 'scan',
      command: {
        FilterExpression: 'begins_with(PK, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'FILE#' },
      },
      binding,
      input: { limit: '10' },
      physicalPageSize: 2,
      keyFor: (file) => ({ PK: `FILE#${file.id}`, SK: `FILE#${file.id}` }),
      matches: (file) => file.category === 'image',
      cleanItem: ({ PK: _partition, SK: _sort, ...file }) => file as FileRecord,
    });

    assert.deepStrictEqual(page.items.map(({ id }) => id), ['file-02', 'file-04']);
    assert.strictEqual(page.nextExclusiveStartKey, undefined);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls.every(({ name }) => name === 'ScanCommand'), true);
    assert.deepEqual(calls[1].input.ExclusiveStartKey, {
      PK: 'FILE#file-02',
      SK: 'FILE#file-02',
    });
    assert.deepEqual(calls[2].input.ExclusiveStartKey, {
      PK: 'FILE#file-03',
      SK: 'FILE#file-03',
    });
  });

  it('rejects a cursor when its collection binding changes', async () => {
    const startKey: ExclusiveStartKey = { PK: 'FILE#file-02', SK: 'FILE#file-02' };
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
  const routeBinding = {
    collection: 'files',
    filters: { taskId, category: null, tag: null },
    principal: 'test-bypass',
  };

  before(async () => {
    process.env.IS_LOCAL = 'true';
    const { client } = await useTestDatabase();
    await truncateTestTables(client);
    for (let sequence = 0; sequence < 26; sequence += 1) {
      await client.send(new PutCommand({
        TableName: TABLE_FILES,
        Item: fileItem(sequence, { taskId }),
      }));
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
    assert.deepStrictEqual(firstBody.files.items.map(({ id }) => id), ['file-00']);
    assert.strictEqual(typeof firstBody.files.nextCursor, 'string');
    assert.deepEqual(await decodeCollectionCursor(routeBinding, firstBody.files.nextCursor!), {
      PK: 'FILE#file-00',
      SK: 'FILE#file-00',
      taskId,
    });

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
