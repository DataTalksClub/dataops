/**
 * One-off cleanup: drop the `trello-import` provenance tag.
 *
 * The Trello import stamped `trello-import` into the tags of every Card, Task
 * and Artifact it created. Nothing reads it, and the queue rendered it as the
 * leading pill on every imported Task. Provenance already lives in the
 * migration metadata (`source`, `metadata.sourceKey`, the Card description's
 * provenance line), so the tag is removed everywhere.
 *
 * Dry run is the default.
 *
 * Offline plan against an exported snapshot directory (cards.json,
 * tasks.json, artifacts.json):
 *   tsx scripts/strip-trello-import-tag.ts --from-dir /path/to/snapshot
 *
 * Against the local replica:
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8001 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
 *     AWS_REGION=us-east-1 IS_LOCAL=true DATAOPS_ARTIFACTS_TABLE=dataops-v1-artifacts \
 *     DATAOPS_CARDS_TABLE=dataops-v1-cards DATAOPS_TASKS_TABLE=dataops-v1-tasks \
 *     tsx scripts/strip-trello-import-tag.ts [--apply]
 *
 * Production needs explicit approval. Delete this script once it has run there.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TAG = 'trello-import';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const fromDirIndex = argv.indexOf('--from-dir');
const FROM_DIR = fromDirIndex >= 0 ? argv[fromDirIndex + 1] : '';

interface Tagged {
  id: string;
  PK?: string;
  tags?: unknown;
}

function stripped(item: Tagged): string[] | null {
  if (!Array.isArray(item.tags) || !item.tags.includes(TAG)) return null;
  return item.tags.filter((tag) => tag !== TAG);
}

function count(items: Tagged[]): number {
  return items.filter((item) => stripped(item)).length;
}

async function main(): Promise<void> {
  if (FROM_DIR) {
    if (APPLY) throw new Error('--from-dir plans only; it never writes');
    const read = (name: string) => JSON.parse(readFileSync(join(FROM_DIR, name), 'utf8')) as Tagged[];
    const tasks = read('tasks.json').filter((item) => !item.PK || item.PK.startsWith('TASK#'));
    console.log(JSON.stringify({
      cards: count(read('cards.json')),
      tasks: count(tasks),
      artifacts: count(read('artifacts.json')),
      mode: 'dry-run',
      source: FROM_DIR,
    }));
    return;
  }

  const { getClient } = await import('../src/db/client');
  const { listArtifacts, updateArtifact } = await import('../src/db/artifacts');
  const { listCards, updateCardAdditive } = await import('../src/db/cards');
  const { listAllTasks, updateTaskAdditive } = await import('../src/db/tasks');

  const client = await getClient();
  const cards = (await listCards(client)).filter((card) => stripped(card));
  const tasks = (await listAllTasks(client)).filter((task) => stripped(task));
  const artifacts = (await listArtifacts(client)).filter((artifact) => stripped(artifact));
  const summary = { cards: cards.length, tasks: tasks.length, artifacts: artifacts.length };

  if (!APPLY) {
    console.log(JSON.stringify({ ...summary, mode: 'dry-run' }));
    return;
  }

  for (const card of cards) {
    await updateCardAdditive(client, card, (current) => ({ tags: stripped(current) || current.tags }));
  }
  for (const task of tasks) {
    await updateTaskAdditive(client, task, (current) => ({ tags: stripped(current) || current.tags }));
  }
  for (const artifact of artifacts) {
    await updateArtifact(client, artifact.id, { tags: stripped(artifact) });
  }
  console.log(JSON.stringify({ ...summary, mode: 'applied' }));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('trello-import tag cleanup failed:', (error as Error).message);
    process.exit(1);
  });
}
