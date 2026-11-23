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
import { MAX_RELAY_BODY_BYTES, RelayError, relayBodyBytes, relayClient } from './blocksRelay';

export interface BlockActor {
  id: string;
  name: string | null;
}

export class BlocksError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

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
): Promise<{ set: IssueBlockSet; block: IssueBlock; changed: boolean }> {
  const set = await requireBlockSet(client, issueId);
  const block = set.blocks.find((item) => item.id === blockId);
  if (!block) throw new BlocksError(`Issue ${issueId} has no block ${blockId}.`, 404, 'block_not_found');
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
  pushed: number[];
  pulled: number[];
  summary: string;
  set: IssueBlockSet;
}

function summarize(plan: SyncPlan): string {
  const counts = new Map<string, number>();
  for (const step of plan.steps) counts.set(step.action, (counts.get(step.action) || 0) + 1);
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(', ') || 'no blocks';
}

/** Three-way sync with Relay. Refuses as a whole on any conflict. */
export async function syncBlocks(
  client: DynamoDBDocumentClient,
  issueId: string,
  options: { dryRun: boolean },
  actor: BlockActor,
): Promise<SyncResult> {
  const set = await requireBlockSet(client, issueId);
  const relay = await relayClient(set.relay.target);
  const remote = await relay.getIssue(set.relay.issueKey);
  const plan = planSync(set.blocks, remote);
  const where = { target: set.relay.target, url: relay.url, issueKey: set.relay.issueKey };

  if (plan.conflicts.length) {
    throw new BlocksError(
      `Sync refused: ${plan.conflicts.length} block(s) changed both in DataOps and in Relay since the last sync. ` +
        'Nothing was written. Resolve each conflict by making both sides equal (copy one into the other), then sync again.',
      409,
      'blocks_sync_conflict',
      { plan: plan.steps, conflicts: plan.conflicts },
    );
  }
  const campaignStatus = remote.campaign?.status || null;
  if (plan.pushes.length && campaignStatus && !EDITABLE_CAMPAIGN_STATUSES.has(campaignStatus)) {
    throw new BlocksError(
      `Sync refused: Relay issue ${set.relay.issueKey} has a ${campaignStatus} campaign, so its blocks are no longer edited. Nothing was written.`,
      409,
      'blocks_campaign_locked',
      { plan: plan.steps },
    );
  }
  const localById = new Map(set.blocks.map((block) => [block.id, block]));
  for (const step of plan.pushes) {
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
  if (options.dryRun) {
    return { dryRun: true, relay: where, plan: plan.steps, pushed: [], pulled: [], summary: summarize(plan), set };
  }

  const now = new Date().toISOString();
  const remoteById = new Map(remote.blocks.map((block) => [block.id, block]));
  const blocks = new Map(set.blocks.map((block) => [block.id, { ...block }]));
  const revisions: NewRevision[] = [];
  const pushed: number[] = [];
  const pulled: number[] = [];
  let failure: unknown = null;

  // Pushes first, one block per request; each re-reads the Relay block right
  // before writing so an edit made in Relay since the plan is not overwritten.
  for (const step of plan.pushes) {
    const block = blocks.get(step.blockId as string) as IssueBlock;
    const seen = remoteById.get(block.relayBlockId)!;
    try {
      const fresh = await relay.getBlock(set.relay.issueKey, block.relayBlockId);
      if (fresh.updated_at !== seen.updated_at || blockHash(fresh.type, fresh.data) !== blockHash(seen.type, seen.data)) {
        throw new BlocksError(
          `Sync stopped: Relay block ${block.relayBlockId} changed during the sync (by ${fresh.updated_by || 'unknown'} at ${fresh.updated_at}). ` +
            `It was not overwritten. ${pushed.length} block(s) pushed before this were saved; sync again to see the conflict.`,
          409,
          'blocks_sync_conflict',
        );
      }
      const saved = await relay.putBlock(set.relay.issueKey, block.relayBlockId, block.type, block.data);
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
      remoteById.set(saved.id, saved);
      pushed.push(block.relayBlockId);
    } catch (error) {
      failure = error;
      break;
    }
  }

  if (!failure) {
    for (const step of plan.steps) {
      if (step.action === 'pull') {
        const block = blocks.get(step.blockId as string)!;
        const source = remoteById.get(block.relayBlockId)!;
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
        pulled.push(block.relayBlockId);
      } else if (step.action === 'add') {
        const source = remoteById.get(step.relayBlockId)!;
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
        pulled.push(block.relayBlockId);
      } else if (step.action === 'in_sync') {
        const block = blocks.get(step.blockId as string)!;
        const source = remoteById.get(block.relayBlockId)!;
        block.base = { hash: blockHash(source.type, source.data), relayUpdatedAt: source.updated_at, syncedAt: now };
      }
    }
  }

  // Block order follows Relay (blocks are added and reordered there).
  for (const block of blocks.values()) {
    const source = remoteById.get(block.relayBlockId);
    if (source) block.position = source.position;
  }
  const summary = failure
    ? `stopped after pushing ${pushed.length}: ${(failure as Error).message}`
    : `${summarize(plan)}; pushed ${pushed.length}, pulled ${pulled.length}`;
  const next: IssueBlockSet = {
    ...set,
    relayIssue: relayIssueSummary(remote),
    blocks: [...blocks.values()].sort((a, b) => a.position - b.position),
    version: set.version + 1,
    lastSync: { at: now, byName: actor.name, summary },
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, revisions);
  if (failure) {
    if (failure instanceof BlocksError || failure instanceof RelayError) throw failure;
    throw new BlocksError(`Sync stopped: ${(failure as Error).message}`, 502, 'blocks_sync_failed');
  }
  return { dryRun: false, relay: where, plan: plan.steps, pushed, pulled, summary, set: next };
}
