/**
 * Where blocks may go, and the sponsor-block rules (enforced here, server-side,
 * so the UI and the CLI get the same loud refusals):
 *
 *  - The main sponsor block (`sponsor`) is pinned as the first content block:
 *    it cannot be moved or deleted, and nothing can be placed above it (the
 *    intro stays on top as the header; nothing else may be moved above the
 *    sponsor, and blocks above it cannot be moved).
 *  - Secondary sponsor blocks (`sponsor_secondary`) can be reordered, but not
 *    deleted directly: they leave when their slot is removed from the sponsor doc.
 *  - Every sponsor block is content read-only: its content only comes from its
 *    sponsor document through the automatic sponsor-doc sync.
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

/** Content edits of sponsor blocks come only from the sponsor doc. */
export function assertEditable(block: IssueBlock, urls: SponsorDocUrls): void {
  const slot = sponsorSlotOf(block.type);
  if (!slot) return;
  throw sponsorRefusal(
    `Block ${block.id} is the ${slot === 'primary' ? 'main' : 'secondary'} sponsor block: its content is read-only here and comes only from the sponsor document. Edit it in the sponsor doc; it syncs to this issue and to Relay on save.`,
    'sponsor_block_readonly',
    slot,
    urls,
  );
}

export function assertDeletable(block: IssueBlock, urls: SponsorDocUrls): void {
  const slot = sponsorSlotOf(block.type);
  if (slot === 'primary') {
    throw sponsorRefusal(
      `Block ${block.id} is the main sponsor block: it is pinned as the first content block and cannot be deleted.`,
      'sponsor_block_pinned',
      slot,
      urls,
    );
  }
  if (slot === 'secondary') {
    throw sponsorRefusal(
      `Block ${block.id} is a secondary sponsor block: it cannot be deleted directly. Remove the slot from the sponsor doc and it leaves the issue on the next doc sync.`,
      'sponsor_block_delete_refused',
      slot,
      urls,
    );
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
export function insertionIndex(ordered: IssueBlock[], position: unknown, urls: SponsorDocUrls): number {
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
