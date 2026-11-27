/**
 * One-off backfill: stamp the GSI-EntityType key (`GSI5PK`) on sponsor CRM rows
 * written before the type index existed.
 *
 * New writes get GSI5PK from the storage client (src/db/sponsorCrmTypeIndex.ts).
 * Rows that predate it are invisible to list reads until this has run, so the
 * rollout is: backfill, deploy (creates the index), backfill again to catch
 * rows the old code wrote in between. Delete this script once that is done.
 *
 * Idempotent: a row whose GSI5PK already matches its PK prefix is skipped, so a
 * second run plans nothing. Each write is `SET GSI5PK` guarded by
 * `attribute_exists(PK)`, so it never recreates a row deleted mid-run and never
 * touches any other attribute or the record version.
 *
 * Usage against local dynalite:
 *   tsx scripts/backfill-sponsor-crm-entity-type.ts [--dry-run] [--apply]
 *
 * Against production (AWS credentials, explicit table name):
 *   DATAOPS_SPONSOR_CRM_TABLE=dataops-v1-sponsor-crm \
 *     tsx scripts/backfill-sponsor-crm-entity-type.ts --apply
 *
 * Default is `--dry-run`: count planned changes without writing.
 */
import path from 'node:path';
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { ENTITY_TYPE_ATTRIBUTE, entityTypeOf } from '../src/db/sponsorCrmTypeIndex';

export type BackfillSummary = {
  mode: 'dry-run' | 'applied';
  table: string;
  scanned: number;
  planned: number;
  applied: number;
  vanished: number;
  byType: Record<string, number>;
};

export async function backfillSponsorCrmEntityType(
  client: DynamoDBDocumentClient,
  options: { apply: boolean },
): Promise<BackfillSummary> {
  const planned: Array<{ PK: string; SK: string; type: string }> = [];
  let scanned = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_SPONSOR_CRM,
      ProjectionExpression: 'PK, SK, #type',
      ExpressionAttributeNames: { '#type': ENTITY_TYPE_ATTRIBUTE },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) {
      scanned += 1;
      const type = entityTypeOf(item.PK);
      if (type && item[ENTITY_TYPE_ATTRIBUTE] !== type) planned.push({ PK: String(item.PK), SK: String(item.SK), type });
    }
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  const byType: Record<string, number> = {};
  for (const row of planned) byType[row.type] = (byType[row.type] || 0) + 1;
  const summary: BackfillSummary = {
    mode: options.apply ? 'applied' : 'dry-run',
    table: TABLE_SPONSOR_CRM,
    scanned,
    planned: planned.length,
    applied: 0,
    vanished: 0,
    byType,
  };
  if (!options.apply) return summary;

  for (const row of planned) {
    try {
      await client.send(new UpdateCommand({
        TableName: TABLE_SPONSOR_CRM,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: 'SET #type = :type',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#type': ENTITY_TYPE_ATTRIBUTE },
        ExpressionAttributeValues: { ':type': row.type },
      }));
      summary.applied += 1;
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
      summary.vanished += 1;
    }
  }
  return summary;
}

export async function main(argv = process.argv.slice(2)): Promise<BackfillSummary> {
  const unknown = argv.find((arg) => arg !== '--apply' && arg !== '--dry-run');
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  if (argv.includes('--apply') && argv.includes('--dry-run')) throw new Error('Choose --apply or --dry-run, not both');
  const summary = await backfillSponsorCrmEntityType(await getClient(), { apply: argv.includes('--apply') });
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
