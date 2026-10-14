/**
 * One-off cleanup: move links pasted into stored Task titles into `materials`.
 *
 * The Trello import left supporting links inside titles, e.g.
 * "Announce in Slack ( , [template](https://docs.google.com/...))". The queue
 * hid them at render time; the API now cleans titles on every write, and this
 * moves what is already stored: the title loses the links and the debris they
 * leave, and each link joins the Task's `materials` as `{ label?, url }`.
 *
 * Dry run is the default and prints every planned title change.
 *
 *   AWS_REGION=eu-west-1 DATAOPS_TASKS_TABLE=dataops-v1-tasks \
 *     tsx scripts/move-task-title-links.ts [--apply]
 *
 * Production needs explicit approval. Delete this script once it has run there.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { extractTitleLinks, mergeMaterials } from '../src/taskMaterials';
import type { Task, TaskMaterial } from '../src/types';

const APPLY = process.argv.slice(2).includes('--apply');

export interface TitleLinkChange {
  id: string;
  from: string;
  to: string;
  materials: TaskMaterial[];
}

/** The cleaned title and merged materials for a Task, or null when its title holds no links. */
export function planTitleLinkMove(task: Pick<Task, 'id' | 'description' | 'materials'>): TitleLinkChange | null {
  const extracted = extractTitleLinks(String(task.description || ''));
  if (extracted.materials.length === 0) return null;
  return {
    id: task.id,
    from: task.description,
    to: extracted.title,
    materials: mergeMaterials(task.materials || [], extracted.materials),
  };
}

export async function moveTaskTitleLinks(
  client: DynamoDBDocumentClient,
  write: boolean,
): Promise<{ changes: TitleLinkChange[]; mode: string }> {
  const { listAllTasks, updateTaskAdditive } = await import('../src/db/tasks');
  const tasks = await listAllTasks(client);
  const planned = tasks
    .map((task) => ({ task, change: planTitleLinkMove(task) }))
    .filter((entry): entry is { task: Task; change: TitleLinkChange } => entry.change !== null);
  if (write) {
    for (const { task } of planned) {
      await updateTaskAdditive(client, task, (current) => {
        const change = planTitleLinkMove(current);
        return change ? { description: change.to, materials: change.materials } : {};
      });
    }
  }
  return { changes: planned.map((entry) => entry.change), mode: write ? 'applied' : 'dry-run' };
}

async function main(): Promise<void> {
  const { getClient } = await import('../src/db/client');
  const result = await moveTaskTitleLinks(await getClient(), APPLY);
  for (const change of result.changes) console.log(JSON.stringify({ change, at: new Date().toISOString() }));
  console.log(JSON.stringify({
    tasks: result.changes.length,
    links: result.changes.reduce((total, change) => total + change.materials.length, 0),
    mode: result.mode,
  }));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Task title link move failed:', (error as Error).message);
    process.exit(1);
  });
}
