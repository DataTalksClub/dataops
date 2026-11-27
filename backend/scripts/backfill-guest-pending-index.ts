/**
 * One-off backfill for the sparse `GSI-Pending` index on the artifacts table.
 *
 * Guest intake jobs (`GUESTINTAKE#`) and guest time choices (`GUESTCHOICE#`)
 * written before `pendingKind` existed are invisible to the scheduled
 * backstops, which now Query that index instead of scanning the table. This
 * scans the two prefixes once and sets or removes `pendingKind` so every row
 * matches what the runtime writers would store.
 *
 * Usage (after the deploy that creates GSI-Pending):
 *   cd backend && npx tsx scripts/backfill-guest-pending-index.ts [--apply]
 *
 * Each write is conditional on the row being unchanged since the scan, so a
 * concurrent runtime write (which already sets pendingKind itself) wins.
 * Delete this script once it has run in production.
 */
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { isGuestIntakePending, type GuestIntakeJob, type PendingKind } from '../src/events/guestIntakeStore';

function expectedKind(item: Record<string, any>): PendingKind | undefined {
  const pk = String(item.PK);
  if (pk.startsWith('GUESTINTAKE#')) return isGuestIntakePending(item as GuestIntakeJob) ? 'guest-intake' : undefined;
  if (pk.startsWith('GUESTCHOICE#')) return item.status === 'pending' ? 'guest-choice' : undefined;
  return undefined;
}

export async function backfillGuestPendingIndex(
  client: DynamoDBDocumentClient,
  { apply = false, log = console.log }: { apply?: boolean; log?: (message: string) => void } = {},
) {
  let scanned = 0;
  let changed = 0;
  let conflicts = 0;
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_ARTIFACTS,
      FilterExpression: 'begins_with(PK, :intake) OR begins_with(PK, :choice)',
      ExpressionAttributeValues: { ':intake': 'GUESTINTAKE#', ':choice': 'GUESTCHOICE#' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of page.Items || []) {
      scanned += 1;
      const want = expectedKind(item);
      if (item.pendingKind === want) continue;
      changed += 1;
      log(`${apply ? 'SET' : 'DRY-RUN'} ${item.PK} status=${item.status} pendingKind=${item.pendingKind ?? '-'} -> ${want ?? '-'}`);
      if (!apply) continue;
      try {
        await client.send(new UpdateCommand({
          TableName: TABLE_ARTIFACTS,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: want ? 'SET pendingKind = :kind' : 'REMOVE pendingKind',
          // Unchanged since the scan: same status and the same version or updatedAt stamp.
          ConditionExpression: `#s = :status AND ${item.version !== undefined ? '#v = :v' : item.updatedAt !== undefined ? 'updatedAt = :u' : 'attribute_exists(PK)'}`,
          ExpressionAttributeNames: { '#s': 'status', ...(item.version !== undefined ? { '#v': 'version' } : {}) },
          ExpressionAttributeValues: {
            ':status': item.status,
            ...(want ? { ':kind': want } : {}),
            ...(item.version !== undefined ? { ':v': item.version } : item.updatedAt !== undefined ? { ':u': item.updatedAt } : {}),
          },
        }));
      } catch (error) {
        if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
        conflicts += 1;
        log(`SKIPPED ${item.PK}: changed since scan; its runtime writer already maintains pendingKind`);
      }
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  log(`${apply ? 'Applied' : 'Dry run'}: scanned=${scanned} changed=${changed - conflicts} conflicts=${conflicts}`);
  return { scanned, changed: changed - conflicts, conflicts };
}

if (require.main === module) {
  getClient()
    .then((client) => backfillGuestPendingIndex(client, { apply: process.argv.includes('--apply') }))
    .catch((error) => { console.error(error); process.exit(1); });
}
