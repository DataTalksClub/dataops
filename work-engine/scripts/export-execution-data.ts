import path from 'path';

import { getClient, stopLocal } from '../src/db/client';
import { createTables, shouldAutoCreateTables } from '../src/db/setup';
import { writePortableExport } from '../src/export/portable';

async function main(): Promise<void> {
  const outputDir = process.argv[2] || path.join(process.cwd(), 'exports', `dataops-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const client = await getClient();
  const shouldStopLocal = shouldAutoCreateTables();
  try {
    if (shouldStopLocal) {
      await createTables(client);
    }

    const result = await writePortableExport(client, outputDir);
    console.log(JSON.stringify({
      outputDir: result.outputDir,
      schemaVersion: result.manifest.schema_version,
      entityCounts: result.manifest.entity_counts,
    }, null, 2));
  } finally {
    if (shouldStopLocal) {
      await stopLocal();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
