/**
 * Where blocks may go, and the sponsor-block rules (enforced here, server-side,
 * so the UI and the CLI get the same loud refusals):
 *
 *  - The main sponsor block (`sponsor`) is pinned as the first content block:
 *    it cannot be moved, and nothing can be placed above it (the intro stays on
 *    top as the header; blocks above it cannot be moved).
 *  - A sponsor block whose slot has a sponsor document is content read-only and
 *    cannot be deleted: its content only comes from that document, staged into
 *    the draft on every doc save (./sponsorBlocks.ts). It leaves when the doc is
 *    removed from the slot.
 *  - A sponsor slot without a document (an own DataTalks.Club promo, or a
 *    placement booked without a doc yet) takes a hand-made sponsor block that is
 *    edited, and deleted, like any other block.
 */
import type { IssueBlock } from './blocks';
import { BlocksError } from './blocksErrors';

export type SponsorSlotKind = 'primary' | 'secondary';
export type SponsorDocUrls = Partial<Record<SponsorSlotKind, string | undefined>>;

export const SPONSOR_TYPES: Record<string, SponsorSlotKind> = { sponsor: 'primary', sponsor_secondary: 'secondary' };

export const sponsorSlotOf = (type: string): SponsorSlotKind | null => SPONSOR_TYPES[type] || null;

export const byPosition = (blocks: IssueBlock[]) => [...blocks].sort((a, b) => a.position - b.position);

/** Index of the pinned main sponsor block, or -1 when the issue has none. */
export function pinnedIndex(ordered: IssueBlock[]): number {
  return ordered.findIndex((block) => block.type === 'sponsor');
}

function docHint(slot: SponsorSlotKind, urls: SponsorDocUrls): Record<string, unknown> {
  return urls[slot] ? { sponsorDocUrl: urls[slot] } : {};
}

function sponsorRefusal(message: string, code: string, slot: SponsorSlotKind, urls: SponsorDocUrls) {
  return new BlocksError(message, 409, code, docHint(slot, urls));
}

/** True when the block's content comes from its slot's sponsor document. */
export function docOwned(block: Pick<IssueBlock, 'type'>, urls: SponsorDocUrls): boolean {
  const slot = sponsorSlotOf(block.type);
  return Boolean(slot && urls[slot]);
}

/** Content edits of a doc-owned sponsor block come only from the sponsor doc. */
export function assertEditable(block: IssueBlock, urls: SponsorDocUrls): void {
  const slot = sponsorSlotOf(block.type);
  if (!slot || !urls[slot]) return;
  throw sponsorRefusal(
    `Block ${block.id} is the ${slot === 'primary' ? 'main' : 'secondary'} sponsor block: its content comes only from the slot's sponsor document. Edit it in the sponsor doc; every doc save stages it into this draft.`,
    'sponsor_block_readonly',
    slot,
    urls,
  );
}

export function assertDeletable(block: IssueBlock, urls: SponsorDocUrls): void {
  const slot = sponsorSlotOf(block.type);
  if (!slot || !urls[slot]) return;
  throw sponsorRefusal(
    `Block ${block.id} is the ${slot === 'primary' ? 'main' : 'secondary'} sponsor block of a slot with a sponsor document: it leaves the draft when the document is removed from the slot.`,
    'sponsor_block_delete_refused',
    slot,
    urls,
  );
}

/** A hand-made sponsor block is allowed only for a slot without a doc, once per slot. */
export function assertSponsorAddable(type: string, ordered: IssueBlock[], urls: SponsorDocUrls): void {
  const slot = sponsorSlotOf(type);
  if (!slot) return;
  if (urls[slot]) {
    throw sponsorRefusal(
      `The ${slot} slot has a sponsor document: its sponsor block comes from that document (save the doc to stage it).`,
      'sponsor_block_doc_only',
      slot,
      urls,
    );
  }
  if (ordered.some((block) => block.type === type)) {
    throw new BlocksError(`The draft already has a ${slot} sponsor block; edit that one.`, 409, 'sponsor_block_exists');
  }
}

/**
 * `toIndex` is the block's final index. Returns the blocks in the new order, or
 * throws when the move breaks a sponsor rule.
 */
export function moveWithin(ordered: IssueBlock[], blockId: string, toIndex: number, urls: SponsorDocUrls): IssueBlock[] {
  const from = ordered.findIndex((block) => block.id === blockId);
  if (from < 0) throw new BlocksError(`No block ${blockId}.`, 404, 'block_not_found');
  const block = ordered[from];
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ordered.length) {
    throw new BlocksError(`Position ${String(toIndex)} is outside 0..${ordered.length - 1}.`, 400, 'position_invalid');
  }
  if (block.type === 'sponsor') {
    throw sponsorRefusal(
      `Block ${block.id} is the main sponsor block: it is pinned as the first content block and cannot be moved.`,
      'sponsor_block_pinned',
      'primary',
      urls,
    );
  }
  const pin = pinnedIndex(ordered);
  if (pin >= 0 && from < pin) {
    throw new BlocksError(
      `Block ${block.id} sits above the pinned main sponsor block and cannot be moved.`,
      409,
      'above_pinned_sponsor',
      docHint('primary', urls),
    );
  }
  if (pin >= 0 && toIndex <= pin) {
    throw new BlocksError(
      `Nothing can be placed above the pinned main sponsor block (it is the first content block, at position ${pin}). Move to position ${pin + 1} or later.`,
      409,
      'above_pinned_sponsor',
      docHint('primary', urls),
    );
  }
  const next = ordered.filter((item) => item.id !== blockId);
  next.splice(toIndex, 0, block);
  return next;
}

/** Position for a new block: append when omitted; never above the pinned sponsor. */
export function insertionIndex(ordered: IssueBlock[], position: unknown, urls: SponsorDocUrls, type = ''): number {
  if (type === 'sponsor') {
    // The main sponsor block goes first, right under the intro.
    let index = 0;
    while (index < ordered.length && ordered[index].type === 'intro') index += 1;
    return index;
  }
  if (position === undefined || position === null || position === '') return ordered.length;
  if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > ordered.length) {
    throw new BlocksError(`Position ${String(position)} is outside 0..${ordered.length}.`, 400, 'position_invalid');
  }
  const pin = pinnedIndex(ordered);
  if (pin >= 0 && (position as number) <= pin) {
    throw new BlocksError(
      `Nothing can be placed above the pinned main sponsor block (it is the first content block, at position ${pin}). Add at position ${pin + 1} or later.`,
      409,
      'above_pinned_sponsor',
      docHint('primary', urls),
    );
  }
  return position as number;
}

export const renumber = (ordered: IssueBlock[]): IssueBlock[] => ordered.map((block, index) => (block.position === index ? block : { ...block, position: index }));
