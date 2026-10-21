import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  getSponsorDocTemplate,
  renderSponsorDocMarkdownExport,
} from '../src/sponsorDocs/templates';

describe('podcast guest form (alternate slot + topics; email stays one slot)', () => {
  it('guest materials form has an alternate-slot picker plus topics fields', () => {
    const template = getSponsorDocTemplate('podcast');
    const keys = template.sections.flatMap((section) =>
      section.fields.map((field) => field.key),
    );
    // Alternate slot picker: the guest confirms or counters the single slot
    // from the first-contact email.
    assert.ok(keys.includes('alternateSlot'));
    // Topics stay in the form (not in the first-contact email).
    assert.ok(keys.includes('topicsToCover'));
    assert.ok(keys.includes('topicsToAvoid'));
    assert.ok(keys.includes('currentFocus'));
  });

  it('guest materials export carries the alternate slot answer', () => {
    const exported = renderSponsorDocMarkdownExport({
      id: 'doc-1',
      title: 'Podcast — Materials from the Guest',
      template: 'podcast',
      status: 'submitted',
      lastEditedAt: '2026-10-22T00:00:00.000Z',
      lastEditedBy: 'sponsor',
      content: {
        guestName: 'Sofiia',
        alternateSlot: 'Wednesday after 16:30',
        topicsToCover: 'LLM evals, data pipelines',
      },
    });
    assert.ok(exported.includes('Wednesday after 16:30'));
    assert.ok(exported.includes('LLM evals, data pipelines'));
  });
});
