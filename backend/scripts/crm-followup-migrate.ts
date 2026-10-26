/**
 * Migrate CRM follow-up tasks into direct contact/company follow-up fields.
 *
 * Source: open Tasks (todo/waiting) tagged `crm-followup`. Each task carries a
 * due date and per-company notes; the target is the task subject's record:
 * `sponsor-company` -> organization, `sponsor-person` -> contact,
 * `sponsor-deal` -> the deal's organization. The task date becomes
 * `follow_up_at` (earliest open date wins), the status becomes `open`, and one
 * marker line per task is appended to `follow_up_note`.
 *
 * Idempotent: a task whose marker `[crm-followup task:<id>]` is already in the
 * record's `follow_up_note` is skipped. Dry-run (default) resolves every task
 * and reports counts without writing. Records that are missing, archived, or
 * do-not-contact are skipped with a reason, never written.
 *
 * Usage:
 *   tsx scripts/crm-followup-migrate.ts --dry-run [--api-base-url URL] [--token TOKEN]
 *   tsx scripts/crm-followup-migrate.ts --apply [--report PATH] [--out-json PATH]
 *
 * Auth: DATAOPS_TOKEN or ~/.config/dataops/import.token (same as
 * crm-inbound-backfill). Needs a credential with task-read and crm:write scope.
 */
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ORIGIN = 'https://ops.dtcdev.click';
export const MARKER = (taskId: string) => `[crm-followup task:${taskId}]`;
const NOTE_BUDGET = 2000;

interface CrmTask {
  id: string;
  description?: string;
  date?: string;
  status?: string;
  tags?: string[];
  subject?: { type?: string; id?: string };
  notesLog?: Array<{ body?: string; text?: string; note?: string }>;
}

export const taskNoteLine = (task: CrmTask): string => {
  const firstNote = (task.notesLog || [])
    .map((entry) => String(entry.body ?? entry.text ?? entry.note ?? '').trim())
    .find((line) => line);
  const text = `${MARKER(task.id)} ${task.description || ''}${firstNote ? ` — ${firstNote}` : ''}`.trim();
  return text.slice(0, 400);
};

async function apiFetch(origin: string, token: string, route: string, init: RequestInit = {}) {
  const res = await fetch(`${origin}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`API ${init.method || 'GET'} ${route}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

async function listOpenTasks(origin: string, token: string): Promise<CrmTask[]> {
  const tasks: CrmTask[] = [];
  for (const status of ['todo', 'waiting']) {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({ status, limit: '100', ...(cursor ? { cursor } : {}) });
      const page_data = await apiFetch(origin, token, `/api/tasks?${query.toString()}`);
      const items = Array.isArray(page_data.items) ? page_data.items : Array.isArray(page_data.tasks) ? page_data.tasks : [];
      tasks.push(...items);
      cursor = page_data.nextCursor || page_data.cursor || undefined;
      if (!cursor) break;
    }
  }
  return tasks.filter((task) => Array.isArray(task.tags) && task.tags.includes('crm-followup'));
}

const isDnc = (record: any): boolean =>
  Boolean(record?.doNotContact || (Array.isArray(record?.tags) && record.tags.includes('do-not-contact')));

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

  console.log(`[crm-followup-migrate] Mode: ${mode}, Origin: ${origin}`);
  const tagged = await listOpenTasks(origin, token);
  console.log(`[crm-followup-migrate] Found ${tagged.length} open tasks tagged crm-followup`);

  const skipped: Record<string, number> = {};
  const migrated: Array<{ task: string; kind: string; id: string; name: string; date: string }> = [];
  const details: Array<{ task: string; outcome: string; reason?: string; kind?: string; id?: string }> = [];
  const skip = (task: CrmTask, reason: string) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
    details.push({ task: task.id, outcome: 'skipped', reason });
  };

  for (const task of tagged) {
    const subjectType = task.subject?.type;
    const subjectId = task.subject?.id;
    if (!subjectType || !subjectId) { skip(task, 'no-subject'); continue; }
    if (!task.date) { skip(task, 'no-date'); continue; }

    let kind: 'organization' | 'contact' | null = null;
    let recordId: string | null = null;
    try {
      if (subjectType === 'sponsor-company') { kind = 'organization'; recordId = subjectId; }
      else if (subjectType === 'sponsor-person') { kind = 'contact'; recordId = subjectId; }
      else if (subjectType === 'sponsor-deal') {
        const deal = await apiFetch(origin, token, `/api/sponsor-crm/deals/${encodeURIComponent(subjectId)}`);
        if (!deal?.organizationId) { skip(task, 'deal-without-organization'); continue; }
        kind = 'organization'; recordId = String(deal.organizationId);
      } else { skip(task, `unsupported-subject:${subjectType}`); continue; }

      const plural = kind === 'contact' ? 'contacts' : 'organizations';
      const record = await apiFetch(origin, token, `/api/sponsor-crm/${plural}/${encodeURIComponent(recordId)}`);
      if (!record?.id) { skip(task, 'record-missing'); continue; }
      if (record.archivedAt) { skip(task, 'record-archived'); continue; }
      if (isDnc(record)) { skip(task, 'do-not-contact'); continue; }
      const existingNote = typeof record.follow_up_note === 'string' ? record.follow_up_note : '';
      if (existingNote.includes(MARKER(task.id))) { skip(task, 'already-migrated'); continue; }

      const existingDate = typeof record.follow_up_at === 'string' && record.follow_up_at ? record.follow_up_at : null;
      const existingOpen = existingDate && record.follow_up_status !== 'done';
      const date = existingOpen && existingDate! < task.date ? existingDate! : task.date;
      const line = taskNoteLine(task);
      const note = (existingNote ? `${existingNote}\n` : '') + line;
      if (note.length > NOTE_BUDGET) { skip(task, 'note-budget-exceeded'); continue; }

      if (mode === 'apply') {
        await apiFetch(origin, token, `/api/sponsor-crm/${plural}/${encodeURIComponent(record.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ version: record.version, follow_up_at: date, follow_up_status: 'open', follow_up_note: note }),
        });
      }
      migrated.push({ task: task.id, kind, id: record.id, name: String(record.displayName || record.name || record.id), date });
      details.push({ task: task.id, outcome: mode === 'apply' ? 'migrated' : 'would-migrate', kind, id: record.id });
    } catch (error) {
      skip(task, `error:${(error as Error).message.slice(0, 60)}`);
    }
  }

  const summary = { tasksFound: tagged.length, migrated: migrated.length, skipped };
  console.log('[crm-followup-migrate] Summary:', JSON.stringify(summary));

  if (reportPath) {
    const lines = [
      `# CRM follow-up migration ${mode} (${new Date().toISOString().slice(0, 10)})`,
      ``,
      `- Tasks tagged \`crm-followup\`: ${tagged.length}`,
      `- ${mode === 'apply' ? 'Migrated' : 'Would migrate'}: ${migrated.length}`,
      ...Object.entries(skipped).map(([reason, count]) => `- Skipped (${reason}): ${count}`),
      ``,
      ...migrated.map((m) => `- ${m.name} (\`${m.kind}:${m.id}\`): follow-up ${m.date} from task \`${m.task}\``),
    ];
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, lines.join('\n') + '\n', 'utf8');
    console.log(`[crm-followup-migrate] Wrote report to ${reportPath}`);
  }
  if (outJsonPath) {
    await mkdir(path.dirname(outJsonPath), { recursive: true });
    await writeFile(outJsonPath, JSON.stringify({ mode, origin, summary, migrated, details }, null, 2), 'utf8');
  }
  return { mode, summary, migrated, details };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = typeof __filename !== 'undefined' ? path.resolve(__filename as string) : new URL(import.meta.url).pathname;
if (entryPath && entryPath === selfPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
