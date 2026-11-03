import { createHash, randomUUID } from "crypto";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_BOOKKEEPING } from "./tableNames";

export const BOOKKEEPING_REPORT_SNAPSHOT_VERSION = 1;
const REPORT_SNAPSHOT_PARTITION_PREFIX = "BOOKKEEPING_REPORT_SNAPSHOT#";
const REPORT_SNAPSHOT_CHUNK_BYTES = 240 * 1024;
const REPORT_SNAPSHOT_ITEM_MAX_BYTES = 350 * 1024;

export type BookkeepingReportSnapshot = Record<string, unknown>;

export type StoredBookkeepingReportSnapshot = {
  snapshotStorageId: string;
  snapshotStorageVersion: number;
  snapshotChunkCount: number;
  snapshotByteSize: number;
  snapshotSha256: string;
};

type SnapshotChunk = Record<string, unknown> & {
  PK: string;
  SK: string;
  storageId: string;
  reportId: string;
  chunkIndex: number;
  chunkCount: number;
  byteSize: number;
  sha256: string;
  payload: string;
};

function partitionKey(storageId: string) {
  return `${REPORT_SNAPSHOT_PARTITION_PREFIX}${storageId}`;
}

function sortKey(index: number) {
  return `CHUNK#${String(index).padStart(8, "0")}`;
}

export function reportSnapshotChunkSizeBytes(item: Record<string, unknown>) {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

export async function storeBookkeepingReportSnapshot(
  client: DynamoDBDocumentClient,
  reportId: string,
  snapshot: BookkeepingReportSnapshot,
): Promise<StoredBookkeepingReportSnapshot> {
  const serialized = JSON.stringify(snapshot);
  if (serialized === undefined) throw new Error("Bookkeeping report snapshot is not serializable");
  const bytes = Buffer.from(serialized, "utf8");
  const storageId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunkCount = Math.max(1, Math.ceil(bytes.length / REPORT_SNAPSHOT_CHUNK_BYTES));
  const pk = partitionKey(storageId);
  const chunks: SnapshotChunk[] = Array.from({ length: chunkCount }, (_, chunkIndex) => ({
    PK: pk,
    SK: sortKey(chunkIndex),
    recordType: "bookkeeping-report-snapshot-chunk",
    storageId,
    reportId,
    chunkIndex,
    chunkCount,
    byteSize: bytes.length,
    sha256,
    payload: bytes.subarray(
      chunkIndex * REPORT_SNAPSHOT_CHUNK_BYTES,
      (chunkIndex + 1) * REPORT_SNAPSHOT_CHUNK_BYTES,
    ).toString("base64"),
  }));
  if (chunks.some((chunk) => reportSnapshotChunkSizeBytes(chunk) > REPORT_SNAPSHOT_ITEM_MAX_BYTES)) {
    throw new Error("Bookkeeping report snapshot chunk exceeds the safe storage size");
  }

  try {
    for (const chunk of chunks) {
      await client.send(new PutCommand({
        TableName: TABLE_BOOKKEEPING,
        Item: chunk,
        ConditionExpression: "attribute_not_exists(PK)",
      }));
    }
  } catch (error) {
    await deleteBookkeepingReportSnapshot(client, storageId).catch(() => undefined);
    throw error;
  }

  return {
    snapshotStorageId: storageId,
    snapshotStorageVersion: BOOKKEEPING_REPORT_SNAPSHOT_VERSION,
    snapshotChunkCount: chunkCount,
    snapshotByteSize: bytes.length,
    snapshotSha256: sha256,
  };
}

export async function readBookkeepingReportSnapshot(
  client: DynamoDBDocumentClient,
  reportId: string,
  stored: StoredBookkeepingReportSnapshot,
): Promise<BookkeepingReportSnapshot> {
  if (stored.snapshotStorageVersion !== BOOKKEEPING_REPORT_SNAPSHOT_VERSION
    || !Number.isSafeInteger(stored.snapshotChunkCount) || stored.snapshotChunkCount < 1
    || !Number.isSafeInteger(stored.snapshotByteSize) || stored.snapshotByteSize < 1
    || !/^[a-f0-9]{64}$/.test(stored.snapshotSha256)) {
    throw new Error("Bookkeeping report snapshot metadata is invalid");
  }
  const chunks: SnapshotChunk[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_BOOKKEEPING,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": partitionKey(stored.snapshotStorageId) },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    chunks.push(...(result.Items || []) as SnapshotChunk[]);
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (chunks.length !== stored.snapshotChunkCount
    || chunks.some((chunk, index) => chunk.recordType !== "bookkeeping-report-snapshot-chunk"
      || chunk.PK !== partitionKey(stored.snapshotStorageId)
      || chunk.storageId !== stored.snapshotStorageId
      || chunk.reportId !== reportId
      || chunk.chunkIndex !== index
      || chunk.chunkCount !== stored.snapshotChunkCount
      || chunk.byteSize !== stored.snapshotByteSize
      || chunk.sha256 !== stored.snapshotSha256
      || typeof chunk.payload !== "string")) {
    throw new Error("Bookkeeping report snapshot chunks are incomplete or inconsistent");
  }
  const parts = chunks.map((chunk) => {
    const decoded = Buffer.from(chunk.payload, "base64");
    if (decoded.toString("base64") !== chunk.payload) {
      throw new Error("Bookkeeping report snapshot chunk encoding is invalid");
    }
    return decoded;
  });
  const bytes = Buffer.concat(parts);
  if (bytes.length !== stored.snapshotByteSize
    || createHash("sha256").update(bytes).digest("hex") !== stored.snapshotSha256) {
    throw new Error("Bookkeeping report snapshot checksum does not match");
  }
  const snapshot = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Bookkeeping report snapshot payload is invalid");
  }
  return snapshot as BookkeepingReportSnapshot;
}

export async function readBookkeepingReportSnapshotForItem(
  client: DynamoDBDocumentClient,
  report: Record<string, unknown> & { id: string },
): Promise<BookkeepingReportSnapshot> {
  if (Number(report.snapshotVersion) !== 4) {
    return {
      transactionIds: Array.isArray(report.transactionIds) ? report.transactionIds : [],
      transactionRows: Array.isArray(report.transactionRows) ? report.transactionRows : [],
      documentIds: Array.isArray(report.documentIds) ? report.documentIds : [],
      reconciliation: report.reconciliation && typeof report.reconciliation === "object"
        ? report.reconciliation
        : {},
    };
  }
  return readBookkeepingReportSnapshot(client, report.id, {
    snapshotStorageId: String(report.snapshotStorageId || ""),
    snapshotStorageVersion: Number(report.snapshotStorageVersion),
    snapshotChunkCount: Number(report.snapshotChunkCount),
    snapshotByteSize: Number(report.snapshotByteSize),
    snapshotSha256: String(report.snapshotSha256 || ""),
  });
}

export async function deleteBookkeepingReportSnapshot(
  client: DynamoDBDocumentClient,
  storageId: string,
) {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_BOOKKEEPING,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": partitionKey(storageId) },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    const rows = (result.Items || []) as Array<{ PK: string; SK: string }>;
    for (const row of rows) {
      await client.send(new DeleteCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: row.PK, SK: row.SK },
      }));
    }
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
}

export async function attachBookkeepingReportSnapshot(
  client: DynamoDBDocumentClient,
  report: { id: string; updatedAt: string; snapshotVersion?: unknown },
  stored: StoredBookkeepingReportSnapshot,
) {
  const snapshotVersionCondition = report.snapshotVersion === undefined
    ? "attribute_not_exists(#snapshotVersion)"
    : "#snapshotVersion = :expectedVersion";
  const values: Record<string, unknown> = {
    ":expectedUpdatedAt": report.updatedAt,
    ":ready": "ready",
    ":generated": "generated",
    ":snapshotVersion": 4,
    ":storageVersion": stored.snapshotStorageVersion,
    ":storageId": stored.snapshotStorageId,
    ":chunkCount": stored.snapshotChunkCount,
    ":byteSize": stored.snapshotByteSize,
    ":sha256": stored.snapshotSha256,
    ":now": new Date().toISOString(),
    ...(report.snapshotVersion === undefined ? {} : { ":expectedVersion": report.snapshotVersion }),
  };
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `REPORT#${report.id}`, SK: `REPORT#${report.id}` },
      UpdateExpression: "SET #snapshotVersion = :snapshotVersion, snapshotStorageVersion = :storageVersion, snapshotStorageId = :storageId, snapshotChunkCount = :chunkCount, snapshotByteSize = :byteSize, snapshotSha256 = :sha256, updatedAt = :now REMOVE transactionIds, transactionRows, documentIds",
      ConditionExpression: `updatedAt = :expectedUpdatedAt AND (#status = :ready OR #status = :generated) AND ${snapshotVersionCondition}`,
      ExpressionAttributeNames: { "#status": "status", "#snapshotVersion": "snapshotVersion" },
      ExpressionAttributeValues: values,
    }));
    return true;
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TransactionCanceledException"
      || name === "ConditionalCheckFailedException"
      || (error as Error).message === "Conditional check failed") return false;
    throw error;
  }
}
