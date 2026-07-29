import { dryRunImport } from '../src/export/portable';
import { resolveProjectPath } from './project-path';

async function main(): Promise<void> {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error('Usage: npm run dry-run:import -- <export-dir>');
    process.exit(2);
  }

  const result = await dryRunImport(resolveProjectPath(exportDir));
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
