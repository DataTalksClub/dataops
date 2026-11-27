/**
 * Create and edit a newsletter issue draft in DataOps.
 *
 * Every change is one optimistic write of the draft plus one revision per
 * affected block. A change to the content (blocks, subject, preview text)
 * always withdraws the owner's approval, recorded as its own revision, so an
 * approval only ever covers the exact revision that was reviewed. Once the
 * approved payload is handed to Relay for delivery the draft is locked until
 * that schedule is cancelled.
 *
 * Nothing here talks to Relay: a draft is created empty, built here, and never
 * imported or pulled from anywhere.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BLOCK_TYPES,
  blockHash,
  newBlockId,
  newWebViewToken,
  validateBlockData,
  type IssueBlock,
  type IssueBlockSet,
} from './blocks';
import { BlocksError } from './blocksErrors';
import {
  assertDeletable,
  assertEditable,
  assertSponsorAddable,
  byPosition,
  insertionIndex,
  moveWithin,
  renumber,
  type SponsorDocUrls,
} from './blocksLayout';
import { appendBlockRevisions, getBlockSet, putBlockSet, type BlockRevision } from './blocksStore';

export { BlocksError } from './blocksErrors';

export interface BlockActor {
  id: string;
  name: string | null;
}

export type NewRevision = Omit<BlockRevision, 'issueId' | 'revision'>;

export const MAX_SUBJECT_LENGTH = 255;
export const MAX_PREVIEW_TEXT_LENGTH = 255;

/** Delivery states in which Relay holds the approved payload; the draft is frozen. */
const LOCKED_DELIVERY = new Set(['scheduling', 'scheduled']);

export function assertUnlocked(set: IssueBlockSet): void {
  if (set.delivery && LOCKED_DELIVERY.has(set.delivery.state)) {
    throw new BlocksError(
      `The approved email of this issue is ${set.delivery.state === 'scheduled' ? 'scheduled' : 'being scheduled'} in Relay `
        + `(campaign ${set.delivery.campaignKey}); the draft is locked. Cancel the schedule first to edit it.`,
      409,
      'draft_locked',
      { delivery: set.delivery },
    );
  }
}

export async function requireBlockSet(client: DynamoDBDocumentClient, issueId: string): Promise<IssueBlockSet> {
  const set = await getBlockSet(client, issueId);
  if (!set) {
    throw new BlocksError(
      `Issue ${issueId} has no draft yet. Create it in DataOps (the issue page's "Start the draft", or dataops newsletter draft <issue> --create).`,
      404,
      'draft_missing',
    );
  }
  return set;
}

/**
 * Write a content change of `set`: bumps the version, withdraws any approval
 * (and records that), and keeps every other stored attribute.
 */
export async function commitContent(
  client: DynamoDBDocumentClient,
  set: IssueBlockSet,
  changes: Partial<IssueBlockSet>,
  revisions: NewRevision[],
  actor: BlockActor,
  now: string,
): Promise<IssueBlockSet> {
  assertUnlocked(set);
  const next: IssueBlockSet = {
    ...set,
    ...changes,
    webViewToken: set.webViewToken || newWebViewToken(),
    approval: null,
    version: set.version + 1,
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  const withdrawn: NewRevision[] = set.approval
    ? [{
      blockId: '',
      blockType: 'draft',
      origin: 'approval-withdrawn',
      createdAt: now,
      actorUserId: actor.id,
      actorName: actor.name,
      detail: `approval of version ${set.approval.draftVersion} (by ${set.approval.approvedByName || set.approval.approvedBy}) withdrawn: the draft changed`,
      before: null,
      after: null,
    }]
    : [];
  await appendBlockRevisions(client, set.issueId, [...revisions, ...withdrawn]);
  return next;
}

/** "#305 · November 30, 2026", the intro's issue label, like the sent issues. */
export function defaultIssueLabel(issue: { issueNumber?: number; publicationDate: string }): string {
  const date = new Date(`${issue.publicationDate}T12:00:00Z`);
  const when = Number.isNaN(date.getTime())
    ? issue.publicationDate
    : date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return issue.issueNumber ? `#${issue.issueNumber} · ${when}` : when;
}

/** Start an empty draft for `issue`: one intro block with the issue label, nothing else. */
export async function createDraft(
  client: DynamoDBDocumentClient,
  issue: { id: string; issueNumber?: number; publicationDate: string; kind?: string },
  actor: BlockActor,
): Promise<IssueBlockSet> {
  if (await getBlockSet(client, issue.id)) {
    throw new BlocksError(`Issue ${issue.id} already has a draft.`, 409, 'draft_exists');
  }
  const now = new Date().toISOString();
  const intro: IssueBlock = {
    id: newBlockId(),
    position: 0,
    type: 'intro',
    data: { issue_label: defaultIssueLabel(issue) },
    version: 1,
    updatedAt: now,
    updatedBy: actor.id,
    updatedByName: actor.name,
  };
  const set: IssueBlockSet = {
    issueId: issue.id,
    subject: '',
    previewText: '',
    blocks: [intro],
    webViewToken: newWebViewToken(),
    approval: null,
    delivery: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await putBlockSet(client, set, 0);
  await appendBlockRevisions(client, issue.id, [{
    blockId: intro.id,
    blockType: 'intro',
    origin: 'create',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: 'draft created in DataOps',
    before: null,
    after: intro.data,
  }]);
  return set;
}

function cleanLine(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BlocksError(`${field} must be text.`, 400, 'details_invalid');
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new BlocksError(`${field} is ${text.length} characters; the limit is ${max}.`, 400, 'details_invalid');
  return text;
}

/** Edit the subject and inbox preview text. `expectedVersion` is the draft version the editor loaded. */
export async function updateDetails(
  client: DynamoDBDocumentClient,
  issueId: string,
  input: { subject?: unknown; previewText?: unknown; expectedVersion: unknown },
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; changed: boolean }> {
  const set = await requireBlockSet(client, issueId);
  if (input.expectedVersion !== set.version) {
    throw new BlocksError(
      `The draft is at version ${set.version}, not ${String(input.expectedVersion)}: it changed since you opened it. Reload, then edit again.`,
      409,
      'draft_version_conflict',
      { currentVersion: set.version },
    );
  }
  const subject = input.subject === undefined ? set.subject : cleanLine(input.subject, 'Subject', MAX_SUBJECT_LENGTH);
  const previewText = input.previewText === undefined ? set.previewText : cleanLine(input.previewText, 'Preview text', MAX_PREVIEW_TEXT_LENGTH);
  if (subject === set.subject && previewText === set.previewText) return { set, changed: false };
  const now = new Date().toISOString();
  const next = await commitContent(client, set, { subject, previewText }, [{
    blockId: '',
    blockType: 'details',
    origin: 'details',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    before: { subject: set.subject, previewText: set.previewText },
    after: { subject, previewText },
  }], actor, now);
  return { set: next, changed: true };
}

/**
 * Save one block's content. Saving an incomplete block is allowed (the draft
 * is built step by step); unknown fields, bad URLs and over-long values are
 * refused, and approval requires every block to be complete.
 */
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
  const data = validateBlockData(block.type, input.data, { draft: true });
  if (blockHash(block.type, data) === blockHash(block.type, block.data)) return { set, block, changed: false };
  const now = new Date().toISOString();
  const updated: IssueBlock = { ...block, data, version: block.version + 1, updatedAt: now, updatedBy: actor.id, updatedByName: actor.name };
  const next = await commitContent(client, set, { blocks: set.blocks.map((item) => (item.id === blockId ? updated : item)) }, [{
    blockId,
    blockType: block.type,
    origin: 'edit',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    before: block.data,
    after: data,
  }], actor, now);
  return { set: next, block: updated, changed: true };
}

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
  const set = await requireBlockSet(client, issueId);
  const ordered = byPosition(set.blocks);
  assertSponsorAddable(type, ordered, urls);
  const index = insertionIndex(ordered, input.position, urls, type);
  const given = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : {};
  const data = validateBlockData(type, { ...spec.defaults, ...given }, { draft: true });
  const now = new Date().toISOString();
  const block: IssueBlock = { id: newBlockId(), position: index, type, data, version: 1, updatedAt: now, updatedBy: actor.id, updatedByName: actor.name };
  ordered.splice(index, 0, block);
  const next = await commitContent(client, set, { blocks: renumber(ordered) }, [{
    blockId: block.id,
    blockType: type,
    origin: 'add',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: `added at position ${index}`,
    before: null,
    after: data,
  }], actor, now);
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
  const next = await commitContent(client, set, { blocks: moved }, [{
    blockId: block.id,
    blockType: block.type,
    origin: 'move',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: `moved from position ${from} to ${to}`,
    before: block.data,
    after: block.data,
  }], actor, now);
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
  const next = await commitContent(client, set, { blocks: renumber(byPosition(set.blocks).filter((item) => item.id !== block.id)) }, [{
    blockId: block.id,
    blockType: block.type,
    origin: 'delete',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: 'deleted',
    before: block.data,
    after: null,
  }], actor, now);
  return { set: next, block };
}
