/**
 * One-off cleanup: drop the retired `emoji` field from stored Templates and Cards.
 *
 * Templates carry a curated `icon` now, so `emoji` left the template schema,
 * the Card projection and the API in the same change. This removes what is
 * already persisted: `emoji` on Template rows, on Card rows, and inside each
 * Card's `templateDefinitionSnapshot`.
 *
 * The write is a conditional REMOVE that leaves `version` and `updatedAt`
 * alone: the field is no longer part of any definition or editable Card
 * state, so stripping it is not a user-visible edit.
 *
 * Dry run is the default. Each applied write prints one JSON line.
 *
 *   DATAOPS_CARDS_TABLE=dataops-v1-cards DATAOPS_TEMPLATES_TABLE=dataops-v1-templates \
 *     tsx scripts/strip-template-emoji.ts [--apply]
 *
 * Production needs explicit approval. Delete this script once it has run there.
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const APPLY = process.argv.slice(2).includes('--apply');

type Item = Record<string, unknown>;

interface Plan {
  table: string;
  key: Item;
  id: string;
  removeTop: boolean;
  removeSnapshot: boolean;
}

async function scanAll(client: DynamoDBDocumentClient, table: string, prefix: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': prefix },
      ExclusiveStartKey: start,
      ConsistentRead: true,
    }));
    items.push(...((page.Items || []) as Item[]));
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start);
  return items;
}

export function planFor(table: string, item: Item): Plan | null {
  const snapshot = item.templateDefinitionSnapshot;
  const removeTop = Object.hasOwn(item, 'emoji');
  const removeSnapshot = Boolean(
    snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot as Item, 'emoji'),
  );
  if (!removeTop && !removeSnapshot) return null;
  return {
    table,
    key: { PK: item.PK, SK: item.SK },
    id: String(item.id),
    removeTop,
    removeSnapshot,
  };
}

async function apply(client: DynamoDBDocumentClient, plan: Plan): Promise<void> {
  const removes: string[] = [];
  const conditions: string[] = ['attribute_exists(PK)'];
  const names: Record<string, string> = { '#emoji': 'emoji' };
  if (plan.removeTop) {
    removes.push('#emoji');
    conditions.push('attribute_exists(#emoji)');
  }
  if (plan.removeSnapshot) {
    names['#snapshot'] = 'templateDefinitionSnapshot';
    removes.push('#snapshot.#emoji');
    conditions.push('attribute_exists(#snapshot.#emoji)');
  }
  await client.send(new UpdateCommand({
    TableName: plan.table,
    Key: plan.key,
    UpdateExpression: `REMOVE ${removes.join(', ')}`,
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
  }));
}

export async function stripTemplateEmoji(
  client: DynamoDBDocumentClient,
  tables: { cards: string; templates: string },
  write: boolean,
): Promise<Record<string, unknown>> {
  const plans = [
    ...(await scanAll(client, tables.templates, 'TEMPLATE#')).map((item) => planFor(tables.templates, item)),
    ...(await scanAll(client, tables.cards, 'CARD#')).map((item) => planFor(tables.cards, item)),
  ].filter((plan): plan is Plan => plan !== null);

  const summary = {
    templates: plans.filter((plan) => plan.table === tables.templates).length,
    cards: plans.filter((plan) => plan.table === tables.cards && plan.removeTop).length,
    cardSnapshots: plans.filter((plan) => plan.table === tables.cards && plan.removeSnapshot).length,
  };
  if (!write) return { ...summary, mode: 'dry-run' };
  for (const plan of plans) {
    await apply(client, plan);
    console.log(JSON.stringify({
      op: 'strip-template-emoji',
      table: plan.table,
      id: plan.id,
      removed: [plan.removeTop && 'emoji', plan.removeSnapshot && 'templateDefinitionSnapshot.emoji'].filter(Boolean),
      at: new Date().toISOString(),
    }));
  }
  return { ...summary, mode: 'applied' };
}

async function main(): Promise<void> {
  const { getClient } = await import('../src/db/client');
  const { TABLE_CARDS, TABLE_TEMPLATES } = await import('../src/db/tableNames');
  const client = await getClient();
  console.log(JSON.stringify(await stripTemplateEmoji(client, { cards: TABLE_CARDS, templates: TABLE_TEMPLATES }, APPLY)));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('template emoji cleanup failed:', (error as Error).message);
    process.exit(1);
  });
}
