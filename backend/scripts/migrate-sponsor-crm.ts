import { randomUUID } from "crypto";
import {
  runApprovedMigration,
  runCleanup,
  runDestinationExport,
  runOfflineDryRun,
  runRollback,
} from "../src/sponsorCrmMigration/runner";
import { DATAOPS_PRODUCTION_ORIGIN } from "../src/sponsorCrmMigration/api";
import { MigrationFailure } from "../src/sponsorCrmMigration/types";

type Arguments = {
  manifestFile?: string;
  snapshotFile?: string;
  sourceFiles: Record<string, string>;
  resolutionFile?: string;
  approvalFile?: string;
  runId: string;
  targetOrigin: string;
  confirmOrigin?: string;
  exportDestination: boolean;
  write: boolean;
  rollback: boolean;
  cleanup: boolean;
  signoffFile?: string;
  confirmCleanup?: string;
};

export function parseSponsorMigrationArguments(argv: string[]): Arguments {
  const result: Arguments = {
    sourceFiles: {},
    runId: randomUUID(),
    targetOrigin: DATAOPS_PRODUCTION_ORIGIN,
    exportDestination: false,
    write: false,
    rollback: false,
    cleanup: false,
  };
  const values: Record<string, keyof Arguments> = {
    "--manifest": "manifestFile",
    "--snapshot": "snapshotFile",
    "--resolution": "resolutionFile",
    "--approval": "approvalFile",
    "--run-id": "runId",
    "--target-origin": "targetOrigin",
    "--confirm-origin": "confirmOrigin",
    "--signoff": "signoffFile",
    "--confirm-cleanup": "confirmCleanup",
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === "--source" && value) {
      const separator = value.indexOf("=");
      if (separator < 1 || result.sourceFiles[value.slice(0, separator)])
        throw new MigrationFailure("invalid-arguments");
      result.sourceFiles[value.slice(0, separator)] = value.slice(separator + 1);
      index += 1;
    } else if (values[flag] && value) {
      (result as unknown as Record<string, unknown>)[values[flag]] = value;
      index += 1;
    } else if (flag === "--export-destination") result.exportDestination = true;
    else if (flag === "--write") result.write = true;
    else if (flag === "--rollback") result.rollback = true;
    else if (flag === "--cleanup") result.cleanup = true;
    else throw new MigrationFailure("invalid-arguments");
  }
  if (!/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result.runId))
    throw new MigrationFailure("invalid-run-id");
  if ([result.exportDestination, result.rollback, result.cleanup].filter(Boolean).length > 1)
    throw new MigrationFailure("invalid-arguments");
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseSponsorMigrationArguments(argv);
  const bearerToken = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;
  if (args.cleanup) {
    if (!args.signoffFile || !args.confirmCleanup)
      throw new MigrationFailure("invalid-arguments");
    return runCleanup({
      runId: args.runId,
      signoffFile: args.signoffFile,
      confirmRunId: args.confirmCleanup,
    });
  }
  if (args.exportDestination) {
    if (!args.confirmOrigin) throw new MigrationFailure("environment-confirmation-required");
    return runDestinationExport({
      runId: args.runId,
      targetOrigin: args.targetOrigin,
      confirmOrigin: args.confirmOrigin,
      bearerToken,
    });
  }
  if (!args.manifestFile || !args.snapshotFile)
    throw new MigrationFailure("invalid-arguments");
  const planFiles = {
    manifestFile: args.manifestFile,
    snapshotFile: args.snapshotFile,
    sourceFiles: args.sourceFiles,
    ...(args.resolutionFile ? { resolutionFile: args.resolutionFile } : {}),
  };
  if (!args.write && !args.rollback)
    return runOfflineDryRun({
      ...planFiles,
      runId: args.runId,
      targetOrigin: args.targetOrigin,
    });
  if (!args.approvalFile || !args.confirmOrigin || !args.resolutionFile)
    throw new MigrationFailure("invalid-arguments");
  const approved = {
    ...planFiles,
    runId: args.runId,
    approvalFile: args.approvalFile,
    targetOrigin: args.targetOrigin,
    confirmOrigin: args.confirmOrigin,
    bearerToken,
    backupConfirmation: process.env.DATAOPS_SPONSOR_MIGRATION_BACKUP_CONFIRMATION,
  };
  if (args.rollback)
    return runRollback({
      ...approved,
      write: args.write,
      rollbackConfirmation: process.env.DATAOPS_SPONSOR_MIGRATION_ROLLBACK_CONFIRMATION,
    });
  return runApprovedMigration(approved);
}

if (require.main === module)
  main().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      const reason = error instanceof MigrationFailure ? error.reason : "unexpected-failure";
      process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
      process.exitCode = 1;
    },
  );
