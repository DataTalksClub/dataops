/**
 * Backfill high-confidence invoice/receipt evidence links.
 *
 * Usage:
 *   npx tsx scripts/backfill-bookkeeping-evidence.ts --dry-run
 *   npx tsx scripts/backfill-bookkeeping-evidence.ts --apply --log /private/path/bookkeeping-evidence.json
 *   npx tsx scripts/backfill-bookkeeping-evidence.ts --rollback --log /private/path/bookkeeping-evidence.json
 *
 * Dry-run is the default. Apply and rollback require an explicit, named AWS
 * profile; the main-temp profile and static environment credentials are
 * rejected. A private JSON log records the exact links created for rollback.
 */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createDocumentLink, deleteDocumentLink, getBookkeepingItem, listBookkeepingItems, listTransactions } from "../src/db/bookkeeping";
import type { BookkeepingItem } from "../src/db/bookkeeping";
import { getClient } from "../src/db/client";
import { planEvidenceAutoMatches, type AutoMatchDocument, type AutoMatchEvidenceLink, type AutoMatchPair, type AutoMatchTransaction } from "../src/bookkeepingAutoMatch";

const FORMAT = "dataops-bookkeeping-evidence-backfill.v1";
const REPORT_MONTH = "2026-09";

type ReceiptCounts = {
  noReceipt: number;
  transactions: number;
};

type Counts = {
  "2026-09": ReceiptCounts;
  overall: ReceiptCounts;
};

type CreatedLink = AutoMatchPair & {
  linkId: string;
  createdAt: string;
};

type BackfillLog = {
  format: typeof FORMAT;
  mode: "apply";
  startedAt: string;
  finishedAt?: string;
  before: Counts;
  planned: AutoMatchPair[];
  created: CreatedLink[];
  after?: Counts;
  rollback?: {
    at: string;
    before: Counts;
    deleted: string[];
    skipped: Array<{ linkId: string; reason: string }>;
    after: Counts;
  };
};

function parseArgs(argv: string[]) {
  const args = [...argv];
  let mode: "dry-run" | "apply" | "rollback" = "dry-run";
  let logPath = "";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--dry-run") {
      if (mode !== "dry-run") throw new Error("Choose only one of --dry-run, --apply, or --rollback");
      mode = "dry-run";
    } else if (argument === "--apply" || argument === "--rollback") {
      if (mode !== "dry-run") throw new Error("Choose only one of --dry-run, --apply, or --rollback");
      mode = argument.slice(2) as "apply" | "rollback";
    } else if (argument === "--log") {
      logPath = args[index + 1] || "";
      if (!logPath) throw new Error("--log requires a path");
      index++;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (mode !== "dry-run" && !logPath) throw new Error(`--${mode} requires --log <path>`);
  if (mode === "dry-run" && logPath) throw new Error("--log is only used by --apply or --rollback");
  return { mode, logPath: logPath ? resolve(logPath) : "" };
}

function assertSafeAwsTarget(mode: "dry-run" | "apply" | "rollback"): void {
  const profile = String(process.env.AWS_PROFILE || "").trim();
  if (profile.toLowerCase() === "main-temp") {
    throw new Error("Refusing the main-temp AWS profile");
  }
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SESSION_TOKEN) {
    throw new Error("Refusing static AWS environment credentials; use an explicit non-main-temp AWS_PROFILE");
  }
  if (!process.env.DYNAMODB_ENDPOINT && !profile) {
    throw new Error("Set an explicit non-main-temp AWS_PROFILE for a live DynamoDB target");
  }
  if (mode !== "dry-run" && !profile) {
    throw new Error("Apply/rollback requires an explicit non-main-temp AWS_PROFILE");
  }
}

function receiptCounts(
  transactions: AutoMatchTransaction[],
  links: AutoMatchEvidenceLink[],
): Counts {
  const evidence = new Set(
    links
      .filter((link) => link.coverageType === "evidence" && link.transactionId)
      .map((link) => String(link.transactionId)),
  );
  const september = transactions.filter((transaction) =>
    String(transaction.transactionDate || "").startsWith(REPORT_MONTH),
  );
  return {
    [REPORT_MONTH]: {
      transactions: september.length,
      noReceipt: september.filter((transaction) => !evidence.has(transaction.id)).length,
    },
    overall: {
      transactions: transactions.length,
      noReceipt: transactions.filter((transaction) => !evidence.has(transaction.id)).length,
    },
  };
}

async function loadData(client: Awaited<ReturnType<typeof getClient>>) {
  const [transactions, documents, links] = await Promise.all([
    listTransactions(client),
    listBookkeepingItems(client, "document"),
    listBookkeepingItems(client, "link"),
  ]);
  return {
    transactions: transactions as unknown as AutoMatchTransaction[],
    documents: documents as unknown as AutoMatchDocument[],
    links: links as unknown as AutoMatchEvidenceLink[],
  };
}

async function persistLog(path: string, log: BackfillLog, initial = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(log, null, 2)}\n`;
  if (initial) {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function assertLogDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Log already exists; choose a new private path: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function applyBackfill(
  client: Awaited<ReturnType<typeof getClient>>,
  logPath: string,
): Promise<void> {
  await assertLogDoesNotExist(logPath);
  const beforeData = await loadData(client);
  const before = receiptCounts(beforeData.transactions, beforeData.links);
  const planned = planEvidenceAutoMatches(beforeData.transactions, beforeData.documents, beforeData.links);
  const log: BackfillLog = {
    format: FORMAT,
    mode: "apply",
    startedAt: new Date().toISOString(),
    before,
    planned,
    created: [],
  };
  await persistLog(logPath, log, true);

  for (const pair of planned) {
    const result = await createDocumentLink(client, {
      documentId: pair.documentId,
      transactionId: pair.transactionId,
      coverageType: "evidence",
    });
    if (result.outcome !== "created") continue;
    log.created.push({ ...pair, linkId: String(result.item.id), createdAt: String(result.item.createdAt) });
    await persistLog(logPath, log);
  }

  const afterData = await loadData(client);
  log.finishedAt = new Date().toISOString();
  log.after = receiptCounts(afterData.transactions, afterData.links);
  await persistLog(logPath, log);
  console.log(JSON.stringify({ mode: "apply", logPath, before, planned: planned.length, created: log.created.length, after: log.after }, null, 2));
}

async function rollbackBackfill(
  client: Awaited<ReturnType<typeof getClient>>,
  logPath: string,
): Promise<void> {
  const log = JSON.parse(await readFile(logPath, "utf8")) as BackfillLog;
  if (log.format !== FORMAT || log.mode !== "apply" || !Array.isArray(log.created)) {
    throw new Error("The log is not a bookkeeping evidence backfill apply log");
  }

  const beforeData = await loadData(client);
  const before = receiptCounts(beforeData.transactions, beforeData.links);
  const deleted: string[] = [];
  const skipped: Array<{ linkId: string; reason: string }> = [];
  for (const created of log.created) {
    const current = await getBookkeepingItem(client, "link", created.linkId);
    if (!current) {
      skipped.push({ linkId: created.linkId, reason: "link is already absent" });
      continue;
    }
    if (
      current.createdAt !== created.createdAt ||
      current.transactionId !== created.transactionId ||
      current.documentId !== created.documentId ||
      current.coverageType !== "evidence"
    ) {
      skipped.push({ linkId: created.linkId, reason: "link identity or creation time changed" });
      continue;
    }
    await deleteDocumentLink(client, current as BookkeepingItem);
    deleted.push(created.linkId);
  }

  const afterData = await loadData(client);
  const after = receiptCounts(afterData.transactions, afterData.links);
  log.rollback = { at: new Date().toISOString(), before, deleted, skipped, after };
  await persistLog(logPath, log);
  console.log(JSON.stringify({ mode: "rollback", logPath, before, deleted: deleted.length, skipped, after }, null, 2));
}

async function main(): Promise<void> {
  const { mode, logPath } = parseArgs(process.argv.slice(2));
  assertSafeAwsTarget(mode);
  const client = await getClient();
  try {
    if (mode === "apply") return await applyBackfill(client, logPath);
    if (mode === "rollback") return await rollbackBackfill(client, logPath);

    const data = await loadData(client);
    const before = receiptCounts(data.transactions, data.links);
    const planned = planEvidenceAutoMatches(data.transactions, data.documents, data.links);
    const projectedAfter: Counts = {
      [REPORT_MONTH]: {
        transactions: before[REPORT_MONTH].transactions,
        noReceipt: Math.max(0, before[REPORT_MONTH].noReceipt - planned.filter((pair) =>
          data.transactions.some((transaction) => transaction.id === pair.transactionId && String(transaction.transactionDate || "").startsWith(REPORT_MONTH)),
        ).length),
      },
      overall: {
        transactions: before.overall.transactions,
        noReceipt: Math.max(0, before.overall.noReceipt - planned.length),
      },
    };
    console.log(JSON.stringify({
      mode: "dry-run",
      before,
      plannedMatches: planned.length,
      plannedPairs: planned,
      projectedAfter,
    }, null, 2));
  } finally {
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
