import { getClient } from '../src/db/client';
import {
  BASELINE_RECURRING_CONFIGS,
  seedRecurringConfigs,
} from '../src/deploymentSeeds';

async function seed() {
  return seedRecurringConfigs(await getClient());
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Recurring seed failed:', err);
      process.exit(1);
    });
}

export { seed, BASELINE_RECURRING_CONFIGS };
