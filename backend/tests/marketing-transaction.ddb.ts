import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

// This suite is run only by the isolated DynamoDB Local transaction CI harness.
// Never resolve a live table name or use ambient AWS credentials in a test.
const endpoint = process.env.DYNAMODB_ENDPOINT || "";
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
process.env.DATAOPS_MARKETING_TABLE = `MarketingTransactionTest${process.pid}`;
const table = process.env.DATAOPS_MARKETING_TABLE;
const raw = new DynamoDBClient({
  endpoint,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const client = DynamoDBDocumentClient.from(raw);

test("real DynamoDB snapshot and latest-index transaction: identical concurrent retries and atomic cancellation", async () => {
  const { disableLocalTransactionEmulation } = await import("../src/db/client");
  disableLocalTransactionEmulation();
  const { pushSnapshots, getMarketingRow, snapshotKey, seriesKey } =
    await import("../src/db/marketing");
  await raw.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "stepId", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI-StepId",
          KeySchema: [{ AttributeName: "stepId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  try {
    await waitUntilTableExists(
      { client: raw, maxWaitTime: 30, minDelay: 1, maxDelay: 1 },
      { TableName: table },
    );
    const s = {
      metricKey: "bing_clicks",
      scope: "site",
      source: "manual",
      period: "2026-W48",
      value: 12,
      unit: "count",
    } as any;
    const results = await Promise.all([
      pushSnapshots(client, [s], {}, "one"),
      pushSnapshots(client, [s], {}, "two"),
    ]);
    assert.equal(
      results.reduce((n, r) => n + r.inserted, 0),
      1,
    );
    assert.equal(
      results.reduce((n, r) => n + r.unchanged, 0),
      1,
    );
    assert.equal(
      (await getMarketingRow(client, { PK: "METRICS", SK: seriesKey(s) }))
        ?.value,
      12,
    );
    const broken = {
      send: async (command: any) => {
        if (command instanceof TransactWriteCommand) {
          const put = command.input.TransactItems!.at(-1)!.Put!;
          put.ConditionExpression = "#version=:impossible";
          put.ExpressionAttributeNames = { "#version": "version" };
          put.ExpressionAttributeValues = { ":impossible": -1 };
        }
        return client.send(command);
      },
    } as unknown as DynamoDBDocumentClient;
    const next = { ...s, period: "2026-W49", value: 15 };
    await assert.rejects(
      () => pushSnapshots(broken, [next], {}, "test"),
      (e: any) => e.name === "TransactionCanceledException",
    );
    assert.equal(
      await getMarketingRow(client, snapshotKey(next)),
      undefined,
      "no snapshot commits when its latest-value index condition fails",
    );
    assert.equal(
      (await getMarketingRow(client, { PK: "METRICS", SK: seriesKey(s) }))
        ?.value,
      12,
    );
  } finally {
    await raw.send(new DeleteTableCommand({ TableName: table }));
    raw.destroy();
  }
});
