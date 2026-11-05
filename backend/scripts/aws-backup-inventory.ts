/**
 * Read-only AWS leftovers inventory for the DB-backups task.
 *
 * Lists RDS instances and clusters, AWS Backup vaults with their
 * recovery-point counts, and DynamoDB tables outside the stack-managed list
 * (dapier-*, restore-drill leftovers, anything unmanaged). Every AWS call is
 * a describe/list read against the ambient AWS credential chain; nothing is
 * created, modified or deleted.
 *
 * Writes one JSON evidence file under the output dir (default
 * .tmp/inventory) and prints a markdown summary. Sections the credentials
 * cannot read are recorded as errors; the rest of the inventory is still
 * produced.
 *
 * Usage: npm run inventory:aws [-- --output-dir .tmp/inventory]
 */
import fs from 'node:fs/promises';
import path from 'path';

import { getClient } from '../src/db/client';
import { REPOSITORY_ROOT, resolveProjectPath } from './project-path';
import { collectLeftoversInventory, markdownSummary } from '../src/export/awsLeftoversInventory';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const outputDir = resolveProjectPath(
    readArg('--output-dir') || path.join(REPOSITORY_ROOT, '.tmp', 'inventory'),
  );

  const inventory = await collectLeftoversInventory({
    dynamo: await getClient(),
  });

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `aws-leftovers-${inventory.generatedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  const mdPath = path.join(outputDir, 'aws-leftovers-summary.md');
  await fs.writeFile(mdPath, `${markdownSummary(inventory)}\n`, 'utf8');

  console.log(JSON.stringify({
    inventoryPath: jsonPath,
    summaryPath: mdPath,
    rdsInstances: inventory.rdsInstances.length,
    rdsClusters: inventory.rdsClusters.length,
    backupVaults: inventory.backupVaults.length,
    unmanagedDynamoTables: inventory.dynamo ? inventory.dynamo.unmanagedTables.length : null,
    restoreDrillDynamoTables: inventory.dynamo ? inventory.dynamo.restoreDrillTables.length : null,
    errors: inventory.errors,
  }, null, 2));

  if (inventory.errors.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error)?.message || 'AWS leftovers inventory failed');
  process.exit(1);
});
