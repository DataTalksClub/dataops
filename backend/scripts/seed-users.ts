import { getClient } from '../src/db/client';
import { seedRuntimeUsers, USERS } from '../src/deploymentSeeds';

async function seed(): Promise<void> {
  await seedRuntimeUsers(await getClient());
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

export { seed, USERS };
