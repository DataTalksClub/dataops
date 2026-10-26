/**
 * Migrate newsletter performance metrics from the retired tracking spreadsheet
 * shape to the DataOps shape.
 *
 * 1. Issue stats rename: `stats.deliveries` -> `stats.sent`. The API rejects
 *    the old field on write, so every issue still carrying `deliveries` is
 *    rewritten with a version-guarded PUT (the value is preserved, only the
 *    key changes).
 * 2. Open metrics tasks: Tasks with templateTaskRef `add-newsletter-performance`
 *    still titled "Add newsletter performance on the spreadsheet" are renamed
 *    to "Add newsletter performance metrics in DataOps".
 *
 * Idempotent: an issue without `stats.deliveries` and a task that already has
 * the new name are skipped. Dry-run (default) resolves everything and reports
 * counts without writing.
 *
 * Usage:
 *   tsx scripts/newsletter-metrics-migrate.ts --dry-run [--api-base-url URL] [--token TOKEN]
 *   tsx scripts/newsletter-metrics-migrate.ts --apply [--report PATH] [--out-json PATH]
 *
 * Auth: DATAOPS_TOKEN or ~/.config/dataops/import.token (same as
 * crm-followup-migrate). Needs a credential with work read/write scope.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ORIGIN = 'https://ops.dtcdev.click';
export const OLD_TASK_NAME = 'Add newsletter performance on the spreadsheet';
export const NEW_TASK_NAME = 'Add newsletter performance metrics in DataOps';
export const METRICS_TASK_REF = 'add-newsletter-performance';

/** The renamed issue stats when the old `deliveries` key is present, else null (nothing to migrate). */
export function renamedIssueStats(stats: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
  if ((stats as Record<string, unknown>).deliveries == null) return null;
  const { deliveries, ...rest } = stats as Record<string, unknown> & { deliveries: unknown };
  return { ...rest, sent: deliveries };
}

/** Whether an open task still carries the retired spreadsheet name. */
export function taskNeedsRename(task: { templateTaskRef?: unknown; description?: unknown }): boolean {
  return task?.templateTaskRef === METRICS_TASK_REF && task?.description === OLD_TASK_NAME;
}

async function apiFetch(origin: string, token: string, route: string, init: RequestInit = {}) {
  const res = await fetch(`${origin}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`API ${init.method || 'GET'} ${route}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function listAllIssues(origin: string, token: string) {
  const data = await apiFetch(origin, token, '/api/newsletter-issues?from=2000-01-01');
  return Array.isArray(data.items) ? data.items : [];
}

async function listOpenTasks(origin: string, token: string) {
  const tasks: any[] = [];
  for (const status of ['todo', 'waiting']) {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({ status, limit: '100', ...(cursor ? { cursor } : {}) });
      const pageData = await apiFetch(origin, token, `/api/tasks?${query.toString()}`);
      const items = Array.isArray(pageData.items) ? pageData.items : [];
      tasks.push(...items);
      cursor = pageData.nextCursor || undefined;
      if (!cursor) break;
    }
  }
  return tasks;
}

export async function main(argv = process.argv.slice(2)) {
  let mode: 'dry-run' | 'apply' = 'dry-run';
  let origin = process.env.DATAOPS_URL || DEFAULT_ORIGIN;
  let token = process.env.DATAOPS_TOKEN || '';
  let reportPath = '';
  let outJsonPath = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') mode = 'dry-run';
    else if (arg === '--apply') mode = 'apply';
    else if (arg === '--api-base-url' && argv[i + 1]) origin = argv[++i];
    else if (arg === '--token' && argv[i + 1]) token = argv[++i];
    else if (arg === '--report' && argv[i + 1]) reportPath = argv[++i];
    else if (arg === '--out-json' && argv[i + 1]) outJsonPath = argv[++i];
  }
  if (!token) {
    try {
      token = (await readFile(path.join(process.env.HOME || '/home/alexey', '.config/dataops/import.token'), 'utf8')).trim();
    } catch {}
  }
  if (!token) throw new Error('Missing DATAOPS_TOKEN or ~/.config/dataops/import.token');

  console.log(`[newsletter-metrics-migrate] Mode: ${mode}, Origin: ${origin}`);
  const details: Array<Record<string, string>> = [];
  let renamedIssues = 0;
  let renamedTasks = 0;
  let skippedIssues = 0;
  let skippedTasks = 0;

  const issues = await listAllIssues(origin, token);
  console.log(`[newsletter-metrics-migrate] Found ${issues.length} newsletter issues`);
  for (const issue of issues) {
    const stats = renamedIssueStats(issue?.stats);
    if (stats === null) {
      skippedIssues += 1;
      continue;
    }
    details.push({ kind: 'issue-stats', id: String(issue.id), outcome: mode === 'apply' ? 'renamed' : 'would-rename' });
    if (mode === 'apply') {
      await apiFetch(origin, token, `/api/newsletter-issues/${encodeURIComponent(String(issue.id))}`, {
        method: 'PUT',
        body: JSON.stringify({ version: issue.version, stats }),
      });
    }
    renamedIssues += 1;
  }

  const tasks = await listOpenTasks(origin, token);
  console.log(`[newsletter-metrics-migrate] Found ${tasks.length} open tasks`);
  for (const task of tasks) {
    if (!taskNeedsRename(task)) {
      if (task?.templateTaskRef === METRICS_TASK_REF && task?.description !== NEW_TASK_NAME) {
        details.push({ kind: 'task-rename', id: String(task.id), outcome: 'skipped-unexpected-name' });
      }
      skippedTasks += 1;
      continue;
    }
    details.push({ kind: 'task-rename', id: String(task.id), outcome: mode === 'apply' ? 'renamed' : 'would-rename' });
    if (mode === 'apply') {
      await apiFetch(origin, token, `/api/tasks/${encodeURIComponent(String(task.id))}`, {
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: task.version, description: NEW_TASK_NAME }),
      });
    }
    renamedTasks += 1;
  }

  const summary = `issues renamed ${renamedIssues} (skipped ${skippedIssues}), tasks renamed ${renamedTasks} (skipped ${skippedTasks})`;
  console.log(`[newsletter-metrics-migrate] ${mode}: ${summary}.`);
  const report = `newsletter-metrics-migrate ${mode}: ${summary}\n${details.map((d) => `${d.kind} ${d.id}: ${d.outcome}`).join('\n')}\n`;
  if (reportPath) await writeFile(reportPath, report, 'utf8');
  if (outJsonPath) {
    await writeFile(outJsonPath, JSON.stringify({ mode, renamedIssues, skippedIssues, renamedTasks, skippedTasks, details }, null, 2), 'utf8');
  }
  return { renamedIssues, skippedIssues, renamedTasks, skippedTasks, details };
}
