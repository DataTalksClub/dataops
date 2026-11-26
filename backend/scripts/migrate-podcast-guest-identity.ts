/**
 * Migrate legacy combined `content.guestName` ("Guest Name & Role / Company")
 * into separate `guestName`, `guestRole`, and `guestCompany` fields on all
 * podcast documents (`podcast`, `podcast-guest-research`, `podcast-run-sheet`,
 * `podcast-episode-brief`).
 *
 * Usage:
 *   cd backend && npx tsx scripts/migrate-podcast-guest-identity.ts [--apply]
 *
 * Apply only while document writers are quiescent, then require open editors
 * to reload before writes resume. The conditions below protect the scanned
 * snapshot until migration; the runtime's unversioned saves cannot reject a
 * stale editor submitting old content after migration.
 */
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { cardSponsorDocIndexKey, sponsorDocKey } from '../src/db/sponsorDocs';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { transactWrite } from '../src/db/transactWrite';
import { splitCombinedGuestIdentity } from '../src/sponsorDocs/guestIdentity';

const PODCAST_TEMPLATES = new Set([
  'podcast',
  'podcast-guest-research',
  'podcast-run-sheet',
  'podcast-episode-brief',
]);

export async function migratePodcastGuestIdentity(
  client: DynamoDBDocumentClient,
  { apply = false, log = console.log }: { apply?: boolean; log?: (message: string) => void } = {},
) {
  let cursor: Record<string, unknown> | undefined;
  let scanned = 0;
  let candidates = 0;
  let updated = 0;
  let ambiguous = 0;
  let conflicts = 0;

  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_ARTIFACTS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': sponsorDocKey('').PK },
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
      log(`${apply ? 'CANDIDATE' : 'DRY-RUN'} ${item.id} (${template}); ambiguous=${split.ambiguous}`);

      if (apply && changed) {
        if (!Number.isSafeInteger(item.version) || item.version < 1 || !item.cardId) {
          throw new Error(`Document ${item.id} lacks a valid version or Card; migration stopped`);
        }
        const nextVersion = item.version + 1;
        const updatedAt = new Date().toISOString();
        const names: Record<string, string> = {
          '#content': 'content', '#version': 'version', '#template': 'template',
        };
        const values: Record<string, unknown> = {
          ':guestName': split.guestName, ':guestRole': split.guestRole, ':guestCompany': split.guestCompany,
          ':version': item.version, ':nextVersion': nextVersion, ':updatedAt': updatedAt,
          ':template': template, ':cardId': item.cardId,
        };
        const unchangedIdentity = ['guestName', 'guestRole', 'guestCompany'].map((field) => {
          names[`#${field}`] = field;
          if (!Object.hasOwn(content, field)) return `attribute_not_exists(#content.#${field})`;
          values[`:before_${field}`] = content[field];
          return `#content.#${field} = :before_${field}`;
        }).join(' AND ');
        try {
          await transactWrite(client, [
            { Update: {
              TableName: TABLE_ARTIFACTS,
              Key: { PK: item.PK, SK: item.SK },
              UpdateExpression: 'SET #content.#guestName = :guestName, #content.#guestRole = :guestRole, #content.#guestCompany = :guestCompany, #version = :nextVersion, updatedAt = :updatedAt',
              ConditionExpression: `${unchangedIdentity} AND #version = :version AND #template = :template AND cardId = :cardId`,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            } },
            { Update: {
              TableName: TABLE_ARTIFACTS,
              Key: cardSponsorDocIndexKey(item.cardId, item.id),
              UpdateExpression: 'SET #version = :nextVersion, updatedAt = :updatedAt',
              ConditionExpression: 'attribute_exists(PK) AND #version = :version',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':version': item.version, ':nextVersion': nextVersion, ':updatedAt': updatedAt },
            } },
          ]);
          updated += 1;
        } catch (error) {
          const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
          if (failure.name !== 'TransactionCanceledException'
            || !failure.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw error;
          conflicts += 1;
          log(`CONFLICT ${item.id}; document or Card index changed; reload and rerun after writers stop`);
        }
      }
    }

    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return { apply, scanned, candidates, updated, ambiguous, conflicts };
}

if (require.main === module) {
  (async () => {
    const result = await migratePodcastGuestIdentity(await getClient(), { apply: process.argv.includes('--apply') });
    console.log(JSON.stringify(result));
    if (result.conflicts) process.exitCode = 1;
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
