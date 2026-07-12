import { createHash, randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_NEWSLETTER_SLOTS } from "./setup";
export type NewsletterSlot = Record<string, unknown> & {
  id: string;
  publicationDate: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
const key = (id: string) => `SLOT#${id}`,
  clean = (item: any) => {
    if (!item) return null;
    const { PK, SK, rangeKey, publicationKey, ...value } = item;
    return value as NewsletterSlot;
  };
export const newsletterSlotId = (sourceKey: string) =>
  createHash("sha256").update(`newsletter:${sourceKey}`).digest("hex");
export async function getNewsletterSlot(
  client: DynamoDBDocumentClient,
  id: string,
) {
  const k = key(id);
  return clean(
    (
      await client.send(
        new GetCommand({
          TableName: TABLE_NEWSLETTER_SLOTS,
          Key: { PK: k, SK: k },
        }),
      )
    ).Item,
  );
}
export async function listNewsletterSlots(
  client: DynamoDBDocumentClient,
  from: string,
  to: string,
) {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      IndexName: "GSI-Date",
      KeyConditionExpression:
        "rangeKey=:range AND publicationKey BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":range": "SLOTS",
        ":from": from,
        ":to": `${to}~`,
      },
    }),
  );
  return (result.Items || []).map(clean).filter(Boolean) as NewsletterSlot[];
}
export async function createNewsletterSlot(
  client: DynamoDBDocumentClient,
  value: Record<string, unknown>,
) {
  const sourceKey = String(value.sourceKey || ""),
    id = sourceKey ? newsletterSlotId(sourceKey) : randomUUID(),
    now = new Date().toISOString(),
    item = {
      PK: key(id),
      SK: key(id),
      rangeKey: "SLOTS",
      publicationKey: `${value.publicationDate}#${id}`,
      ...value,
      id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_NEWSLETTER_SLOTS,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return { item: clean(item)!, duplicate: false };
  } catch (error) {
    if (
      (error as Error).name !== "ConditionalCheckFailedException" ||
      !sourceKey
    )
      throw error;
    const existing = await getNewsletterSlot(client, id);
    if (
      existing &&
      Object.keys(value).every(
        (name) =>
          JSON.stringify(existing[name]) === JSON.stringify(value[name]),
      )
    )
      return { item: existing, duplicate: true };
    throw Object.assign(new Error("Source key already used"), {
      statusCode: 409,
    });
  }
}
export async function updateNewsletterSlot(
  client: DynamoDBDocumentClient,
  existing: NewsletterSlot,
  value: Record<string, unknown>,
) {
  const next = {
      ...existing,
      ...value,
      id: existing.id,
      version: existing.version + 1,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    },
    k = key(existing.id);
  await client.send(
    new PutCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Item: {
        PK: k,
        SK: k,
        rangeKey: "SLOTS",
        publicationKey: `${next.publicationDate}#${existing.id}`,
        ...next,
      },
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
  return next;
}
export async function deleteNewsletterSlot(
  client: DynamoDBDocumentClient,
  existing: NewsletterSlot,
) {
  const k = key(existing.id);
  await client.send(
    new DeleteCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Key: { PK: k, SK: k },
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
}
export async function listNewsletterAlertRecords(
  client: DynamoDBDocumentClient,
) {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      FilterExpression: "begins_with(PK,:prefix)",
      ExpressionAttributeValues: { ":prefix": "ALERT#" },
    }),
  );
  return (result.Items || []) as any[];
}
export async function putNewsletterAlertRecord(
  client: DynamoDBDocumentClient,
  record: any,
) {
  const k = `ALERT#${record.id}`;
  await client.send(
    new PutCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Item: { PK: k, SK: k, ...record },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return record;
}
export async function updateNewsletterAlertRecord(
  client: DynamoDBDocumentClient,
  id: string,
  changes: any,
) {
  const k = `ALERT#${id}`,
    names = Object.keys(changes);
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Key: { PK: k, SK: k },
      UpdateExpression: `SET ${names.map((name) => `${name}=:${name}`).join(", ")}`,
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: Object.fromEntries(
        names.map((name) => [`:${name}`, changes[name]]),
      ),
    }),
  );
}
