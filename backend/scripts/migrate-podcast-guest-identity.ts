/**
 * Migrate legacy combined `content.guestName` ("Guest Name & Role / Company")
 * into separate `guestName`, `guestRole`, and `guestCompany` fields on all
 * podcast documents (`podcast`, `podcast-guest-research`, `podcast-run-sheet`,
 * `podcast-episode-brief`).
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-podcast-guest-identity.ts [--apply]
 */
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { splitCombinedGuestIdentity } from '../src/sponsorDocs/guestIdentity';

const PODCAST_TEMPLATES = new Set([
  'podcast',
  'podcast-guest-research',
  'podcast-run-sheet',
  'podcast-episode-brief',
]);

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await getClient();

  let cursor: Record<string, unknown> | undefined;
  let scanned = 0;
  let candidates = 0;
  let updated = 0;
  let ambiguous = 0;

  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_ARTIFACTS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'SPONSORDOC#' },
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));

    for (const item of page.Items || []) {
      scanned += 1;
      const template = String(item.template || '');
      if (!PODCAST_TEMPLATES.has(template)) continue;
      const content = (item.content && typeof item.content === 'object')
        ? (item.content as Record<string, unknown>)
        : {};
      const rawName = String(content.guestName || '').trim();
      const hasRole = String(content.guestRole || '').trim().length > 0;
      const hasCompany = String(content.guestCompany || '').trim().length > 0;
      if (!rawName || hasRole || hasCompany) continue;

      const split = splitCombinedGuestIdentity(rawName);
      const changed = split.guestName !== rawName || split.guestRole.length > 0 || split.guestCompany.length > 0;
      if (!changed && !split.ambiguous) continue;

      candidates += 1;
      if (split.ambiguous) ambiguous += 1;
      console.log(
        `${apply ? 'UPDATE' : 'DRY-RUN'} ${item.id} (${template}):`,
        JSON.stringify({
          before: rawName,
          after: {
            guestName: split.guestName,
            guestRole: split.guestRole,
            guestCompany: split.guestCompany,
          },
          ambiguous: split.ambiguous,
        }),
      );

      if (apply && changed) {
        const nextContent = {
          ...content,
          guestName: split.guestName,
          guestRole: split.guestRole,
          guestCompany: split.guestCompany,
        };
        await client.send(new UpdateCommand({
          TableName: TABLE_ARTIFACTS,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: 'SET content = :content',
          ExpressionAttributeValues: { ':content': nextContent },
        }));
        updated += 1;
      }
    }

    cursor = page.LastEvaluatedKey;
  } while (cursor);

  console.log(JSON.stringify({ apply, scanned, candidates, updated, ambiguous }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
