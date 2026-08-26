import path from 'path';

import { writeRestoreEvidence } from '../src/export/archive';
import { REPOSITORY_ROOT, resolveProjectPath } from './project-path';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const archiveArg = readArg('--archive') || process.argv[2];
  const targetEnvironment = readArg('--target-environment') || 'local-drill';
  const expectedArchiveChecksum = readArg('--archive-checksum');
  const outputDir = resolveProjectPath(
    readArg('--output-dir') || path.join(REPOSITORY_ROOT, '.tmp', 'exports', 'restore-drill')
  );
  const smokeChecksPassed = process.argv.includes('--smoke-checks-passed');

  if (!archiveArg || !expectedArchiveChecksum) {
    console.error('Usage: npm run restore:drill -- --archive <file-or-s3-uri> --archive-checksum sha256:<hex> [--target-environment staging] [--output-dir .tmp/exports/restore-drill]');
    process.exit(2);
  }
  const archiveUri = resolveProjectPath(archiveArg);

  const result = await writeRestoreEvidence({
    archiveUri,
    expectedArchiveChecksum,
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
  console.error((err as Error)?.message || 'Restore drill failed');
  process.exit(1);
});
