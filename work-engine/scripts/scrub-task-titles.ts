#!/usr/bin/env node

/**
 * One-time data cleanup: strip leaked Trello shortLink suffixes (e.g.
 * "p3by19", "qVB6fAUG") from stored task `description` values.
 *
 * Background: a legacy Trello import accidentally appended each card's
 * shortLink to the task description. No runtime path produces these tokens
 * (templates/recurring/cron all copy descriptions verbatim), so the suffix is
 * stale data, not a run id. This script scrubs it at the storage layer; the
 * frontend also sanitizes defensively in workTaskTitle() (see frontend/src/app.js
 * and issue #91).
 *
 * Idempotent: stripping is a pure function of the description, so re-running on
 * already-clean data changes nothing (a clean description has no matching token
 * and is returned verbatim). A second run therefore reports zero changes.
 *
 * Usage:
 *   IS_LOCAL=true tsx scripts/scrub-task-titles.ts [--dry-run]
 *
 * Flags:
 *   --dry-run  Print what would change without writing to the DB.
 *
 * Run against the same environment that holds the migrated data (local
 * persistent dynalite, or a configured DynamoDB endpoint via IS_LOCAL /
 * DYNAMODB_ENDPOINT).
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal } from '../src/db/client';
import { TABLE_TASKS } from '../src/db/setup';
import { updateTask } from '../src/db/tasks';
import type { Task } from '../src/types';

// ---------------------------------------------------------------------------
// Pure title scrubber — kept IDENTICAL in intent to frontend stripTitleSuffix()
// in frontend/src/app.js. If you change the matching rule here, change it there.
// ---------------------------------------------------------------------------

// A leaked Trello shortLink token: 4-8 alphanumeric chars that mix a letter and
// a digit, sitting alone after a preceding word. A bare token with no prior
// sentence is left alone so a standalone id is not blanked.
const TRAILING_SHORT_ID = /^(.+[ ].+)[ \t]+([a-zA-Z0-9]{4,8})$/;

/**
 * Strip a leaked Trello shortLink suffix from a task title/description.
 *
 * Returns the value unchanged when it is null/undefined/empty/numeric or has no
 * matching suffix. Never throws.
 */
export function scrubTaskTitle(value: unknown): string {
  if (value == null) return '';
  const title = typeof value === 'string' ? value : String(value);
  const match = title.match(TRAILING_SHORT_ID);
  if (!match) return title;
  const [, head, token] = match;
  // Only strip when the trailing token itself mixes a letter and a digit.
  // All-letters ("guest", "Alice") and all-digits ("2026") words are kept.
  if (/[a-zA-Z]/.test(token) && /[0-9]/.test(token)) return head.trimEnd();
  return title;
}

// ---------------------------------------------------------------------------
// DB scrubber
// ---------------------------------------------------------------------------

export interface ScrubReport {
  scanned: number;
  changed: number;
  changedTaskIds: string[];
  dryRun: boolean;
}

/**
 * Scan every task, strip a leaked suffix from `description` where present, and
 * persist the change. Idempotent: re-running on already-scrubbed data performs
 * zero writes because scrubTaskTitle() returns clean descriptions unchanged.
 *
 * Pass a null client to plan changes without touching the DB (used by tests and
 * --dry-run).
 */
export async function scrubStoredTaskTitles(
  client: DynamoDBDocumentClient | null,
  tasks?: Task[]
): Promise<ScrubReport> {
  const dryRun = client === null;
  const scanned = tasks ?? (await scanAllTasks(client as DynamoDBDocumentClient));

  const changedTaskIds: string[] = [];
  for (const task of scanned) {
    const original = task.description;
    if (typeof original !== 'string') continue;
    const cleaned = scrubTaskTitle(original);
    if (cleaned === original || !task.id) continue;
    changedTaskIds.push(task.id);
    if (!dryRun) {
      await updateTask(client as DynamoDBDocumentClient, task.id, { description: cleaned });
    }
  }

  return {
    scanned: scanned.length,
    changed: changedTaskIds.length,
    changedTaskIds,
    dryRun,
  };
}

async function scanAllTasks(client: DynamoDBDocumentClient): Promise<Task[]> {
  const tasks: Task[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_TASKS,
        FilterExpression: 'begins_with(PK, :taskPrefix)',
        ExpressionAttributeValues: { ':taskPrefix': 'TASK#' },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    for (const item of result.Items || []) {
      const { PK, SK, ...rest } = item as Record<string, unknown>;
      tasks.push(rest as unknown as Task);
    }
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);
  return tasks;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  console.log('=== DataOps task-title suffix scrub ===');
  if (dryRun) console.log('** DRY RUN - no data will be written **\n');

  let client: DynamoDBDocumentClient | null = null;
  if (!dryRun) {
    console.log('Starting local DynamoDB (persistent)...');
    const port = await startLocal();
    client = await getClient(port);
    console.log('  DB ready.');
  }

  const report = await scrubStoredTaskTitles(client);
  console.log(`\nScanned tasks:  ${report.scanned}`);
  console.log(`Changed tasks:  ${report.changed}`);
  if (report.changed > 0 && report.changed <= 50) {
    console.log('Changed ids:');
    for (const id of report.changedTaskIds) console.log(`  - ${id}`);
  }
  console.log(dryRun ? '\nDry run complete. Re-run without --dry-run to apply.' : '\nScrub complete.');
}

// Only run main() when executed directly (not when imported for testing).
const isDirectExecution =
  process.argv[1]?.endsWith('scrub-task-titles.ts') || process.argv[1]?.endsWith('scrub-task-titles.js');
if (isDirectExecution) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Scrub failed:', err);
      process.exit(1);
    });
}
