import path from 'path';

import { writeRestoreEvidence } from '../src/export/archive';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const archiveUri = readArg('--archive') || process.argv[2];
  const targetEnvironment = readArg('--target-environment') || 'local-drill';
  const outputDir = readArg('--output-dir') || path.join(process.cwd(), '..', '.tmp', 'exports', 'restore-drill');
  const smokeChecksPassed = process.argv.includes('--smoke-checks-passed');

  if (!archiveUri) {
    console.error('Usage: npm run restore:drill -- --archive <file-or-s3-uri> [--target-environment staging] [--output-dir .tmp/exports/restore-drill]');
    process.exit(2);
  }

  const result = await writeRestoreEvidence({
    archiveUri,
    outputDir,
    targetEnvironment,
    smokeChecksPassed,
  });

  console.log(JSON.stringify({
    evidencePath: result.evidencePath,
    extractedDir: result.extractedDir,
    archiveUri: result.report.archive_uri,
    exportGeneratedAt: result.report.export_generated_at,
    validationValid: result.report.validation.valid,
    dryRunTotalRecords: result.report.dry_run_import.totalRecords,
    targetEnvironment: result.report.target_environment,
  }, null, 2));

  if (!result.report.validation.valid || !result.report.dry_run_import.valid) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
