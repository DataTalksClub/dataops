import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  formatGuestSlotLabel,
  getSponsorDocTemplate,
  hydratePodcastGuestSlotOptions,
  humanizePodcastSlotChoice,
  renderSponsorDocMarkdownExport,
} from '../src/sponsorDocs/templates';

describe('podcast guest form (radio slot picker + topics; email stays one slot)', () => {
  it('guest materials form orders scheduling first, uses radios, and drops the custom-slot text path', () => {
    const template = getSponsorDocTemplate('podcast');
    assert.equal(template.defaultLinkType, 'Guest materials');
    const sections = template.sections.map((section) => section.id);
    assert.deepEqual(sections, [
      'scheduling',
      'who-you-are',
      'topics',
      'social-links',
      'detailed-questions',
      'notes',
    ]);
    const fields = template.sections.flatMap((section) => section.fields);
    const keys = fields.map((field) => field.key);
    assert.ok(keys.includes('slotChoice'));
    assert.ok(keys.includes('proposedSlotLabel'));
    assert.ok(!keys.includes('customSlot'), 'no custom-slot text field for guests');
    const slotChoice = fields.find((field) => field.key === 'slotChoice');
    assert.equal(slotChoice?.type, 'radio');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    assert.ok(values.includes('confirm_proposed'));
    assert.ok(values.includes('none_fit'));
    const noneFit = (slotChoice?.options || []).find((opt) => opt.value === 'none_fit');
    assert.match(noneFit?.label || '', /reply to the invite email/i);
    assert.ok(keys.includes('topicsToCover'));
    assert.ok(keys.includes('topicsToAvoid'));
    assert.ok(keys.includes('currentFocus'));
    assert.ok(keys.includes('introduction'));
    assert.ok(!/couple of sentences/i.test(template.intro));
    assert.ok(!/either way works/i.test(template.intro));
    assert.ok(!/reply to our email/i.test(template.intro));
    assert.ok(/confirm or change the recording slot/i.test(template.intro));
    const story = template.sections.find((section) => section.id === 'detailed-questions');
    assert.equal(story?.collapsible, true);
    const notes = template.sections.find((section) => section.id === 'notes');
    assert.equal(notes?.collapsible, true);
  });

  it('hydrates free Mon/Tue slots as one-label radios with human datetime labels', () => {
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
    assert.equal(slotChoice?.type, 'radio');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    const labels = (slotChoice?.options || []).map((opt) => opt.label);
    assert.deepEqual(values.slice(0, 1), ['confirm_proposed']);
    assert.ok(values.includes('slot:2026-11-03:midday'));
    assert.ok(values.includes('slot:2026-11-03:evening'));
    assert.equal(values.at(-1), 'none_fit');
    assert.ok(labels[0].includes('Tuesday, November 3 at 12:30 CET'));
    assert.ok(!labels.some((label) => /slot:/.test(label)), 'no raw slot: values in UI labels');
    assert.ok(!labels.some((label) => /2026-11-03 midday/.test(label)), 'no raw date+window labels');
    assert.ok(labels.some((label) => /Tue 3 Nov · 12:30–13:30 Berlin/.test(label)));
    assert.ok(labels.some((label) => /Tue 3 Nov · 17:00–18:00 Berlin/.test(label)));
  });

  it('never hydrates Wed–Fri free slots: Mon/Tue ordinary windows only', () => {
    const template = getSponsorDocTemplate('podcast');
    const hydrated = hydratePodcastGuestSlotOptions(
      template,
      [
        { date: '2026-10-28', window: 'midday', localTime: '12:30' },
        { date: '2026-10-29', window: 'midday', localTime: '12:30' },
        { date: '2026-10-30', window: 'evening', localTime: '17:00' },
        { date: '2026-10-31', window: 'midday', localTime: '12:30' },
        { date: '2026-11-02', window: 'midday', localTime: '12:30' },
        { date: '2026-11-03', window: 'evening', localTime: '17:00' },
      ],
      null,
    );
    const slotChoice = hydrated.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'slotChoice');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    assert.deepEqual(values, [
      'confirm_proposed',
      'slot:2026-11-02:midday',
      'slot:2026-11-03:evening',
      'none_fit',
    ]);
  });

  it('filters Wed–Fri before the option cap so Mon/Tue are not crowded out', () => {
    const template = getSponsorDocTemplate('podcast');
    const stale = [
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-11',
      '2026-11-12',
    ].map((date) => ({ date, window: 'midday', localTime: '12:30' }));
    const hydrated = hydratePodcastGuestSlotOptions(
      template,
      [...stale, { date: '2026-11-02', window: 'midday', localTime: '12:30' }],
      null,
    );
    const slotChoice = hydrated.sections
      .flatMap((section) => section.fields)
      .find((field) => field.key === 'slotChoice');
    const values = (slotChoice?.options || []).map((opt) => opt.value);
    assert.deepEqual(values, [
      'confirm_proposed',
      'slot:2026-11-02:midday',
      'none_fit',
    ]);
  });

  it('formats guest slot labels as weekday date and window', () => {
    assert.equal(formatGuestSlotLabel('2026-10-26', 'midday'), 'Mon 26 Oct · 12:30–13:30 Berlin');
    assert.equal(formatGuestSlotLabel('2026-10-27', 'evening'), 'Tue 27 Oct · 17:00–18:00 Berlin');
  });

  it('humanizes stored slot choices for the export', () => {
    assert.equal(
      humanizePodcastSlotChoice('slot:2026-11-04:midday'),
      'Wed 4 Nov · 12:30–13:30 Berlin',
    );
    assert.equal(
      humanizePodcastSlotChoice('confirm_proposed', 'Tue 3 Nov · 12:30–13:30 Berlin'),
      'Confirmed — Tue 3 Nov · 12:30–13:30 Berlin',
    );
    assert.equal(
      humanizePodcastSlotChoice('none_fit'),
      'None fit — guest will reply to the invite email',
    );
    assert.equal(humanizePodcastSlotChoice(''), '_[Not selected]_');
  });

  it('guest materials export carries the human slot choice and guest wording', () => {
    const exported = renderSponsorDocMarkdownExport({
      id: 'doc-1',
      title: 'Podcast — Materials from the Guest',
      template: 'podcast',
      sponsorName: 'Sofiia',
      status: 'submitted',
      lastEditedAt: '2026-10-22T00:00:00.000Z',
      lastEditedBy: 'sponsor',
      content: {
        guestName: 'Sofiia',
        proposedSlotLabel: 'Tuesday, November 3 at 12:30 CET',
        slotChoice: 'slot:2026-11-04:midday',
        topicsToCover: 'LLM evals, data pipelines',
        sponsorNotes: 'Extra link',
      },
    });
    assert.ok(!/slot:2026-11-04:midday/.test(exported), 'no raw slot value in export');
    assert.ok(exported.includes('Wed 4 Nov · 12:30–13:30 Berlin'));
    assert.ok(exported.includes('Tuesday, November 3 at 12:30 CET'));
    assert.ok(exported.includes('LLM evals, data pipelines'));
    assert.ok(exported.includes('**Guest:** Sofiia'));
    assert.ok(!exported.includes('**Sponsor**'));
    assert.ok(exported.includes('## Notes from the Guest'));
    assert.ok(!exported.includes('Sponsor / Guest'));
    assert.ok(!/custom slot/i.test(exported));
  });

  it('newsletter exports keep sponsor wording', () => {
    const exported = renderSponsorDocMarkdownExport({
      id: 'doc-2',
      title: '2026-11-15 - Acme',
      template: 'newsletter-main',
      sponsorName: 'Acme',
      status: 'submitted',
      lastEditedAt: '2026-10-22T00:00:00.000Z',
      lastEditedBy: 'sponsor',
      content: { title: 'Hello', sponsorNotes: 'Note' },
    });
    assert.ok(exported.includes('- **Sponsor**: Acme'));
    assert.ok(exported.includes('## Notes from Sponsor'));
  });
});
