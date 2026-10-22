import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  getSponsorDocTemplate,
  hydratePodcastGuestSlotOptions,
  renderSponsorDocMarkdownExport,
} from '../src/sponsorDocs/templates';

describe('podcast guest form (slot picker + topics; email stays one slot)', () => {
  it('guest materials form has slot picker (confirm / free / none-fit) plus topics fields', () => {
    const template = getSponsorDocTemplate('podcast');
    const fields = template.sections.flatMap((section) => section.fields);
    const keys = fields.map((field) => field.key);
    assert.ok(keys.includes('slotChoice'));
    assert.ok(keys.includes('customSlot'));
    assert.ok(keys.includes('proposedSlotLabel'));
    const slotChoice = fields.find((field) => field.key === 'slotChoice');
    assert.equal(slotChoice?.type, 'select');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    assert.ok(values.includes('confirm_proposed'));
    assert.ok(values.includes('none_fit'));
    assert.ok(keys.includes('topicsToCover'));
    assert.ok(keys.includes('topicsToAvoid'));
    assert.ok(keys.includes('currentFocus'));
    assert.ok(keys.includes('introduction'));
  });

  it('hydrates ordinary free podcast slots into the select options', () => {
    const template = getSponsorDocTemplate('podcast');
    const hydrated = hydratePodcastGuestSlotOptions(
      template,
      [
        { date: '2026-11-03', window: 'midday', localTime: '12:30' },
        { date: '2026-11-03', window: 'evening', localTime: '17:00' },
      ],
      'Tuesday, November 3 at 12:30 CET',
    );
    const slotChoice = hydrated.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'slotChoice');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    const labels = (slotChoice?.options || []).map((opt) => opt.label);
    assert.deepEqual(values.slice(0, 1), ['confirm_proposed']);
    assert.ok(values.includes('slot:2026-11-03:midday'));
    assert.ok(values.includes('slot:2026-11-03:evening'));
    assert.equal(values.at(-1), 'none_fit');
    assert.ok(labels[0].includes('12:30'));
    assert.ok(labels.some((label) => label.includes('12:30')));
    assert.ok(labels.some((label) => label.includes('17:00')));
  });

  it('guest materials export carries the slot choice answer', () => {
    const exported = renderSponsorDocMarkdownExport({
      id: 'doc-1',
      title: 'Podcast — Materials from the Guest',
      template: 'podcast',
      status: 'submitted',
      lastEditedAt: '2026-10-22T00:00:00.000Z',
      lastEditedBy: 'sponsor',
      content: {
        guestName: 'Sofiia',
        proposedSlotLabel: 'Tuesday, November 3 at 12:30 CET',
        slotChoice: 'slot:2026-11-04:midday',
        customSlot: '',
        topicsToCover: 'LLM evals, data pipelines',
      },
    });
    assert.ok(exported.includes('slot:2026-11-04:midday'));
    assert.ok(exported.includes('Tuesday, November 3 at 12:30 CET'));
    assert.ok(exported.includes('LLM evals, data pipelines'));
  });
});
