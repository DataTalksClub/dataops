/**
 * Automatic sync of a sponsor document into its newsletter issue.
 *
 * On every sponsor-doc save, the issue's sponsor block for that slot (and the
 * Relay copy of it) is rebuilt from the doc: title, intro -> body, bullets,
 * closing, ctaText/ctaUrl, graphics -> image_url/image_link. When the doc owns
 * the primary slot, subjectLine/previewText also become the Relay issue's
 * subject (with the " | DataTalks.Club Weekly" suffix) and preview text.
 *
 * Sponsor blocks are content read-only in the issue editor, so this is the only
 * writer of their content. It never overwrites silently: if the Relay block (or
 * subject) was edited in Relay since the last sync and differs from the doc, the
 * sync fails loudly (unless `force`), and every failure is recorded on the
 * issue, returned to the doc page and raised as a notification.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  BLOCK_TYPES,
  BlockValidationError,
  blockHash,
  newBlockId,
  validateBlockData,
  type BlockData,
  type IssueBlock,
  type IssueBlockSet,
  type SponsorSyncStatus,
} from './blocks';
import { BlocksError } from './blocksErrors';
import { byPosition, renumber, type SponsorSlotKind } from './blocksLayout';
import { RelayError, relayClient } from './blocksRelay';
import { appendBlockRevisions, getBlockSet, putBlockSet, BlockSetVersionConflict } from './blocksStore';
import { syncBlocks, type BlockActor } from './blocksSync';
import { listNewsletterIssues, type NewsletterIssue } from '../db/newsletterIssues';
import { createNotification } from '../db/notifications';
import type { SponsorDoc } from '../db/sponsorDocs';

export const SUBJECT_SUFFIX = ' | DataTalks.Club Weekly';
const BLOCK_TYPE: Record<SponsorSlotKind, string> = { primary: 'sponsor', secondary: 'sponsor_secondary' };

const text = (value: unknown) => String(value ?? '').trim();

/** One bullet per line, list markers stripped. */
export function normalizeBullets(raw: unknown): string {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•→▸▪◦]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean)
    .join('\n');
}

/** Relay block data for a sponsor doc's content; empty fields are omitted. */
export function sponsorBlockData(doc: Pick<SponsorDoc, 'template' | 'content'>): BlockData {
  const content = (doc.content || {}) as Record<string, string>;
  const standalone = doc.template === 'newsletter-standalone';
  const body = standalone ? [text(content.intro), text(content.mainBodyOpening)].filter(Boolean).join('\n\n') : text(content.intro);
  const ctaText = standalone ? text(content.closingCtaText) || text(content.earlyCtaText) : text(content.ctaText);
  const ctaUrl = standalone ? text(content.closingCtaUrl) || text(content.earlyCtaUrl) : text(content.ctaUrl);
  const imageUrl = text(content.graphicsUrl);
  const data: Record<string, string> = {
    kicker: 'SPONSORED',
    title: text(content.title),
    image_url: imageUrl,
    image_link: imageUrl ? ctaUrl : '',
    body,
    bullets: normalizeBullets(content.bullets),
    closing: text(content.closing),
    cta_text: ctaText,
    cta_url: ctaUrl,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value));
}

export function sponsorSubject(doc: Pick<SponsorDoc, 'content'>): { subject: string; previewText: string } | null {
  const content = (doc.content || {}) as Record<string, string>;
  const line = text(content.subjectLine);
  if (!line) return null;
  return { subject: `${line}${SUBJECT_SUFFIX}`, previewText: text(content.previewText) };
}

export const docIdFromUrl = (url: string | undefined): string => {
  const match = /([^/?#]+)\/?(?:[?#].*)?$/.exec(String(url || '').trim());
  return match ? decodeURIComponent(match[1]) : '';
};

/** The slots (of any issue in the sponsor doc's neighbourhood) whose document is `docId`. */
export async function issueSlotsForDoc(
  client: DynamoDBDocumentClient,
  doc: Pick<SponsorDoc, 'id' | 'publicationDate'>,
): Promise<{ issue: NewsletterIssue; slot: SponsorSlotKind }[]> {
  const day = 86_400_000;
  const anchor = doc.publicationDate ? Date.parse(doc.publicationDate) : Date.now();
  const center = Number.isFinite(anchor) ? anchor : Date.now();
  const issues = await listNewsletterIssues(
    client,
    new Date(Math.min(center, Date.now()) - 120 * day).toISOString().slice(0, 10),
    new Date(Math.max(center, Date.now()) + 365 * day).toISOString().slice(0, 10),
  );
  const found: { issue: NewsletterIssue; slot: SponsorSlotKind }[] = [];
  for (const issue of issues) {
    for (const slot of ['primary', 'secondary'] as const) {
      if (docIdFromUrl(issue.slots?.[slot]?.documentUrl) === doc.id) found.push({ issue, slot });
    }
  }
  return found;
}

export interface SponsorSyncResult {
  status: 'ok' | 'failed' | 'skipped';
  message: string;
  issueId: string;
  slot: SponsorSlotKind;
  at: string;
  block?: string;
  dryRun?: boolean;
  changes?: string[];
}

export interface SponsorSyncDeps {
  /** Hosts an uploaded `data:` image and returns its public https URL. */
  hostDataImage?: (dataUrl: string) => Promise<string>;
}

function missingRequired(type: string, data: BlockData): string[] {
  return (BLOCK_TYPES[type]?.required || []).filter((name) => !data[name] && !BLOCK_TYPES[type].defaults[name]);
}

/** Where a newly created sponsor block goes: primary right after the intro, secondary after the primary. */
function sponsorInsertIndex(ordered: IssueBlock[], slot: SponsorSlotKind): number {
  if (slot === 'secondary') {
    const primary = ordered.findIndex((block) => block.type === 'sponsor');
    if (primary >= 0) return primary + 1;
  }
  let index = 0;
  while (index < ordered.length && ordered[index].type === 'intro') index += 1;
  return index;
}

async function recordStatus(
  client: DynamoDBDocumentClient,
  issueId: string,
  slot: SponsorSlotKind,
  status: SponsorSyncStatus,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const set = await getBlockSet(client, issueId);
    if (!set) return;
    try {
      await putBlockSet(client, { ...set, sponsorSync: { ...(set.sponsorSync || {}), [slot]: status }, version: set.version + 1 }, set.version);
      return;
    } catch (error) {
      if (!(error instanceof BlockSetVersionConflict) || attempt === 2) throw error;
    }
  }
}

/** Sync one slot of one issue from its sponsor doc. Throws only for unexpected bugs; expected failures are reported in the result. */
export async function syncSponsorSlot(
  client: DynamoDBDocumentClient,
  issue: Pick<NewsletterIssue, 'id' | 'publicationDate'> & { issueNumber?: number },
  slot: SponsorSlotKind,
  doc: SponsorDoc,
  actor: BlockActor,
  options: { dryRun?: boolean; force?: boolean } = {},
  deps: SponsorSyncDeps = {},
): Promise<SponsorSyncResult> {
  const at = new Date().toISOString();
  const base = { issueId: issue.id, slot, at };
  const fail = async (message: string): Promise<SponsorSyncResult> => {
    if (!options.dryRun) {
      await recordStatus(client, issue.id, slot, { at, ok: false, error: message, docId: doc.id }).catch(() => undefined);
      console.error(JSON.stringify({ event: 'newsletter_sponsor_sync_failed', level: 'ERROR', issueId: issue.id, slot, docId: doc.id, message }));
      try {
        await createNotification(client, {
          type: 'newsletter-sponsor-sync-failed',
          message: `Sponsor doc "${doc.title || doc.id}" did not sync to newsletter issue ${issue.issueNumber ? `#${issue.issueNumber}` : issue.id} (${slot} slot): ${message}`,
          metadata: { docId: doc.id, issueId: issue.id, slot },
        });
      } catch (notifyError) {
        console.error('Failed to persist newsletter sponsor sync alert notification:', notifyError);
      }
    }
    return { ...base, status: 'failed', message };
  };
  const skip = (message: string): SponsorSyncResult => ({ ...base, status: 'skipped', message });

  const set = await getBlockSet(client, issue.id);
  if (!set) {
    return skip(
      `Issue ${issue.issueNumber ? `#${issue.issueNumber}` : issue.id} has no content blocks in DataOps yet, so nothing was synced. ` +
        'Import them once: dataops newsletter blocks <issue> --import <relay-issue-key>.',
    );
  }
  const type = BLOCK_TYPE[slot];
  let data = sponsorBlockData(doc);
  const existing = set.blocks.filter((block) => block.type === type);
  if (existing.length > 1) return fail(`Issue has ${existing.length} "${type}" blocks (${existing.map((b) => b.id).join(', ')}); expected one.`);
  const current = existing[0];
  if (current?.data.meta) data = { ...data, meta: current.data.meta };
  const missing = missingRequired(type, data);
  if (missing.length) {
    return skip(`The sponsor doc is not complete enough to publish yet (missing: ${missing.join(', ')}); the issue block was not changed.`);
  }
  try {
    if (/^data:/i.test(data.image_url || '')) {
      if (!deps.hostDataImage) return await fail('The doc has an uploaded graphics image but image hosting is unavailable here.');
      data = { ...data, image_url: await deps.hostDataImage(data.image_url) };
    }
    data = validateBlockData(type, data);
  } catch (error) {
    if (error instanceof BlockValidationError) {
      return fail(`The sponsor doc content is not valid for a newsletter block: ${error.message}`);
    }
    return fail(`Preparing the sponsor block failed: ${(error as Error).message}`);
  }

  const changes: string[] = [];
  let blockId = current?.id || '';
  if (options.dryRun) {
    changes.push(current ? (blockHash(type, current.data) === blockHash(type, data) ? 'block unchanged' : 'block would be updated') : 'block would be added');
  } else {
    const now = new Date().toISOString();
    const ordered = byPosition(set.blocks);
    let next: IssueBlockSet;
    if (!current) {
      const index = sponsorInsertIndex(ordered, slot);
      blockId = newBlockId();
      const block: IssueBlock = {
        id: blockId, relayBlockId: null, position: index, type, data, version: 1, updatedAt: now,
        updatedBy: actor.id, updatedByName: actor.name, base: { hash: '', relayUpdatedAt: '', syncedAt: '' },
      };
      ordered.splice(index, 0, block);
      next = { ...set, blocks: renumber(ordered), orderDirty: true, version: set.version + 1, updatedAt: now };
      await putBlockSet(client, next, set.version);
      await appendBlockRevisions(client, issue.id, [{
        blockId, relayBlockId: null, blockType: type, origin: 'sponsor-doc', createdAt: now, actorUserId: actor.id,
        actorName: actor.name, detail: `created from sponsor doc ${doc.id}`, before: null, after: data,
      }]);
      changes.push('block added');
    } else if (blockHash(type, current.data) !== blockHash(type, data)) {
      const updated = { ...current, data, version: current.version + 1, updatedAt: now, updatedBy: actor.id, updatedByName: actor.name };
      next = { ...set, blocks: set.blocks.map((block) => (block.id === current.id ? updated : block)), version: set.version + 1, updatedAt: now };
      await putBlockSet(client, next, set.version);
      await appendBlockRevisions(client, issue.id, [{
        blockId, relayBlockId: current.relayBlockId, blockType: type, origin: 'sponsor-doc', createdAt: now,
        actorUserId: actor.id, actorName: actor.name, detail: `updated from sponsor doc ${doc.id}`, before: current.data, after: data,
      }]);
      changes.push('block updated');
    }
  }

  try {
    if (options.force && current?.relayBlockId && !options.dryRun) {
      // Explicit overwrite: take Relay's current copy as the base so the push replaces it.
      const relay = await relayClient(set.relay.target);
      const live = await relay.getBlock(set.relay.issueKey, current.relayBlockId);
      const fresh = (await getBlockSet(client, issue.id)) as IssueBlockSet;
      const blocks = fresh.blocks.map((block) => (block.id === blockId
        ? { ...block, base: { hash: blockHash(live.type, live.data), relayUpdatedAt: live.updated_at, syncedAt: at } }
        : block));
      await putBlockSet(client, { ...fresh, blocks, version: fresh.version + 1 }, fresh.version);
    }
    const result = await syncBlocks(client, issue.id, { dryRun: Boolean(options.dryRun), only: [blockId], pullIsConflict: true }, actor);
    if (result.pushed.length || result.created.length) changes.push('Relay block written');
    if (slot === 'primary') {
      const wanted = sponsorSubject(doc);
      if (wanted) changes.push(...(await syncSubject(client, issue.id, set, wanted, options)));
    }
  } catch (error) {
    if (error instanceof BlocksError || error instanceof RelayError || error instanceof BlockSetVersionConflict) {
      return fail(`${error.message}${error instanceof BlocksError && error.code === 'blocks_sync_conflict' ? ' To overwrite Relay with the doc anyway: dataops newsletter sponsor-sync <issue> --slot ' + slot + ' --force.' : ''}`);
    }
    return fail((error as Error).message || 'Unexpected sync error');
  }
  const message = changes.length ? changes.join('; ') : 'already in sync with the sponsor doc';
  if (!options.dryRun) await recordStatus(client, issue.id, slot, { at, ok: true, docId: doc.id, summary: message });
  return { ...base, status: 'ok', message, block: blockId, dryRun: options.dryRun, changes };
}

/** Subject / preview text from the primary doc, three-way against what DataOps last saw in Relay. */
async function syncSubject(
  client: DynamoDBDocumentClient,
  issueId: string,
  set: IssueBlockSet,
  wanted: { subject: string; previewText: string },
  options: { dryRun?: boolean; force?: boolean },
): Promise<string[]> {
  const relay = await relayClient(set.relay.target);
  const live = await relay.getIssue(set.relay.issueKey);
  const lastKnown = set.relayIssue;
  const fields: { subject?: string; preview_text?: string } = {};
  const edited = (now: string, known: string, target: string) => now !== known && now !== target;
  if (live.subject !== wanted.subject) {
    if (edited(live.subject || '', lastKnown.subject, wanted.subject) && !options.force) {
      throw new BlocksError(
        `Relay subject "${live.subject}" was changed in Relay since the last sync and differs from the sponsor doc ("${wanted.subject}"). Nothing was overwritten.`,
        409, 'blocks_sync_conflict',
      );
    }
    fields.subject = wanted.subject;
  }
  if ((live.preview_text || '') !== wanted.previewText && wanted.previewText) {
    if (edited(live.preview_text || '', lastKnown.previewText, wanted.previewText) && !options.force) {
      throw new BlocksError(
        `Relay preview text was changed in Relay since the last sync and differs from the sponsor doc. Nothing was overwritten.`,
        409, 'blocks_sync_conflict',
      );
    }
    fields.preview_text = wanted.previewText;
  }
  if (!Object.keys(fields).length) return [];
  const status = live.campaign?.status;
  if (status && status !== 'draft') {
    throw new BlocksError(`Relay issue ${set.relay.issueKey} has a ${status} campaign; its subject is no longer edited.`, 409, 'blocks_campaign_locked');
  }
  if (options.dryRun) return ['subject/preview would be updated'];
  const saved = await relay.putIssueFields(set.relay.issueKey, fields);
  const fresh = (await getBlockSet(client, issueId)) as IssueBlockSet;
  await putBlockSet(
    client,
    { ...fresh, relayIssue: { ...fresh.relayIssue, subject: saved.subject || '', previewText: saved.preview_text || '' }, version: fresh.version + 1 },
    fresh.version,
  );
  return ['Relay subject/preview updated'];
}

/** Sync a saved sponsor doc into every slot of every issue that links it. Never throws; the doc save must not fail because of it. */
export async function syncSponsorDoc(
  client: DynamoDBDocumentClient,
  doc: SponsorDoc,
  actor: BlockActor,
  deps: SponsorSyncDeps = {},
): Promise<SponsorSyncResult[]> {
  try {
    const linked = await issueSlotsForDoc(client, doc);
    const results: SponsorSyncResult[] = [];
    for (const { issue, slot } of linked) results.push(await syncSponsorSlot(client, issue, slot, doc, actor, {}, deps));
    return results;
  } catch (error) {
    console.error(JSON.stringify({ event: 'newsletter_sponsor_sync_crashed', level: 'ERROR', docId: doc.id, message: (error as Error).message }));
    try {
      await createNotification(client, {
        type: 'newsletter-sponsor-sync-failed',
        message: `Sponsor doc "${doc.title || doc.id}" could not be synced to the newsletter: ${(error as Error).message}`,
        metadata: { docId: doc.id },
      });
    } catch { /* already logged above */ }
    return [{ status: 'failed', message: (error as Error).message, issueId: '', slot: 'primary', at: new Date().toISOString() }];
  }
}

/**
 * A secondary sponsor block cannot be deleted by hand; it leaves the issue (and
 * Relay) when its slot's sponsor document is removed from the issue. The main
 * block is pinned and stays. Never throws: failures are recorded and alerted.
 */
export async function releaseRemovedSponsorBlocks(
  client: DynamoDBDocumentClient,
  before: Pick<NewsletterIssue, 'id' | 'slots' | 'issueNumber'>,
  after: Pick<NewsletterIssue, 'id' | 'slots'>,
  actor: BlockActor,
): Promise<SponsorSyncResult | null> {
  if (!before.slots?.secondary?.documentUrl || after.slots?.secondary?.documentUrl) return null;
  const at = new Date().toISOString();
  try {
    const set = await getBlockSet(client, before.id);
    const block = set?.blocks.find((item) => item.type === 'sponsor_secondary');
    if (!set || !block) return null;
    const now = at;
    const deleted = [...(set.deleted || [])];
    if (block.relayBlockId !== null) {
      deleted.push({
        id: block.id, relayBlockId: block.relayBlockId, type: block.type, data: block.data,
        baseHash: block.base.hash || blockHash(block.type, block.data), deletedAt: now, deletedByName: actor.name,
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
    await appendBlockRevisions(client, before.id, [{
      blockId: block.id, relayBlockId: block.relayBlockId, blockType: block.type, origin: 'delete', createdAt: now,
      actorUserId: actor.id, actorName: actor.name, detail: 'secondary slot removed from the issue; block removed', before: block.data, after: null,
    }]);
    if (block.relayBlockId !== null) await syncBlocks(client, before.id, { dryRun: false, only: [block.id] }, actor);
    return { status: 'ok', message: 'secondary sponsor block removed with its slot', issueId: before.id, slot: 'secondary', at, block: block.id };
  } catch (error) {
    const message = (error as Error).message;
    console.error(JSON.stringify({ event: 'newsletter_sponsor_release_failed', level: 'ERROR', issueId: before.id, message }));
    try {
      await createNotification(client, {
        type: 'newsletter-sponsor-sync-failed',
        message: `Removing the secondary sponsor block of newsletter issue ${before.issueNumber ? `#${before.issueNumber}` : before.id} failed: ${message}`,
        metadata: { issueId: before.id, slot: 'secondary' },
      });
    } catch { /* logged above */ }
    return { status: 'failed', message, issueId: before.id, slot: 'secondary', at };
  }
}

export interface DocNewsletterSync {
  status: 'ok' | 'failed' | 'skipped';
  message: string;
  issueId?: string;
  at: string;
}

/** What the doc page shows: the worst result of a save's sync. */
export function summarizeSyncResults(results: SponsorSyncResult[]): DocNewsletterSync | null {
  if (!results.length) return null;
  const pick = results.find((item) => item.status === 'failed') || results.find((item) => item.status === 'ok') || results[0];
  const message = results.length > 1 ? results.map((item) => `${item.slot}: ${item.message}`).join(' | ') : pick.message;
  return { status: pick.status, message, issueId: pick.issueId || undefined, at: pick.at };
}

/** Last recorded sync outcome for a doc (shown on GET so a failure stays visible after reload). */
export async function newsletterSyncForDoc(client: DynamoDBDocumentClient, doc: SponsorDoc): Promise<DocNewsletterSync | null> {
  if (!String(doc.template).startsWith('newsletter-')) return null;
  const linked = await issueSlotsForDoc(client, doc);
  const found: SponsorSyncResult[] = [];
  for (const { issue, slot } of linked) {
    const set = await getBlockSet(client, issue.id);
    const status = set?.sponsorSync?.[slot];
    if (status && status.docId === doc.id) {
      found.push({
        status: status.ok ? 'ok' : 'failed', message: status.ok ? status.summary || 'in sync' : status.error || 'failed',
        issueId: issue.id, slot, at: status.at,
      });
    }
  }
  return summarizeSyncResults(found);
}
