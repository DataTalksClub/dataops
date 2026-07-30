import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { MigrationFailure } from "./types";

const RUN_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

async function projectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  for (;;) {
    const git = await fs.lstat(path.join(current, ".git")).catch(() => null);
    const backend = await fs.lstat(path.join(current, "backend")).catch(() => null);
    if (git && backend?.isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new MigrationFailure("project-root-not-found");
    current = parent;
  }
}

async function secureDirectory(directory: string, parent: string) {
  const relative = path.relative(parent, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new MigrationFailure("unsafe-artifact-directory");
  let stat = await fs.lstat(directory).catch(() => null);
  if (!stat) {
    await fs.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    stat = await fs.lstat(directory);
  }
  if (
    !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new MigrationFailure("unsafe-artifact-directory");
}

export async function migrationArtifactRoot() {
  const root = await projectRoot();
  const temporary = path.join(root, ".tmp");
  let temporaryStat = await fs.lstat(temporary).catch(() => null);
  if (!temporaryStat) {
    await fs.mkdir(temporary, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    temporaryStat = await fs.lstat(temporary);
  }
  if (
    !temporaryStat.isDirectory() || temporaryStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && temporaryStat.uid !== process.getuid())
  ) throw new MigrationFailure("unsafe-artifact-root");
  const migrations = path.join(temporary, "migrations");
  await secureDirectory(migrations, temporary);
  const sponsor = path.join(migrations, "sponsor-crm");
  await secureDirectory(sponsor, migrations);
  return sponsor;
}

export async function privateRunDirectory(runId: string) {
  if (!RUN_ID.test(runId)) throw new MigrationFailure("invalid-run-id");
  const root = await migrationArtifactRoot();
  const directory = path.join(root, runId);
  await secureDirectory(directory, root);
  return directory;
}

export async function privateWrite(file: string, value: unknown) {
  const directory = path.dirname(file);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new MigrationFailure("unsafe-artifact-directory");
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

export async function privateRead(file: string) {
  const stat = await fs.lstat(file).catch(() => null);
  if (
    !stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) throw new MigrationFailure("unsafe-artifact-file");
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    throw new MigrationFailure("invalid-artifact-file");
  }
}

export async function appendJournal(directory: string, event: Record<string, unknown>) {
  const file = path.join(directory, "journal.ndjson");
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

export async function cleanupRunArtifacts(input: {
  runId: string;
  signoffAt: string;
  now?: Date;
  confirmRunId: string;
}) {
  if (input.confirmRunId !== input.runId) throw new MigrationFailure("cleanup-confirmation-required");
  const signoff = Date.parse(input.signoffAt), now = (input.now || new Date()).getTime();
  if (!Number.isFinite(signoff) || signoff > now)
    throw new MigrationFailure("artifact-cleanup-window-invalid");
  const root = await migrationArtifactRoot();
  const directory = path.join(root, input.runId);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new MigrationFailure("unsafe-artifact-directory");
  await fs.rm(directory, { recursive: true });
  return {
    runId: input.runId,
    artifactsDeleted: true,
    cleanupOverdue: now - signoff > 30 * 86400000,
    backupDeleteEligibleAt: new Date(signoff + 35 * 86400000).toISOString(),
    backupDeletionRequiresHumanApproval: true,
  };
}
