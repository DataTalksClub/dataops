/**
 * Import, edit and two-way Relay sync of newsletter issue blocks.
 *
 * Decision: two-way sync with a per-block three-way merge, not DataOps as the
 * only source of truth. Relay stays the renderer and sender, and its blocks
 * keep being written outside DataOps (Relay's own editor, template autofill,
 * `dataops newsletter relay-sync` for the sponsor block), so a one-way
 * "DataOps builds Relay" would overwrite those edits. Instead each block keeps
 * the content both sides last agreed on; a sync pushes blocks changed only in
 * DataOps, pulls blocks changed only in Relay, and refuses to write anything
 * when any block changed on both sides.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  blockFromRelay,
  blockHash,
  planSync,
  validateBlockData,
  type DeletedBlock,
  type IssueBlock,
  type IssueBlockSet,
  type RelayIssue,
  type RelayTarget,
  type SyncPlan,
  type SyncStep,
} from './blocks';
import {
  appendBlockRevisions,
  getBlockSet,
  putBlockSet,
  type BlockRevision,
} from './blocksStore';
import { BlocksError } from './blocksErrors';
import { assertEditable, byPosition, type SponsorDocUrls } from './blocksLayout';
import { MAX_RELAY_BODY_BYTES, RelayError, relayBodyBytes, relayClient } from './blocksRelay';

export interface BlockActor {
  id: string;
  name: string | null;
}

export { BlocksError } from './blocksErrors';

type NewRevision = Omit<BlockRevision, 'issueId' | 'revision'>;

const EDITABLE_CAMPAIGN_STATUSES = new Set(['draft']);

function relayIssueSummary(issue: RelayIssue): IssueBlockSet['relayIssue'] {
  return {
    subject: issue.subject || '',
    previewText: issue.preview_text || '',
    campaignStatus: issue.campaign?.status || null,
    updatedAt: issue.updated_at,
  };
}

export async function importBlocks(
  client: DynamoDBDocumentClient,
  issueId: string,
  input: { target: RelayTarget; issueKey: string },
  actor: BlockActor,
): Promise<IssueBlockSet> {
  const existing = await getBlockSet(client, issueId);
  if (existing) {
    throw new BlocksError(
      `Issue ${issueId} already has blocks linked to Relay ${existing.relay.target} ${existing.relay.issueKey}; use sync.`,
      409,
      'blocks_already_imported',
    );
  }
  const relay = await relayClient(input.target);
  const remote = await relay.getIssue(input.issueKey);
  const now = new Date().toISOString();
  const blocks = [...remote.blocks]
    .sort((a, b) => a.position - b.position)
    .map((block) => blockFromRelay(block, now, actor));
  const set: IssueBlockSet = {
    issueId,
    relay: { target: input.target, issueKey: remote.key || input.issueKey },
    relayIssue: relayIssueSummary(remote),
    blocks,
    deleted: [],
    orderBase: blocks.map((block) => block.relayBlockId as number),
    orderDirty: false,
    version: 1,
    lastSync: { at: now, byName: actor.name, summary: `imported ${blocks.length} blocks` },
    createdAt: now,
    updatedAt: now,
  };
  await putBlockSet(client, set, 0);
  await appendBlockRevisions(
    client,
    issueId,
    remote.blocks.map((block) => ({
      blockId: `rb-${block.id}`,
      relayBlockId: block.id,
      blockType: block.type,
      origin: 'import',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      relayActor: block.updated_by || '',
      before: null,
      after: { ...block.data },
    })),
  );
  return set;
}

export async function requireBlockSet(client: DynamoDBDocumentClient, issueId: string): Promise<IssueBlockSet> {
  const set = await getBlockSet(client, issueId);
  if (!set) {
    throw new BlocksError(
      `Issue ${issueId} has no blocks yet. Import them from Relay first (dataops newsletter blocks <issue> --import <relay-issue-key>).`,
      404,
      'blocks_not_imported',
    );
  }
  return set;
}

export async function editBlock(
  client: DynamoDBDocumentClient,
  issueId: string,
  blockId: string,
  input: { data: unknown; expectedVersion: unknown },
  actor: BlockActor,
  urls: SponsorDocUrls = {},
): Promise<{ set: IssueBlockSet; block: IssueBlock; changed: boolean }> {
  const set = await requireBlockSet(client, issueId);
  const block = set.blocks.find((item) => item.id === blockId);
  if (!block) throw new BlocksError(`Issue ${issueId} has no block ${blockId}.`, 404, 'block_not_found');
  assertEditable(block, urls);
  if (input.expectedVersion !== block.version) {
    throw new BlocksError(
      `Block ${blockId} is at version ${block.version}, not ${String(input.expectedVersion)}: it changed since you opened it. Reload, then edit again.`,
      409,
      'block_version_conflict',
      { currentVersion: block.version },
    );
  }
  const data = validateBlockData(block.type, input.data);
  if (blockHash(block.type, data) === blockHash(block.type, block.data)) return { set, block, changed: false };
  const now = new Date().toISOString();
  const updated: IssueBlock = {
    ...block,
    data,
    version: block.version + 1,
    updatedAt: now,
    updatedBy: actor.id,
    updatedByName: actor.name,
  };
  const next: IssueBlockSet = {
    ...set,
    blocks: set.blocks.map((item) => (item.id === blockId ? updated : item)),
    version: set.version + 1,
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, [
    {
      blockId,
      relayBlockId: block.relayBlockId,
      blockType: block.type,
      origin: 'edit',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      before: block.data,
      after: data,
    },
  ]);
  return { set: next, block: updated, changed: true };
}

export interface SyncResult {
  dryRun: boolean;
  relay: { target: RelayTarget; url: string; issueKey: string };
  plan: SyncStep[];
  order: SyncPlan['order'];
  pushed: number[];
  pulled: number[];
  created: number[];
  deleted: number[];
  summary: string;
  set: IssueBlockSet;
}

function summarize(plan: SyncPlan): string {
  const counts = new Map<string, number>();
  for (const step of plan.steps) counts.set(step.action, (counts.get(step.action) || 0) + 1);
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(', ') || 'no blocks';
}


/** Keep only the steps of the given blocks (a scoped sync never touches the rest). */
function scopePlan(plan: SyncPlan, only: Set<string>, pullIsConflict: boolean): SyncPlan {
  const steps = plan.steps
    .filter((step) => step.blockId !== null && only.has(step.blockId))
    .map((step): SyncStep => (pullIsConflict && step.action === 'pull'
      ? { ...step, action: 'conflict', reason: `${step.reason}; the sponsor doc is the source of truth for this block, so Relay's copy differs from the doc` }
      : step));
  return {
    steps,
    conflicts: steps.filter((step) => step.action === 'conflict'),
    pushes: steps.filter((step) => step.action === 'push'),
    creates: steps.filter((step) => step.action === 'create'),
    deletes: steps.filter((step) => step.action === 'delete'),
    pulls: steps.filter((step) => step.action === 'pull' || step.action === 'add' || step.action === 'remove'),
    order: { action: 'none', reason: 'scoped sync' },
  };
}

/**
 * Three-way sync with Relay. Refuses as a whole on any conflict. `only` limits
 * the sync to the given DataOps block ids (the automatic sponsor-doc sync), so
 * other pending edits and other conflicts are neither pushed nor reported.
 */
export async function syncBlocks(
  client: DynamoDBDocumentClient,
  issueId: string,
  options: { dryRun: boolean; only?: string[]; pullIsConflict?: boolean },
  actor: BlockActor,
): Promise<SyncResult> {
  const set = await requireBlockSet(client, issueId);
  const relay = await relayClient(set.relay.target);
  const remote = await relay.getIssue(set.relay.issueKey);
  const full = planSync(set.blocks, remote, { deleted: set.deleted, orderBase: set.orderBase, orderDirty: set.orderDirty });
  const scoped = Boolean(options.only);
  const plan = options.only ? scopePlan(full, new Set(options.only), Boolean(options.pullIsConflict)) : full;
  const where = { target: set.relay.target, url: relay.url, issueKey: set.relay.issueKey };

  if (plan.conflicts.length) {
    throw new BlocksError(
      `Sync refused: ${plan.conflicts.length} change(s) conflict between DataOps and Relay since the last sync ` +
        `(${plan.conflicts.map((step) => `${step.type}${step.relayBlockId ? ` #${step.relayBlockId}` : ''}: ${step.reason}`).join('; ')}). ` +
        'Nothing was written. Resolve each conflict by making both sides equal (copy one into the other), then sync again.',
      409,
      'blocks_sync_conflict',
      { plan: plan.steps, conflicts: plan.conflicts },
    );
  }
  const campaignStatus = remote.campaign?.status || null;
  const writes = plan.pushes.length + plan.creates.length + plan.deletes.length + (plan.order.action === 'push' ? 1 : 0);
  if (writes && campaignStatus && !EDITABLE_CAMPAIGN_STATUSES.has(campaignStatus)) {
    throw new BlocksError(
      `Sync refused: Relay issue ${set.relay.issueKey} has a ${campaignStatus} campaign, so its blocks are no longer edited. Nothing was written.`,
      409,
      'blocks_campaign_locked',
      { plan: plan.steps },
    );
  }
  const localById = new Map(set.blocks.map((block) => [block.id, block]));
  for (const step of [...plan.pushes, ...plan.creates]) {
    const block = localById.get(step.blockId as string) as IssueBlock;
    const bytes = relayBodyBytes(block.type, block.data);
    if (bytes > MAX_RELAY_BODY_BYTES) {
      throw new BlocksError(
        `Sync refused: block ${block.id} (${block.type}) is ${bytes} bytes, over Relay's ${MAX_RELAY_BODY_BYTES}-byte request limit. Shorten it. Nothing was written.`,
        422,
        'relay_body_too_large',
        { plan: plan.steps },
      );
    }
  }
  const empty = { pushed: [], pulled: [], created: [], deleted: [] };
  if (options.dryRun) {
    return { dryRun: true, relay: where, plan: plan.steps, order: plan.order, ...empty, summary: summarize(plan), set };
  }

  const now = new Date().toISOString();
  const key = set.relay.issueKey;
  const remoteById = new Map(remote.blocks.map((block) => [block.id, block]));
  const blocks = new Map(set.blocks.map((block) => [block.id, { ...block }]));
  let tombstones: DeletedBlock[] = [...(set.deleted || [])];
  const revisions: NewRevision[] = [];
  const pushed: number[] = [];
  const pulled: number[] = [];
  const created: number[] = [];
  const deleted: number[] = [];
  let failure: unknown = null;
  let wrote = false;
  const stamp = (block: IssueBlock, saved: { type: string; data: Record<string, string>; updated_at: string }) => {
    const savedHash = blockHash(saved.type, saved.data);
    if (savedHash !== blockHash(block.type, block.data)) {
      // Relay normalized the content; record what it actually stored.
      revisions.push({
        blockId: block.id,
        relayBlockId: block.relayBlockId,
        blockType: saved.type,
        origin: 'relay-pull',
        createdAt: now,
        actorUserId: actor.id,
        actorName: actor.name,
        relayActor: 'relay normalization on push',
        before: block.data,
        after: { ...saved.data },
      });
      block.data = { ...saved.data };
      block.type = saved.type;
      block.version += 1;
    }
    block.base = { hash: savedHash, relayUpdatedAt: saved.updated_at, syncedAt: now };
  };

  try {
    // Pushes first, one block per request; each re-reads the Relay block right
    // before writing so an edit made in Relay since the plan is not overwritten.
    for (const step of plan.pushes) {
      const block = blocks.get(step.blockId as string) as IssueBlock;
      const blockId = block.relayBlockId as number;
      const seen = remoteById.get(blockId)!;
      const fresh = await relay.getBlock(key, blockId);
      if (fresh.updated_at !== seen.updated_at || blockHash(fresh.type, fresh.data) !== blockHash(seen.type, seen.data)) {
        throw new BlocksError(
          `Sync stopped: Relay block ${blockId} changed during the sync (by ${fresh.updated_by || 'unknown'} at ${fresh.updated_at}). ` +
            `It was not overwritten. ${pushed.length} block(s) pushed before this were saved; sync again to see the conflict.`,
          409,
          'blocks_sync_conflict',
        );
      }
      const saved = await relay.putBlock(key, blockId, block.type, block.data);
      wrote = true;
      stamp(block, saved);
      remoteById.set(saved.id, saved);
      pushed.push(blockId);
    }
    // Deletes: only when Relay's copy is still what DataOps last saw.
    for (const step of plan.deletes) {
      const gone = tombstones.find((item) => item.id === step.blockId) as DeletedBlock;
      const fresh = await relay.getBlock(key, gone.relayBlockId);
      if (blockHash(fresh.type, fresh.data) !== gone.baseHash) {
        throw new BlocksError(
          `Sync stopped: Relay block ${gone.relayBlockId} was edited in Relay (by ${fresh.updated_by || 'unknown'} at ${fresh.updated_at}) after you deleted it here. It was not deleted.`,
          409,
          'blocks_sync_conflict',
        );
      }
      await relay.deleteBlock(key, gone.relayBlockId);
      wrote = true;
      tombstones = tombstones.filter((item) => item.id !== gone.id);
      deleted.push(gone.relayBlockId);
    }
    // Creates: blocks added in DataOps, at their DataOps position.
    const ordered = byPosition([...blocks.values()]);
    for (const step of plan.creates) {
      const block = blocks.get(step.blockId as string) as IssueBlock;
      const saved = await relay.postBlock(key, block.type, block.data, ordered.findIndex((item) => item.id === block.id));
      wrote = true;
      block.relayBlockId = saved.id;
      stamp(block, saved);
      remoteById.set(saved.id, saved);
      created.push(saved.id);
    }
    // Order: make Relay's order match DataOps' (the move only changes position).
    if (plan.order.action === 'push' || (plan.creates.length && plan.order.action !== 'pull')) {
      const live = (await relay.getIssue(key)).blocks;
      const current = [...live].sort((a, b) => a.position - b.position).map((block) => block.id);
      const wanted = byPosition([...blocks.values()])
        .map((block) => block.relayBlockId)
        .filter((id): id is number => id !== null && current.includes(id));
      for (let index = 0; index < wanted.length; index += 1) {
        if (current[index] === wanted[index]) continue;
        await relay.moveBlock(key, wanted[index], index);
        wrote = true;
        current.splice(current.indexOf(wanted[index]), 1);
        current.splice(index, 0, wanted[index]);
      }
    }
  } catch (error) {
    failure = error;
  }

  let finalIssue = remote;
  if (wrote || plan.order.action === 'pull') {
    try {
      finalIssue = await relay.getIssue(key);
    } catch (error) {
      failure = failure || error;
    }
  }

  if (!failure) {
    for (const step of plan.steps) {
      if (step.action === 'pull') {
        const block = blocks.get(step.blockId as string)!;
        const source = remoteById.get(block.relayBlockId as number)!;
        revisions.push({
          blockId: block.id,
          relayBlockId: block.relayBlockId,
          blockType: source.type,
          origin: 'relay-pull',
          createdAt: now,
          actorUserId: actor.id,
          actorName: actor.name,
          relayActor: source.updated_by || '',
          before: block.data,
          after: { ...source.data },
        });
        Object.assign(block, {
          type: source.type,
          data: { ...source.data },
          version: block.version + 1,
          updatedAt: now,
          updatedBy: actor.id,
          updatedByName: actor.name,
          base: { hash: blockHash(source.type, source.data), relayUpdatedAt: source.updated_at, syncedAt: now },
        });
        pulled.push(source.id);
      } else if (step.action === 'add') {
        const source = remoteById.get(step.relayBlockId as number)!;
        const block = blockFromRelay(source, now, actor);
        blocks.set(block.id, block);
        revisions.push({
          blockId: block.id,
          relayBlockId: source.id,
          blockType: source.type,
          origin: 'relay-pull',
          createdAt: now,
          actorUserId: actor.id,
          actorName: actor.name,
          relayActor: source.updated_by || '',
          before: null,
          after: { ...source.data },
        });
        pulled.push(source.id);
      } else if (step.action === 'remove') {
        const block = blocks.get(step.blockId as string)!;
        blocks.delete(block.id);
        revisions.push({
          blockId: block.id,
          relayBlockId: block.relayBlockId,
          blockType: block.type,
          origin: 'relay-remove',
          createdAt: now,
          actorUserId: actor.id,
          actorName: actor.name,
          before: block.data,
          after: null,
        });
        pulled.push(block.relayBlockId as number);
      } else if (step.action === 'in_sync') {
        const block = blocks.get(step.blockId as string);
        const source = step.relayBlockId === null ? undefined : remoteById.get(step.relayBlockId);
        if (block && source) block.base = { hash: blockHash(source.type, source.data), relayUpdatedAt: source.updated_at, syncedAt: now };
        else if (!block) tombstones = tombstones.filter((item) => item.id !== step.blockId);
      }
    }
  }

  // Block order follows Relay once the sync is done; unpushed blocks go last.
  const finalOrder = [...finalIssue.blocks].sort((a, b) => a.position - b.position).map((block) => block.id);
  const rank = (block: IssueBlock) => {
    const at = block.relayBlockId === null ? -1 : finalOrder.indexOf(block.relayBlockId);
    return at < 0 ? finalOrder.length + block.position : at;
  };
  const sorted = [...blocks.values()].sort((a, b) => rank(a) - rank(b)).map((block, index) => ({ ...block, position: index }));
  const summary = failure
    ? `stopped after ${pushed.length} push(es), ${created.length} create(s), ${deleted.length} delete(s): ${(failure as Error).message}`
    : `${summarize(plan)}; pushed ${pushed.length}, created ${created.length}, deleted ${deleted.length}, pulled ${pulled.length}`;
  const next: IssueBlockSet = {
    ...set,
    relayIssue: scoped ? set.relayIssue : relayIssueSummary(finalIssue),
    blocks: sorted,
    deleted: tombstones,
    orderBase: failure || scoped ? set.orderBase : finalOrder,
    orderDirty: failure || scoped ? set.orderDirty : false,
    version: set.version + 1,
    lastSync: scoped ? set.lastSync : { at: now, byName: actor.name, summary },
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, revisions);
  if (failure) {
    if (failure instanceof BlocksError || failure instanceof RelayError) throw failure;
    throw new BlocksError(`Sync stopped: ${(failure as Error).message}`, 502, 'blocks_sync_failed');
  }
  return { dryRun: false, relay: where, plan: plan.steps, order: plan.order, pushed, pulled, created, deleted, summary, set: next };
}
