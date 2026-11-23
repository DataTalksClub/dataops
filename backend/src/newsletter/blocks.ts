/**
 * Newsletter content blocks: the editable pieces of one issue (intro, sponsor,
 * event spotlight, course updates, events list, recording, article...).
 *
 * Relay renders and sends the newsletter from its own blocks. DataOps keeps an
 * editable copy of the same blocks so staff can edit every block here, with a
 * revision history per edit, and syncs it with Relay both ways. Neither side is
 * overwritten blindly: each block remembers the content both sides last agreed
 * on (its sync base), and a sync is a three-way merge against that base:
 *
 *   changed only here     -> push to Relay
 *   changed only in Relay -> pull into DataOps
 *   changed on both sides -> conflict; the whole sync stops before any write
 *
 * Block field names, kinds and limits mirror Relay's
 * `mailing.services.newsletters.BLOCK_TYPES`, so content that saves here also
 * saves in Relay (whose block update is strict).
 */
import { createHash, randomBytes } from 'crypto';

export type BlockFieldKind = 'text' | 'url' | 'markdown' | 'lines' | 'html';

export const FIELD_KINDS: Record<string, BlockFieldKind> = {
  kicker: 'text',
  title: 'text',
  meta: 'text',
  image_url: 'url',
  image_link: 'url',
  body: 'markdown',
  bullets: 'lines',
  closing: 'markdown',
  cta_text: 'text',
  cta_url: 'url',
  issue_label: 'text',
  summary: 'markdown',
  events: 'lines',
  links: 'lines',
  footer: 'markdown',
  html: 'html',
};

export const FIELD_LABELS: Record<string, string> = {
  kicker: 'Section label ("-" for none)',
  title: 'Title',
  meta: 'Date / details line',
  image_url: 'Image URL',
  image_link: 'Image link',
  body: 'Text (Markdown)',
  bullets: 'Bullet points (one per line)',
  closing: 'Closing text (Markdown)',
  cta_text: 'Button text',
  cta_url: 'Button link',
  issue_label: 'Issue label',
  summary: 'This week (Markdown)',
  events: 'Events (one per line: when · type | title | https://link | with Speaker)',
  links: 'Links (one per line: title | https://link | optional note)',
  footer: 'Text under the list (Markdown)',
  html: 'HTML',
};

export const MAX_LENGTHS: Record<BlockFieldKind, number> = {
  text: 500,
  url: 2000,
  markdown: 20_000,
  lines: 20_000,
  html: 100_000,
};

const CARD_FIELDS = ['kicker', 'title', 'meta', 'image_url', 'image_link', 'body', 'bullets', 'closing', 'cta_text', 'cta_url'];

export interface BlockTypeSpec {
  label: string;
  fields: string[];
  required: string[];
  defaults: Record<string, string>;
}

const card = (label: string, kicker = '', required: string[] = ['title']): BlockTypeSpec => ({
  label,
  fields: CARD_FIELDS,
  required,
  defaults: kicker ? { kicker } : {},
});

export const BLOCK_TYPES: Record<string, BlockTypeSpec> = {
  intro: { label: 'Intro', fields: ['issue_label', 'summary'], required: ['summary'], defaults: {} },
  sponsor: card('Sponsor (main)', 'SPONSORED', ['title', 'cta_text', 'cta_url']),
  sponsor_secondary: card('Sponsor (secondary)', 'SPONSORED', ['title', 'cta_url']),
  course_promo: card('Course promo', '', ['title', 'cta_text', 'cta_url']),
  own_promo: card('Own promo', '', ['title']),
  course_update: card('Course update'),
  event_spotlight: card('Event spotlight', 'EVENT', ['title', 'cta_url']),
  events_list: {
    label: 'Upcoming events list',
    fields: ['kicker', 'title', 'events', 'footer'],
    required: ['events'],
    defaults: { kicker: 'EVENTS', title: 'Upcoming Events' },
  },
  recording: card('Recording', 'RECORDINGS'),
  podcast_episode: card('Podcast episode', 'PODCAST'),
  alexey_article: card('Article (Alexey on Data)', 'READ'),
  book_of_week: card('Book of the week', 'BOOK OF THE WEEK'),
  feature: card('Feature'),
  link_list: { label: 'Link list', fields: ['kicker', 'title', 'links'], required: ['links'], defaults: {} },
  html: { label: 'Custom HTML', fields: ['html'], required: ['html'], defaults: {} },
};

export type BlockData = Record<string, string>;

export class BlockValidationError extends Error {
  constructor(public readonly errors: Record<string, string>) {
    super(`Invalid block content: ${Object.entries(errors).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && ![...value].some((c) => c.charCodeAt(0) < 33)
    );
  } catch {
    return false;
  }
}

const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/**
 * Clean `data` for `type` the way Relay's strict update does (trim, drop empty
 * fields, reject unknown fields, bad URLs, over-long values and missing required
 * fields). Returns the cleaned data or throws BlockValidationError.
 */
export function validateBlockData(type: string, data: unknown, { draft = false } = {}): BlockData {
  const spec = BLOCK_TYPES[type];
  if (!spec) throw new BlockValidationError({ type: 'unknown_block_type' });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BlockValidationError({ data: 'must_be_object' });
  const input = data as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const name of Object.keys(input)) {
    if (!spec.fields.includes(name)) errors[`data.${name}`] = 'unknown_field';
  }
  const cleaned: BlockData = {};
  for (const name of spec.fields) {
    const kind = FIELD_KINDS[name];
    let value = input[name] ?? '';
    if (typeof value !== 'string') {
      errors[`data.${name}`] = 'must_be_string';
      continue;
    }
    if (kind !== 'html') value = value.trim();
    const text = value as string;
    if (text.length > MAX_LENGTHS[kind]) {
      errors[`data.${name}`] = 'too_long';
      continue;
    }
    if (kind === 'url' && text && !validUrl(text)) {
      errors[`data.${name}`] = 'invalid_url';
      continue;
    }
    if (!draft && spec.required.includes(name) && !text && !spec.defaults[name]) {
      errors[`data.${name}`] = 'required';
      continue;
    }
    if (name === 'events') {
      lines(text).forEach((line, index) => {
        const parts = line.split('|').map((part) => part.trim());
        if (parts.length > 2 && parts[2] && !validUrl(parts[2])) errors[`data.events.${index}`] = 'invalid_url';
      });
    }
    if (name === 'links') {
      lines(text).forEach((line, index) => {
        const parts = line.split('|').map((part) => part.trim());
        if (parts.length < 2 || !validUrl(parts[1])) errors[`data.links.${index}`] = 'invalid_url';
      });
    }
    if (text) cleaned[name] = text;
  }
  if (Object.keys(errors).length) throw new BlockValidationError(errors);
  return cleaned;
}

/** Comparable form of a block's content: type plus non-empty fields in key order. */
export function canonicalBlock(type: string, data: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(data || {})
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([type, entries]);
}

export function blockHash(type: string, data: Record<string, unknown> | null | undefined): string {
  return createHash('sha256').update(canonicalBlock(type, data)).digest('hex').slice(0, 32);
}

export function blockLabel(type: string): string {
  return BLOCK_TYPES[type]?.label || type;
}

// ---------------------------------------------------------------- stored shape

export type RelayTarget = 'production' | 'dev';
export const RELAY_TARGETS: RelayTarget[] = ['production', 'dev'];

/** What both sides last agreed on for one block. */
export interface BlockSyncBase {
  hash: string;
  relayUpdatedAt: string;
  syncedAt: string;
}

export interface IssueBlock {
  /** Stable DataOps id: `rb-<relay block id>` for blocks that came from Relay, `nb-<random>` for blocks added here. */
  id: string;
  /** The Relay block this mirrors; null until a block added in DataOps is pushed. */
  relayBlockId: number | null;
  position: number;
  type: string;
  data: BlockData;
  /** Bumped on every change to this block (edit or pull). */
  version: number;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string | null;
  base: BlockSyncBase;
}

/** A block deleted in DataOps whose Relay copy is removed on the next sync. */
export interface DeletedBlock {
  id: string;
  relayBlockId: number;
  type: string;
  data: BlockData;
  /** Hash both sides last agreed on; a Relay edit since then blocks the delete. */
  baseHash: string;
  deletedAt: string;
  deletedByName: string | null;
}

export type SponsorSyncStatus = { at: string; ok: boolean; error?: string; docId: string; summary?: string };

export interface IssueBlockSet {
  issueId: string;
  relay: { target: RelayTarget; issueKey: string };
  /** Issue-level fields as last read from Relay (shown, not edited here). */
  relayIssue: { subject: string; previewText: string; campaignStatus: string | null; updatedAt: string };
  blocks: IssueBlock[];
  /** Blocks deleted here and still present in Relay. */
  deleted?: DeletedBlock[];
  /** Relay block ids in the order both sides last agreed on. */
  orderBase?: number[];
  /** The order was changed in DataOps since the last sync. */
  orderDirty?: boolean;
  /** Outcome of the last automatic sponsor-doc sync per slot. */
  sponsorSync?: Partial<Record<'primary' | 'secondary', SponsorSyncStatus>>;
  version: number;
  lastSync: { at: string; byName: string | null; summary: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- Relay payload

export interface RelayBlock {
  id: number;
  position: number;
  type: string;
  data: Record<string, string>;
  needs_review?: boolean;
  updated_by?: string;
  updated_at: string;
}

export interface RelayIssue {
  key: string;
  subject: string;
  preview_text?: string;
  issue_number?: number | null;
  campaign?: { status?: string } | null;
  updated_at: string;
  blocks: RelayBlock[];
}

// ---------------------------------------------------------------- three-way plan

export type SyncAction = 'in_sync' | 'push' | 'pull' | 'add' | 'remove' | 'conflict' | 'create' | 'delete';

export interface SyncStep {
  action: SyncAction;
  blockId: string | null;
  relayBlockId: number | null;
  type: string;
  reason: string;
}

export interface OrderStep {
  action: 'none' | 'push' | 'pull' | 'conflict';
  reason: string;
}

export interface SyncPlan {
  steps: SyncStep[];
  conflicts: SyncStep[];
  /** Existing Relay blocks to update. */
  pushes: SyncStep[];
  /** Blocks added in DataOps, to create in Relay. */
  creates: SyncStep[];
  /** Blocks deleted in DataOps, to delete in Relay. */
  deletes: SyncStep[];
  pulls: SyncStep[];
  order: OrderStep;
}

const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Compare each block against its sync base. Never decides a winner when both
 * sides changed: that is a conflict, and executing a plan with conflicts is
 * refused as a whole. Blocks added in DataOps are created in Relay, blocks
 * deleted in DataOps are deleted there (unless Relay edited them since), and
 * the block order follows whichever side changed it.
 */
export function planSync(
  blocks: IssueBlock[],
  relay: RelayIssue,
  extras: { deleted?: DeletedBlock[]; orderBase?: number[]; orderDirty?: boolean } = {},
): SyncPlan {
  const steps: SyncStep[] = [];
  const relayById = new Map(relay.blocks.map((block) => [block.id, block]));
  const seen = new Set<number>();
  for (const local of blocks) {
    if (local.relayBlockId === null) {
      steps.push({ action: 'create', blockId: local.id, relayBlockId: null, type: local.type, reason: 'added in DataOps' });
      continue;
    }
    const remote = relayById.get(local.relayBlockId);
    const localHash = blockHash(local.type, local.data);
    const localChanged = localHash !== local.base.hash;
    const common = { blockId: local.id, relayBlockId: local.relayBlockId, type: local.type };
    if (!remote) {
      steps.push(
        localChanged
          ? { ...common, action: 'conflict', reason: 'deleted in Relay but edited in DataOps' }
          : { ...common, action: 'remove', reason: 'deleted in Relay' },
      );
      continue;
    }
    seen.add(remote.id);
    const remoteHash = blockHash(remote.type, remote.data);
    const remoteChanged = remoteHash !== local.base.hash;
    if (localHash === remoteHash) {
      steps.push({ ...common, action: 'in_sync', reason: localChanged ? 'both sides made the same change' : 'unchanged' });
    } else if (localChanged && remoteChanged) {
      steps.push({
        ...common,
        action: 'conflict',
        reason: `edited in DataOps and in Relay (Relay: ${remote.updated_by || 'unknown'} at ${remote.updated_at})`,
      });
    } else if (localChanged) {
      steps.push({ ...common, action: 'push', reason: 'edited in DataOps' });
    } else {
      steps.push({ ...common, action: 'pull', reason: `edited in Relay by ${remote.updated_by || 'unknown'}` });
    }
  }
  for (const gone of extras.deleted || []) {
    const remote = relayById.get(gone.relayBlockId);
    const common = { blockId: gone.id, relayBlockId: gone.relayBlockId, type: gone.type };
    if (!remote) {
      steps.push({ ...common, action: 'in_sync', reason: 'deleted in DataOps and already gone from Relay' });
      continue;
    }
    seen.add(remote.id);
    if (blockHash(remote.type, remote.data) !== gone.baseHash) {
      steps.push({
        ...common,
        action: 'conflict',
        reason: `deleted in DataOps but edited in Relay (Relay: ${remote.updated_by || 'unknown'} at ${remote.updated_at})`,
      });
    } else {
      steps.push({ ...common, action: 'delete', reason: 'deleted in DataOps' });
    }
  }
  for (const remote of relay.blocks) {
    if (seen.has(remote.id)) continue;
    steps.push({ action: 'add', blockId: null, relayBlockId: remote.id, type: remote.type, reason: 'new in Relay' });
  }

  // Order: compare only the blocks both sides know, so adds and deletes do not count as moves.
  const relayOrder = [...relay.blocks].sort((a, b) => a.position - b.position).map((block) => block.id);
  const localOrder = [...blocks]
    .sort((a, b) => a.position - b.position)
    .map((block) => block.relayBlockId)
    .filter((id): id is number => id !== null && relayById.has(id));
  const base = extras.orderBase;
  const baseKnown = base ? base.filter((id) => relayById.has(id)) : relayOrder;
  const relayKnown = relayOrder.filter((id) => (base ? base.includes(id) : true));
  const relayMoved = !sameList(relayKnown, baseKnown);
  const localMoved = Boolean(extras.orderDirty);
  const localCommon = localOrder.filter((id) => relayOrder.includes(id));
  const relayCommon = relayOrder.filter((id) => localOrder.includes(id));
  let order: OrderStep = { action: 'none', reason: 'same order' };
  if (localMoved && relayMoved && !sameList(localCommon, relayCommon)) {
    order = { action: 'conflict', reason: 'blocks were reordered in DataOps and in Relay' };
  } else if (localMoved && !sameList(localCommon, relayCommon)) {
    order = { action: 'push', reason: 'reordered in DataOps' };
  } else if (relayMoved && !sameList(localCommon, relayCommon)) {
    order = { action: 'pull', reason: 'reordered in Relay' };
  }
  if (order.action === 'conflict') {
    steps.push({ action: 'conflict', blockId: null, relayBlockId: null, type: 'order', reason: order.reason });
  }
  return {
    steps,
    conflicts: steps.filter((step) => step.action === 'conflict'),
    pushes: steps.filter((step) => step.action === 'push'),
    creates: steps.filter((step) => step.action === 'create'),
    deletes: steps.filter((step) => step.action === 'delete'),
    pulls: steps.filter((step) => step.action === 'pull' || step.action === 'add' || step.action === 'remove'),
    order,
  };
}

export const localBlockId = (relayBlockId: number) => `rb-${relayBlockId}`;
export const newBlockId = () => `nb-${randomBytes(5).toString('hex')}`;

/** A local block that mirrors `remote` exactly, with the sync base set to it. */
export function blockFromRelay(remote: RelayBlock, now: string, actor: { id: string; name: string | null }, version = 1): IssueBlock {
  return {
    id: localBlockId(remote.id),
    relayBlockId: remote.id,
    position: remote.position,
    type: remote.type,
    data: { ...(remote.data || {}) },
    version,
    updatedAt: now,
    updatedBy: actor.id,
    updatedByName: actor.name,
    base: { hash: blockHash(remote.type, remote.data), relayUpdatedAt: remote.updated_at, syncedAt: now },
  };
}

// ---------------------------------------------------------------- diffs

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export function changedFields(before: BlockData | null, after: BlockData | null): FieldChange[] {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  return keys
    .map((field) => ({ field, before: before?.[field] ?? '', after: after?.[field] ?? '' }))
    .filter((change) => change.before !== change.after);
}
