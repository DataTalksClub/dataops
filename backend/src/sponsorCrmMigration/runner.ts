import path from "path";
import { promises as fs } from "fs";
import { digest } from "./canonical";
import {
  SponsorMigrationApi,
  DATAOPS_PRODUCTION_ORIGIN,
  exportDestinationSnapshot,
} from "./api";
import {
  appendJournal,
  cleanupRunArtifacts,
  privateRead,
  privateRunDirectory,
  privateWrite,
} from "./artifacts";
import {
  buildRollbackPlan,
  executeMigrationPlan,
  executeRollback,
  reconcileMigrationPlan,
  validateApprovedDestinationState,
} from "./execution";
import {
  readPrivateJson,
  sourceFileDigest,
  validateDestinationSnapshot,
  validateResolutionManifest,
  validateSourceData,
  validateSourceManifest,
} from "./manifest";
import {
  applyResolutions,
  buildMigrationPlan,
  migrationCounts,
  redactedPlan,
} from "./planner";
import {
  MigrationFailure,
  type DestinationSnapshot,
  type MigrationCheckpoint,
  type MigrationPlan,
  type ResolutionManifest,
  type ReviewedApproval,
  type RollbackPlan,
  type SourceManifest,
  type SponsorSourceV1,
} from "./types";

const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

type PlanFiles = {
  manifestFile: string;
  snapshotFile: string;
  sourceFiles: Record<string, string>;
  resolutionFile?: string;
};

type LoadedPlan = {
  manifest: SourceManifest;
  manifestDigest: string;
  snapshot: DestinationSnapshot;
  snapshotDigest: string;
  resolution?: ResolutionManifest;
  resolutionDigest?: string;
  unresolvedPlan: MigrationPlan;
  plan: MigrationPlan;
};

async function loadPlan(files: PlanFiles): Promise<LoadedPlan> {
  const manifest = validateSourceManifest(await readPrivateJson(files.manifestFile));
  const manifestDigest = await sourceFileDigest(files.manifestFile);
  const expectedSources = new Set(manifest.sources.map((source) => source.id));
  if (
    Object.keys(files.sourceFiles).length !== expectedSources.size ||
    Object.keys(files.sourceFiles).some((sourceId) => !expectedSources.has(sourceId))
  ) throw new MigrationFailure("source-set-mismatch");
  const sources: { manifest: SourceManifest["sources"][number]; data: SponsorSourceV1 }[] = [];
  for (const source of manifest.sources) {
    const file = files.sourceFiles[source.id];
    if (!file || await sourceFileDigest(file) !== source.sha256)
      throw new MigrationFailure("source-digest-mismatch");
    const data = validateSourceData(await readPrivateJson(file, 64 * 1024 * 1024));
    const observedDates = [
      ...data.organizations.flatMap((item) => item.observedAt ? [item.observedAt] : []),
      ...data.contacts.flatMap((item) => item.observedAt ? [item.observedAt] : []),
      ...data.bookings.flatMap((item) =>
        item.plannedPublicationDate ? [item.plannedPublicationDate] :
          item.observedAt ? [item.observedAt] : []),
    ].sort();
    if (
      (observedDates.length === 0 &&
        (source.observedEarliest !== undefined || source.observedLatest !== undefined)) ||
      (observedDates.length > 0 &&
        (source.observedEarliest !== observedDates[0] ||
          source.observedLatest !== observedDates.at(-1)))
    ) throw new MigrationFailure("source-date-boundary-mismatch");
    sources.push({ manifest: source, data });
  }
  const snapshot = validateDestinationSnapshot(await readPrivateJson(files.snapshotFile));
  const snapshotDigest = digest(snapshot);
  if (snapshotDigest !== manifest.destinationSnapshotSha256)
    throw new MigrationFailure("destination-snapshot-digest-mismatch");
  const unresolvedPlan = buildMigrationPlan({
    manifest,
    manifestDigest,
    destinationSnapshot: snapshot,
    destinationSnapshotDigest: snapshotDigest,
    sources,
  });
  if (!files.resolutionFile)
    return {
      manifest, manifestDigest, snapshot, snapshotDigest,
      unresolvedPlan, plan: unresolvedPlan,
    };
  const resolution = validateResolutionManifest(await readPrivateJson(files.resolutionFile));
  const resolutionDigest = await sourceFileDigest(files.resolutionFile);
  return {
    manifest, manifestDigest, snapshot, snapshotDigest, resolution, resolutionDigest,
    unresolvedPlan,
    plan: applyResolutions(unresolvedPlan, resolution, snapshot),
  };
}

function approvalIsValid(value: unknown, allowTestOrigin = false): value is ReviewedApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const approval = value as ReviewedApproval;
  return (
    Object.keys(approval).every((key) => [
      "schemaVersion", "runId", "targetOrigin", "expiresAt", "manifestDigest",
      "resolutionDigest", "planDigest", "destinationSnapshotDigest",
    ].includes(key)) &&
    approval.schemaVersion === 1 && RUN_ID.test(approval.runId) &&
    (allowTestOrigin
      ? (() => { try { return new URL(approval.targetOrigin).protocol === "https:"; } catch { return false; } })()
      : approval.targetOrigin === DATAOPS_PRODUCTION_ORIGIN) &&
    Number.isFinite(Date.parse(approval.expiresAt)) &&
    [approval.manifestDigest, approval.resolutionDigest, approval.planDigest,
      approval.destinationSnapshotDigest].every((value) => HASH.test(value))
  );
}

function validateBackupConfirmation(
  serialized: string | undefined,
  origin: string,
  now: Date,
) {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(serialized || "") as Record<string, unknown>;
  } catch {
    throw new MigrationFailure("backup-confirmation-required");
  }
  if (
    Object.keys(value).some((key) => ![
      "confirmed", "targetOrigin", "confirmedAt", "crmBackupIdHash",
      "newsletterBackupIdHash", "approvedByRef",
    ].includes(key)) ||
    value.confirmed !== true || value.targetOrigin !== origin ||
    typeof value.confirmedAt !== "string" ||
    !HASH.test(String(value.crmBackupIdHash || "")) ||
    !HASH.test(String(value.newsletterBackupIdHash || "")) ||
    !OPAQUE.test(String(value.approvedByRef || ""))
  ) throw new MigrationFailure("backup-confirmation-required");
  const confirmedAt = Date.parse(value.confirmedAt);
  if (
    !Number.isFinite(confirmedAt) || confirmedAt > now.getTime() ||
    now.getTime() - confirmedAt > 24 * 60 * 60 * 1000
  ) throw new MigrationFailure("fresh-backup-confirmation-required");
}

async function loadCheckpoint(
  directory: string,
  runId: string,
  loaded: LoadedPlan,
): Promise<MigrationCheckpoint> {
  const file = path.join(directory, "checkpoint.json");
  const exists = await fs.lstat(file).catch(() => null);
  if (!exists)
    return {
      schemaVersion: 1,
      runId,
      manifestDigest: loaded.manifestDigest,
      resolutionDigest: loaded.resolutionDigest!,
      planDigest: loaded.plan.planDigest,
      operations: {},
    };
  const value = await privateRead(file) as MigrationCheckpoint;
  if (
    value.schemaVersion !== 1 || value.runId !== runId ||
    value.manifestDigest !== loaded.manifestDigest ||
    value.resolutionDigest !== loaded.resolutionDigest ||
    value.planDigest !== loaded.plan.planDigest ||
    !value.operations || typeof value.operations !== "object" ||
    Array.isArray(value.operations)
  ) throw new MigrationFailure("stale-checkpoint");
  return value;
}

export async function runOfflineDryRun(input: PlanFiles & {
  runId: string;
  targetOrigin?: string;
  now?: Date;
}) {
  const now = input.now || new Date();
  const loaded = await loadPlan(input);
  const directory = await privateRunDirectory(input.runId);
  await privateWrite(path.join(directory, "plan.json"), redactedPlan(loaded.plan));
  await privateWrite(path.join(directory, "summary.json"), {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: now.toISOString(),
    manifestDigest: loaded.manifestDigest,
    destinationSnapshotDigest: loaded.snapshotDigest,
    ...(loaded.resolutionDigest ? { resolutionDigest: loaded.resolutionDigest } : {}),
    planDigest: loaded.plan.planDigest,
    counts: migrationCounts(loaded.plan),
    deleteArtifactsBy: new Date(now.getTime() + 30 * 86400000).toISOString(),
    retainBackupsUntilAfterSignoffDays: 35,
  });
  const unresolved = loaded.plan.operations.filter((item) => item.action === "quarantine").length;
  let approvalReady = false;
  if (loaded.resolutionDigest && unresolved === 0) {
    const approval: ReviewedApproval = {
      schemaVersion: 1,
      runId: input.runId,
      targetOrigin: input.targetOrigin || DATAOPS_PRODUCTION_ORIGIN,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      manifestDigest: loaded.manifestDigest,
      resolutionDigest: loaded.resolutionDigest,
      planDigest: loaded.plan.planDigest,
      destinationSnapshotDigest: loaded.snapshotDigest,
    };
    if (approval.targetOrigin !== DATAOPS_PRODUCTION_ORIGIN)
      throw new MigrationFailure("invalid-api-origin");
    await privateWrite(path.join(directory, "approval.json"), approval);
    await privateWrite(
      path.join(directory, "rollback-plan.json"),
      buildRollbackPlan(input.runId, loaded.plan),
    );
    approvalReady = true;
  }
  await appendJournal(directory, {
    kind: "offline-dry-run",
    at: now.toISOString(),
    planDigest: loaded.plan.planDigest,
    unresolved,
    approvalReady,
  });
  return {
    mode: "offline-dry-run",
    runId: input.runId,
    manifestDigest: loaded.manifestDigest,
    destinationSnapshotDigest: loaded.snapshotDigest,
    planDigest: loaded.plan.planDigest,
    ...(loaded.resolutionDigest ? { resolutionDigest: loaded.resolutionDigest } : {}),
    counts: migrationCounts(loaded.plan),
    approvalReady,
  };
}

async function validateApprovedRun(input: PlanFiles & {
  runId: string;
  approvalFile: string;
  targetOrigin: string;
  confirmOrigin: string;
  bearerToken?: string;
  backupConfirmation?: string;
  now?: Date;
  allowTestOrigin?: boolean;
  requestFetch?: typeof fetch;
  allowExpiredApproval?: boolean;
}) {
  const now = input.now || new Date();
  const loaded = await loadPlan(input);
  if (!loaded.resolution || !loaded.resolutionDigest)
    throw new MigrationFailure("resolution-manifest-required");
  if (loaded.plan.operations.some((item) => item.action === "quarantine"))
    throw new MigrationFailure("unresolved-conflicts");
  const directory = await privateRunDirectory(input.runId);
  if (path.resolve(input.approvalFile) !== path.join(directory, "approval.json"))
    throw new MigrationFailure("unsafe-approval-file");
  const approvalValue = await privateRead(input.approvalFile);
  if (!approvalIsValid(approvalValue, input.allowTestOrigin))
    throw new MigrationFailure("stale-dry-run-approval");
  const approval = approvalValue;
  const checkpoint = await loadCheckpoint(directory, input.runId, loaded);
  const runStarted = Object.keys(checkpoint.operations).length > 0;
  if (
    approval.runId !== input.runId ||
    approval.targetOrigin !== input.targetOrigin ||
    input.confirmOrigin !== input.targetOrigin ||
    (!input.allowExpiredApproval && !runStarted &&
      Date.parse(approval.expiresAt) <= now.getTime()) ||
    approval.manifestDigest !== loaded.manifestDigest ||
    approval.resolutionDigest !== loaded.resolutionDigest ||
    approval.planDigest !== loaded.plan.planDigest ||
    approval.destinationSnapshotDigest !== loaded.snapshotDigest
  ) throw new MigrationFailure("stale-dry-run-approval");
  validateBackupConfirmation(input.backupConfirmation, input.targetOrigin, now);
  if (!input.bearerToken) throw new MigrationFailure("operator-credential-required");
  const api = SponsorMigrationApi.create({
    origin: input.targetOrigin,
    bearerToken: input.bearerToken,
    allowTestOrigin: input.allowTestOrigin,
    requestFetch: input.requestFetch,
    sleep: input.allowTestOrigin ? async () => undefined : undefined,
  });
  return { loaded, directory, approval, api, now, checkpoint };
}

export async function runApprovedMigration(input: PlanFiles & {
  runId: string;
  approvalFile: string;
  targetOrigin: string;
  confirmOrigin: string;
  bearerToken?: string;
  backupConfirmation?: string;
  now?: Date;
  allowTestOrigin?: boolean;
  requestFetch?: typeof fetch;
}) {
  // Every local approval/credential/backup gate above is evaluated before api is
  // created or any method capable of network access is called.
  const prepared = await validateApprovedRun(input);
  const { loaded, directory, api, now, checkpoint } = prepared;
  await api.preflight();
  const rollbackPlan = buildRollbackPlan(input.runId, loaded.plan);
  await privateWrite(path.join(directory, "rollback-plan.json"), rollbackPlan);
  const currentSnapshot = await exportDestinationSnapshot(
    api, new Date(loaded.snapshot.generatedAt),
  );
  if (!Object.keys(checkpoint.operations).length) {
    if (digest(currentSnapshot) !== loaded.snapshotDigest)
      throw new MigrationFailure("destination-changed-after-approval");
  } else {
    validateApprovedDestinationState({
      approved: loaded.snapshot,
      current: currentSnapshot,
      plan: loaded.plan,
      checkpoint,
    });
  }
  const persist = async (value: MigrationCheckpoint) => {
    await privateWrite(path.join(directory, "checkpoint.json"), value);
  };
  try {
    await executeMigrationPlan({
      api, plan: loaded.plan, checkpoint, persistCheckpoint: persist,
    });
    const reconciliation = await reconcileMigrationPlan(api, loaded.plan);
    await privateWrite(path.join(directory, "reconciliation.json"), {
      schemaVersion: 1,
      runId: input.runId,
      at: now.toISOString(),
      planDigest: loaded.plan.planDigest,
      ...reconciliation,
    });
    await appendJournal(directory, {
      kind: "migration-complete",
      at: now.toISOString(),
      planDigest: loaded.plan.planDigest,
      ...reconciliation,
    });
    return { mode: "write", runId: input.runId, ...reconciliation };
  } catch (error) {
    await appendJournal(directory, {
      kind: "migration-stopped",
      at: now.toISOString(),
      reason: error instanceof MigrationFailure ? error.reason : "unexpected-failure",
    });
    throw error;
  }
}

export async function runRollback(input: PlanFiles & {
  runId: string;
  approvalFile: string;
  targetOrigin: string;
  confirmOrigin: string;
  bearerToken?: string;
  backupConfirmation?: string;
  write: boolean;
  rollbackConfirmation?: string;
  now?: Date;
  allowTestOrigin?: boolean;
  requestFetch?: typeof fetch;
}) {
  const prepared = await validateApprovedRun({ ...input, allowExpiredApproval: true });
  if (input.write && input.rollbackConfirmation !== input.runId)
    throw new MigrationFailure("rollback-confirmation-required");
  const rollbackValue = await privateRead(
    path.join(prepared.directory, "rollback-plan.json"),
  ) as RollbackPlan;
  const expected = buildRollbackPlan(input.runId, prepared.loaded.plan);
  if (digest(rollbackValue) !== digest(expected))
    throw new MigrationFailure("stale-rollback-plan");
  await prepared.api.preflight();
  const result = await executeRollback({
    api: prepared.api,
    migrationPlan: prepared.loaded.plan,
    rollbackPlan: rollbackValue,
    write: input.write,
  });
  await privateWrite(
    path.join(prepared.directory, input.write ? "rollback-result.json" : "rollback-preview.json"),
    {
      schemaVersion: 1, runId: input.runId, at: prepared.now.toISOString(),
      write: input.write, ...result,
    },
  );
  return { mode: input.write ? "rollback-write" : "rollback-preview", runId: input.runId, ...result };
}

export async function runDestinationExport(input: {
  runId: string;
  targetOrigin: string;
  confirmOrigin: string;
  bearerToken?: string;
  allowTestOrigin?: boolean;
  requestFetch?: typeof fetch;
  now?: Date;
}) {
  if (input.confirmOrigin !== input.targetOrigin)
    throw new MigrationFailure("environment-confirmation-required");
  if (!input.bearerToken) throw new MigrationFailure("operator-credential-required");
  const api = SponsorMigrationApi.create({
    origin: input.targetOrigin,
    bearerToken: input.bearerToken,
    allowTestOrigin: input.allowTestOrigin,
    requestFetch: input.requestFetch,
    sleep: input.allowTestOrigin ? async () => undefined : undefined,
  });
  const snapshot = await exportDestinationSnapshot(api, input.now || new Date());
  const directory = await privateRunDirectory(input.runId);
  await privateWrite(path.join(directory, "destination-snapshot.json"), snapshot);
  const snapshotDigest = digest(snapshot);
  return {
    mode: "destination-export",
    runId: input.runId,
    destinationSnapshotDigest: snapshotDigest,
    counts: {
      organizations: snapshot.organizations.length,
      contacts: snapshot.contacts.length,
      bookings: snapshot.bookings.length,
      newsletterSlots: snapshot.newsletterSlots.length,
    },
  };
}

export async function runCleanup(input: {
  runId: string;
  signoffFile: string;
  confirmRunId: string;
  now?: Date;
}) {
  const signoff = await readPrivateJson(input.signoffFile) as Record<string, unknown>;
  if (
    Object.keys(signoff).some((key) =>
      !["schemaVersion", "runId", "signedOffAt", "approvedByRef"].includes(key)) ||
    signoff.schemaVersion !== 1 || signoff.runId !== input.runId ||
    typeof signoff.signedOffAt !== "string" ||
    !OPAQUE.test(String(signoff.approvedByRef || ""))
  ) throw new MigrationFailure("invalid-human-signoff");
  return cleanupRunArtifacts({
    runId: input.runId,
    signoffAt: signoff.signedOffAt,
    now: input.now,
    confirmRunId: input.confirmRunId,
  });
}
