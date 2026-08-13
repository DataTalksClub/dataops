import path from 'path';

import { getClient, stopLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { writePortableExport } from '../src/export/portable';
import { REPOSITORY_ROOT, resolveProjectPath } from './project-path';

async function main(): Promise<void> {
  const outputDir = process.argv[2]
    ? resolveProjectPath(process.argv[2])
    : path.join(REPOSITORY_ROOT, '.tmp', 'exports', `dataops-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const client = await getClient();
  // Local-only script: npm run export:data sets IS_LOCAL=true.
  const shouldStopLocal = process.env.IS_LOCAL === 'true' || process.env.IS_LOCAL === '1';
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
