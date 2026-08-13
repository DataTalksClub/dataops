/**
 * CLI script to run the cron runner once.
 * Usage: IS_LOCAL=true tsx scripts/cron-runner.ts
 */
import { getClient } from '../src/db/client';
import { runCron } from '../src/cron/runner';

(async () => {
  const client = await getClient();
  console.log('Running cron...');
  const result = await runCron(client);
  console.log(`Created: ${result.created.length} cards`);
  console.log(`Skipped: ${result.skipped} (duplicates)`);
  if (result.created.length > 0) {
    console.log('Card IDs:', result.created);
  }
  process.exit(0);
})();
