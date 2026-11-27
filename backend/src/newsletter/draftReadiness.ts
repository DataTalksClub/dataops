/**
 * Readiness rules that only apply when the issue is reviewed: draft saves may
 * stay incomplete, but the owner cannot approve a draft (./draftApproval.ts)
 * that breaks one of them, and the API/CLI say exactly which.
 *
 *  - The envelope fits the inbox: the subject (without the
 *    " | DataTalks.Club Weekly" suffix) is at most 65 characters and the inbox
 *    preview text at most 140.
 *  - Every sponsor block comes from its slot's linked sponsor document, and a
 *    booked slot has one, an own DataTalks.Club promo included. An archived
 *    hand-made sponsor block is readable but never ready.
 *  - A sponsor block's title is at most 12 words.
 *  - An own DataTalks.Club promo has had its planned bullet points, closing and
 *    tracking reviewed: bullets and closing are filled and the button link
 *    carries `utm_` tracking parameters.
 */
import { isOwnOrganization } from '../identity/operatingIdentities';
import type { IssueBlock, IssueBlockSet } from './blocks';
import { byPosition, sponsorSlotOf, type SponsorSlotKind } from './blocksLayout';
import { SUBJECT_SUFFIX } from './sponsorBlocks';

export const SUBJECT_MAX_CHARS = 65;
export const PREVIEW_MAX_CHARS = 140;
export const SPONSOR_TITLE_MAX_WORDS = 12;

export interface ReadinessProblem {
  blockId: string | null;
  field: string;
  message: string;
}

/** What the issue says about a slot: who booked it and its sponsor document. */
export interface SlotState {
  sponsor?: string;
  organizationId?: string;
  documentUrl?: string;
}

export type IssueSlots = Partial<Record<SponsorSlotKind, SlotState | undefined>>;

const SLOT_NAME: Record<SponsorSlotKind, string> = { primary: 'Main sponsor', secondary: 'Secondary sponsor' };

export const wordCount = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

/** The sponsor's part of the subject: the weekly suffix is DataTalks.Club's, not counted. */
export function subjectCore(subject: string): string {
  const trimmed = subject.trim();
  return trimmed.endsWith(SUBJECT_SUFFIX) ? trimmed.slice(0, -SUBJECT_SUFFIX.length).trim() : trimmed;
}

export function hasTracking(url: string): boolean {
  try {
    return [...new URL(url).searchParams.keys()].some((key) => key.toLowerCase().startsWith('utm_'));
  } catch {
    return false;
  }
}

export function envelopeProblems(set: Pick<IssueBlockSet, 'subject' | 'previewText'>): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  const core = subjectCore(set.subject || '');
  if (core.length > SUBJECT_MAX_CHARS) {
    problems.push({ blockId: null, field: 'subject', message: `The subject is ${core.length} characters; keep it to ${SUBJECT_MAX_CHARS} (the "${SUBJECT_SUFFIX.trim()}" suffix is not counted).` });
  }
  const preview = (set.previewText || '').trim();
  if (preview.length > PREVIEW_MAX_CHARS) {
    problems.push({ blockId: null, field: 'previewText', message: `The inbox preview text is ${preview.length} characters; keep it to ${PREVIEW_MAX_CHARS}.` });
  }
  return problems;
}

function ownPromoProblems(block: IssueBlock, label: string): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  const data = block.data || {};
  if (!String(data.bullets || '').trim()) {
    problems.push({ blockId: block.id, field: 'bullets', message: `${label}: review the planned bullet points of the own DataTalks.Club promo in its sponsor document.` });
  }
  if (!String(data.closing || '').trim()) {
    problems.push({ blockId: block.id, field: 'closing', message: `${label}: review the closing sentence of the own DataTalks.Club promo in its sponsor document.` });
  }
  if (data.cta_url && !hasTracking(data.cta_url)) {
    problems.push({ blockId: block.id, field: 'cta_url', message: `${label}: the own promo's button link has no utm_ tracking parameters; add them in its sponsor document.` });
  }
  return problems;
}

/** Sponsor-slot problems; needs the issue's slots (who booked them, which doc). */
export function sponsorProblems(set: Pick<IssueBlockSet, 'blocks'>, slots: IssueSlots): ReadinessProblem[] {
  const problems: ReadinessProblem[] = [];
  const blocks = byPosition(set.blocks);
  for (const slot of ['primary', 'secondary'] as SponsorSlotKind[]) {
    const state = slots[slot];
    const block = blocks.find((item) => sponsorSlotOf(item.type) === slot);
    const label = SLOT_NAME[slot];
    if (block && !state?.documentUrl) {
      problems.push({
        blockId: block.id,
        field: 'sponsor_doc',
        message: `${label}: the block has no linked sponsor document. Its copy comes only from the slot's sponsor document (an own DataTalks.Club promo needs one too); create or link it, or remove this block.`,
      });
    } else if (!block && state?.documentUrl) {
      problems.push({ blockId: null, field: `sponsor_${slot}`, message: `${label}: the slot's sponsor document is not staged into the draft yet; save the sponsor document.` });
    } else if (!block && state?.sponsor) {
      problems.push({ blockId: null, field: `sponsor_${slot}`, message: `${label}: the slot is booked for ${state.sponsor} but has no sponsor document; create it from the issue page.` });
    }
    if (!block) continue;
    const title = String(block.data?.title || '');
    if (wordCount(title) > SPONSOR_TITLE_MAX_WORDS) {
      problems.push({ blockId: block.id, field: 'title', message: `${label}: the title has ${wordCount(title)} words; keep it to ${SPONSOR_TITLE_MAX_WORDS} (edit it in the sponsor document).` });
    }
    if (state && isOwnOrganization({ organizationId: state.organizationId, name: state.sponsor })) problems.push(...ownPromoProblems(block, label));
  }
  return problems;
}
