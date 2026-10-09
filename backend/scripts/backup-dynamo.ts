import { getClient } from '../src/db/client';
import { backupConfigFromEnv, writeRawDynamoBackup } from '../src/export/dynamoBackup';

async function main(): Promise<void> {
  const client = await getClient();
  const result = await writeRawDynamoBackup(client, backupConfigFromEnv());
  console.log(JSON.stringify({
    manifestUri: result.manifestUri,
    manifestKey: result.manifestKey,
    schemaVersion: result.manifest.schema_version,
    itemCount: result.manifest.item_count,
    tableCount: result.manifest.table_count,
    tables: Object.fromEntries(
      Object.entries(result.manifest.tables).map(([name, stats]) => [name, stats.items]),
    ),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
