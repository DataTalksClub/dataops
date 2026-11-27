/**
 * Review and approval of a newsletter draft.
 *
 * The owner reviews the email exactly as DataOps renders it (./emailRender.ts)
 * and approves that exact revision: the approval names the draft version and
 * the sha256 of the rendered payload (subject, preview text, HTML, text), and
 * the payload itself is frozen in its own item. Approving refuses a payload
 * that differs from the one the reviewer saw, and a draft that is not complete.
 * Any later content change withdraws the approval (./blocksEdit.ts), so only an
 * approved, unchanged payload can ever be handed to Relay.
 */
import { createHash } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { browserAuthOrigin } from '../auth/browserAuth';
import { BlockValidationError, blockLabel, newWebViewToken, validateBlockData, type IssueBlockSet } from './blocks';
import { BlocksError } from './blocksErrors';
import { byPosition } from './blocksLayout';
import { appendBlockRevisions, putBlockSet, putFrozenPayload, type FrozenPayload } from './blocksStore';
import { assertUnlocked, requireBlockSet, type BlockActor } from './blocksEdit';
import { renderIssueEmail, type RenderedEmail } from './emailRender';
import { envelopeProblems, sponsorProblems, type IssueSlots } from './draftReadiness';
import { getNewsletterIssue } from '../db/newsletterIssues';

export const WEB_VIEW_PATH = '/api/newsletter-view/';

/** The deployment's public origin; fixed per deployment so a render never depends on the request host. */
export function publicOrigin(): string {
  return (browserAuthOrigin() || process.env.DATAOPS_PORTAL_URL || 'https://ops.dtcdev.click').replace(/\/$/, '');
}

export function webViewUrl(token: string): string {
  return token ? `${publicOrigin()}${WEB_VIEW_PATH}${encodeURIComponent(token)}` : '#';
}

export interface DraftProblem {
  blockId: string | null;
  field: string;
  message: string;
}

const FIELD_WORDS: Record<string, string> = { required: 'is required', invalid_url: 'is not a valid http(s) URL', too_long: 'is too long', unknown_field: 'is not a field of this block' };

/**
 * Everything that keeps the draft from being approved; empty when it is
 * complete. `slots` (the issue's sponsor slots) adds the sponsor-document rules
 * of ./draftReadiness.ts; approval always passes them.
 */
export function draftProblems(set: IssueBlockSet, slots?: IssueSlots): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!set.subject.trim()) problems.push({ blockId: null, field: 'subject', message: 'The subject is empty.' });
  problems.push(...envelopeProblems(set));
  const blocks = byPosition(set.blocks);
  if (!blocks.some((block) => block.type !== 'intro')) {
    problems.push({ blockId: null, field: 'blocks', message: 'The draft has no content blocks besides the intro.' });
  }
  for (const block of blocks) {
    try {
      validateBlockData(block.type, block.data);
    } catch (error) {
      if (!(error instanceof BlockValidationError)) throw error;
      for (const [field, code] of Object.entries(error.errors)) {
        const name = field.replace(/^data\./, '');
        problems.push({ blockId: block.id, field: name, message: `${blockLabel(block.type)}: ${name} ${FIELD_WORDS[code] || code}.` });
      }
    }
  }
  if (slots) problems.push(...sponsorProblems(set, slots));
  return problems;
}

export function payloadHashOf(email: Pick<RenderedEmail, 'subject' | 'previewText' | 'html' | 'text'>): string {
  return createHash('sha256').update(JSON.stringify([email.subject, email.previewText, email.html, email.text])).digest('hex');
}

export interface DraftRender extends RenderedEmail {
  payloadHash: string;
  draftVersion: number;
  problems: DraftProblem[];
}

/**
 * The email recipients would get from the draft as stored. `editor` adds a
 * visible "Needs content" note before incomplete blocks (and changes the
 * hash); the approved and delivered payload is always the plain render.
 */
export function renderDraft(set: IssueBlockSet, options: { editor?: boolean; slots?: IssueSlots } = {}): DraftRender {
  const problems = draftProblems(set, options.slots);
  const unfinished = new Map<string, string[]>();
  if (options.editor) {
    for (const problem of problems) {
      if (!problem.blockId) continue;
      unfinished.set(problem.blockId, [...(unfinished.get(problem.blockId) || []), problem.field]);
    }
  }
  const email = renderIssueEmail(
    { subject: set.subject, previewText: set.previewText, blocks: byPosition(set.blocks), webViewUrl: webViewUrl(set.webViewToken) },
    { unfinished },
  );
  return { ...email, payloadHash: payloadHashOf(email), draftVersion: set.version, problems };
}

export type ApprovalState = 'none' | 'current' | 'stale';

/** Current only while the stored approval still matches what the draft renders now. */
export function approvalState(set: IssueBlockSet, render: Pick<DraftRender, 'payloadHash'> = renderDraft(set)): ApprovalState {
  if (!set.approval) return 'none';
  return set.approval.payloadHash === render.payloadHash ? 'current' : 'stale';
}

/**
 * Approve the revision the owner reviewed. `expectedVersion` and `payloadHash`
 * are what the review screen showed; anything else is refused.
 */
export async function approveDraft(
  client: DynamoDBDocumentClient,
  issueId: string,
  input: { expectedVersion: unknown; payloadHash: unknown; note?: unknown },
  actor: BlockActor,
): Promise<{ set: IssueBlockSet; payload: FrozenPayload }> {
  let set = await requireBlockSet(client, issueId);
  assertUnlocked(set);
  if (!set.webViewToken) {
    // A draft built by the retired Relay import has no web-view link yet; give it one, which changes the email.
    const now = new Date().toISOString();
    const next = { ...set, webViewToken: newWebViewToken(), version: set.version + 1, updatedAt: now };
    await putBlockSet(client, next, set.version);
    set = next;
  }
  const issue = await getNewsletterIssue(client, issueId);
  const render = renderDraft(set, { slots: issue?.slots || {} });
  if (input.expectedVersion !== set.version || input.payloadHash !== render.payloadHash) {
    throw new BlocksError(
      `The draft changed since you reviewed it (now version ${set.version}). Review the current email again, then approve.`,
      409,
      'draft_changed',
      { currentVersion: set.version, payloadHash: render.payloadHash },
    );
  }
  if (render.problems.length) {
    throw new BlocksError(
      `The draft is not complete: ${render.problems.map((problem) => problem.message).join(' ')}`,
      422,
      'draft_incomplete',
      { problems: render.problems },
    );
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
  const now = new Date().toISOString();
  const payload: FrozenPayload = {
    issueId,
    payloadHash: render.payloadHash,
    draftVersion: set.version + 1,
    subject: render.subject,
    previewText: render.previewText,
    html: render.html,
    text: render.text,
    webViewToken: set.webViewToken,
    createdAt: now,
    createdBy: actor.id,
  };
  await putFrozenPayload(client, payload);
  const next: IssueBlockSet = {
    ...set,
    approval: {
      draftVersion: set.version + 1,
      payloadHash: render.payloadHash,
      approvedAt: now,
      approvedBy: actor.id,
      approvedByName: actor.name,
      ...(note ? { note } : {}),
    },
    version: set.version + 1,
    updatedAt: now,
  };
  await putBlockSet(client, next, set.version);
  await appendBlockRevisions(client, issueId, [{
    blockId: '',
    blockType: 'draft',
    origin: 'approve',
    createdAt: now,
    actorUserId: actor.id,
    actorName: actor.name,
    detail: `approved version ${next.version}, payload sha256 ${render.payloadHash}${note ? ` — ${note}` : ''}`,
    before: null,
    after: null,
  }]);
  return { set: next, payload };
}
