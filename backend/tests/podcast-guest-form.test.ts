import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  formatGuestSlotLabel,
  getSponsorDocTemplate,
  hydratePodcastGuestSlotOptions,
  humanizePodcastSlotChoice,
  renderSponsorDocMarkdownExport,
  speakerContentView,
  speakerTemplateView,
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
      'interview-questions',
      'run-sheet',
      'episode-brief',
      'internal-research',
    ]);
    const guestSections = template.sections.slice(0, 7);
    const internalSections = template.sections.slice(7);
    assert.ok(guestSections.every((section) => section.tab === 'guest' && !section.internal));
    assert.ok(internalSections.every((section) => section.tab === 'internal' && section.internal === true && !section.collapsible));
    assert.deepEqual(
      internalSections.map((section) => section.fields.map((field) => field.key)),
      [
        ['coldOpen', 'introScript', 'closingScript'],
        ['goal', 'audience', 'keyMessages'],
        ['sourceLinks', 'keyInsights', 'openQuestions', 'hostNotes'],
      ],
    );
    const questionsSection = template.sections.find((section) => section.id === 'interview-questions');
    assert.equal(questionsSection?.tab, 'guest');
    assert.equal(questionsSection?.internal, undefined);
    assert.equal(questionsSection?.collapsible, undefined);
    assert.deepEqual(questionsSection?.fields.map((field) => field.key), ['interviewQuestions']);
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
    assert.match(template.sections.find(section => section.id === 'scheduling')?.description || '', /confirm it, pick another free slot/i);
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
        jobTitle: 'AI Engineer',
        company: 'Example Corp',
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
    assert.ok(exported.includes('**Job title:** AI Engineer'));
    assert.ok(exported.includes('**Company:** Example Corp'));
    assert.ok(exported.includes('**Website headline:** AI Engineer at Example Corp'));
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

  it('speakerTemplateView and speakerContentView share interviewQuestions with guests and isolate internal sections', () => {
    const template = getSponsorDocTemplate('podcast');
    const speakerTemplate = speakerTemplateView(template);
    assert.deepEqual(
      speakerTemplate.sections.map((section) => section.id),
      ['scheduling', 'who-you-are', 'topics', 'social-links', 'detailed-questions', 'notes', 'interview-questions'],
    );
    assert.ok(speakerTemplate.sections.every((section) => !section.internal && section.tab === 'guest'));

    const fullContent: Record<string, string> = {
      proposedSlotLabel: 'Tue 3 Nov · 12:30–13:30 Berlin',
      slotChoice: 'confirm_proposed',
      guestTimezone: 'Europe/Berlin',
      guestName: 'Jane Doe',
      introduction: 'Principal Data Engineer',
      photoUrl: 'https://example.test/jane.jpg',
      currentFocus: 'Streaming pipelines',
      topicsToCover: 'Flink, Kafka',
      topicsToAvoid: 'Internal pricing',
      linkedinUrl: 'https://linkedin.com/in/janedoe',
      twitterUrl: 'https://x.com/janedoe',
      githubUrl: 'https://github.com/janedoe',
      websiteUrl: 'https://janedoe.example',
      preparationMaterials: 'https://janedoe.example/post',
      hookAndPainPoint: 'Why batch breaks',
      keyInsightsAndMilestones: 'Moved to streaming in 2025',
      actionableTakeaway: 'Start with idempotency',
      sponsorNotes: 'Happy to answer live questions',
      interviewQuestions: 'SHARED-INTERVIEW-QUESTIONS',
      coldOpen: 'SECRET-COLD-OPEN',
      introScript: 'SECRET-INTRO-SCRIPT',
      closingScript: 'SECRET-CLOSING-SCRIPT',
      goal: 'SECRET-GOAL',
      audience: 'SECRET-AUDIENCE',
      keyMessages: 'SECRET-KEY-MESSAGES',
      sourceLinks: 'SECRET-SOURCE-LINKS',
      keyInsights: 'SECRET-KEY-INSIGHTS',
      openQuestions: 'SECRET-OPEN-QUESTIONS',
      hostNotes: 'SECRET-HOST-NOTES',
      strayUnknownKey: 'STRAY-UNKNOWN-VALUE',
    };

    const guestContent = speakerContentView('podcast', fullContent);
    assert.equal(guestContent.guestName, 'Jane Doe');
    assert.equal(guestContent.topicsToCover, 'Flink, Kafka');
    assert.equal(guestContent.sponsorNotes, 'Happy to answer live questions');
    assert.equal(guestContent.interviewQuestions, 'SHARED-INTERVIEW-QUESTIONS');
    for (const secretKey of [
      'coldOpen',
      'introScript',
      'closingScript',
      'goal',
      'audience',
      'keyMessages',
      'sourceLinks',
      'keyInsights',
      'openQuestions',
      'hostNotes',
      'strayUnknownKey',
    ]) {
      assert.equal(Object.hasOwn(guestContent, secretKey), false, `expected ${secretKey} to be stripped`);
    }

    const baseDoc = {
      id: 'doc-iso',
      title: 'Podcast — Materials from the Guest',
      template: 'podcast' as const,
      sponsorName: 'Jane Doe',
      status: 'draft' as const,
      lastEditedAt: '2026-11-21T00:00:00.000Z',
      lastEditedBy: 'staff' as const,
    };

    const guestExport = renderSponsorDocMarkdownExport({ ...baseDoc, content: guestContent });
    assert.ok(guestExport.includes('## Notes from the Guest'));
    assert.ok(guestExport.includes('## Interview Questions'));
    assert.ok(guestExport.includes('SHARED-INTERVIEW-QUESTIONS'));
    assert.ok(!guestExport.includes('## Run Sheet'));
    assert.ok(!guestExport.includes('## Event Description & Episode Plan'));
    assert.ok(!guestExport.includes('## Internal Research & Host Notes (Staff Only)'));
    assert.ok(!guestExport.includes('SECRET-'));

    const staffExport = renderSponsorDocMarkdownExport({ ...baseDoc, content: fullContent });
    const notesIdx = staffExport.indexOf('## Notes from the Guest');
    const questionsIdx = staffExport.indexOf('## Interview Questions');
    const runSheetIdx = staffExport.indexOf('## Run Sheet');
    const briefIdx = staffExport.indexOf('## Event Description & Episode Plan');
    const researchIdx = staffExport.indexOf('## Internal Research & Host Notes (Staff Only)');
    assert.ok(notesIdx > 0);
    assert.ok(questionsIdx > notesIdx);
    assert.ok(runSheetIdx > questionsIdx);
    assert.ok(briefIdx > runSheetIdx);
    assert.ok(researchIdx > briefIdx);
    assert.ok(staffExport.includes('SHARED-INTERVIEW-QUESTIONS'));
    assert.ok(staffExport.includes('SECRET-COLD-OPEN'));
    assert.ok(staffExport.includes('SECRET-GOAL'));
    assert.ok(staffExport.includes('SECRET-HOST-NOTES'));
  });
});
