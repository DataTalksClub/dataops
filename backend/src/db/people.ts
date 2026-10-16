import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_PEOPLE } from "./tableNames";

export type PersonLinks = {
  github?: string;
  twitter?: string;
  linkedin?: string;
  website?: string;
};

/**
 * A website speaker/author profile (`_people/<slug>.md`): the public facts
 * the website page renders. Private contact details never live here.
 */
export type Person = {
  id: string;
  name: string;
  /** The website `_people` short id; doubles as the filename. */
  slug: string;
  bio?: string | null;
  bioShort?: string | null;
  photoUrl?: string | null;
  links?: PersonLinks;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const key = (id: string) => `PERSON#${id}`;
const clean = (item: Record<string, unknown> | undefined) => {
  if (!item) return null;
  const { PK, SK, ...value } = item;
  return value as unknown as Person;
};
const stored = (person: Person) => ({
  PK: key(person.id),
  SK: key(person.id),
  ...Object.fromEntries(
    Object.entries(person).filter(([, value]) => value !== undefined && value !== null),
  ),
});

export async function getPerson(client: DynamoDBDocumentClient, id: string) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_PEOPLE,
      Key: { PK: key(id), SK: key(id) },
    }),
  );
  return clean(result.Item as Record<string, unknown> | undefined);
}

/** The register holds a few hundred profiles at most; a scan is enough. */
export async function listPeople(client: DynamoDBDocumentClient) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_PEOPLE,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": "PERSON#" },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...((page.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return (items.map(clean).filter(Boolean) as Person[]).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function createPerson(
  client: DynamoDBDocumentClient,
  value: Omit<Person, "id" | "version" | "createdAt" | "updatedAt">,
) {
  const now = new Date().toISOString();
  const person: Person = {
    ...value,
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_PEOPLE,
      Item: stored(person),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return person;
}

/** Version-conditional replace; `null` clears an optional field. */
export async function updatePerson(
  client: DynamoDBDocumentClient,
  existing: Person,
  changes: Partial<Person>,
) {
  const next = {
    ...existing,
    ...changes,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } as Person;
  await client.send(
    new PutCommand({
      TableName: TABLE_PEOPLE,
      Item: stored(next),
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
  return clean(stored(next))!;
}

export async function deletePerson(client: DynamoDBDocumentClient, existing: Person) {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_PEOPLE,
      Key: { PK: key(existing.id), SK: key(existing.id) },
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
}
