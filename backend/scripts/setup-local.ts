/**
 * The single supported local database setup entry point.
 *
 * Runtime code only connects to declared infrastructure. This script owns the
 * local exception: loopback dynalite, the complete table schema, and supported
 * seed projections. Persistent mode stores data under backend/.data so setup
 * can close cleanly and a later development server can reopen the same state.
 */
import { setupLocalDynamo, stopLocal } from './local-dynamodb';
import { seed as seedUsers } from './seed-users';
import { seed as seedTemplates } from './seed-templates';
import { seed as seedRecurring } from './seed-recurring';

type LocalSetupOptions = {
  persistent?: boolean;
  seed?: boolean;
};

async function setupLocalEnvironment(options: LocalSetupOptions = {}): Promise<void> {
  const persistent = options.persistent ?? true;
  const shouldSeed = options.seed ?? true;

  await setupLocalDynamo({ persistent });
  if (!shouldSeed) return;

  await seedUsers();
  await seedTemplates();
  await seedRecurring();
}

async function main(): Promise<void> {
  try {
    await setupLocalEnvironment({ persistent: true, seed: true });
    console.log('Local DynamoDB schema and seed data are ready.');
  } finally {
    await stopLocal();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Local setup failed:', (error as Error).message);
    process.exitCode = 1;
  });
}

export { setupLocalEnvironment };
