/**
 * Add, move and delete blocks in DataOps (the edit-in-place operations live in
 * blocksSync.ts next to the Relay sync). Every operation is one optimistic
 * write of the block set plus one revision per affected block; the Relay copy
 * follows on the next sync (or at once for sponsor blocks).
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BLOCK_TYPES,
  blockHash,
  newBlockId,
  validateBlockData,
  type IssueBlock,
  type IssueBlockSet,
} from './blocks';
import { BlocksError } from './blocksErrors';
import {
  assertDeletable,
  byPosition,
  insertionIndex,
  moveWithin,
  renumber,
  sponsorSlotOf,
  type SponsorDocUrls,
} from './blocksLayout';
import { appendBlockRevisions, putBlockSet } from './blocksStore';
import { requireBlockSet, type BlockActor } from './blocksSync';

function find(set: IssueBlockSet, blockId: string): IssueBlock {
  const block = set.blocks.find((item) => item.id === blockId);
  if (!block) throw new BlocksError(`Issue ${set.issueId} has no block ${blockId}.`, 404, 'block_not_found');
  return block;
}

export async function addBlock(
  client: DynamoDBDocumentClient,
  issueId: string,
  input: { type: unknown; data?: unknown; position?: unknown },
  urls: SponsorDocUrls,
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; block: IssueBlock }> {
  const type = String(input.type || '');
  const spec = BLOCK_TYPES[type];
  if (!spec) throw new BlocksError(`Unknown block type "${type}". Types: ${Object.keys(BLOCK_TYPES).join(', ')}.`, 400, 'block_type_unknown');
  if (sponsorSlotOf(type)) {
    throw new BlocksError(
      `${spec.label} blocks cannot be added by hand: sponsor blocks are created from the slot's sponsor document when it is saved.`,
      409,
      'sponsor_block_doc_only',
    );
  }
  const set = await requireBlockSet(client, issueId);
  const ordered = byPosition(set.blocks);
  const index = insertionIndex(ordered, input.position, urls);
  const given = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : {};
  const data = validateBlockData(type, { ...spec.defaults, ...given });
  const now = new Date().toISOString();
  const block: IssueBlock = {
    id: newBlockId(),
    relayBlockId: null,
    position: index,
    type,
    data,
    version: 1,
    updatedAt: now,
    updatedBy: actor.id,
    updatedByName: actor.name,
    base: { hash: '', relayUpdatedAt: '', syncedAt: '' },
  };
  ordered.splice(index, 0, block);
  const next: IssueBlockSet = {
    ...set,
    blocks: renumber(ordered),
    orderDirty: true,
    version: set.version + 1,
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, [
    {
      blockId: block.id,
      relayBlockId: null,
      blockType: type,
      origin: 'add',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: `added at position ${index}`,
      before: null,
      after: data,
    },
  ]);
  return { set: next, block: next.blocks.find((item) => item.id === block.id) as IssueBlock };
}

export async function moveBlock(
  client: DynamoDBDocumentClient,
  issueId: string,
  blockId: string,
  input: { to?: unknown; direction?: unknown },
  urls: SponsorDocUrls,
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; block: IssueBlock }> {
  const set = await requireBlockSet(client, issueId);
  const block = find(set, blockId);
  const ordered = byPosition(set.blocks);
  const from = ordered.findIndex((item) => item.id === block.id);
  let to: number;
  if (input.direction === 'up' || input.direction === 'down') to = from + (input.direction === 'up' ? -1 : 1);
  else if (typeof input.to === 'number') to = input.to;
  else throw new BlocksError('Give a direction ("up" or "down") or a target position "to".', 400, 'move_target_missing');
  const moved = renumber(moveWithin(ordered, block.id, to, urls));
  if (to === from) return { set, block };
  const now = new Date().toISOString();
  const next: IssueBlockSet = { ...set, blocks: moved, orderDirty: true, version: set.version + 1, updatedAt: now };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, [
    {
      blockId: block.id,
      relayBlockId: block.relayBlockId,
      blockType: block.type,
      origin: 'move',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: `moved from position ${from} to ${to}`,
      before: block.data,
      after: block.data,
    },
  ]);
  return { set: next, block: next.blocks.find((item) => item.id === block.id) as IssueBlock };
}

export async function deleteBlock(
  client: DynamoDBDocumentClient,
  issueId: string,
  blockId: string,
  urls: SponsorDocUrls,
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; block: IssueBlock }> {
  const set = await requireBlockSet(client, issueId);
  const block = find(set, blockId);
  assertDeletable(block, urls);
  const now = new Date().toISOString();
  const deleted = [...(set.deleted || [])];
  if (block.relayBlockId !== null) {
    deleted.push({
      id: block.id,
      relayBlockId: block.relayBlockId,
      type: block.type,
      data: block.data,
      baseHash: block.base.hash || blockHash(block.type, block.data),
      deletedAt: now,
      deletedByName: actor.name,
    });
  }
  const next: IssueBlockSet = {
    ...set,
    blocks: renumber(byPosition(set.blocks).filter((item) => item.id !== block.id)),
    deleted,
    version: set.version + 1,
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, [
    {
      blockId: block.id,
      relayBlockId: block.relayBlockId,
      blockType: block.type,
      origin: 'delete',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: block.relayBlockId === null ? 'deleted (never pushed to Relay)' : 'deleted; the Relay copy is removed on the next sync',
      before: block.data,
      after: null,
    },
  ]);
  return { set: next, block };
}
