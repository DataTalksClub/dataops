/**
 * One-off backfill: move the Trello checklist tag out of Task descriptions.
 *
 * Imported Tasks carry a `[Checklist]` prefix baked into `description`
 * (e.g. `[Podcast page] Add a podcast episode`). The canonical home is
 * `tags[0]`; the queue renders that entry as its own pill and strips the
 * prefix from the title. For each Task this script:
 * - extracts the leading `[Tag]` when the Task has no explicit tags,
 * - rewrites `description` to the remainder,
 * - sets `tags` to `[Tag]` (existing tags are never overwritten).
 *
 * Template `taskDefinitions` keep their stored shape: the template
 * projection splits the prefix at instantiation time, so old and new
 * definitions both produce clean Tasks.
 *
 * Usage against local dynalite (dev server stopped first):
 *   tsx scripts/backfill-task-tags.ts [--dry-run] [--apply]
 *
 * Against production (AWS credentials, explicit table name):
 *   DATAOPS_TASKS_TABLE=dataops-v1-tasks \
 *     tsx scripts/backfill-task-tags.ts --apply
 *
 * Default is `--dry-run`: print planned changes without writing.
 */
import { getClient } from '../src/db/client';
import { listAllTasks, updateTask } from '../src/db/tasks';
import { extractLeadingTag } from '../src/routes/taskValidation';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

interface PlannedChange {
  id: string;
  description: { from: string; to: string };
  tags: { from: string[]; to: string[] };
}

async function main(): Promise<void> {
  const client = await getClient();
  const tasks = await listAllTasks(client);

  const planned: PlannedChange[] = [];
  for (const task of tasks) {
    if (Array.isArray(task.tags) && task.tags.length > 0) continue;
    const extracted = extractLeadingTag(task.description);
    if (!extracted) continue;
    planned.push({
      id: task.id,
      description: { from: task.description, to: extracted.clean },
      tags: { from: [], to: [extracted.tag] },
    });
  }

  for (const change of planned) console.log(JSON.stringify(change));

  const summary = {
    scanned: tasks.length,
    planned: planned.length,
    applied: false,
  };

  if (!APPLY) {
    console.log(JSON.stringify({ ...summary, mode: 'dry-run' }));
    return;
  }

  let applied = 0;
  for (const change of planned) {
    const current = tasks.find((task) => task.id === change.id);
    if (!current) continue;
    await updateTask(client, change.id, {
      expectedVersion: current.version,
      patch: {
        description: change.description.to,
        tags: change.tags.to,
      },
    });
    applied += 1;
  }

  console.log(JSON.stringify({ ...summary, applied, mode: 'applied' }));
}

await main();
