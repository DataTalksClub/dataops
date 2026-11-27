import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SponsorDocValidationError, validateSubmittedContent } from '../src/sponsorDocs/templates';
import { envelopeProblems, sponsorProblems, subjectCore } from '../src/newsletter/draftReadiness';
import type { IssueBlock } from '../src/newsletter/blocks';

const READY_MAIN = {
  subjectLine: 'Build real-time data pipelines in minutes',
  previewText: 'A short summary next to the subject',
  title: 'Real-time pipelines without the ops work',
  bullets: '- One\n- Two\n- Three',
  closing: 'Try Acme today.',
  ctaText: 'Start free',
  ctaUrl: 'https://acme.example/?utm_source=datatalksclub-newsletter',
};

function submitErrors(content: Record<string, string>, template: 'newsletter-main' | 'newsletter-secondary' = 'newsletter-main') {
  try {
    validateSubmittedContent(template, content);
    return {};
  } catch (error) {
    assert.ok(error instanceof SponsorDocValidationError);
    return error.fields;
  }
}

const block = (id: string, type: string, data: Record<string, string>): IssueBlock => ({
  id, type, data, position: 0, version: 1, updatedAt: '', updatedBy: '', updatedByName: null,
});

describe('Newsletter readiness: hard limits at Ready/approval, drafts stay saveable', () => {
  it('refuses a newsletter sponsor doc marked Ready with an over-long subject, preview or title', () => {
    assert.deepStrictEqual(submitErrors(READY_MAIN), {});
    const errors = submitErrors({ ...READY_MAIN, subjectLine: 'x'.repeat(66), previewText: 'y'.repeat(141), title: 'one two three four five six seven eight nine ten eleven twelve thirteen' });
    assert.deepStrictEqual(Object.keys(errors).sort(), ['previewText', 'subjectLine', 'title']);
    assert.match(errors.subjectLine, /66 characters; keep it to 65/);
    assert.match(errors.title, /13 words; keep it to 12/);
    assert.deepStrictEqual(submitErrors({ ...READY_MAIN, subjectLine: 'x'.repeat(65), previewText: 'y'.repeat(140) }), {});
    const secondary = submitErrors({ title: 'one two three four five six seven eight nine ten eleven twelve thirteen', ctaUrl: 'https://acme.example/' }, 'newsletter-secondary');
    assert.ok(secondary.title, JSON.stringify(secondary));
  });

  it('measures the subject without the weekly suffix and the preview text as is', () => {
    assert.strictEqual(subjectCore('Hello | DataTalks.Club Weekly'), 'Hello');
    assert.deepStrictEqual(envelopeProblems({ subject: `${'x'.repeat(65)} | DataTalks.Club Weekly`, previewText: 'y'.repeat(140) }), []);
    assert.deepStrictEqual(envelopeProblems({ subject: 'x'.repeat(66), previewText: 'y'.repeat(141) }).map((p) => p.field), ['subject', 'previewText']);
  });

  it('never accepts a hand-made sponsor block, and checks an own promo\'s bullets, closing and tracking', () => {
    const handMade = block('nb-1', 'sponsor', { title: 'Hand-made', cta_text: 'Go', cta_url: 'https://datatalks.club/' });
    assert.deepStrictEqual(sponsorProblems({ blocks: [handMade] }, {}).map((p) => p.field), ['sponsor_doc']);
    assert.deepStrictEqual(sponsorProblems({ blocks: [] }, { primary: { sponsor: 'Acme' } }).map((p) => p.field), ['sponsor_primary']);
    assert.deepStrictEqual(sponsorProblems({ blocks: [] }, { secondary: { documentUrl: 'https://ops.example/sponsor-docs/d1' } }).map((p) => p.field), ['sponsor_secondary']);

    const doc = 'https://ops.example/sponsor-docs/d2';
    const own = { primary: { sponsor: 'DataTalks.Club', documentUrl: doc } };
    assert.deepStrictEqual(sponsorProblems({ blocks: [handMade] }, own).map((p) => p.field).sort(), ['bullets', 'closing', 'cta_url']);
    const reviewed = block('nb-2', 'sponsor', { title: 'Zoomcamp', bullets: 'a\nb', closing: 'Join.', cta_text: 'Go', cta_url: 'https://datatalks.club/?utm_source=newsletter' });
    assert.deepStrictEqual(sponsorProblems({ blocks: [reviewed] }, own), []);
    // An external sponsor's copy is theirs: no own-promo checks, only the title limit.
    const external = block('nb-3', 'sponsor', { title: 'one two three four five six seven eight nine ten eleven twelve thirteen', cta_url: 'https://acme.example/' });
    assert.deepStrictEqual(sponsorProblems({ blocks: [external] }, { primary: { sponsor: 'Acme', documentUrl: doc } }).map((p) => p.field), ['title']);
  });
});
