import { resolve } from 'node:path';

import { getClient } from '../src/db/client';
import {
  findAuthoredTemplatesRoot,
  loadAuthoredTemplatesFromDirectory,
  reconcileAuthoredTemplates,
} from '../src/templates/authoredTemplates';

/** Project a local private-repository checkout into local DynamoDB. */
async function seed(templateRoot?: string): Promise<void> {
  const client = await getClient();

  const repoRoot = resolve(__dirname, '..', '..');
  const root = templateRoot || findAuthoredTemplatesRoot(repoRoot);
  const authored = loadAuthoredTemplatesFromDirectory(root);
  const result = await reconcileAuthoredTemplates(client, authored);
  console.log(
    `Template projection complete. total=${result.total} created=${result.created} `
    + `updated=${result.updated} unchanged=${result.unchanged}`,
  );
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('Template projection failed:', (error as Error).message);
      process.exit(1);
    });
}

export { seed };
