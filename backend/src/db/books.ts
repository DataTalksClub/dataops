import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_BOOKS } from "./tableNames";

export type BookAuthor = { name: string; slug?: string };
export type BookLink = { text: string; url: string };

/**
 * A Book of the Week entry (`_books/<YYYYMMDD>-<slug>.md`): the public facts
 * the website page renders, including the event week and labeled links.
 */
export type Book = {
  id: string;
  title: string;
  /** The website filename slug (without the event-week date prefix). */
  slug?: string | null;
  authors: BookAuthor[];
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  links?: BookLink[];
  coverUrl?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const key = (id: string) => `BOOK#${id}`;
const clean = (item: Record<string, unknown> | undefined) => {
  if (!item) return null;
  const { PK, SK, ...value } = item;
  return value as unknown as Book;
};
const stored = (book: Book) => ({
  PK: key(book.id),
  SK: key(book.id),
  ...Object.fromEntries(
    Object.entries(book).filter(([, value]) => value !== undefined && value !== null),
  ),
});

export async function getBook(client: DynamoDBDocumentClient, id: string) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_BOOKS,
      Key: { PK: key(id), SK: key(id) },
    }),
  );
  return clean(result.Item as Record<string, unknown> | undefined);
}

/** The register holds about a hundred books; a scan is enough. */
export async function listBooks(client: DynamoDBDocumentClient) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_BOOKS,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": "BOOK#" },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...((page.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return (items.map(clean).filter(Boolean) as Book[]).sort(
    (left, right) =>
      (right.startDate || "").localeCompare(left.startDate || "") ||
      left.title.localeCompare(right.title),
  );
}

export async function createBook(
  client: DynamoDBDocumentClient,
  value: Omit<Book, "id" | "version" | "createdAt" | "updatedAt">,
) {
  const now = new Date().toISOString();
  const book: Book = {
    ...value,
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_BOOKS,
      Item: stored(book),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return book;
}

/** Version-conditional replace; `null` clears an optional field. */
export async function updateBook(
  client: DynamoDBDocumentClient,
  existing: Book,
  changes: Partial<Book>,
) {
  const next = {
    ...existing,
    ...changes,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } as Book;
  await client.send(
    new PutCommand({
      TableName: TABLE_BOOKS,
      Item: stored(next),
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
  return clean(stored(next))!;
}

export async function deleteBook(client: DynamoDBDocumentClient, existing: Book) {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_BOOKS,
      Key: { PK: key(existing.id), SK: key(existing.id) },
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
}
