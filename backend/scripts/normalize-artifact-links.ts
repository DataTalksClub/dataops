/**
 * One-off cleanup: give every external artifact link one clean shape and
 * keep one artifact per link per owner.
 *
 * The Trello import stored description links as Markdown left them:
 * `url](url` halves, `\_` escapes, tracking parameters, and the same page
 * once per spelling. For each external (non-s3, non-local) artifact this
 * script:
 * - rewrites `storageUri` to the canonical URL (`src/artifactLinks.ts`),
 * - rewrites a URL-shaped `title` to that URL (an operator label is kept),
 * - groups artifacts by owner (card or task) and link identity, keeps the
 *   best one (approved first, then labelled, then oldest) and deletes the
 *   rest, carrying a dropped duplicate's label over to the keeper,
 * - rewrites card and task `artifactRefs` to match.
 *
 * Dry run is the default and prints the plan plus counts.
 *
 * Offline plan against an exported snapshot (no database):
 *   tsx scripts/normalize-artifact-links.ts --from-json /path/to/artifacts.json [--cards-json /path/to/cards.json]
 *
 * Against the local replica (dev server may keep running):
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8001 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
 *     AWS_REGION=us-east-1 IS_LOCAL=true DATAOPS_ARTIFACTS_TABLE=dataops-v1-artifacts \
 *     DATAOPS_CARDS_TABLE=dataops-v1-cards DATAOPS_TASKS_TABLE=dataops-v1-tasks \
 *     tsx scripts/normalize-artifact-links.ts [--apply]
 *
 * Production needs explicit approval, AWS credentials and the table names.
 * Delete this script once it has run in production.
 */
import { readFileSync } from 'node:fs';

import {
  externalLinkKey,
  isUrlLikeTitle,
  normalizeExternalTitle,
  normalizeExternalUrl,
} from '../src/artifactLinks';
import type { ArtifactRecord, ArtifactRef } from '../src/types';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const fromJsonIndex = argv.indexOf('--from-json');
const FROM_JSON = fromJsonIndex >= 0 ? argv[fromJsonIndex + 1] : '';
const cardsJsonIndex = argv.indexOf('--cards-json');
const CARDS_JSON = cardsJsonIndex >= 0 ? argv[cardsJsonIndex + 1] : '';

const STATUS_RANK: Record<string, number> = { approved: 0, 'needs-review': 1, draft: 2 };

export interface ArtifactRewrite {
  id: string;
  storageUri?: { from: string; to: string };
  title?: { from: string; to: string };
}

export interface ArtifactLinkPlan {
  rewrites: ArtifactRewrite[];
  deletions: Array<{ id: string; keptId: string; storageUri: string }>;
  unparseable: Array<{ id: string; storageUri: string }>;
  summary: {
    scanned: number;
    external: number;
    uriRewrites: number;
    titleRewrites: number;
    duplicateGroups: number;
    duplicatesDeleted: number;
    unparseable: number;
    remainingExternal: number;
  };
}

function isOwned(uri: string): boolean {
  return uri.startsWith('s3://') || uri.startsWith('local-dev://');
}

function keeperOrder(left: ArtifactRecord, right: ArtifactRecord): number {
  const rank = (artifact: ArtifactRecord) => STATUS_RANK[artifact.status] ?? 3;
  const labelled = (artifact: ArtifactRecord) => (isUrlLikeTitle(artifact.title || '') ? 1 : 0);
  return rank(left) - rank(right)
    || labelled(left) - labelled(right)
    || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
    || left.id.localeCompare(right.id);
}

/** Pure planning step, shared by the offline and the database modes. */
export function planArtifactLinkCleanup(artifacts: ArtifactRecord[]): ArtifactLinkPlan {
  const unparseable: ArtifactLinkPlan['unparseable'] = [];
  const groups = new Map<string, Array<{ artifact: ArtifactRecord; url: string }>>();
  let external = 0;

  for (const artifact of artifacts) {
    const uri = String(artifact.storageUri || '');
    if (!uri || isOwned(uri)) continue;
    external += 1;
    const url = normalizeExternalUrl(uri);
    if (!url) {
      unparseable.push({ id: artifact.id, storageUri: uri });
      continue;
    }
    const owner = artifact.cardId ? `card:${artifact.cardId}` : artifact.taskId ? `task:${artifact.taskId}` : `self:${artifact.id}`;
    const key = `${owner}|${externalLinkKey(url)}`;
    const members = groups.get(key) || [];
    members.push({ artifact, url });
    groups.set(key, members);
  }

  const rewrites: ArtifactRewrite[] = [];
  const deletions: ArtifactLinkPlan['deletions'] = [];
  let duplicateGroups = 0;
  for (const members of groups.values()) {
    members.sort((left, right) => keeperOrder(left.artifact, right.artifact));
    const [keeper, ...duplicates] = members;
    if (duplicates.length > 0) duplicateGroups += 1;
    const label = [keeper, ...duplicates]
      .map(({ artifact }) => artifact.title || '')
      .find((title) => title && !isUrlLikeTitle(title));
    const title = normalizeExternalTitle(label || keeper.artifact.title, keeper.url);
    const rewrite: ArtifactRewrite = { id: keeper.artifact.id };
    if (keeper.url !== keeper.artifact.storageUri) rewrite.storageUri = { from: keeper.artifact.storageUri, to: keeper.url };
    if (title !== keeper.artifact.title) rewrite.title = { from: keeper.artifact.title, to: title };
    if (rewrite.storageUri || rewrite.title) rewrites.push(rewrite);
    for (const { artifact } of duplicates) {
      deletions.push({ id: artifact.id, keptId: keeper.artifact.id, storageUri: artifact.storageUri });
    }
  }

  return {
    rewrites,
    deletions,
    unparseable,
    summary: {
      scanned: artifacts.length,
      external,
      uriRewrites: rewrites.filter((rewrite) => rewrite.storageUri).length,
      titleRewrites: rewrites.filter((rewrite) => rewrite.title).length,
      duplicateGroups,
      duplicatesDeleted: deletions.length,
      unparseable: unparseable.length,
      remainingExternal: external - deletions.length,
    },
  };
}

/** Rewrite an owner's artifactRefs to match the plan; null when unchanged. */
export function rewriteArtifactRefs(refs: ArtifactRef[] | undefined, plan: ArtifactLinkPlan): ArtifactRef[] | null {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const deleted = new Map(plan.deletions.map((deletion) => [deletion.id, deletion.keptId]));
  const rewrites = new Map(plan.rewrites.map((rewrite) => [rewrite.id, rewrite]));
  const next: ArtifactRef[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const ref of refs) {
    const id = deleted.get(ref.artifactId) || ref.artifactId;
    if (id !== ref.artifactId) changed = true;
    if (seen.has(id)) {
      changed = true;
      continue;
    }
    seen.add(id);
    const rewrite = rewrites.get(id);
    const updated: ArtifactRef = { ...ref, artifactId: id };
    if (rewrite?.storageUri && updated.storageUri !== undefined) updated.storageUri = rewrite.storageUri.to;
    if (rewrite?.title && updated.title !== undefined) updated.title = rewrite.title.to;
    if (updated.storageUri !== ref.storageUri || updated.title !== ref.title) changed = true;
    next.push(updated);
  }
  return changed ? next : null;
}

async function main(): Promise<void> {
  if (FROM_JSON) {
    if (APPLY) throw new Error('--from-json plans only; it never writes');
    const artifacts = JSON.parse(readFileSync(FROM_JSON, 'utf8')) as ArtifactRecord[];
    const plan = planArtifactLinkCleanup(artifacts);
    for (const rewrite of plan.rewrites) console.log(JSON.stringify({ rewrite }));
    for (const deletion of plan.deletions) console.log(JSON.stringify({ deletion }));
    for (const entry of plan.unparseable) console.log(JSON.stringify({ unparseable: entry }));
    const cards = CARDS_JSON ? JSON.parse(readFileSync(CARDS_JSON, 'utf8')) as Array<{ artifactRefs?: ArtifactRef[] }> : [];
    const cardRefUpdates = cards.filter((card) => rewriteArtifactRefs(card.artifactRefs, plan)).length;
    console.log(JSON.stringify({ ...plan.summary, cardRefUpdates, mode: 'dry-run', source: FROM_JSON }));
    return;
  }

  const { getClient } = await import('../src/db/client');
  const { deleteArtifact, listArtifacts, updateArtifact } = await import('../src/db/artifacts');
  const { listCards, updateCardAdditive } = await import('../src/db/cards');
  const { listAllTasks, updateTaskAdditive } = await import('../src/db/tasks');

  const client = await getClient();
  const artifacts = await listArtifacts(client);
  const plan = planArtifactLinkCleanup(artifacts);
  const cards = await listCards(client);
  const tasks = await listAllTasks(client);
  const cardRefChanges = cards
    .map((card) => ({ card, refs: rewriteArtifactRefs(card.artifactRefs, plan) }))
    .filter((entry) => entry.refs);
  const taskRefChanges = tasks
    .map((task) => ({ task, refs: rewriteArtifactRefs(task.artifactRefs, plan) }))
    .filter((entry) => entry.refs);

  for (const rewrite of plan.rewrites) console.log(JSON.stringify({ rewrite }));
  for (const deletion of plan.deletions) console.log(JSON.stringify({ deletion }));
  for (const entry of plan.unparseable) console.log(JSON.stringify({ unparseable: entry }));
  const summary = { ...plan.summary, cardRefUpdates: cardRefChanges.length, taskRefUpdates: taskRefChanges.length };

  if (!APPLY) {
    console.log(JSON.stringify({ ...summary, mode: 'dry-run' }));
    return;
  }

  for (const rewrite of plan.rewrites) {
    const updates: Record<string, unknown> = {};
    if (rewrite.storageUri) updates.storageUri = rewrite.storageUri.to;
    if (rewrite.title) updates.title = rewrite.title.to;
    await updateArtifact(client, rewrite.id, updates);
  }
  for (const { card } of cardRefChanges) {
    await updateCardAdditive(client, card, (current) => ({
      artifactRefs: rewriteArtifactRefs(current.artifactRefs, plan) || current.artifactRefs,
    }));
  }
  for (const { task } of taskRefChanges) {
    await updateTaskAdditive(client, task, (current) => ({
      artifactRefs: rewriteArtifactRefs(current.artifactRefs, plan) || current.artifactRefs,
    }));
  }
  for (const deletion of plan.deletions) await deleteArtifact(client, deletion.id);

  console.log(JSON.stringify({ ...summary, mode: 'applied' }));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('Artifact link cleanup failed:', (error as Error).message);
    process.exit(1);
  });
}
