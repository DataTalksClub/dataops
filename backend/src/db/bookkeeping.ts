import { createHash, randomUUID } from "crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cleanItem } from "./cleanItem";
import { TABLE_BOOKKEEPING } from "./tableNames";
import { classifyMandatoryPayment } from "../finance/mandatoryPayments";
import { isOwnerWithdrawalReportExempt } from "../finance/ownerPay";
import {
  BOOKKEEPING_AUDIT_PARTITION_PREFIX,
  BOOKKEEPING_AUDIT_STORAGE_VERSION,
  BookkeepingAuditIntegrityError,
  bookkeepingAuditEvents,
  bookkeepingAuditPartitionKey,
  planBookkeepingAuditWrite,
  type BookkeepingAuditEvent,
  type BookkeepingAuditRow,
} from "../bookkeepingAudit";

export type BookkeepingItem = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

// Payment categories tracked in the ledger but kept out of the accountant's
// monthly package: they are settled from private money and reported separately.
export const REPORT_EXEMPT_CATEGORIES = new Set(["Taxes", "Health Insurance"]);
export function isReportExemptTransaction(item: Readonly<Record<string, unknown>>) {
  return REPORT_EXEMPT_CATEGORIES.has(String(item.category || ""))
    || classifyMandatoryPayment(item) !== null
    || isOwnerWithdrawalReportExempt(item);
}

// Raised when a conditional mutation loses its optimistic-concurrency race or
// the item is claimed by sponsor finance, as opposed to an unexpected failure.
export class BookkeepingItemLockedError extends Error {
  constructor() {
    super("Bookkeeping item is claimed or changed");
    this.name = "BookkeepingItemLockedError";
  }
}

export class BookkeepingTransactionLimitError extends Error {
  constructor(message = "Bookkeeping update exceeds DynamoDB transaction limits") {
    super(message);
    this.name = "BookkeepingTransactionLimitError";
  }
}
const isConditionalMutationFailure = (error: unknown) =>
  ((error as Error).name === "TransactionCanceledException" ||
    (error as Error).name === "ConditionalCheckFailedException" ||
    (error as Error).message === "Conditional check failed");

const key = (kind: string, id: string) => `${kind.toUpperCase()}#${id}`;
const documentKey = (id: string) => key("document", id);
const hashKey = (sha256: string) => `DOCUMENT_HASH#${sha256}`;
const clean = cleanItem<BookkeepingItem>;
const raw = (item?: Record<string, unknown>) => item || null;
let testTransactionLock = Promise.resolve();

export type BookkeepingTransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]
>[number];

export function bookkeepingItemId(unique?: string) {
  return unique ? createHash("sha256").update(unique).digest("hex") : randomUUID();
}

function testConditionMatches(
  expression: string | undefined,
  item: Record<string, unknown> | undefined,
  names: Record<string, string> = {},
  values: Record<string, unknown> = {},
) {
  if (!expression) return true;
  const tokens = expression.match(/attribute_not_exists|attribute_exists|AND\b|OR\b|<>|<=|>=|=|<|>|\(|\)|[^\s()]+/gi) || [];
  let cursor = 0;
  const attribute = (token: string) => names[token] || token;
  const value = (token: string) => token.startsWith(":") ? values[token] : item?.[attribute(token)];
  const parseOr = (): boolean => {
    let result = parseAnd();
    while (tokens[cursor]?.toUpperCase() === "OR") {
      cursor += 1;
      const right = parseAnd();
      result = result || right;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parsePrimary();
    while (tokens[cursor]?.toUpperCase() === "AND") {
      cursor += 1;
      const right = parsePrimary();
      result = result && right;
    }
    return result;
  };
  const parsePrimary = (): boolean => {
    const token = tokens[cursor++];
    if (token === "(") {
      const result = parseOr();
      if (tokens[cursor++] !== ")") throw new Error(`Unsupported test condition: ${expression}`);
      return result;
    }
    if (token === "attribute_exists" || token === "attribute_not_exists") {
      if (tokens[cursor++] !== "(") throw new Error(`Unsupported test condition: ${expression}`);
      const path = attribute(tokens[cursor++]);
      if (tokens[cursor++] !== ")") throw new Error(`Unsupported test condition: ${expression}`);
      const exists = item?.[path] !== undefined;
      return token === "attribute_exists" ? exists : !exists;
    }
    const operator = tokens[cursor++];
    const rightToken = tokens[cursor++];
    if (!["=", "<>", "<", ">", "<=", ">="].includes(operator || "") || !rightToken)
      throw new Error(`Unsupported test condition: ${expression}`);
    const leftValue = item?.[attribute(token)];
    const rightValue = value(rightToken);
    if (operator === "=") return leftValue !== undefined && leftValue === rightValue;
    if (operator === "<>") return leftValue !== undefined && leftValue !== rightValue;
    if (leftValue === undefined || rightValue === undefined) return false;
    if (operator === "<") return Number(leftValue) < Number(rightValue);
    if (operator === ">") return Number(leftValue) > Number(rightValue);
    if (operator === "<=") return Number(leftValue) <= Number(rightValue);
    return Number(leftValue) >= Number(rightValue);
  };
  const matched = parseOr();
  if (cursor !== tokens.length) throw new Error(`Unsupported test condition: ${expression}`);
  return matched;
}

async function transact(
  client: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof TransactWriteCommand>[0],
  reportCounterOnly = false,
  preflightAtomicTestFallback = false,
) {
  const guarded = [...(input.TransactItems || [])];
  const protectedSources = new Set<string>();
  for (const action of input.TransactItems || []) {
    const mutation = action.Update || action.Delete;
    const pk = String(mutation?.Key?.PK || "");
    const match = pk.match(/^(DOCUMENT|BOOKKEEPING)#(.+)$/);
    if (!match) continue;
    // A report reference pins existing immutable bytes. Only the two internal
    // reference operations may change this counter on a finance-claimed PDF.
    if (reportCounterOnly && match[1] === "DOCUMENT" && action.Update
      && /^SET updatedAt = :now ADD reportRefCount :(one|minus)$/.test(action.Update.UpdateExpression || "")) continue;
    const claim = `SPONSOR_FINANCE_CLAIM#${match[1] === "DOCUMENT" ? "document" : "transaction"}#${match[2]}`;
    if (protectedSources.has(claim)) continue;
    protectedSources.add(claim);
    guarded.push({
      ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: claim, SK: claim },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  }
  input = { ...input, TransactItems: guarded };
  if (guarded.length > 100) throw new BookkeepingTransactionLimitError();
  const targets = new Set<string>();
  for (const action of guarded) {
    const operation = action.Put || action.Update || action.Delete || action.ConditionCheck;
    if (!operation) continue;
    const targetKey = "Item" in operation ? operation.Item : operation.Key;
    if (!targetKey) continue;
    const target = JSON.stringify([operation.TableName, targetKey.PK, targetKey.SK]);
    if (targets.has(target)) {
      throw new BookkeepingTransactionLimitError("Bookkeeping transaction targets one DynamoDB item more than once");
    }
    targets.add(target);
  }
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
      const actions = input.TransactItems || [];
      if (preflightAtomicTestFallback) {
        for (const action of actions) {
          const write = action.Put || action.Update || action.Delete || action.ConditionCheck;
          if (!write) continue;
          const itemKey = action.Put
            ? { PK: action.Put.Item!.PK, SK: action.Put.Item!.SK }
            : "Key" in write ? write.Key : undefined;
          if (!itemKey) continue;
          const result = await client.send(new GetCommand({ TableName: write.TableName, Key: itemKey, ConsistentRead: true }));
          const condition = write.ConditionExpression;
          if (!testConditionMatches(condition, result.Item as Record<string, unknown> | undefined,
            write.ExpressionAttributeNames as Record<string, string> | undefined,
            write.ExpressionAttributeValues as Record<string, unknown> | undefined)) {
            throw new Error("Conditional check failed");
          }
        }
      } else {
        for (const action of actions) {
          if (action.Put?.ConditionExpression?.includes("attribute_not_exists")) {
            const existing = await client.send(
              new GetCommand({ TableName: action.Put.TableName, Key: { PK: action.Put.Item!.PK, SK: action.Put.Item!.SK }, ConsistentRead: true }),
            );
            if (existing.Item) throw new Error("Conditional check failed");
          }
        }
        for (const action of actions) {
          if (action.ConditionCheck) {
            const result = await client.send(
              new GetCommand({
                TableName: action.ConditionCheck.TableName,
                Key: action.ConditionCheck.Key,
                ConsistentRead: true,
              }),
            );
            const expression = action.ConditionCheck.ConditionExpression || "";
            const values = action.ConditionCheck.ExpressionAttributeValues || {};
            const valid = expression === "attribute_not_exists(PK)"
              ? !result.Item
              : expression.includes("updatedAt = :expected")
                ? result.Item?.updatedAt === values[":expected"]
                  && (result.Item?.voidStatus === undefined || result.Item?.voidStatus !== values[":voided"])
                : !!result.Item;
            if (!valid) throw new Error("Conditional check failed");
          }
        }
      }
      for (const action of actions) {
        if (action.Put) await client.send(new PutCommand(action.Put));
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
  const id = String(value.id || bookkeepingItemId(unique));
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

/** Create a ledger row and any related evidence/claims atomically. */
export async function putBookkeepingTransactionWithItems(
  client: DynamoDBDocumentClient,
  value: Record<string, unknown>,
  relatedItems: BookkeepingTransactItem[],
  unique?: string,
) {
  const id = String(value.id || bookkeepingItemId(unique));
  const now = new Date().toISOString();
  const item = {
    PK: key("bookkeeping", id),
    SK: key("bookkeeping", id),
    ...value,
    id,
    createdAt: value.createdAt || now,
    updatedAt: now,
  };
  try {
    await transact(client, {
      TransactItems: [
        { Put: { TableName: TABLE_BOOKKEEPING, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
        ...relatedItems,
      ],
    }, false, true);
  } catch (error) {
    if (isConditionalMutationFailure(error)) {
      if (unique) {
        const existing = await getBookkeepingItem(client, "bookkeeping", id, true);
        const generatedFields = new Set([
          "PK", "SK", "id", "createdAt", "updatedAt", "addedAt", "counterpartyCanonical",
        ]);
        const sameInput = existing && Object.entries(value)
          .filter(([field]) => !generatedFields.has(field))
          .every(([field, requested]) => isDeepStrictEqual(existing[field], requested))
          && isDeepStrictEqual(existing.allocations ?? null, value.allocations ?? null);
        if (existing && sameInput) return { item: existing, duplicate: true };
      }
      throw new BookkeepingItemLockedError();
    }
    throw error;
  }
  return { item: clean(item)!, duplicate: false };
}

async function getBookkeepingItemRaw(
  client: DynamoDBDocumentClient,
  kind: string,
  id: string,
  consistentRead = false,
) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: key(kind, id), SK: key(kind, id) },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  return clean(result.Item as Record<string, unknown>);
}

async function listBookkeepingAuditRows(
  client: DynamoDBDocumentClient,
  transactionId: string,
): Promise<BookkeepingAuditRow[]> {
  const rows: BookkeepingAuditRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: TABLE_BOOKKEEPING,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": bookkeepingAuditPartitionKey(transactionId) },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    rows.push(...(result.Items || []) as BookkeepingAuditRow[]);
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return rows;
}

async function readBookkeepingAuditSnapshot(
  client: DynamoDBDocumentClient,
  transactionId: string,
  initial?: BookkeepingItem | null,
): Promise<{ item: BookkeepingItem; events: ReturnType<typeof bookkeepingAuditEvents> } | null> {
  let item = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    item ||= await getBookkeepingItemRaw(client, "bookkeeping", transactionId, true);
    if (!item) return null;
    const rows = await listBookkeepingAuditRows(client, transactionId);
    try {
      return { item, events: bookkeepingAuditEvents(item, rows) };
    } catch (error) {
      if (!(error instanceof BookkeepingAuditIntegrityError)
        || item.auditStorageVersion !== BOOKKEEPING_AUDIT_STORAGE_VERSION
        || attempt === 2) throw error;
      item = await getBookkeepingItemRaw(client, "bookkeeping", transactionId, true);
    }
  }
  throw new BookkeepingAuditIntegrityError();
}

export async function getBookkeepingItem(
  client: DynamoDBDocumentClient,
  kind: string,
  id: string,
  consistentRead = false,
) {
  const item = await getBookkeepingItemRaw(client, kind, id, consistentRead || kind === "bookkeeping");
  if (!item || kind !== "bookkeeping") return item;
  if (item.auditStorageVersion === undefined && item.audit === undefined) return item;
  const snapshot = await readBookkeepingAuditSnapshot(client, id, item);
  if (!snapshot) return null;
  if (snapshot.item.auditStorageVersion === BOOKKEEPING_AUDIT_STORAGE_VERSION
    || snapshot.item.audit !== undefined || snapshot.events.length) {
    return { ...snapshot.item, audit: snapshot.events.map((entry) => entry.event) };
  }
  return snapshot.item;
}

export async function getBookkeepingAuditPage(
  client: DynamoDBDocumentClient,
  transactionId: string,
  afterSequence: number,
  limit: number,
): Promise<{ items: BookkeepingAuditEvent[]; nextCursor: string | null } | null> {
  const snapshot = await readBookkeepingAuditSnapshot(client, transactionId);
  if (!snapshot) return null;
  const page = snapshot.events.filter((entry) => entry.sequence > afterSequence).slice(0, limit);
  const hasMore = snapshot.events.some((entry) => entry.sequence > (page.at(-1)?.sequence ?? afterSequence));
  return {
    items: page.map((entry) => entry.event),
    nextCursor: hasMore && page.length ? String(page[page.length - 1].sequence) : null,
  };
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
  consistentRead = false,
): Promise<BookkeepingItem[]> {
  const items: BookkeepingItem[] = [];
  const auditRows = new Map<string, BookkeepingAuditRow[]>();
  const transactionItems = kind.toLowerCase() === "bookkeeping";
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_BOOKKEEPING,
        ...(consistentRead ? { ConsistentRead: true } : {}),
        FilterExpression: transactionItems
          ? "begins_with(PK, :prefix) OR begins_with(PK, :audit)"
          : "begins_with(PK, :prefix)",
        ExpressionAttributeValues: transactionItems
          ? { ":prefix": "BOOKKEEPING#", ":audit": BOOKKEEPING_AUDIT_PARTITION_PREFIX }
          : { ":prefix": `${kind.toUpperCase()}#` },
        ExclusiveStartKey,
      }),
    );
    for (const item of result.Items || []) {
      const pk = String(item.PK);
      if (transactionItems && pk.startsWith(BOOKKEEPING_AUDIT_PARTITION_PREFIX)) {
        const transactionId = pk.slice(BOOKKEEPING_AUDIT_PARTITION_PREFIX.length);
        const rows = auditRows.get(transactionId) || [];
        rows.push(item as BookkeepingAuditRow);
        auditRows.set(transactionId, rows);
      } else if (!transactionItems || String(item.PK) === String(item.SK)) {
        items.push(clean(item as Record<string, unknown>)!);
      }
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const readItems = transactionItems
    ? await Promise.all(items.map(async (item) => {
      if (item.auditStorageVersion === undefined && !auditRows.has(item.id)) return item;
      try {
        const events = bookkeepingAuditEvents(item, auditRows.get(item.id) || []);
        return { ...item, audit: events.map((entry) => entry.event) };
      } catch (error) {
        if (!(error instanceof BookkeepingAuditIntegrityError)) throw error;
        const snapshot = await readBookkeepingAuditSnapshot(client, item.id, item);
        if (!snapshot) return item;
        return { ...snapshot.item, audit: snapshot.events.map((entry) => entry.event) };
      }
    }))
    : items;

  return readItems.sort((a, b) =>
    String(b.transactionDate || b.createdAt).localeCompare(
      String(a.transactionDate || a.createdAt),
    ),
  );
}

/**
 * Every transaction, each one a sponsor deal has claimed as its payment
 * carrying that deal's id. A claimed transaction is immutable: sponsor finance
 * pins its amount, currency and updatedAt. Transactions and claims come from
 * one scan of the table.
 */
export async function listTransactions(
  client: DynamoDBDocumentClient,
  consistentRead = false,
): Promise<BookkeepingItem[]> {
  const transactions: BookkeepingItem[] = [];
  const claims = new Map<string, string>();
  const auditRows = new Map<string, BookkeepingAuditRow[]>();
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_BOOKKEEPING,
        ...(consistentRead ? { ConsistentRead: true } : {}),
        FilterExpression: "begins_with(PK, :transaction) OR begins_with(PK, :claim) OR begins_with(PK, :audit)",
        ExpressionAttributeValues: {
          ":transaction": "BOOKKEEPING#",
          ":claim": "SPONSOR_FINANCE_CLAIM#transaction#",
          ":audit": BOOKKEEPING_AUDIT_PARTITION_PREFIX,
        },
        ExclusiveStartKey,
      }),
    );
    for (const item of result.Items || []) {
      const pk = String(item.PK);
      if (pk.startsWith("SPONSOR_FINANCE_CLAIM#")) {
        claims.set(String(item.sourceId), String(item.dealId));
      } else if (pk.startsWith(BOOKKEEPING_AUDIT_PARTITION_PREFIX)) {
        const transactionId = pk.slice(BOOKKEEPING_AUDIT_PARTITION_PREFIX.length);
        const rows = auditRows.get(transactionId) || [];
        rows.push(item as BookkeepingAuditRow);
        auditRows.set(transactionId, rows);
      } else if (String(item.PK) === String(item.SK)) {
        transactions.push(clean(item as Record<string, unknown>)!);
      }
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const withAudit = await Promise.all(transactions.map(async (item) => {
    if (item.auditStorageVersion === undefined) {
      if (!auditRows.has(item.id)) return item;
      const snapshot = await readBookkeepingAuditSnapshot(client, item.id, item);
      if (!snapshot) return item;
      return { ...snapshot.item, audit: snapshot.events.map((entry) => entry.event) };
    }
    try {
      const events = bookkeepingAuditEvents(item, auditRows.get(item.id) || []);
      return { ...item, audit: events.map((entry) => entry.event) };
    } catch (error) {
      if (!(error instanceof BookkeepingAuditIntegrityError)) throw error;
      const snapshot = await readBookkeepingAuditSnapshot(client, item.id, item);
      if (!snapshot) return item;
      return { ...snapshot.item, audit: snapshot.events.map((entry) => entry.event) };
    }
  }));
  return withAudit
    .filter((item) => item.voidStatus !== "voided")
    .map((item) => (claims.has(item.id) ? { ...item, sponsorDealId: claims.get(item.id) } : item))
    .sort((a, b) =>
      String(b.transactionDate || b.createdAt).localeCompare(String(a.transactionDate || a.createdAt)),
    );
}

/** The sponsor deal that claimed a transaction as its payment, if any. */
export async function transactionSponsorDeal(client: DynamoDBDocumentClient, id: string) {
  const claim = `SPONSOR_FINANCE_CLAIM#transaction#${id}`;
  const result = await client.send(
    new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: claim, SK: claim } }),
  );
  return result.Item ? String(result.Item.dealId) : null;
}

/** Store what a document's text says (date, amount, provider) for matching. */
export async function setDocumentFacts(
  client: DynamoDBDocumentClient,
  id: string,
  facts: Record<string, unknown>,
) {
  await client.send(
    new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: documentKey(id), SK: documentKey(id) },
      UpdateExpression: "SET facts = :facts",
      ConditionExpression: "attribute_exists(PK) AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":facts": facts, ":active": "active" },
    }),
  );
}

export async function deleteBookkeepingItem(
  client: DynamoDBDocumentClient,
  kind: string,
  id: string,
) {
  const existing = await getBookkeepingItem(client, kind, id);
  if (existing) {
    try {
      await transact(client, {
        TransactItems: [{
          Delete: {
            TableName: TABLE_BOOKKEEPING,
            Key: { PK: key(kind, id), SK: key(kind, id) },
            ConditionExpression: "updatedAt = :updatedAt",
            ExpressionAttributeValues: { ":updatedAt": existing.updatedAt },
          },
        }],
      });
    } catch (error) {
      if (isConditionalMutationFailure(error))
        throw new BookkeepingItemLockedError();
      throw error;
    }
  }
  return existing;
}

export async function updateBookkeepingTransaction(
  client: DynamoDBDocumentClient,
  id: string,
  expectedUpdatedAt: string,
  value: Record<string, unknown>,
  expectedVoidStatus: "active" | "voided" = "active",
  expectedRelatedTransaction?: { id: string; updatedAt: string },
  additionalTransactItems: BookkeepingTransactItem[] = [],
) {
  let mutationValue = value;
  let auditTransactItems: BookkeepingTransactItem[] = [];
  let expectedAuditSequence: number | undefined;
  let expectedLegacyAuditStorage = false;
  if (Array.isArray(value.audit) && value.audit.length) {
    const candidate = value.audit[value.audit.length - 1];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const current = await getBookkeepingItemRaw(client, "bookkeeping", id, true);
      if (!current || String(current.updatedAt || "") !== expectedUpdatedAt) {
        throw new BookkeepingItemLockedError();
      }
      const sidecarRows = current.auditStorageVersion === BOOKKEEPING_AUDIT_STORAGE_VERSION
        ? await listBookkeepingAuditRows(client, id)
        : [];
      const plan = planBookkeepingAuditWrite({
        transactionId: id,
        transaction: current,
        sidecarRows,
        event: candidate as BookkeepingAuditEvent,
        tableName: TABLE_BOOKKEEPING,
      });
      auditTransactItems = plan.transactItems;
      if (current.auditStorageVersion === BOOKKEEPING_AUDIT_STORAGE_VERSION) {
        expectedAuditSequence = Number(current.auditSequence);
      } else {
        expectedLegacyAuditStorage = true;
      }
      mutationValue = {
        ...value,
        audit: undefined,
        auditStorageVersion: BOOKKEEPING_AUDIT_STORAGE_VERSION,
        auditSequence: plan.sequence,
      };
    }
  }
  const now = new Date().toISOString();
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":expected": expectedUpdatedAt,
    ":now": now,
    ":voided": "voided",
  };
  let auditCondition = "";
  if (expectedAuditSequence !== undefined) {
    names["#auditSequence"] = "auditSequence";
    values[":expectedAuditSequence"] = expectedAuditSequence;
    auditCondition = " AND #auditSequence = :expectedAuditSequence";
  } else if (expectedLegacyAuditStorage) {
    names["#auditStorageVersion"] = "auditStorageVersion";
    auditCondition = " AND attribute_not_exists(#auditStorageVersion)";
  }
  const writableFields = Object.entries(mutationValue)
    .filter(([name]) => !["id", "createdAt", "updatedAt", "PK", "SK"].includes(name));
  const sets = writableFields
    .filter(([, child]) => child !== undefined)
    .map(([name, child], index) => {
      names[`#field${index}`] = name;
      values[`:value${index}`] = child;
      return `#field${index} = :value${index}`;
    });
  const removes = writableFields
    .filter(([, child]) => child === undefined)
    .map(([name], index) => {
      const alias = `#remove${index}`;
      names[alias] = name;
      return alias;
    });
  try {
    await transact(client, {
      TransactItems: [{
        Update: {
          TableName: TABLE_BOOKKEEPING,
          Key: { PK: key("bookkeeping", id), SK: key("bookkeeping", id) },
          UpdateExpression: `SET ${[...sets, "updatedAt = :now"].join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
          ConditionExpression: expectedVoidStatus === "voided"
            ? `updatedAt = :expected AND voidStatus = :voided${auditCondition}`
            : `updatedAt = :expected AND (attribute_not_exists(voidStatus) OR voidStatus <> :voided)${auditCondition}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      }, ...(expectedRelatedTransaction ? [{
        ConditionCheck: {
          TableName: TABLE_BOOKKEEPING,
          Key: { PK: key("bookkeeping", expectedRelatedTransaction.id), SK: key("bookkeeping", expectedRelatedTransaction.id) },
          ConditionExpression: "updatedAt = :expected AND (attribute_not_exists(voidStatus) OR voidStatus <> :voided)",
          ExpressionAttributeValues: { ":expected": expectedRelatedTransaction.updatedAt, ":voided": "voided" },
        },
      }] : []), ...auditTransactItems, ...additionalTransactItems],
    }, false, auditTransactItems.length > 0 || additionalTransactItems.length > 0);
  } catch (error) {
    if (isConditionalMutationFailure(error))
      throw new BookkeepingItemLockedError();
    throw error;
  }
  return getBookkeepingItem(client, "bookkeeping", id);
}

export type PrepareDocumentInput = {
  sha256: string;
  byteSize: number;
  documentType: string;
  contentType?: string;
  accountId?: string;
  statementMonth?: string;
  originalFilename?: string;
  idempotencyKey: string;
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
      existing.document?.creatorIdempotencyKey === input.idempotencyKey;
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
    contentType: input.contentType || "application/pdf",
    declaredSha256: input.sha256,
    declaredByteSize: input.byteSize,
    byteSize: input.byteSize,
    documentType: input.documentType,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.statementMonth ? { statementMonth: input.statementMonth } : {}),
    ...(input.originalFilename ? { originalFilename: input.originalFilename } : {}),
    s3Key: input.s3Key.replace("{id}", id),
    prepareExpiresAt: input.expiresAt,
    uploadAuthorizationExpiresAt: input.uploadAuthorizationExpiresAt,
    creatorIdempotencyKey: input.idempotencyKey,
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
      winner.document?.creatorIdempotencyKey === input.idempotencyKey;
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
            ConditionExpression: "#status = :pending AND declaredSha256 = :hash AND creatorIdempotencyKey = :owner",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "active", ":pending": "pending", ":hash": sha256, ":size": verifiedByteSize, ":version": versionId, ":owner": idempotencyKey, ":now": now },
          },
        },
        {
          Update: {
            TableName: TABLE_BOOKKEEPING,
            Key: { PK: hashKey(sha256), SK: hashKey(sha256) },
            UpdateExpression: "SET #state = :active, updatedAt = :now",
            ConditionExpression: "#state = :pending AND documentId = :id AND creatorIdempotencyKey = :owner",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":active": "active", ":pending": "pending", ":id": id, ":owner": idempotencyKey, ":now": now },
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
  expiresAt: string,
  uploadAuthorizationExpiresAt: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(id), SK: documentKey(id) }, UpdateExpression: "SET prepareExpiresAt = :expiry, uploadAuthorizationExpiresAt = :uploadExpiry, updatedAt = :now", ConditionExpression: "#status = :pending AND creatorIdempotencyKey = :owner", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":expiry": expiresAt, ":uploadExpiry": uploadAuthorizationExpiresAt, ":now": new Date().toISOString(), ":pending": "pending", ":owner": idempotencyKey } } },
        { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: hashKey(sha256), SK: hashKey(sha256) }, UpdateExpression: "SET expiresAt = :expiry, updatedAt = :now", ConditionExpression: "#state = :pending AND documentId = :id AND creatorIdempotencyKey = :owner", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":expiry": expiresAt, ":now": new Date().toISOString(), ":pending": "pending", ":id": id, ":owner": idempotencyKey } } },
      ],
    },
  );
}

export async function markDocumentCleanupRequired(
  client: DynamoDBDocumentClient,
  id: string,
  idempotencyKey: string,
) {
  await transact(client, { TransactItems: [{ Update: {
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: documentKey(id), SK: documentKey(id) },
      UpdateExpression: "SET #status = :cleanup, updatedAt = :now",
      ConditionExpression: "creatorIdempotencyKey = :owner AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":cleanup": "cleanup-required", ":pending": "pending", ":owner": idempotencyKey, ":now": new Date().toISOString() },
    } }] });
}

export async function removePendingDocumentClaim(
  client: DynamoDBDocumentClient,
  id: string,
  sha256: string,
  idempotencyKey: string,
) {
  await transact(
    client,
    {
      TransactItems: [
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(id), SK: documentKey(id) }, ConditionExpression: "creatorIdempotencyKey = :owner AND #status <> :active", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":owner": idempotencyKey, ":active": "active" } } },
        { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: hashKey(sha256), SK: hashKey(sha256) }, ConditionExpression: "documentId = :id AND creatorIdempotencyKey = :owner AND #state <> :active", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":id": id, ":owner": idempotencyKey, ":active": "active" } } },
      ],
    },
  );
}

export function documentLinkItem(
  input: { documentId: string; transactionId: string; coverageType: string; allocationManaged?: boolean },
  now = new Date().toISOString(),
) {
  const id = createHash("sha256")
    .update(`link#${input.documentId}#${input.transactionId}#${input.coverageType}`)
    .digest("hex");
  return {
    PK: key("link", id),
    SK: key("link", id),
    id,
    documentId: input.documentId,
    transactionId: input.transactionId,
    coverageType: input.coverageType,
    ...(input.allocationManaged ? { allocationManaged: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function allocationClaimKey(kind: "document" | "sha256", value: string) {
  const id = createHash("sha256").update(`${kind}\0${value}`).digest("hex");
  const pk = `ALLOCATION-SOURCE-CLAIM#${id}`;
  return { PK: pk, SK: pk };
}

export function evidenceSourceVersionKey(kind: "document" | "sha256", value: string) {
  const id = createHash("sha256").update(`${kind}\0${value}`).digest("hex");
  const pk = `EVIDENCE-SOURCE-VERSION#${id}`;
  return { id, PK: pk, SK: pk };
}

function evidenceSourceVersionUpdate(
  kind: "document" | "sha256", value: string,
): BookkeepingTransactItem {
  const source = evidenceSourceVersionKey(kind, value);
  return { Update: {
    TableName: TABLE_BOOKKEEPING,
    Key: { PK: source.PK, SK: source.SK },
    UpdateExpression: "SET id = :id ADD revision :one",
    ExpressionAttributeValues: { ":id": source.id, ":one": 1 },
  } };
}

function allocationClaimCheck(
  key: { PK: string; SK: string },
  transactionId: string,
  allowOwner: boolean,
): BookkeepingTransactItem {
  return {
    ConditionCheck: {
      TableName: TABLE_BOOKKEEPING,
      Key: key,
      ConditionExpression: allowOwner
        ? "attribute_not_exists(PK) OR transactionId = :transactionId"
        : "attribute_not_exists(PK) OR transactionId <> :transactionId",
      ExpressionAttributeValues: { ":transactionId": transactionId },
    },
  };
}

export async function createDocumentLink(
  client: DynamoDBDocumentClient,
  input: { documentId: string; transactionId: string; coverageType: string },
) {
  const now = new Date().toISOString();
  const item = documentLinkItem(input, now);
  const id = item.id;
  const document = await getRawDocument(client, input.documentId);
  if (!document || document.status !== "active") throw new BookkeepingItemLockedError();
  const sha256 = typeof document.sha256 === "string" ? document.sha256.trim().toLowerCase() : "";
  const claims = input.coverageType === "evidence"
    ? [allocationClaimKey("document", input.documentId),
       ...(sha256 ? [allocationClaimKey("sha256", sha256)] : [])]
    : [];
  const shaCondition = document.sha256 === undefined
    ? "attribute_not_exists(sha256)"
    : "sha256 = :sha256";
  try {
    await transact(
      client,
      {
        TransactItems: [
          { Put: { TableName: TABLE_BOOKKEEPING, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
          { ConditionCheck: { TableName: TABLE_BOOKKEEPING, Key: { PK: key("bookkeeping", input.transactionId), SK: key("bookkeeping", input.transactionId) }, ConditionExpression: "attribute_exists(PK)" } },
          { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(input.documentId), SK: documentKey(input.documentId) }, UpdateExpression: "SET updatedAt = :now ADD linkRefCount :one", ConditionExpression: `#status = :active AND ${shaCondition}`, ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":one": 1, ":active": "active", ":now": now, ...(document.sha256 === undefined ? {} : { ":sha256": document.sha256 }) } } },
          ...claims.map((claim) => allocationClaimCheck(claim, input.transactionId, true)),
          ...(input.coverageType === "evidence"
            ? [evidenceSourceVersionUpdate("document", input.documentId),
               ...(sha256 ? [evidenceSourceVersionUpdate("sha256", sha256)] : [])]
            : []),
        ],
      }, false, true,
    );
    return { outcome: "created", item: clean(item)! };
  } catch (error) {
    if (!isConditionalMutationFailure(error)) throw error;
    for (const claim of claims) {
      const current = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: claim, ConsistentRead: true }));
      if (current.Item && current.Item.transactionId !== input.transactionId) throw new BookkeepingItemLockedError();
    }
    const existing = await getBookkeepingItem(client, "link", id, true);
    if (existing) return { outcome: "existing", item: existing };
    throw new BookkeepingItemLockedError();
  }
}

export async function deleteDocumentLink(
  client: DynamoDBDocumentClient,
  link: BookkeepingItem,
) {
  const document = await getRawDocument(client, String(link.documentId));
  if (!document) throw new BookkeepingItemLockedError();
  const sha256 = typeof document.sha256 === "string" ? document.sha256.trim().toLowerCase() : "";
  const shaCondition = document.sha256 === undefined
    ? "attribute_not_exists(sha256)"
    : "sha256 = :sha256";
  const guard = link.coverageType === "evidence"
    ? [allocationClaimCheck(allocationClaimKey("document", String(link.documentId)), String(link.transactionId), false),
       evidenceSourceVersionUpdate("document", String(link.documentId)),
       ...(sha256 ? [evidenceSourceVersionUpdate("sha256", sha256)] : [])]
    : [];
  try {
    await transact(
      client,
      {
        TransactItems: [
          { Delete: { TableName: TABLE_BOOKKEEPING, Key: { PK: key("link", link.id), SK: key("link", link.id) }, ConditionExpression: "attribute_exists(PK)" } },
          { Update: { TableName: TABLE_BOOKKEEPING, Key: { PK: documentKey(String(link.documentId)), SK: documentKey(String(link.documentId)) }, UpdateExpression: "SET updatedAt = :now ADD linkRefCount :minus", ConditionExpression: `linkRefCount > :zero AND ${shaCondition}`, ExpressionAttributeValues: { ":minus": -1, ":zero": 0, ":now": new Date().toISOString(), ...(document.sha256 === undefined ? {} : { ":sha256": document.sha256 }) } } },
          ...guard,
        ],
      }, false, true,
    );
  } catch (error) {
    if (isConditionalMutationFailure(error)) throw new BookkeepingItemLockedError();
    throw error;
  }
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
      true,
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
    true,
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
