/**
 * /api/newsletter-issues/:id/blocks — an issue's editable content blocks.
 *
 *   GET  /blocks                    the block set (404 blocks_not_imported before import)
 *   POST /blocks/import             {target, issueKey}: copy a Relay issue's blocks in
 *   PUT  /blocks/:blockId           {data, version}: edit one block (records a revision)
 *   POST /blocks/sync               {dryRun}: three-way sync with Relay (409 on conflict)
 *   GET  /blocks/revisions          every revision, oldest first (?block=<id> filters)
 *   GET  /blocks/types              block types (Relay's catalogue) with fields and defaults
 *   POST /blocks                    {type, data?, position?}: add a block
 *   POST /blocks/:blockId/move      {direction: up|down} or {to}: reorder
 *   DELETE /blocks/:blockId         delete a block
 *   POST /blocks/sponsor-sync       {slot, dryRun?, force?}: rebuild a sponsor block from its doc
 *
 * See ../newsletter/blocksSync.ts for why the sync is two-way.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { json, parseJsonObjectEventOrEmpty } from '../http';
import { resolveNewsletterIssue } from '../db/newsletterIssues';
import { resolveInteractiveActor, type VerifiedActor } from '../identity/actor';
import {
  BLOCK_TYPES,
  BlockValidationError,
  FIELD_KINDS,
  FIELD_LABELS,
  RELAY_TARGETS,
  blockHash,
  blockLabel,
  changedFields,
  type IssueBlockSet,
  type RelayTarget,
} from '../newsletter/blocks';
import { BlockSetVersionConflict, getBlockSet, listBlockRevisions } from '../newsletter/blocksStore';
import { RelayError } from '../newsletter/blocksRelay';
import { BlocksError, editBlock, importBlocks, requireBlockSet, syncBlocks, type BlockActor } from '../newsletter/blocksSync';
import { addBlock, deleteBlock, moveBlock } from '../newsletter/blocksOps';
import { byPosition, pinnedIndex, sponsorSlotOf, type SponsorDocUrls } from '../newsletter/blocksLayout';
import { docIdFromUrl, syncSponsorSlot } from '../newsletter/sponsorBlocks';
import { getSponsorDoc } from '../db/sponsorDocs';
import { savePublicImage } from '../publicImages';
import { publicImagePayload } from './publicImages';

const blockActor = (actor: VerifiedActor): BlockActor => ({ id: actor.id, name: actor.user?.name || actor.user?.email || null });

/** Host an uploaded `data:image/...` visual and return its public https URL. */
export function dataImageHost(event: LambdaEvent) {
  return async (dataUrl: string): Promise<string> => {
    const match = /^data:image\/(?:png|jpe?g|gif|webp);base64,(.+)$/is.exec(dataUrl);
    if (!match) throw new Error('The sponsor document graphics is an unsupported data: URL; upload a PNG, JPEG, GIF or WebP.');
    return publicImagePayload(await savePublicImage(Buffer.from(match[1], 'base64')), event).url;
  };
}

export const sponsorDocUrls = (issue: { slots?: Record<string, { documentUrl?: string } | undefined> }): SponsorDocUrls => ({
  primary: issue.slots?.primary?.documentUrl,
  secondary: issue.slots?.secondary?.documentUrl,
});

/** The set as the API returns it: labels, field specs, sponsor rules and pending-change flags added. */
export function blockSetView(set: IssueBlockSet, urls: SponsorDocUrls = {}) {
  const ordered = byPosition(set.blocks);
  const pin = pinnedIndex(ordered);
  return {
    ...set,
    orderChanged: Boolean(set.orderDirty),
    deletedPending: (set.deleted || []).map((gone) => ({ id: gone.id, type: gone.type, label: blockLabel(gone.type), relayBlockId: gone.relayBlockId })),
    blocks: ordered.map((block, index) => {
      const spec = BLOCK_TYPES[block.type];
      const sponsor = sponsorSlotOf(block.type);
      const isNew = block.relayBlockId === null;
      const changed = isNew || blockHash(block.type, block.data) !== block.base.hash;
      return {
        ...block,
        label: blockLabel(block.type),
        fields: (spec?.fields || Object.keys(block.data)).map((name) => ({
          name,
          label: FIELD_LABELS[name] || name,
          kind: FIELD_KINDS[name] || 'text',
          required: Boolean(spec?.required.includes(name)),
          default: spec?.defaults[name] || '',
        })),
        changedSinceSync: changed,
        pushState: isNew ? 'new' : changed ? 'edited' : 'in-sync',
        sponsor,
        readOnly: sponsor !== null,
        pinned: sponsor === 'primary',
        canMove: sponsor !== 'primary' && !(pin >= 0 && index < pin),
        canDelete: sponsor === null,
        sponsorDocUrl: sponsor ? urls[sponsor] || null : null,
      };
    }),
  };
}

export function blockTypesView() {
  return Object.entries(BLOCK_TYPES).map(([type, spec]) => ({
    type,
    label: spec.label,
    addable: sponsorSlotOf(type) === null,
    fields: spec.fields.map((name) => ({
      name,
      label: FIELD_LABELS[name] || name,
      kind: FIELD_KINDS[name] || 'text',
      required: spec.required.includes(name),
      default: spec.defaults[name] || '',
    })),
  }));
}

function failure(error: unknown): LambdaResponse {
  if (error instanceof BlocksError) return json(error.status, { error: error.message, code: error.code, ...error.detail });
  if (error instanceof RelayError) return json(error.status, { error: error.message, code: error.code });
  if (error instanceof BlockValidationError) {
    return json(400, { error: error.message, code: 'block_invalid', fields: error.errors });
  }
  if (error instanceof BlockSetVersionConflict) return json(409, { error: error.message, code: 'blocks_version_conflict' });
  throw error;
}

export async function handleNewsletterBlockRoutes(
  issueRef: string,
  rest: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const readOnly = method === 'GET';
  const resolved = await resolveInteractiveActor(client, event, readOnly ? 'work-read' : 'work-write');
  if (!resolved.ok) return resolved.response;
  const issue = await resolveNewsletterIssue(client, issueRef);
  if (!issue) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });
  const actor = blockActor(resolved.actor);
  const body = readOnly ? {} : parseJsonObjectEventOrEmpty(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const urls = sponsorDocUrls(issue);
  const view = (set: IssueBlockSet) => blockSetView(set, urls);
  try {
    if (rest === '' || rest === '/') {
      if (method === 'POST') {
        const added = await addBlock(client, issue.id, { type: body.type, data: body.data, position: body.position }, urls, actor);
        const blocks = view(added.set);
        return json(201, { issueId: issue.id, block: blocks.blocks.find((item) => item.id === added.block.id), blocks });
      }
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      return json(200, { issueId: issue.id, blocks: view(await requireBlockSet(client, issue.id)) });
    }
    if (rest === '/types') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      return json(200, { issueId: issue.id, types: blockTypesView() });
    }
    if (rest === '/import') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const target = String(body.target || 'production') as RelayTarget;
      if (!RELAY_TARGETS.includes(target)) return json(400, { error: `target must be one of ${RELAY_TARGETS.join(', ')}` });
      const issueKey = String(body.issueKey || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(issueKey)) return json(400, { error: 'issueKey must be a Relay issue key like weekly-304' });
      const set = await importBlocks(client, issue.id, { target, issueKey }, actor);
      return json(201, { issueId: issue.id, blocks: view(set) });
    }
    if (rest === '/sync') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const result = await syncBlocks(client, issue.id, { dryRun: body.dryRun === true }, actor);
      return json(200, { issueId: issue.id, ...result, set: undefined, blocks: view(result.set) });
    }
    if (rest === '/sponsor-sync') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const slot = String(body.slot || '');
      if (slot !== 'primary' && slot !== 'secondary') return json(400, { error: 'slot must be primary or secondary', code: 'slot_invalid' });
      const docId = docIdFromUrl(urls[slot]);
      if (!docId) return json(422, { error: `The ${slot} slot of this issue has no sponsor document.`, code: 'sponsor_doc_missing' });
      const doc = await getSponsorDoc(client, docId);
      if (!doc) return json(404, { error: `Sponsor document ${docId} was not found.`, code: 'sponsor_doc_not_found' });
      const result = await syncSponsorSlot(
        client,
        issue,
        slot,
        doc,
        actor,
        { dryRun: body.dryRun === true, force: body.force === true },
        { hostDataImage: dataImageHost(event) },
      );
      const current = await getBlockSet(client, issue.id);
      return json(result.status === 'failed' ? 409 : 200, {
        issueId: issue.id,
        result,
        summary: result.message,
        ...(result.status === 'failed' ? { error: result.message, code: 'sponsor_sync_failed' } : {}),
        blocks: current ? view(current) : null,
      });
    }
    if (rest === '/revisions') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      const set = await requireBlockSet(client, issue.id);
      const filter = event.queryStringParameters?.block || '';
      const revisions = (await listBlockRevisions(client, issue.id))
        .filter((revision) => !filter || revision.blockId === filter || String(revision.relayBlockId) === filter)
        .map((revision) => ({ ...revision, label: blockLabel(revision.blockType), changes: changedFields(revision.before, revision.after) }));
      return json(200, { issueId: issue.id, relay: set.relay, revisions });
    }
    const moveMatch = rest.match(/^\/([^/]+)\/move$/);
    if (moveMatch) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const moved = await moveBlock(client, issue.id, decodeURIComponent(moveMatch[1]), { to: body.to, direction: body.direction }, urls, actor);
      return json(200, { issueId: issue.id, blocks: view(moved.set) });
    }
    const blockMatch = rest.match(/^\/([^/]+)$/);
    if (blockMatch) {
      const blockId = decodeURIComponent(blockMatch[1]);
      if (method === 'DELETE') {
        const removed = await deleteBlock(client, issue.id, blockId, urls, actor);
        return json(200, { issueId: issue.id, deleted: blockId, blocks: view(removed.set) });
      }
      if (method !== 'PUT') return json(405, { error: 'Method not allowed' });
      const result = await editBlock(client, issue.id, blockId, { data: body.data, expectedVersion: body.version }, actor, urls);
      return json(200, { issueId: issue.id, changed: result.changed, blocks: view(result.set) });
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    return failure(error);
  }
}
