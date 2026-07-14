import { createHash, randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_BOOKKEEPING } from "./setup";

export type BookkeepingItem = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const key = (kind: string, id: string) => `${kind.toUpperCase()}#${id}`;
const documentKey = (id: string) => key("document", id);
const hashKey = (sha256: string) => `DOCUMENT_HASH#${sha256}`;
const HASH_CLAIMS_READY = "DOCUMENT_HASH_MIGRATION#READY";
const clean = (item?: Record<string, unknown>): BookkeepingItem | null => {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...value } = item;
  return value as BookkeepingItem;
};
const raw = (item?: Record<string, unknown>) => item || null;
let testTransactionLock = Promise.resolve();

async function transact(
  client: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof TransactWriteCommand>[0],
) {
  try {
    await client.send(new TransactWriteCommand(input));
  } catch (error) {
    if (process.env.NODE_ENV !== "test" || (error as Error).name !== "UnknownOperationException")
      throw error;
    // Dynalite does not implement TransactWriteItems. This compatibility path
    // exists only for the repository's local test emulator; deployed code
    // always executes the single atomic command above.
    const previous = testTransactionLock;
    let release!: () => void;
    testTransactionLock = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      for (const action of input.TransactItems || []) {
        if (action.Put?.ConditionExpression?.includes("attribute_not_exists")) {
          const existing = await client.send(
            new GetCommand({ TableName: action.Put.TableName, Key: { PK: action.Put.Item!.PK, SK: action.Put.Item!.SK }, ConsistentRead: true }),
          );
          if (existing.Item) throw new Error("Conditional check failed");
        }
      }
      for (const action of input.TransactItems || []) {
        if (action.ConditionCheck) {
          const result = await client.send(
            new GetCommand({
              TableName: action.ConditionCheck.TableName,
              Key: action.ConditionCheck.Key,
              ConsistentRead: true,
            }),
          );
          if (!result.Item) throw new Error("Conditional check failed");
        } else if (action.Put) await client.send(new PutCommand(action.Put));
        else if (action.Update) await client.send(new UpdateCommand(action.Update));
        else if (action.Delete) await client.send(new DeleteCommand(action.Delete));
      }
    } catch (emulatedError) {
      if (
        (emulatedError as Error).name === "ConditionalCheckFailedException" ||
        (emulatedError as Error).message === "Conditional check failed"
      ) {
        const conditional = new Error("Conditional check failed");
        conditional.name = "TransactionCanceledException";
        throw conditional;
      }
      throw emulatedError;
    } finally {
      release();
    }
  }
}

export async function putBookkeepingItem(
  client: DynamoDBDocumentClient,
  kind: string,
  value: Record<string, unknown>,
  unique?: string,
): Promise<{ item: BookkeepingItem; duplicate: boolean }> {
  const id = String(
    value.id ||
      (unique ? createHash("sha256").update(unique).digest("hex") : randomUUID()),
  );
  const now = new Date().toISOString();
  const item = {
    PK: key(kind, id),
    SK: key(kind, id),
    ...value,
    id,
    createdAt: value.createdAt || now,
    updatedAt: now,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_BOOKKEEPING,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return { item: clean(item)!, duplicate: false };
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
    if (!unique) throw error;
    const existing = await client.send(
      new GetCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: key(kind, id), SK: key(kind, id) },
      }),
    );
    return { item: clean(existing.Item as Record<string, unknown>)!, duplicate: true };
  }
}

export async function getBookkeepingItem(
  client: DynamoDBDocumentClient,
  kind: string,
  id: string,
) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key(kind, id), SK: key(kind, id) },
    }),
  );
  return clean(result.Item as Record<string, unknown>);
}

export async function getRawDocument(client: DynamoDBDocumentClient, id: string) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: documentKey(id), SK: documentKey(id) },
      ConsistentRead: true,
    }),
  );
  return raw(result.Item as Record<string, unknown>);
}

export async function listBookkeepingItems(
  client: DynamoDBDocumentClient,
  kind: string,
): Promise<BookkeepingItem[]> {
  const items: BookkeepingItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_BOOKKEEPING,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": `${kind.toUpperCase()}#` },
        ExclusiveStartKey,
      }),
    );
    items.push(
      ...(result.Items || []).map((item) => clean(item as Record<string, unknown>)!),
    );
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.sort((a, b) =>
    String(b.transactionDate || b.createdAt).localeCompare(
      String(a.transactionDate || a.createdAt),
    ),
  );
}

export async function deleteBookkeepingItem(
  client: DynamoDBDocumentClient,
  kind: string,
  id: string,
) {
  const existing = await getBookkeepingItem(client, kind, id);
  if (existing)
    await client.send(
      new DeleteCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: key(kind, id), SK: key(kind, id) },
      }),
    );
  return existing;
}

export type PrepareDocumentInput = {
  sha256: string;
  byteSize: number;
  documentType: string;
  accountId?: string;
  statementMonth?: string;
  idempotencyKey: string;
  runId: string;
  sourceRef: string;
  s3Key: string;
  expiresAt: string;
  uploadAuthorizationExpiresAt: string;
};

export async function lookupDocumentHash(
  client: DynamoDBDocumentClient,
  sha256: string,
) {
  const claim = await client.send(
    new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: hashKey(sha256), SK: hashKey(sha256) },
      ConsistentRead: true,
    }),
  );
  if (!claim.Item) return { state: "absent" as const };
  const document = await getRawDocument(client, String(claim.Item.documentId));
  if (!document) return { state: "cleanup-required" as const, document: null };
  if (claim.Item.state !== document.status)
    return { state: "cleanup-required" as const, document };
  return {
    state: String(document.status) as "pending" | "active" | "cleanup-required",
    document,
  };
}

export async function prepareDocument(
  client: DynamoDBDocumentClient,
  input: PrepareDocumentInput,
) {
  const existing = await lookupDocumentHash(client, input.sha256);
  if (existing.state !== "absent") {
    const owned =
      existing.document?.creatorIdempotencyKey === input.idempotencyKey &&
      existing.document?.createdByRunId === input.runId;
    return {
      outcome:
        existing.state === "active"
          ? "existing"
          : existing.state === "pending" && owned
            ? "retry"
            : existing.state === "pending"
              ? "pending"
              : "cleanup-required",
      document: existing.document,
    };
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const document = {
    PK: documentKey(id),
    SK: documentKey(id),
    id,
    status: "pending",
    contentType: "application/pdf",
    declaredSha256: input.sha256,
    declaredByteSize: input.byteSize,
    byteSize: input.byteSize,
    documentType: input.documentType,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.statementMonth ? { statementMonth: input.statementMonth } : {}),
    s3Key: input.s3Key.replace("{id}", id),
    prepareExpiresAt: input.expiresAt,
    uploadAuthorizationExpiresAt: input.uploadAuthorizationExpiresAt,
    creatorIdempotencyKey: input.idempotencyKey,
    createdByRunId: input.runId,
    sourceRef: input.sourceRef,
    linkRefCount: 0,
    reportRefCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const claim = {
    PK: hashKey(input.sha256),
    SK: hashKey(input.sha256),
    documentId: id,
    state: "pending",
    creatorIdempotencyKey: input.idempotencyKey,
    createdByRunId: input.runId,
    expiresAt: input.expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await transact(
      client,
      {
        TransactItems: [
          { Put: { TableName: TABLE_BOOKKEEPING, Item: document, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: TABLE_BOOKKEEPING, Item: claim, ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      },
    );
    return { outcome: "created", document };
  } catch (error) {
    if ((error as Error).name !== "TransactionCanceledException") throw error;
    const winner = await lookupDocumentHash(client, input.sha256);
    if (winner.state === "absent") throw error;
    const owned =
      winner.document?.creatorIdempotencyKey === input.idempotencyKey &&
      winner.document?.createdByRunId === input.runId;
    return {
      outcome:
        winner.state === "active"
          ? "existing"
          : winner.state === "pending" && owned
            ? "retry"
            : winner.state === "pending"
              ? "pending"
              : "cleanup-required",
      document: winner.document,
    };
  }
}

export async function activateDocument(
  client: DynamoDBDocumentClient,
  id: string,
  sha256: string,
  idempotencyKey: string,
  runId: string,
  versionId: string,
  verifiedByteSize: number,
) {
  const now = new Date().toISOString();
  await transact(
    client,
    {
      TransactItems: [
        {
          Update: {
            TableName: TABLE_BOOKKEEPING,
            Key: { PK: documentKey(id), SK: documentKey(id) },
            UpdateExpression: "SET #status = :active, sha256 = :hash, verifiedByteSize = :size, objectVersionId = :version, updatedAt = :now REMOVE prepareExpiresAt",
            ConditionExpression: "#status = :pending AND declaredSha256 = :hash AND creatorIdempotencyKey = :owner AND createdByRunId = :run",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "active", ":pending": "pending", ":hash": sha256, ":size": verifiedByteSize, ":version": versionId, ":owner": idempotencyKey, ":run": runId, ":now": now },
          },
        },
        {
          Update: {
            TableName: TABLE_BOOKKEEPING,
            Key: { PK: hashKey(sha256), SK: hashKey(sha256) },
            UpdateExpression: "SET #state = :active, updatedAt = :now",
            ConditionExpression: "#state = :pending AND documentId = :id AND creatorIdempotencyKey = :owner AND createdByRunId = :run",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":active": "active", ":pending": "pending", ":id": id, ":owner": idempotencyKey, ":run": runId, ":now": now },
          },
        },
      ],
    },
  );
}

export async function renewDocumentPrepareLease(
  client: DynamoDBDocumentClient,
  id: string,
  sha256: string,
  idempotencyKey: string,
  runId: string,
  expiresAt: string,
  uploadAuthorizationExpiresAt: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(id), SK: documentKey(id) }, UpdateExpression: "SET prepareExpiresAt = :expiry, uploadAuthorizationExpiresAt = :uploadExpiry, updatedAt = :now", ConditionExpression: "#status = :pending AND creatorIdempotencyKey = :owner AND createdByRunId = :run", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":expiry": expiresAt, ":uploadExpiry": uploadAuthorizationExpiresAt, ":now": new Date().toISOString(), ":pending": "pending", ":owner": idempotencyKey, ":run": runId } } },
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: hashKey(sha256), SK: hashKey(sha256) }, UpdateExpression: "SET expiresAt = :expiry, updatedAt = :now", ConditionExpression: "#state = :pending AND documentId = :id AND creatorIdempotencyKey = :owner AND createdByRunId = :run", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":expiry": expiresAt, ":now": new Date().toISOString(), ":pending": "pending", ":id": id, ":owner": idempotencyKey, ":run": runId } } },
      ],
    },
  );
}

export async function markDocumentCleanupRequired(
  client: DynamoDBDocumentClient,
  id: string,
  idempotencyKey: string,
  runId: string,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: documentKey(id), SK: documentKey(id) },
      UpdateExpression: "SET #status = :cleanup, updatedAt = :now",
      ConditionExpression: "creatorIdempotencyKey = :owner AND createdByRunId = :run AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":cleanup": "cleanup-required", ":pending": "pending", ":owner": idempotencyKey, ":run": runId, ":now": new Date().toISOString() },
    }),
  );
}

export async function removePendingDocumentClaim(
  client: DynamoDBDocumentClient,
  id: string,
  sha256: string,
  idempotencyKey: string,
  runId: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(id), SK: documentKey(id) }, ConditionExpression: "creatorIdempotencyKey = :owner AND createdByRunId = :run AND #status <> :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":owner": idempotencyKey, ":run": runId, ":active": "active" } } },
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: hashKey(sha256), SK: hashKey(sha256) }, ConditionExpression: "documentId = :id AND creatorIdempotencyKey = :owner AND createdByRunId = :run AND #state <> :active", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":id": id, ":owner": idempotencyKey, ":run": runId, ":active": "active" } } },
      ],
    },
  );
}

export async function createDocumentLink(
  client: DynamoDBDocumentClient,
  input: { documentId: string; transactionId: string; coverageType: string; runId?: string; sourceRef?: string },
) {
  const id = createHash("sha256")
    .update(`link#${input.documentId}#${input.transactionId}#${input.coverageType}`)
    .digest("hex");
  const now = new Date().toISOString();
  const item = {
    PK: key("link", id),
    SK: key("link", id),
    id,
    documentId: input.documentId,
    transactionId: input.transactionId,
    coverageType: input.coverageType,
    ...(input.runId ? { createdByRunId: input.runId } : {}),
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await transact(
      client,
      {
        TransactItems: [
          { Put: { TableName: TABLE_BOOKKEEPING, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
          { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: { PK: key("bookkeeping", input.transactionId), SK: key("bookkeeping", input.transactionId) }, ConditionExpression: "attribute_exists(PK)" } },
          { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(input.documentId), SK: documentKey(input.documentId) }, UpdateExpression: "SET updatedAt = :now ADD linkRefCount :one", ConditionExpression: "#status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":one": 1, ":active": "active", ":now": now } } },
        ],
      },
    );
    return { outcome: "created", item: clean(item)! };
  } catch (error) {
    if ((error as Error).name !== "TransactionCanceledException") throw error;
    const existing = await getBookkeepingItem(client, "link", id);
    if (existing) return { outcome: "existing", item: existing };
    throw error;
  }
}

export async function deleteRunOwnedLink(
  client: DynamoDBDocumentClient,
  link: BookkeepingItem,
  runId: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: key("link", link.id), SK: key("link", link.id) }, ConditionExpression: "createdByRunId = :run", ExpressionAttributeValues: { ":run": runId } } },
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(String(link.documentId)), SK: documentKey(String(link.documentId)) }, UpdateExpression: "SET updatedAt = :now ADD linkRefCount :minus", ConditionExpression: "linkRefCount > :zero", ExpressionAttributeValues: { ":minus": -1, ":zero": 0, ":now": new Date().toISOString() } } },
      ],
    },
  );
}

export async function deleteDocumentLink(
  client: DynamoDBDocumentClient,
  link: BookkeepingItem,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: key("link", link.id), SK: key("link", link.id) }, ConditionExpression: "attribute_exists(PK)" } },
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(String(link.documentId)), SK: documentKey(String(link.documentId)) }, UpdateExpression: "SET updatedAt = :now ADD linkRefCount :minus", ConditionExpression: "linkRefCount > :zero", ExpressionAttributeValues: { ":minus": -1, ":zero": 0, ":now": new Date().toISOString() } } },
      ],
    },
  );
}

export async function markDocumentRollbackDeleting(
  client: DynamoDBDocumentClient,
  id: string,
  runId: string,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: documentKey(id), SK: documentKey(id) },
      UpdateExpression: "SET #status = :deleting, updatedAt = :now",
      ConditionExpression: "createdByRunId = :run AND (#status = :active OR #status = :deleting) AND uploadAuthorizationExpiresAt < :now AND (attribute_not_exists(linkRefCount) OR linkRefCount = :zero) AND (attribute_not_exists(reportRefCount) OR reportRefCount = :zero)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":run": runId, ":active": "active", ":deleting": "rollback-deleting", ":zero": 0, ":now": new Date().toISOString() },
    }),
  );
}

export async function removeRollbackDocument(
  client: DynamoDBDocumentClient,
  id: string,
  sha256: string,
  runId: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(id), SK: documentKey(id) }, ConditionExpression: "createdByRunId = :run AND #status = :deleting", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":run": runId, ":deleting": "rollback-deleting" } } },
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: hashKey(sha256), SK: hashKey(sha256) }, ConditionExpression: "documentId = :id AND createdByRunId = :run", ExpressionAttributeValues: { ":id": id, ":run": runId } } },
      ],
    },
  );
}

export async function listRunOwnedItems(
  client: DynamoDBDocumentClient,
  kind: "document" | "link",
  runId: string,
) {
  const all = await listBookkeepingItems(client, kind);
  return all.filter((item) => item.createdByRunId === runId);
}

export async function listRunOwnedPage(
  client: DynamoDBDocumentClient,
  kind: "document" | "link",
  runId: string,
  nextToken?: string,
  limit = 100,
) {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  if (nextToken) {
    if (nextToken.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(nextToken))
      throw new Error("invalid-page-token");
    try {
      ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64url").toString("utf8"));
      if (
        !ExclusiveStartKey ||
        typeof ExclusiveStartKey.PK !== "string" ||
        typeof ExclusiveStartKey.SK !== "string" ||
        Object.keys(ExclusiveStartKey).some((name) => !["PK", "SK"].includes(name))
      )
        throw new Error("invalid-page-token");
    } catch {
      throw new Error("invalid-page-token");
    }
  }
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_BOOKKEEPING,
      FilterExpression: "begins_with(PK, :prefix) AND createdByRunId = :run",
      ExpressionAttributeValues: { ":prefix": `${kind.toUpperCase()}#`, ":run": runId },
      ExclusiveStartKey,
      Limit: Math.max(1, Math.min(limit, 100)),
    }),
  );
  return {
    items: (result.Items || []).map((item) => clean(item as Record<string, unknown>)!),
    nextToken: result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url")
      : undefined,
  };
}

export async function documentHashClaimsReady(client: DynamoDBDocumentClient) {
  const result = await client.send(
    new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: HASH_CLAIMS_READY, SK: HASH_CLAIMS_READY }, ConsistentRead: true }),
  );
  return result.Item?.state === "ready";
}

export async function backfillDocumentHashClaims(
  client: DynamoDBDocumentClient,
  write: boolean,
) {
  const activePdfDocs = (await listBookkeepingItems(client, "document")).filter(
    (doc) =>
      doc.status === "active" &&
      doc.contentType === "application/pdf" &&
      doc.documentType !== "monthly-report",
  );
  const unclaimable = activePdfDocs.filter(
    (doc) => typeof doc.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(doc.sha256),
  );
  const docs = activePdfDocs.filter(
    (doc) => typeof doc.sha256 === "string" && /^[a-f0-9]{64}$/.test(doc.sha256),
  );
  let existing = 0;
  let created = 0;
  const conflicts: string[] = [];
  const seen = new Map<string, string>();
  for (const doc of docs) {
    const prior = seen.get(String(doc.sha256));
    if (prior && prior !== doc.id) {
      conflicts.push("hash-claim-conflict");
      continue;
    }
    seen.set(String(doc.sha256), doc.id);
    const lookup = await lookupDocumentHash(client, String(doc.sha256));
    if (lookup.state !== "absent") {
      if (lookup.document?.id === doc.id) existing += 1;
      else conflicts.push("hash-claim-conflict");
      continue;
    }
    if (!write) {
      created += 1;
      continue;
    }
    try {
      await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { PK: hashKey(String(doc.sha256)), SK: hashKey(String(doc.sha256)), documentId: doc.id, state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(PK)" }));
      created += 1;
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
      const winner = await lookupDocumentHash(client, String(doc.sha256));
      if (winner.document?.id === doc.id) existing += 1;
      else conflicts.push("hash-claim-conflict");
    }
  }
  if (write && conflicts.length === 0 && unclaimable.length === 0)
    await client.send(
      new PutCommand({
        TableName: TABLE_BOOKKEEPING,
        Item: { PK: HASH_CLAIMS_READY, SK: HASH_CLAIMS_READY, state: "ready", verifiedAt: new Date().toISOString(), documentCount: docs.length },
      }),
    );
  return { scanned: activePdfDocs.length, existing, created, conflicts: conflicts.length, unclaimable: unclaimable.length };
}

export async function addDocumentReportReference(
  client: DynamoDBDocumentClient,
  documentId: string,
  reportId: string,
) {
  const guard = `DOCUMENT_REPORT_REF#${documentId}#${reportId}`;
  try {
    await transact(
      client,
      {
        TransactItems: [
          { Put: { TableName: TABLE_BOOKKEEPING, Item: { PK: guard, SK: guard, documentId, reportId, createdAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(documentId), SK: documentKey(documentId) }, UpdateExpression: "SET updatedAt = :now ADD reportRefCount :one", ConditionExpression: "#status = :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":one": 1, ":active": "active", ":now": new Date().toISOString() } } },
        ],
      },
    );
    return true;
  } catch (error) {
    if ((error as Error).name !== "TransactionCanceledException") throw error;
    const existing = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: guard, SK: guard }, ConsistentRead: true }));
    if (!existing.Item) throw error;
    return false;
  }
}

export async function removeDocumentReportReference(
  client: DynamoDBDocumentClient,
  documentId: string,
  reportId: string,
) {
  const guard = `DOCUMENT_REPORT_REF#${documentId}#${reportId}`;
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: guard, SK: guard }, ConditionExpression: "attribute_exists(PK)" } },
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(documentId), SK: documentKey(documentId) }, UpdateExpression: "SET updatedAt = :now ADD reportRefCount :minus", ConditionExpression: "reportRefCount > :zero", ExpressionAttributeValues: { ":minus": -1, ":zero": 0, ":now": new Date().toISOString() } } },
      ],
    },
  );
}

export async function markReportDeleting(
  client: DynamoDBDocumentClient,
  reportId: string,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key("report", reportId), SK: key("report", reportId) },
      UpdateExpression: "SET #status = :deleting, updatedAt = :now",
      ConditionExpression: "#status = :ready OR #status = :generated OR #status = :deleting",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":ready": "ready", ":generated": "generated", ":deleting": "deleting", ":now": new Date().toISOString() },
    }),
  );
}

export async function deleteDeletingReport(
  client: DynamoDBDocumentClient,
  reportId: string,
) {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key("report", reportId), SK: key("report", reportId) },
      ConditionExpression: "#status = :deleting",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":deleting": "deleting" },
    }),
  );
}

export async function markReportGenerated(
  client: DynamoDBDocumentClient,
  reportId: string,
  archiveDocumentId: string,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key("report", reportId), SK: key("report", reportId) },
      UpdateExpression: "SET #status = :generated, archiveDocumentId = :archive, updatedAt = :now",
      ConditionExpression: "#status = :ready AND attribute_not_exists(archiveDocumentId)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":ready": "ready", ":generated": "generated", ":archive": archiveDocumentId, ":now": new Date().toISOString() },
    }),
  );
}

export async function markGenerationCleanupRequired(
  client: DynamoDBDocumentClient,
  generationId: string,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key("generation", generationId), SK: key("generation", generationId) },
      UpdateExpression: "SET #status = :cleanup, updatedAt = :now",
      ConditionExpression: "#status = :generating",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":generating": "generating", ":cleanup": "cleanup-required", ":now": new Date().toISOString() },
    }),
  );
}
