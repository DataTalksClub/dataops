import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  extractEmoji,
  extractTags,
  mapStageFromList,
  extractReferences,
  extractBundleLinks,
  extractInstructionsUrl,
  extractAssigneeHint,
  trelloCardToBundle,
  trelloChecklistItemsToTasks,
  trelloTemplateToAppTemplate,
  mapTriggerType,
  type TrelloCard,
  type TrelloChecklist,
} from '../scripts/migrate-data';

// ---------------------------------------------------------------------------
// extractEmoji
// ---------------------------------------------------------------------------

describe('extractEmoji', () => {
  it('extracts a single emoji from card name prefix', () => {
    assert.strictEqual(extractEmoji('\u{1F4F0} [Newsletter] Weekly email #123'), '\u{1F4F0}');
  });

  it('extracts microphone emoji', () => {
    assert.strictEqual(extractEmoji('\u{1F399}\u{FE0F} [Podcast] 2026-Feb-15'), '\u{1F399}\u{FE0F}');
  });

  it('extracts wrench emoji', () => {
    assert.strictEqual(extractEmoji('\u{1F527} [Workshop] 2026-Mar-01'), '\u{1F527}');
  });

  it('returns null when no emoji prefix', () => {
    assert.strictEqual(extractEmoji('[Newsletter] Weekly email #123'), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(extractEmoji(''), null);
  });

  it('extracts gear emoji', () => {
    assert.strictEqual(extractEmoji('\u{2699}\u{FE0F} [Open-Source Spotlight]'), '\u{2699}\u{FE0F}');
  });
});

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

describe('extractTags', () => {
  it('extracts tag names from labels', () => {
    const labels = [{ name: 'Newsletter' }, { name: 'Weekly' }];
    assert.deepStrictEqual(extractTags(labels), ['Newsletter', 'Weekly']);
  });

  it('returns empty array for no labels', () => {
    assert.deepStrictEqual(extractTags([]), []);
  });

  it('filters empty label names', () => {
    const labels = [{ name: 'Podcast' }, { name: '' }];
    assert.deepStrictEqual(extractTags(labels), ['Podcast']);
  });
});

// ---------------------------------------------------------------------------
// mapStageFromList
// ---------------------------------------------------------------------------

describe('mapStageFromList', () => {
  it('maps Preparation list', () => {
    assert.strictEqual(mapStageFromList('Preparation'), 'preparation');
  });

  it('maps Announced list', () => {
    assert.strictEqual(mapStageFromList('Announced'), 'announced');
  });

  it('maps After event list', () => {
    assert.strictEqual(mapStageFromList('After event'), 'after-event');
  });

  it('maps Done list', () => {
    assert.strictEqual(mapStageFromList('Done'), 'done');
  });

  it('defaults to preparation for unknown lists', () => {
    assert.strictEqual(mapStageFromList('Templates'), 'preparation');
  });

  it('is case-insensitive', () => {
    assert.strictEqual(mapStageFromList('ANNOUNCED'), 'announced');
  });
});

// ---------------------------------------------------------------------------
// extractReferences
// ---------------------------------------------------------------------------

describe('extractReferences', () => {
  it('extracts markdown links from description', () => {
    const desc = 'See [Process docs](https://docs.google.com/proc) and [Guide](https://docs.google.com/guide)';
    const refs = extractReferences(desc);
    assert.deepStrictEqual(refs, [
      { name: 'Process docs', url: 'https://docs.google.com/proc' },
      { name: 'Guide', url: 'https://docs.google.com/guide' },
    ]);
  });

  it('returns empty array for no description', () => {
    assert.deepStrictEqual(extractReferences(undefined), []);
  });

  it('returns empty array for description with no links', () => {
    assert.deepStrictEqual(extractReferences('Just some text'), []);
  });

  it('extracts single link', () => {
    const desc = 'Check [overview](https://docs.google.com/overview)';
    const refs = extractReferences(desc);
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].name, 'overview');
    assert.strictEqual(refs[0].url, 'https://docs.google.com/overview');
  });
});

// ---------------------------------------------------------------------------
// extractBundleLinks
// ---------------------------------------------------------------------------

describe('extractBundleLinks', () => {
  it('extracts non-Trello attachments as bundle links', () => {
    const card = {
      attachments: [
        { name: 'Luma event', url: 'https://lu.ma/abc' },
        { name: 'Trello img', url: 'https://trello.com/1/cards/xyz/image.png' },
      ],
    } as unknown as TrelloCard;
    const links = extractBundleLinks(card);
    assert.deepStrictEqual(links, [{ name: 'Luma event', url: 'https://lu.ma/abc' }]);
  });

  it('returns empty array when no attachments', () => {
    const card = { attachments: [] } as unknown as TrelloCard;
    assert.deepStrictEqual(extractBundleLinks(card), []);
  });

  it('uses url as name when name is missing', () => {
    const card = {
      attachments: [{ url: 'https://example.com/file.pdf' }],
    } as unknown as TrelloCard;
    const links = extractBundleLinks(card);
    assert.deepStrictEqual(links, [{ name: 'https://example.com/file.pdf', url: 'https://example.com/file.pdf' }]);
  });
});

// ---------------------------------------------------------------------------
// extractInstructionsUrl
// ---------------------------------------------------------------------------

describe('extractInstructionsUrl', () => {
  it('extracts URL from parenthesized markdown link', () => {
    const text = 'Create a MailChimp campaign ([link](https://docs.google.com/doc123))';
    const result = extractInstructionsUrl(text);
    assert.strictEqual(result.instructionsUrl, 'https://docs.google.com/doc123');
    assert.strictEqual(result.description, 'Create a MailChimp campaign');
  });

  it('extracts URL from bare markdown link', () => {
    const text = 'Do something [doc](https://docs.google.com/xyz)';
    const result = extractInstructionsUrl(text);
    assert.strictEqual(result.instructionsUrl, 'https://docs.google.com/xyz');
    assert.strictEqual(result.description, 'Do something');
  });

  it('returns null when no link present', () => {
    const text = 'Just a plain task description';
    const result = extractInstructionsUrl(text);
    assert.strictEqual(result.instructionsUrl, null);
    assert.strictEqual(result.description, 'Just a plain task description');
  });
});

// ---------------------------------------------------------------------------
// extractAssigneeHint
// ---------------------------------------------------------------------------

describe('extractAssigneeHint', () => {
  it('extracts assignee from (assignee: Name) pattern', () => {
    const result = extractAssigneeHint('Review content (assignee: Valeriia)');
    assert.strictEqual(result.assigneeId, 'valeriia');
    assert.strictEqual(result.description, 'Review content');
  });

  it('extracts assignee from -- Name pattern', () => {
    const result = extractAssigneeHint('Upload recording -- Alexey');
    assert.strictEqual(result.assigneeId, 'alexey');
    assert.strictEqual(result.description, 'Upload recording');
  });

  it('returns null for unknown name', () => {
    const result = extractAssigneeHint('Do something -- UnknownPerson');
    assert.strictEqual(result.assigneeId, null);
    assert.strictEqual(result.description, 'Do something -- UnknownPerson');
  });

  it('returns null when no assignee hint', () => {
    const result = extractAssigneeHint('Regular task description');
    assert.strictEqual(result.assigneeId, null);
    assert.strictEqual(result.description, 'Regular task description');
  });

  it('is case insensitive for assignee matching', () => {
    const result = extractAssigneeHint('Task (assignee: GRACE)');
    assert.strictEqual(result.assigneeId, 'grace');
  });
});

// ---------------------------------------------------------------------------
// mapTriggerType
// ---------------------------------------------------------------------------

describe('mapTriggerType', () => {
  it('returns automatic for newsletter', () => {
    assert.strictEqual(mapTriggerType('newsletter'), 'automatic');
  });

  it('returns automatic for social-media', () => {
    assert.strictEqual(mapTriggerType('social-media'), 'automatic');
  });

  it('returns automatic for tax-report', () => {
    assert.strictEqual(mapTriggerType('tax-report'), 'automatic');
  });

  it('returns manual for podcast', () => {
    assert.strictEqual(mapTriggerType('podcast'), 'manual');
  });

  it('returns manual for webinar', () => {
    assert.strictEqual(mapTriggerType('webinar'), 'manual');
  });
});

// ---------------------------------------------------------------------------
// trelloCardToBundle
// ---------------------------------------------------------------------------

describe('trelloCardToBundle', () => {
  it('creates bundle with emoji, tags, stage, references, and bundleLinks', () => {
    const card: TrelloCard = {
      id: 'card1',
      name: '\u{1F4F0} [Newsletter] Weekly email #123 (15 Mar 2026)',
      desc: 'See [Process docs](https://docs.google.com/proc)',
      due: '2026-03-15T00:00:00.000Z',
      closed: false,
      isTemplate: false,
      idList: 'list1',
      idChecklists: [],
      labels: [{ name: 'Newsletter' }],
      attachments: [{ name: 'Luma event', url: 'https://lu.ma/abc' }],
      dateLastActivity: '2026-03-10T12:00:00.000Z',
    };

    const bundle = trelloCardToBundle(card, 'Preparation');

    assert.strictEqual(bundle.emoji, '\u{1F4F0}');
    assert.deepStrictEqual(bundle.tags, ['Newsletter']);
    assert.strictEqual(bundle.stage, 'preparation');
    assert.strictEqual(bundle.status, 'active');
    assert.deepStrictEqual(bundle.references, [
      { name: 'Process docs', url: 'https://docs.google.com/proc' },
    ]);
    assert.deepStrictEqual(bundle.bundleLinks, [
      { name: 'Luma event', url: 'https://lu.ma/abc' },
    ]);
    // Should NOT have the old links field
    assert.strictEqual(bundle.links, undefined);
  });

  it('sets status to archived for closed cards', () => {
    const card: TrelloCard = {
      id: 'card2',
      name: 'Old card',
      closed: true,
      isTemplate: false,
      idList: 'list1',
      idChecklists: [],
      labels: [],
      attachments: [],
      dateLastActivity: '2025-01-01T00:00:00.000Z',
    };

    const bundle = trelloCardToBundle(card, 'Done');
    assert.strictEqual(bundle.status, 'archived');
    assert.strictEqual(bundle.stage, 'done');
  });

  it('maps After event list to after-event stage', () => {
    const card: TrelloCard = {
      id: 'card3',
      name: 'Some card',
      closed: false,
      isTemplate: false,
      idList: 'list1',
      idChecklists: [],
      labels: [],
      attachments: [],
    };

    const bundle = trelloCardToBundle(card, 'After event');
    assert.strictEqual(bundle.stage, 'after-event');
    assert.strictEqual(bundle.status, 'active');
  });
});

// ---------------------------------------------------------------------------
// trelloChecklistItemsToTasks
// ---------------------------------------------------------------------------

describe('trelloChecklistItemsToTasks', () => {
  const makeCard = (overrides?: Partial<TrelloCard>): TrelloCard => ({
    id: 'card1',
    name: 'Test card',
    closed: false,
    isTemplate: false,
    idList: 'list1',
    idChecklists: ['cl1'],
    labels: [],
    attachments: [],
    due: '2026-03-15T00:00:00.000Z',
    ...overrides,
  });

  const makeChecklist = (items: { name: string; state?: string }[]): TrelloChecklist => ({
    id: 'cl1',
    name: 'Phase 1',
    pos: 1,
    checkItems: items.map((item, i) => ({
      name: item.name,
      pos: i,
      state: item.state || 'incomplete',
    })),
  });

  it('sets source to template for checklist items', () => {
    const card = makeCard();
    const checklists = [makeChecklist([{ name: 'Task A' }])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, 'bundle1');
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].source, 'template');
  });

  it('stores instructionsUrl on task, not in comment', () => {
    const card = makeCard();
    const checklists = [makeChecklist([
      { name: 'Create a MailChimp campaign ([link](https://docs.google.com/doc123))' },
    ])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, 'bundle1');
    assert.strictEqual(tasks[0].instructionsUrl, 'https://docs.google.com/doc123');
    assert.strictEqual(tasks[0].comment, undefined);
    assert.strictEqual((tasks[0].description as string).includes('Create a MailChimp campaign'), true);
  });

  it('sets templateTaskRef on tasks', () => {
    const card = makeCard();
    const checklists = [makeChecklist([{ name: 'Do something' }])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, 'bundle1');
    assert.ok(tasks[0].templateTaskRef);
    assert.strictEqual(typeof tasks[0].templateTaskRef, 'string');
  });

  it('extracts assigneeId from task description hint', () => {
    const card = makeCard();
    const checklists = [makeChecklist([
      { name: 'Review content (assignee: Valeriia)' },
    ])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, 'bundle1');
    assert.strictEqual(tasks[0].assigneeId, 'valeriia');
    assert.ok(!(tasks[0].description as string).includes('assignee'));
  });

  it('sets bundleId when provided', () => {
    const card = makeCard();
    const checklists = [makeChecklist([{ name: 'Task A' }])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, 'bundle123');
    assert.strictEqual(tasks[0].bundleId, 'bundle123');
  });

  it('handles completed tasks', () => {
    const card = makeCard();
    const checklists = [makeChecklist([
      { name: 'Done task', state: 'complete' },
    ])];

    const tasks = trelloChecklistItemsToTasks(card, checklists, null);
    assert.strictEqual(tasks[0].status, 'done');
  });
});

// ---------------------------------------------------------------------------
// trelloTemplateToAppTemplate
// ---------------------------------------------------------------------------

describe('trelloTemplateToAppTemplate', () => {
  const makeTemplateCard = (overrides?: Partial<TrelloCard>): TrelloCard => ({
    id: 'tpl1',
    name: '\u{1F4F0} [Newsletter] Weekly email #XXX (DD MMM 2026)',
    closed: false,
    isTemplate: true,
    idList: 'list1',
    idChecklists: ['cl1'],
    labels: [{ name: 'Newsletter' }],
    attachments: [],
    ...overrides,
  });

  it('includes emoji in template', () => {
    const card = makeTemplateCard();
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [{ name: 'Create campaign', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.strictEqual(template.emoji, '\u{1F4F0}');
  });

  it('includes tags from labels in template', () => {
    const card = makeTemplateCard();
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [{ name: 'Create campaign', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.deepStrictEqual(template.tags, ['Newsletter']);
  });

  it('sets triggerType for newsletter to automatic', () => {
    const card = makeTemplateCard();
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [{ name: 'Create campaign', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.strictEqual(template.triggerType, 'automatic');
  });

  it('sets triggerType for podcast to manual', () => {
    const card = makeTemplateCard({
      name: '\u{1F399}\u{FE0F} [Podcast] 2026-MMM-DD - Topic - Speaker',
      labels: [{ name: 'Podcast' }],
    });
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Prep', pos: 1,
      checkItems: [{ name: 'Book guest', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.strictEqual(template.triggerType, 'manual');
  });

  it('does not include emoji when not present', () => {
    const card = makeTemplateCard({ name: '[Newsletter] Weekly email #XXX' });
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [{ name: 'Create campaign', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.strictEqual(template.emoji, undefined);
  });

  it('does not include tags when no labels', () => {
    const card = makeTemplateCard({ labels: [] });
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [{ name: 'Create campaign', pos: 1, state: 'incomplete' }],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    assert.strictEqual(template.tags, undefined);
  });

  it('extracts instructionsUrl into taskDefinitions', () => {
    const card = makeTemplateCard();
    const checklists: TrelloChecklist[] = [{
      id: 'cl1', name: 'Setup', pos: 1,
      checkItems: [
        { name: 'Create campaign ([link](https://docs.google.com/doc123))', pos: 1, state: 'incomplete' },
      ],
    }];

    const template = trelloTemplateToAppTemplate(card, checklists);
    const td = (template.taskDefinitions as { instructionsUrl?: string }[])[0];
    assert.strictEqual(td.instructionsUrl, 'https://docs.google.com/doc123');
  });
});
