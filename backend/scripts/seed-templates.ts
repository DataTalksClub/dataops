import { resolve } from 'node:path';

import { getClient, startLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  findAuthoredTemplatesRoot,
  loadAuthoredTemplatesFromDirectory,
  reconcileAuthoredTemplates,
} from '../src/templates/authoredTemplates';

function shouldUseLocalDynamo(): boolean {
  return (
    process.env.IS_LOCAL === 'true'
    || process.env.IS_LOCAL === '1'
    || process.env.NODE_ENV === 'test'
    || process.env.NODE_ENV === 'local'
    || Boolean(process.env.DYNAMODB_ENDPOINT)
  );
}

/** Project a local private-repository checkout into local DynamoDB. */
async function seed(templateRoot?: string): Promise<void> {
  const useLocalDynamo = shouldUseLocalDynamo();
  const port = useLocalDynamo && !process.env.DYNAMODB_ENDPOINT
    ? await startLocal()
    : undefined;
  const client = await getClient(port);
  if (useLocalDynamo) await createTables(client);

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
