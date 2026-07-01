import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import dynalite from 'dynalite';

describe('DynamoDB local (dynalite)', () => {
  let server: ReturnType<typeof dynalite>;
  let client: DynamoDBClient;
  let docClient: DynamoDBDocumentClient;
  let port: number;
  const TABLE_NAME = 'TestTable';

  before(async () => {
    server = dynalite({ createTableMs: 0 });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, (err?: Error) => {
        if (err) return reject(err);
        port = server.address().port;
        resolve();
      });
    });

    client = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: `http://localhost:${port}`,
      credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
    });
    docClient = DynamoDBDocumentClient.from(client);

    // Create test table
    await client.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      })
    );
  });

  after(async () => {
    if (client) client.destroy();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  });

  it('dynalite starts and serves DynamoDB API', async () => {
    assert.ok(port > 0, 'dynalite should be listening on a port');
  });

  it('can create a table', async () => {
    const desc = await client.send(
      new DescribeTableCommand({ TableName: TABLE_NAME })
    );
    assert.strictEqual(desc.Table!.TableName, TABLE_NAME);
    assert.strictEqual(desc.Table!.TableStatus, 'ACTIVE');
  });

  it('can put and get an item', async () => {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: 'task-1', title: 'Write tests', done: false },
      })
    );

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: 'task-1' },
      })
    );

    assert.ok(result.Item, 'Item should exist');
    assert.strictEqual(result.Item.pk, 'task-1');
    assert.strictEqual(result.Item.title, 'Write tests');
    assert.strictEqual(result.Item.done, false);
  });
});
