import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export const BOOKKEEPING_AUDIT_STORAGE_VERSION = 1;
export const MAX_BOOKKEEPING_AUDIT_ENTRIES = 100;
export const BOOKKEEPING_AUDIT_PARTITION_PREFIX = "BOOKKEEPING_AUDIT#";
export const BOOKKEEPING_AUDIT_LEGACY_SK_PREFIX = "LEGACY#V1#";
export const MAX_BOOKKEEPING_AUDIT_ITEM_BYTES = 350 * 1024;

const EVENT_SK_PREFIX = "EVENT#";
const LEGACY_RECORD_TYPE = "bookkeeping-audit-legacy-chunk";
const EVENT_RECORD_TYPE = "bookkeeping-audit-event";
const MAX_LEGACY_CHUNK_BYTES = MAX_BOOKKEEPING_AUDIT_ITEM_BYTES - 2048;

export type BookkeepingAuditEvent = Record<string, unknown>;
export type BookkeepingAuditRow = Record<string, unknown> & { PK: string; SK: string };
export type BookkeepingAuditTransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
>[number];

export class BookkeepingAuditIntegrityError extends Error {
  constructor(message = "Bookkeeping audit history is incomplete") {
    super(message);
    this.name = "BookkeepingAuditIntegrityError";
  }
}

export class BookkeepingAuditTooLargeError extends Error {
  constructor() {
    super("Bookkeeping audit payload exceeds the safe DynamoDB item size");
    this.name = "BookkeepingAuditTooLargeError";
  }
}

export type SequencedBookkeepingAuditEvent = {
  sequence: number;
  event: BookkeepingAuditEvent;
  source: "legacy" | "event";
  rowKey?: { PK: string; SK: string };
};

export type BookkeepingAuditWritePlan = {
  sequence: number;
  transactItems: BookkeepingAuditTransactItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BookkeepingAuditIntegrityError("Bookkeeping audit sequence is invalid");
  }
  return value;
}

function assertSupportedAuditStorageVersion(transaction: Record<string, unknown>) {
  if (transaction.auditStorageVersion !== undefined
    && transaction.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION) {
    throw new BookkeepingAuditIntegrityError("Bookkeeping audit storage version is unsupported");
  }
}

function auditPartition(transactionId: string) {
  return `${BOOKKEEPING_AUDIT_PARTITION_PREFIX}${transactionId}`;
}

function eventSortKey(sequence: number) {
  return `${EVENT_SK_PREFIX}${String(sequence).padStart(12, "0")}`;
}

function legacyChunkSortKey(index: number) {
  return `${BOOKKEEPING_AUDIT_LEGACY_SK_PREFIX}${String(index).padStart(8, "0")}`;
}

function assertSafeRowSize(row: BookkeepingAuditRow) {
  if (Buffer.byteLength(JSON.stringify(row), "utf8") > MAX_BOOKKEEPING_AUDIT_ITEM_BYTES) {
    throw new BookkeepingAuditTooLargeError();
  }
}

function encodeLegacyAuditChunks(
  transactionId: string,
  entries: Array<{ sequence: number; event: BookkeepingAuditEvent }>,
): BookkeepingAuditRow[] {
  if (!entries.length) return [];
  const serialized = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
  const chunkCount = Math.ceil(serialized.length / MAX_LEGACY_CHUNK_BYTES);
  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const payload = serialized.slice(
      chunkIndex * MAX_LEGACY_CHUNK_BYTES,
      (chunkIndex + 1) * MAX_LEGACY_CHUNK_BYTES,
    );
    const row: BookkeepingAuditRow = {
      PK: auditPartition(transactionId),
      SK: legacyChunkSortKey(chunkIndex),
      recordType: LEGACY_RECORD_TYPE,
      transactionId,
      chunkIndex,
      chunkCount,
      payload,
    };
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      PK: row.PK,
      SK: row.SK,
      recordType: row.recordType,
      transactionId: row.transactionId,
      chunkIndex: row.chunkIndex,
      chunkCount: row.chunkCount,
    }), "utf8") + Buffer.byteLength("payload", "utf8");
    if (Buffer.byteLength(payload, "utf8") + metadataBytes > MAX_BOOKKEEPING_AUDIT_ITEM_BYTES) {
      throw new BookkeepingAuditTooLargeError();
    }
    return row;
  });
}

function decodeLegacyAuditChunks(
  transactionId: string,
  rows: BookkeepingAuditRow[],
): Array<{ sequence: number; event: BookkeepingAuditEvent }> {
  if (!rows.length) return [];
  const first = rows[0];
  if (typeof first.chunkCount !== "number" || !Number.isSafeInteger(first.chunkCount)
    || first.chunkCount < 1 || first.chunkCount !== rows.length) {
    throw new BookkeepingAuditIntegrityError("Legacy audit chunk count is invalid");
  }
  const parts: Array<string | undefined> = Array(first.chunkCount).fill(undefined);
  for (const row of rows) {
    if (String(row.PK) !== auditPartition(transactionId) || row.transactionId !== transactionId
      || row.recordType !== LEGACY_RECORD_TYPE || row.chunkCount !== first.chunkCount
      || typeof row.chunkIndex !== "number" || !Number.isSafeInteger(row.chunkIndex)
      || row.chunkIndex < 0 || row.chunkIndex >= first.chunkCount
      || row.SK !== legacyChunkSortKey(row.chunkIndex)
      || typeof row.payload !== "string") {
      throw new BookkeepingAuditIntegrityError("Legacy audit chunk is invalid");
    }
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      PK: row.PK,
      SK: row.SK,
      recordType: row.recordType,
      transactionId: row.transactionId,
      chunkIndex: row.chunkIndex,
      chunkCount: row.chunkCount,
    }), "utf8") + Buffer.byteLength("payload", "utf8");
    if (Buffer.byteLength(row.payload, "utf8") + metadataBytes > MAX_BOOKKEEPING_AUDIT_ITEM_BYTES || parts[row.chunkIndex]) {
      throw new BookkeepingAuditIntegrityError("Legacy audit chunk size or index is invalid");
    }
    parts[row.chunkIndex] = row.payload;
  }
  if (parts.some((part) => !part)) throw new BookkeepingAuditIntegrityError("Legacy audit chunk is missing");

  let entries: unknown;
  try {
    const encoded = (parts as string[]).join("");
    if (encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("invalid base64");
    }
    entries = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new BookkeepingAuditIntegrityError("Legacy audit chunk payload is invalid");
  }
  if (!Array.isArray(entries)) throw new BookkeepingAuditIntegrityError("Legacy audit chunk payload is invalid");
  return entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.sequence !== "number" || !Number.isSafeInteger(entry.sequence)
      || entry.sequence < 1 || !isRecord(entry.event)) {
      throw new BookkeepingAuditIntegrityError("Legacy audit batch entry is invalid");
    }
    return { sequence: entry.sequence, event: entry.event };
  });
}

export function sequenceBookkeepingAuditHistory(
  transaction: Record<string, unknown>,
): SequencedBookkeepingAuditEvent[] {
  assertSupportedAuditStorageVersion(transaction);
  if (transaction.auditStorageVersion === BOOKKEEPING_AUDIT_STORAGE_VERSION) {
    throw new BookkeepingAuditIntegrityError("Migrated audit history must be read from its sidecar rows");
  }
  if (transaction.audit !== undefined && !Array.isArray(transaction.audit)) {
    throw new BookkeepingAuditIntegrityError("Inline bookkeeping audit history is invalid");
  }
  const inline = Array.isArray(transaction.audit) ? transaction.audit : [];
  return inline.map((event, index) => {
    if (!isRecord(event)) throw new BookkeepingAuditIntegrityError("Inline bookkeeping audit entry is invalid");
    return { sequence: index + 1, event, source: "legacy" };
  });
}

export function sequenceBookkeepingAuditRows(
  transaction: Record<string, unknown>,
  rows: BookkeepingAuditRow[],
): SequencedBookkeepingAuditEvent[] {
  assertSupportedAuditStorageVersion(transaction);
  if (transaction.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION) {
    if (rows.length) throw new BookkeepingAuditIntegrityError("Unversioned bookkeeping row has audit sidecar data");
    return sequenceBookkeepingAuditHistory(transaction);
  }

  if (transaction.audit !== undefined) {
    throw new BookkeepingAuditIntegrityError("Migrated bookkeeping transaction still contains inline audit data");
  }
  const latestSequence = requireSequence(transaction.auditSequence);
  if (latestSequence < 1) throw new BookkeepingAuditIntegrityError("Bookkeeping audit sequence is empty");
  const events: SequencedBookkeepingAuditEvent[] = [];
  const legacyRows = rows.filter((row) => row.recordType === LEGACY_RECORD_TYPE);
  for (const entry of decodeLegacyAuditChunks(String(transaction.id), legacyRows)) {
    events.push({ sequence: entry.sequence, event: entry.event, source: "legacy" });
  }
  for (const row of rows) {
    if (String(row.PK) !== auditPartition(String(transaction.id))) {
      throw new BookkeepingAuditIntegrityError("Bookkeeping audit row belongs to another transaction");
    }
    if (row.recordType === LEGACY_RECORD_TYPE) continue;
    if (row.recordType === EVENT_RECORD_TYPE && typeof row.SK === "string" && row.SK.startsWith(EVENT_SK_PREFIX)) {
      if (typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence)
        || row.sequence < 1 || row.SK !== eventSortKey(row.sequence)
        || row.transactionId !== transaction.id || !isRecord(row.event)) {
        throw new BookkeepingAuditIntegrityError("Bookkeeping audit event row is invalid");
      }
      events.push({
        sequence: row.sequence,
        event: row.event,
        source: "event",
        rowKey: { PK: String(row.PK), SK: String(row.SK) },
      });
      continue;
    }
    throw new BookkeepingAuditIntegrityError("Unknown bookkeeping audit sidecar row");
  }

  events.sort((left, right) => left.sequence - right.sequence);
  const expectedCount = Math.min(latestSequence, MAX_BOOKKEEPING_AUDIT_ENTRIES);
  const firstExpectedSequence = Math.max(1, latestSequence - MAX_BOOKKEEPING_AUDIT_ENTRIES + 1);
  if (events.length !== expectedCount) throw new BookkeepingAuditIntegrityError();
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== firstExpectedSequence + index) {
      throw new BookkeepingAuditIntegrityError();
    }
  }
  if (events.at(-1)?.source !== "event") {
    throw new BookkeepingAuditIntegrityError("Latest bookkeeping audit event row is missing");
  }
  return events;
}

export function planBookkeepingAuditWrite(input: {
  transactionId: string;
  transaction: Record<string, unknown>;
  sidecarRows: BookkeepingAuditRow[];
  event: BookkeepingAuditEvent;
  tableName: string;
}): BookkeepingAuditWritePlan {
  const { transactionId, transaction, sidecarRows, event, tableName } = input;
  assertSupportedAuditStorageVersion(transaction);
  if (!isRecord(event)) throw new BookkeepingAuditIntegrityError("New bookkeeping audit event is invalid");
  const partition = auditPartition(transactionId);
  const nextSequence = (() => {
    if (transaction.auditStorageVersion === BOOKKEEPING_AUDIT_STORAGE_VERSION) {
      const latest = requireSequence(transaction.auditSequence);
      if (latest === Number.MAX_SAFE_INTEGER) {
        throw new BookkeepingAuditIntegrityError("Bookkeeping audit sequence is exhausted");
      }
      return latest + 1;
    }
    return sequenceBookkeepingAuditHistory(transaction).length + 1;
  })();
  const eventRow: BookkeepingAuditRow = {
    PK: partition,
    SK: eventSortKey(nextSequence),
    recordType: EVENT_RECORD_TYPE,
    transactionId,
    sequence: nextSequence,
    event,
    createdAt: typeof event.at === "string" ? event.at : new Date().toISOString(),
  };
  assertSafeRowSize(eventRow);

  const transactItems: BookkeepingAuditTransactItem[] = [];
  if (transaction.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION) {
    if (sidecarRows.length) {
      throw new BookkeepingAuditIntegrityError("Legacy transaction already has audit sidecar rows");
    }
    const legacy = sequenceBookkeepingAuditHistory(transaction);
    const retained = [...legacy, {
      sequence: nextSequence,
      event,
      source: "event" as const,
      rowKey: { PK: eventRow.PK, SK: eventRow.SK },
    }].slice(-MAX_BOOKKEEPING_AUDIT_ENTRIES);
    const retainedLegacy = retained
      .filter((entry) => entry.source === "legacy")
      .map(({ sequence, event: legacyEvent }) => ({ sequence, event: legacyEvent }));
    for (const legacyRow of encodeLegacyAuditChunks(transactionId, retainedLegacy)) {
      transactItems.push({ Put: {
        TableName: tableName,
        Item: legacyRow,
        ConditionExpression: "attribute_not_exists(PK)",
      } });
    }
  } else {
    const existing = sequenceBookkeepingAuditRows(transaction, sidecarRows);
    if (existing.length >= MAX_BOOKKEEPING_AUDIT_ENTRIES) {
      const oldest = existing[0];
      if (oldest.source === "event") {
        if (!oldest.rowKey) throw new BookkeepingAuditIntegrityError("Oldest bookkeeping audit row has no key");
        transactItems.push({ Delete: {
          TableName: tableName,
          Key: oldest.rowKey,
          ConditionExpression: "#sequence = :sequence",
          ExpressionAttributeNames: { "#sequence": "sequence" },
          ExpressionAttributeValues: { ":sequence": oldest.sequence },
        } });
      } else {
        const remaining = existing
          .filter((entry) => entry.source === "legacy" && entry.sequence !== oldest.sequence)
          .map(({ sequence, event: legacyEvent }) => ({ sequence, event: legacyEvent }));
        if (remaining.length === existing.filter((entry) => entry.source === "legacy").length) {
          throw new BookkeepingAuditIntegrityError("Oldest legacy audit event is missing from its chunks");
        }
        const previousLegacyRows = sidecarRows.filter((row) => row.recordType === LEGACY_RECORD_TYPE);
        const nextLegacyRows = encodeLegacyAuditChunks(transactionId, remaining);
        const nextByKey = new Map(nextLegacyRows.map((row) => [row.SK, row]));
        const previousByKey = new Map(previousLegacyRows.map((row) => [String(row.SK), row]));
        for (const [sk, nextRow] of nextByKey) {
          const previousRow = previousByKey.get(sk);
          if (!previousRow) {
            transactItems.push({ Put: {
              TableName: tableName,
              Item: nextRow,
              ConditionExpression: "attribute_not_exists(PK)",
            } });
          } else {
            transactItems.push({ Update: {
              TableName: tableName,
              Key: { PK: String(previousRow.PK), SK: sk },
              UpdateExpression: "SET #payload = :payload, #chunkCount = :chunkCount",
              ConditionExpression: "#chunkIndex = :chunkIndex AND #chunkCount = :expectedChunkCount",
              ExpressionAttributeNames: {
                "#payload": "payload",
                "#chunkIndex": "chunkIndex",
                "#chunkCount": "chunkCount",
              },
              ExpressionAttributeValues: {
                ":payload": nextRow.payload,
                ":chunkCount": nextRow.chunkCount,
                ":chunkIndex": nextRow.chunkIndex,
                ":expectedChunkCount": previousRow.chunkCount,
              },
            } });
          }
        }
        for (const [sk, previousRow] of previousByKey) {
          if (nextByKey.has(sk)) continue;
          transactItems.push({ Delete: {
            TableName: tableName,
            Key: { PK: String(previousRow.PK), SK: sk },
            ConditionExpression: "#chunkIndex = :chunkIndex AND #chunkCount = :chunkCount",
            ExpressionAttributeNames: { "#chunkIndex": "chunkIndex", "#chunkCount": "chunkCount" },
            ExpressionAttributeValues: {
              ":chunkIndex": previousRow.chunkIndex,
              ":chunkCount": previousRow.chunkCount,
            },
          } });
        }
      }
    }
  }

  transactItems.push({ Put: {
    TableName: tableName,
    Item: eventRow,
    ConditionExpression: "attribute_not_exists(PK)",
  } });
  return { sequence: nextSequence, transactItems };
}

export function bookkeepingAuditEvents(
  transaction: Record<string, unknown>,
  rows: BookkeepingAuditRow[],
): SequencedBookkeepingAuditEvent[] {
  return sequenceBookkeepingAuditRows(transaction, rows);
}

export function bookkeepingAuditPartitionKey(transactionId: string) {
  return auditPartition(transactionId);
}
