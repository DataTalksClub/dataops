/**
 * /api/newsletter-issues/:id/draft — an issue's email, built, reviewed and
 * approved in DataOps, then handed to Relay as a finished payload.
 *
 *   POST   /draft                       start an empty draft (no Relay call)
 *   GET    /draft                       the draft: blocks, subject, approval, delivery
 *   PUT    /draft                       {version, subject?, previewText?}
 *   GET    /draft/render                the rendered email (?mode=editor marks incomplete blocks)
 *   POST   /draft/preview               render unsaved editor state; writes nothing
 *   GET    /draft/types                 block types with fields and defaults
 *   POST   /draft/blocks                {type, data?, position?}: add a block
 *   PUT    /draft/blocks/:blockId       {data, version}: save one block
 *   POST   /draft/blocks/:blockId/move  {direction: up|down} or {to}
 *   DELETE /draft/blocks/:blockId
 *   GET    /draft/revisions             audit history (?block=<id> filters)
 *   POST   /draft/sponsor-sync          {slot}: stage the slot's sponsor doc (local only)
 *   POST   /draft/approve               owner: {version, payloadHash, note?}
 *   POST   /draft/test-send             owner: {requestId}; the test goes to the owner's mailbox only
 *   POST   /draft/test-receipt          owner: {version, payloadHash, testRequestId}: the test email arrived and is right
 *   POST   /draft/schedule              owner: {scheduledAt, payloadHash, version, requestId}; needs a current receipt
 *   POST   /draft/cancel                owner: cancel the Relay schedule
 *   GET    /draft/delivery              delivery status (?refresh=1 reads Relay; owner)
 *
 * Only the owner routes ever send to Relay, and only an approved, frozen
 * payload (../newsletter/relayTransport.ts). The one other Relay call: an
 * edit of a scheduled draft cancels that schedule first, verified with Relay,
 * and fails without changing anything if Relay cannot confirm it.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import { json, parseJsonObjectEventOrEmpty } from '../http';
import { headerValue } from '../httpHeaders';
import { resolveNewsletterIssue, type NewsletterIssue } from '../db/newsletterIssues';
import { resolveInteractiveActor, type VerifiedActor } from '../identity/actor';
import { OWNER_WORK_EMAIL } from '../identity/operatingIdentities';
import {
  BLOCK_TYPES,
  BlockValidationError,
  FIELD_KINDS,
  FIELD_LABELS,
  blockLabel,
  changedFields,
  type IssueBlockSet,
} from '../newsletter/blocks';
import { BlockSetVersionConflict, listBlockRevisions, requireBlockSet } from '../newsletter/blocksStore';
import {
  addBlock,
  BlocksError,
  createDraft,
  deleteBlock,
  editBlock,
  moveBlock,
  updateDetails,
  type BlockActor,
} from '../newsletter/blocksEdit';
import { byPosition, docOwned, pinnedIndex, sponsorSlotOf, type SponsorDocUrls } from '../newsletter/blocksLayout';
import { approvalState, approveDraft, renderDraft, testReceiptState, webViewUrl } from '../newsletter/draftApproval';
import { renderIssueEmail } from '../newsletter/emailRender';
import {
  cancelScheduled,
  recordTestReceipt,
  refreshDelivery,
  RelayError,
  relayAudience,
  scheduleApproved,
  TEST_RECIPIENT,
  testSendApproved,
} from '../newsletter/relayTransport';
import { docIdFromUrl, syncSponsorSlot } from '../newsletter/sponsorBlocks';
import { syncStandaloneMarkdownTask } from '../newsletter/markdownTask';
import { getSponsorDoc } from '../db/sponsorDocs';
import { savePublicImage } from '../publicImages';
import { FileStorageError } from '../storage';
import { extractMultipartImageBuffer, publicImagePayload } from './publicImages';

const blockActor = (actor: VerifiedActor): BlockActor => ({ id: actor.id, name: actor.user?.name || actor.user?.email || null });

/**
 * The owner: the workspace owner's own admin account, signed in as a person
 * (browser session or the CLI's personal login), never a scoped API token.
 */
export function isNewsletterOwner(actor: VerifiedActor, event: LambdaEvent): boolean {
  return Boolean(
    actor.isAdmin
      && actor.user
      && String(actor.user.email || '').toLowerCase() === OWNER_WORK_EMAIL
      && !headerValue(event.headers, 'x-api-token-id'),
  );
}

const ownerOnly = () => json(403, {
  error: `Only the owner (${OWNER_WORK_EMAIL}, signed in personally) can approve, test-send, confirm a test or schedule a newsletter.`,
  code: 'newsletter_owner_required',
});

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

const fieldSpecs = (type: string, data: Record<string, string>) => {
  const spec = BLOCK_TYPES[type];
  return (spec?.fields || Object.keys(data)).map((name) => ({
    name,
    label: FIELD_LABELS[name] || name,
    kind: FIELD_KINDS[name] || 'text',
    required: Boolean(spec?.required.includes(name)),
    default: spec?.defaults[name] || '',
  }));
};

/** The draft as the API returns it: ordered blocks with field specs and rules, approval and delivery state. */
export function draftView(set: IssueBlockSet, issue: Pick<NewsletterIssue, 'id' | 'slots'>, viewer?: { owner: boolean }) {
  const urls = sponsorDocUrls(issue);
  const ordered = byPosition(set.blocks);
  const pin = pinnedIndex(ordered);
  const render = renderDraft(set);
  const problemsByBlock = new Map<string, string[]>();
  for (const problem of render.problems) {
    if (problem.blockId) problemsByBlock.set(problem.blockId, [...(problemsByBlock.get(problem.blockId) || []), problem.message]);
  }
  const locked = Boolean(set.delivery && (set.delivery.state === 'scheduling' || set.delivery.state === 'scheduled'));
  return {
    issueId: set.issueId,
    subject: set.subject,
    previewText: set.previewText,
    version: set.version,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    locked,
    blocks: ordered.map((block, index) => {
      const sponsor = sponsorSlotOf(block.type);
      const owned = docOwned(block, urls);
      return {
        id: block.id,
        position: block.position,
        type: block.type,
        label: blockLabel(block.type),
        data: block.data,
        version: block.version,
        updatedAt: block.updatedAt,
        updatedByName: block.updatedByName,
        fields: fieldSpecs(block.type, block.data),
        problems: problemsByBlock.get(block.id) || [],
        sponsor,
        readOnly: owned,
        pinned: sponsor === 'primary',
        canMove: sponsor !== 'primary' && !(pin >= 0 && index < pin),
        canDelete: !owned,
        sponsorDocUrl: sponsor ? urls[sponsor] || null : null,
      };
    }),
    sponsorSync: set.sponsorSync || {},
    sponsorSlots: { primary: Boolean(urls.primary), secondary: Boolean(urls.secondary) },
    problems: render.problems,
    payloadHash: render.payloadHash,
    approval: { state: approvalState(set, render), ...(set.approval || {}) },
    testReceipt: { state: testReceiptState(set, render), ...(set.testReceipt || {}) },
    testRecipient: TEST_RECIPIENT,
    lastTest: set.lastTest || null,
    delivery: set.delivery || null,
    relayAudience: relayAudience(),
    webViewUrl: webViewUrl(set.webViewToken),
    canApprove: Boolean(viewer?.owner),
  };
}

export function blockTypesView(urls: SponsorDocUrls = {}) {
  return Object.entries(BLOCK_TYPES).map(([type, spec]) => {
    const slot = sponsorSlotOf(type);
    return {
      type,
      label: spec.label,
      addable: !slot || !urls[slot],
      fields: fieldSpecs(type, {}),
    };
  });
}

function failure(error: unknown): LambdaResponse {
  if (error instanceof BlocksError) return json(error.status, { error: error.message, code: error.code, ...error.detail });
  if (error instanceof RelayError) return json(error.status, { error: error.message, code: error.code });
  if (error instanceof BlockValidationError) return json(400, { error: error.message, code: 'block_invalid', fields: error.errors });
  if (error instanceof BlockSetVersionConflict) return json(409, { error: error.message, code: 'draft_version_conflict' });
  throw error;
}

const MAX_PREVIEW_BLOCKS = 60;

/** Unsaved editor state -> render input; tolerant (it is only a preview) but bounded. */
function previewInput(body: Record<string, unknown>, set: IssueBlockSet) {
  const rawBlocks = Array.isArray(body.blocks) ? body.blocks.slice(0, MAX_PREVIEW_BLOCKS) : byPosition(set.blocks);
  const blocks = rawBlocks
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const data: Record<string, string> = {};
      const source = item.data && typeof item.data === 'object' ? (item.data as Record<string, unknown>) : {};
      for (const [name, value] of Object.entries(source)) if (typeof value === 'string' && FIELD_KINDS[name]) data[name] = value.slice(0, 100_000);
      return { id: String(item.id || ''), type: String(item.type || ''), data };
    })
    .filter((item) => BLOCK_TYPES[item.type]);
  return {
    subject: typeof body.subject === 'string' ? body.subject.slice(0, 500) : set.subject,
    previewText: typeof body.previewText === 'string' ? body.previewText.slice(0, 500) : set.previewText,
    blocks,
    webViewUrl: webViewUrl(set.webViewToken),
  };
}

export async function handleNewsletterDraftRoutes(
  issueRef: string,
  rest: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const readOnly = method === 'GET' || (method === 'POST' && rest === '/preview');
  const resolved = await resolveInteractiveActor(client, event, readOnly ? 'work-read' : 'work-write');
  if (!resolved.ok) return resolved.response;
  const issue = await resolveNewsletterIssue(client, issueRef);
  if (!issue) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });
  const actor = blockActor(resolved.actor);
  const owner = isNewsletterOwner(resolved.actor, event);
  const body = method === 'GET' || method === 'DELETE' ? {} : parseJsonObjectEventOrEmpty(event);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const urls = sponsorDocUrls(issue);
  const view = (set: IssueBlockSet) => draftView(set, issue, { owner });

  try {
    if (rest === '' || rest === '/') {
      if (method === 'GET') return json(200, { issueId: issue.id, draft: view(await requireBlockSet(client, issue.id)) });
      if (method === 'POST') {
        let set = await createDraft(client, issue, actor);
        const staged = [];
        for (const slot of ['primary', 'secondary'] as const) {
          const docId = docIdFromUrl(urls[slot]);
          const doc = docId ? await getSponsorDoc(client, docId) : null;
          if (doc) staged.push(await syncSponsorSlot(client, issue, slot, doc, actor, {}, { hostDataImage: dataImageHost(event) }));
        }
        if (staged.length) set = await requireBlockSet(client, issue.id);
        return json(201, { issueId: issue.id, draft: view(set), sponsorStaging: staged });
      }
      if (method === 'PUT') {
        const result = await updateDetails(client, issue.id, { subject: body.subject, previewText: body.previewText, expectedVersion: body.version }, actor);
        return json(200, { issueId: issue.id, changed: result.changed, draft: view(result.set) });
      }
      return json(405, { error: 'Method not allowed' });
    }
    if (rest === '/render') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      const set = await requireBlockSet(client, issue.id);
      const render = renderDraft(set, { editor: event.queryStringParameters?.mode === 'editor' });
      return json(200, { issueId: issue.id, render, approval: { state: approvalState(set), ...(set.approval || {}) } });
    }
    if (rest === '/preview') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const set = await requireBlockSet(client, issue.id);
      const email = renderIssueEmail(previewInput(body, set));
      return json(200, { issueId: issue.id, preview: email });
    }
    if (rest === '/types') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      return json(200, { issueId: issue.id, types: blockTypesView(urls) });
    }
    if (rest === '/revisions') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      await requireBlockSet(client, issue.id);
      const filter = event.queryStringParameters?.block || '';
      const revisions = (await listBlockRevisions(client, issue.id))
        .filter((revision) => !filter || revision.blockId === filter)
        .map((revision) => ({ ...revision, label: revision.blockType === 'draft' || revision.blockType === 'details' ? revision.blockType : blockLabel(revision.blockType), changes: changedFields(revision.before, revision.after) }));
      return json(200, { issueId: issue.id, revisions });
    }
    if (rest === '/sponsor-sync') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const slot = String(body.slot || '');
      if (slot !== 'primary' && slot !== 'secondary') return json(400, { error: 'slot must be primary or secondary', code: 'slot_invalid' });
      const docId = docIdFromUrl(urls[slot]);
      if (!docId) return json(422, { error: `The ${slot} slot of this issue has no sponsor document.`, code: 'sponsor_doc_missing' });
      const doc = await getSponsorDoc(client, docId);
      if (!doc) return json(404, { error: `Sponsor document ${docId} was not found.`, code: 'sponsor_doc_not_found' });
      const result = await syncSponsorSlot(client, issue, slot, doc, actor, { dryRun: body.dryRun === true }, { hostDataImage: dataImageHost(event) });
      const current = await requireBlockSet(client, issue.id);
      return json(result.status === 'failed' ? 409 : 200, {
        issueId: issue.id,
        result,
        summary: result.message,
        ...(result.status === 'failed' ? { error: result.message, code: 'sponsor_sync_failed' } : {}),
        draft: view(current),
      });
    }
    if (rest === '/approve' || rest === '/test-send' || rest === '/test-receipt' || rest === '/schedule' || rest === '/cancel') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      if (!owner) return ownerOnly();
      if (rest === '/approve') {
        const result = await approveDraft(client, issue.id, { expectedVersion: body.version, payloadHash: body.payloadHash, note: body.note }, actor);
        await syncStandaloneMarkdownTask(client, issue, actor.id, { draftApproved: true });
        return json(200, { issueId: issue.id, draft: view(result.set), payloadHash: result.payload.payloadHash });
      }
      if (rest === '/test-send') {
        const result = await testSendApproved(client, issue, { emails: body.emails, requestId: body.requestId }, actor);
        return json(result.status === 'provider_accepted' || result.replayed ? 200 : 502, {
          issueId: issue.id,
          testSend: result,
          draft: view(await requireBlockSet(client, issue.id)),
        });
      }
      if (rest === '/test-receipt') {
        const result = await recordTestReceipt(client, issue, { version: body.version, payloadHash: body.payloadHash, testRequestId: body.testRequestId }, actor);
        return json(200, { issueId: issue.id, testReceipt: result.receipt, draft: view(result.set) });
      }
      if (rest === '/schedule') {
        const result = await scheduleApproved(
          client,
          issue,
          { scheduledAt: body.scheduledAt, payloadHash: body.payloadHash, expectedVersion: body.version, requestId: body.requestId },
          actor,
        );
        return json(200, { issueId: issue.id, delivery: result.delivery, adopted: result.adopted, replayed: result.replayed, draft: view(result.set) });
      }
      const result = await cancelScheduled(client, issue, actor);
      return json(200, { issueId: issue.id, delivery: result.delivery, draft: view(result.set) });
    }
    if (rest === '/delivery') {
      if (method !== 'GET') return json(405, { error: 'Method not allowed' });
      if (event.queryStringParameters?.refresh === '1') {
        if (!owner) return ownerOnly();
        return json(200, { issueId: issue.id, delivery: await refreshDelivery(client, issue) });
      }
      return json(200, { issueId: issue.id, delivery: (await requireBlockSet(client, issue.id)).delivery || null });
    }
    if (rest === '/blocks') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const added = await addBlock(client, issue.id, { type: body.type, data: body.data, position: body.position }, urls, actor);
      const draft = view(added.set);
      return json(201, { issueId: issue.id, block: draft.blocks.find((item) => item.id === added.block.id), draft });
    }
    const moveMatch = rest.match(/^\/blocks\/([^/]+)\/move$/);
    if (moveMatch) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const moved = await moveBlock(client, issue.id, decodeURIComponent(moveMatch[1]), { to: body.to, direction: body.direction }, urls, actor);
      return json(200, { issueId: issue.id, draft: view(moved.set) });
    }
    const blockMatch = rest.match(/^\/blocks\/([^/]+)$/);
    if (blockMatch) {
      const blockId = decodeURIComponent(blockMatch[1]);
      if (method === 'DELETE') {
        const removed = await deleteBlock(client, issue.id, blockId, urls, actor);
        return json(200, { issueId: issue.id, deleted: blockId, draft: view(removed.set) });
      }
      if (method !== 'PUT') return json(405, { error: 'Method not allowed' });
      const result = await editBlock(client, issue.id, blockId, { data: body.data, expectedVersion: body.version }, actor, urls);
      return json(200, { issueId: issue.id, changed: result.changed, draft: view(result.set) });
    }
    return json(404, { error: 'Not found' });
  } catch (error) {
    return failure(error);
  }
}

/** Upload an image for a block (`POST /api/newsletter-issues/:id/images`) to durable public hosting. */
export async function handleNewsletterImageUpload(issueRef: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  const issue = await resolveNewsletterIssue(client, issueRef);
  if (!issue) return json(404, { error: 'Newsletter issue not found', code: 'issue_not_found' });
  try {
    const saved = await savePublicImage(extractMultipartImageBuffer(event));
    return json(201, { issueId: issue.id, image: publicImagePayload(saved, event) });
  } catch (error) {
    if (error instanceof FileStorageError) return json(error.statusCode, { error: error.message, code: error.code });
    throw error;
  }
}
