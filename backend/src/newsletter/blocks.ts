/**
 * Newsletter content blocks: the editable pieces of one issue (intro, sponsor,
 * event spotlight, course updates, events list, recording, article...).
 *
 * DataOps is the only home of an issue's content. Staff build the draft here
 * block by block (each change is one revision), DataOps renders the email
 * itself (./emailRender.ts), the owner approves the exact rendered revision
 * (./draftApproval.ts), and only that frozen payload goes to Relay, which is
 * transport only (./relayTransport.ts). Nothing is ever imported or pulled from
 * Relay, and no block is written to Relay.
 *
 * Block field names, kinds and limits keep the catalogue Relay's renderer used
 * (`mailing.services.newsletters.BLOCK_TYPES`), so issues built here render
 * like the issues sent before.
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

export function validUrl(value: string): boolean {
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

export interface IssueBlock {
  /** Stable id within the issue (`nb-<random>`; `rb-<n>` on archived drafts first built from Relay). */
  id: string;
  position: number;
  type: string;
  data: BlockData;
  /** Bumped on every change to this block. */
  version: number;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string | null;
}

export type SponsorSyncStatus = { at: string; ok: boolean; error?: string; docId: string; summary?: string };

/** The owner's approval of one exact rendered revision of the draft. */
export interface DraftApproval {
  /** The draft `version` that was approved; any later change makes the approval stale. */
  draftVersion: number;
  /** sha256 of the frozen payload (subject, preview text, HTML, text) that was approved. */
  payloadHash: string;
  approvedAt: string;
  approvedBy: string;
  approvedByName: string | null;
  note?: string;
}

/** The owner received the test email of an approval and accepted it (see ./relayTransport.ts). */
export interface DraftTestReceipt {
  /** The approval's `draftVersion` and payload hash the received test email carried. */
  approvedVersion: number;
  payloadHash: string;
  /** The test send whose email arrived, and the Relay campaign it went through. */
  testRequestId: string;
  campaignKey: string;
  recipient: string;
  receivedAt: string;
  receivedBy: string;
  receivedByName: string | null;
}

/** Where the approved payload went in Relay (see ./relayTransport.ts). */
export interface DraftDelivery {
  state: 'scheduling' | 'scheduled' | 'failed' | 'cancelled';
  draftVersion: number;
  payloadHash: string;
  campaignKey: string;
  audience: string;
  scheduledAt: string;
  relayStatus?: string;
  error?: string;
  requestedAt: string;
  requestedBy: string;
  requestedByName: string | null;
  /** 1 for the first Relay campaign; a cancelled schedule moves on to a new campaign. */
  attempt?: number;
  /** The schedule request's idempotency key: a replay returns this delivery. */
  requestId?: string;
  updatedAt: string;
}

export interface IssueBlockSet {
  issueId: string;
  /** Email subject and inbox preview (preheader), edited in DataOps. */
  subject: string;
  previewText: string;
  blocks: IssueBlock[];
  /** Outcome of the last sponsor-doc staging per slot (local only). */
  sponsorSync?: Partial<Record<'primary' | 'secondary', SponsorSyncStatus>>;
  /** Unguessable id of the public "View this email in your browser" page. */
  webViewToken: string;
  approval?: DraftApproval | null;
  /** Required before scheduling: the owner got the test email of the current approval. */
  testReceipt?: DraftTestReceipt | null;
  delivery?: DraftDelivery | null;
  /** Held while a test send rewrites the Relay draft campaign; a schedule waits for it. */
  testLock?: { requestId: string; at: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const newBlockId = () => `nb-${randomBytes(5).toString('hex')}`;
export const newWebViewToken = () => randomBytes(18).toString('base64url');

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
