import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  extractEmoji,
  extractTags,
  mapStageFromList,
  extractReferences,
  extractBundleLinks,
  extractInstructionsUrl,
  extractAssigneeHint,
  selectActiveTrelloCards,
  trelloCardToBundle,
  trelloChecklistItemsToTasks,
  migrateTrelloActiveCards,
  trelloTemplateToAppTemplate,
  mapTriggerType,
  parseCSVFile,
  parseDate,
  planCsvRow,
  normalizeSpreadsheetStatus,
  redactUnsafeText,
  migrateCsvFile,
  emptyCsvMigrationReport,
  type TrelloCard,
  type TrelloChecklist,
} from '../scripts/migrate-data';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listBundles } from '../src/db/bundles';
import { listRecurringConfigs } from '../src/db/recurring';
import { listTasksByBundle, listTasksByStatus } from '../src/db/tasks';
import { listArtifacts } from '../src/db/artifacts';
import { dryRunImport, validatePortableExport, writePortableExport } from '../src/export/portable';

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
      { name: 'Process docs', url: 'https://docs.google.com/proc' },
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

// ---------------------------------------------------------------------------
// Trello active-card migration
// ---------------------------------------------------------------------------

describe('Trello active-card migration', () => {
  const fixture = path.join(__dirname, 'fixtures', 'trello-active-cards.json');

  async function loadFixture(): Promise<{
    cards: TrelloCard[];
    checklists: TrelloChecklist[];
    lists: { id: string; name: string; closed: boolean; pos: number }[];
  }> {
    return JSON.parse(await fs.readFile(fixture, 'utf8'));
  }

  it('selects only active non-template cards from active lists and reports skipped records', async () => {
    const trello = await loadFixture();
    const selection = selectActiveTrelloCards(trello.cards, trello.lists);

    assert.deepStrictEqual(selection.activeCards.map((card) => card.id), [
      'card-preparation',
      'card-announced',
      'card-after-event',
    ]);
    assert.ok(selection.skippedRecords.some((record) => record.sourceId === 'card-template' && record.reason === 'template-card'));
    assert.ok(selection.skippedRecords.some((record) => record.sourceId === 'card-done' && record.reason === 'inactive-list'));
  });

  it('imports active cards idempotently as bundles, tasks, artifacts, notifications, and valid portable export data', async () => {
    const trello = await loadFixture();
    const selection = selectActiveTrelloCards(trello.cards, trello.lists);
    const dryRunReport = await migrateTrelloActiveCards(null, selection.activeCards, trello.checklists, selection.listMap, selection.skippedRecords);
    assert.strictEqual(dryRunReport.stats.cardsPlanned, 3);
    assert.strictEqual(dryRunReport.stats.cardsSkipped, 2);
    assert.strictEqual(dryRunReport.stats.tasksPlanned, 7);
    assert.strictEqual(dryRunReport.stats.waitingTasks, 2);
    assert.ok(dryRunReport.stats.proofRequirements >= 4);
    assert.ok(dryRunReport.stats.unsafeArtifactUrls >= 1);

    const preparationPlan = dryRunReport.plans.find((plan) => plan.sourceKey === 'trello:card:card-preparation');
    assert.ok(preparationPlan);
    assert.strictEqual(preparationPlan.bundle.stage, 'preparation');
    assert.ok((preparationPlan.bundle.bundleLinks as { url: string }[]).some((link) => link.url === 'https://lu.ma/prep-event'));
    const docTask = preparationPlan.tasks.find((task) => String(task.description).includes('Create podcast document'));
    assert.strictEqual(docTask?.instructionDocId, 'sop.media.podcast.create-podcast-document');
    const waitingTask = preparationPlan.tasks.find((task) => String(task.description).includes('Follow up with guest'));
    assert.strictEqual(waitingTask?.status, 'waiting');
    assert.strictEqual(waitingTask?.waitingFor, 'Guest');
    assert.strictEqual(waitingTask?.followUpAt, '2026-06-18');
    const lumaTask = preparationPlan.tasks.find((task) => String(task.description).includes('Publish Luma'));
    assert.deepStrictEqual(lumaTask?.proofRequirement, { type: 'url', label: 'Luma', required: true });
    assert.strictEqual(lumaTask?.requiredLinkName, 'Luma');

    const announcedPlan = dryRunReport.plans.find((plan) => plan.sourceKey === 'trello:card:card-announced');
    assert.strictEqual(announcedPlan?.bundle.stage, 'announced');
    assert.ok(announcedPlan?.tasks.some((task) => task.status === 'waiting' && task.waitingFor === 'Sponsor'));

    const afterEventPlan = dryRunReport.plans.find((plan) => plan.sourceKey === 'trello:card:card-after-event');
    assert.strictEqual(afterEventPlan?.bundle.stage, 'after-event');
    assert.ok(afterEventPlan?.artifacts.some((artifactPlan) => artifactPlan.artifact.sourceType === 'migration'));
    assert.ok(afterEventPlan?.tasks.some((task) => task.status === 'done' && task.link === 'https://youtube.com/watch?v=duckdb123'));

    const port = await startLocal();
    const client = await getClient(port);
    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-trello-export-'));
    try {
      await createTables(client);

      const firstReport = await migrateTrelloActiveCards(client, selection.activeCards, trello.checklists, selection.listMap, selection.skippedRecords);
      assert.strictEqual(firstReport.stats.bundlesCreated, 3);
      assert.strictEqual(firstReport.stats.tasksCreated, 7);
      assert.ok(firstReport.stats.artifactsCreated >= 3);
      assert.strictEqual(firstReport.stats.followUpNotificationsCreated, 2);

      const secondReport = await migrateTrelloActiveCards(client, selection.activeCards, trello.checklists, selection.listMap, selection.skippedRecords);
      assert.strictEqual(secondReport.stats.bundlesCreated, 0);
      assert.strictEqual(secondReport.stats.tasksCreated, 0);
      assert.strictEqual(secondReport.stats.bundlesUpdated, 3);
      assert.strictEqual(secondReport.stats.tasksUpdated, 7);
      assert.strictEqual(secondReport.stats.followUpNotificationsCreated, 0);

      const bundles = await listBundles(client);
      assert.strictEqual(bundles.length, 3);
      assert.deepStrictEqual(new Set(bundles.map((bundle) => bundle.stage)), new Set(['preparation', 'announced', 'after-event']));
      const prepBundle = bundles.find((bundle) => bundle.stage === 'preparation');
      assert.ok(prepBundle);
      assert.ok(prepBundle.description?.includes('source_key=trello:card:card-preparation'));
      assert.ok(prepBundle.artifactRefs && prepBundle.artifactRefs.length > 0);

      const prepTasks = await listTasksByBundle(client, prepBundle.id);
      assert.ok(prepTasks.some((task) => task.instructionDocId === 'sop.media.podcast.create-podcast-document'));
      assert.ok(prepTasks.some((task) => task.status === 'waiting' && task.waitingFor === 'Guest' && task.followUpAt === '2026-06-18'));
      assert.ok(prepTasks.some((task) => task.requiredLinkName === 'Luma' && task.proofRequirement?.type === 'url'));

      const artifacts = await listArtifacts(client);
      assert.ok(artifacts.some((artifact) => artifact.sourceType === 'migration' && artifact.storageUri === 'https://lu.ma/prep-event'));
      assert.ok(artifacts.every((artifact) => !artifact.storageUri.includes('X-Amz-Signature')));

      await writePortableExport(client, exportDir, {
        generatedAt: '2026-06-28T00:00:00.000Z',
        sourceEnvironment: 'test',
        sourceStack: 'test-stack',
        sourceRegion: 'eu-west-1',
        appGitSha: 'test-sha',
      });
      const validation = await validatePortableExport(exportDir);
      assert.strictEqual(validation.valid, true);
      const dryRun = await dryRunImport(exportDir);
      assert.strictEqual(dryRun.valid, true);
      assert.strictEqual(dryRun.wouldWrite.bundles, 3);
      assert.strictEqual(dryRun.wouldWrite.tasks, 7);
      assert.ok(dryRun.wouldWrite.artifacts >= 3);
      assert.strictEqual(dryRun.wouldWrite.notifications, 2);
      assert.strictEqual(dryRun.wouldWrite.audit_events, 3);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
      await stopLocal();
    }
  });
});

// ---------------------------------------------------------------------------
// Spreadsheet TODO CSV migration planning
// ---------------------------------------------------------------------------

describe('spreadsheet TODO migration planning', () => {
  const fixtureTodo = path.join(__dirname, 'fixtures', 'spreadsheet-todo.csv');
  const fixtureDone = path.join(__dirname, 'fixtures', 'spreadsheet-done.csv');

  it('parses known spreadsheet date and status formats', () => {
    assert.strictEqual(parseDate('2026-06-20 12:00:00'), '2026-06-20');
    assert.strictEqual(parseDate('21 Jun 2026'), '2026-06-21');
    assert.strictEqual(parseDate('June 22, 2026'), '2026-06-22');
    assert.strictEqual(parseDate('06/23/2026'), '2026-06-23');
    assert.strictEqual(parseDate('2026-99-99'), null);

    assert.strictEqual(normalizeSpreadsheetStatus('NEW', 'todo', true), 'open');
    assert.strictEqual(normalizeSpreadsheetStatus('doneDone', 'todo', true), 'done');
    assert.strictEqual(normalizeSpreadsheetStatus('', 'done', true), 'done');
    assert.strictEqual(normalizeSpreadsheetStatus('', 'todo', false), 'blank');
  });

  it('plans pending rows as normal tasks with provenance, waiting, proof, and redaction', async () => {
    const rows = parseCSVFile(fixtureTodo).slice(1);
    const waitingPlan = planCsvRow(rows[0], {
      sourceFile: fixtureTodo,
      sourceLabel: 'spreadsheet-todo.csv',
      fileRole: 'todo',
      rowNumber: 2,
    });
    assert.strictEqual(waitingPlan.kind, 'task');
    if (waitingPlan.kind === 'task') {
      assert.strictEqual(waitingPlan.task.source, 'import');
      assert.strictEqual(waitingPlan.task.status, 'waiting');
      assert.strictEqual(waitingPlan.task.waitingFor, 'Sponsor');
      assert.strictEqual(waitingPlan.task.followUpAt, '2026-06-20');
      assert.match(String(waitingPlan.task.comment), /source_key=spreadsheet-todo:/);
    }

    const docPlan = planCsvRow(rows[1], {
      sourceFile: fixtureTodo,
      sourceLabel: 'spreadsheet-todo.csv',
      fileRole: 'todo',
      rowNumber: 3,
    });
    assert.strictEqual(docPlan.kind, 'task');
    if (docPlan.kind === 'task') {
      assert.strictEqual(docPlan.task.instructionsUrl, 'https://docs.google.com/document/d/doc-safe/edit');
      assert.deepStrictEqual(docPlan.task.proofRequirement, { type: 'url', label: 'Completion proof', required: true });
      assert.ok(docPlan.warnings.some((warning) => warning.startsWith('unresolved process doc:')));
    }

    const recurringPlan = planCsvRow(rows[2], {
      sourceFile: fixtureTodo,
      sourceLabel: 'spreadsheet-todo.csv',
      fileRole: 'todo',
      rowNumber: 4,
    });
    assert.strictEqual(recurringPlan.kind, 'recurring');
    if (recurringPlan.kind === 'recurring') {
      assert.strictEqual(recurringPlan.config.description, 'Backup MailChimp mailing list to Google Drive');
      assert.strictEqual(recurringPlan.config.cronExpression, '0 9 * * 4');
    }

    const invalidDatePlan = planCsvRow(rows[4], {
      sourceFile: fixtureTodo,
      sourceLabel: 'spreadsheet-todo.csv',
      fileRole: 'todo',
      rowNumber: 6,
    });
    assert.deepStrictEqual(invalidDatePlan, {
      kind: 'skip',
      reason: 'invalid-date',
      sourceKey: invalidDatePlan.sourceKey,
      warnings: ['invalid date: 2026-99-99'],
    });

    const secret = redactUnsafeText('password=abc https://example.com/?access_token=abc');
    assert.strictEqual(secret.unsafe, true);
    assert.match(secret.text, /\[REDACTED_SECRET\]/);
    assert.match(secret.text, /\[REDACTED_URL\]/);
  });

  it('skips done history by default while still analyzing recurring patterns', () => {
    const rows = parseCSVFile(fixtureDone).slice(1);
    const recurringPlan = planCsvRow(rows[0], {
      sourceFile: fixtureDone,
      sourceLabel: 'spreadsheet-done.csv',
      fileRole: 'done',
      rowNumber: 2,
    });
    assert.strictEqual(recurringPlan.kind, 'recurring');

    const historyPlan = planCsvRow(rows[1], {
      sourceFile: fixtureDone,
      sourceLabel: 'spreadsheet-done.csv',
      fileRole: 'done',
      rowNumber: 3,
    });
    assert.strictEqual(historyPlan.kind, 'skip');
    if (historyPlan.kind === 'skip') {
      assert.strictEqual(historyPlan.reason, 'completed-history');
    }
  });

  it('imports fixture rows idempotently and keeps portable export valid', async () => {
    const port = await startLocal();
    const client = await getClient(port);
    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dataops-spreadsheet-export-'));
    try {
      await createTables(client);

      const firstReport = emptyCsvMigrationReport();
      await migrateCsvFile(client, fixtureTodo, 'todo', firstReport);
      await migrateCsvFile(client, fixtureDone, 'done', firstReport);
      assert.strictEqual(firstReport.stats.createdTasks, 5);
      assert.strictEqual(firstReport.stats.recurringConfigsCreated, 3);
      assert.strictEqual(firstReport.stats.completedRowsSkipped, 3);
      assert.strictEqual(firstReport.stats.validationErrors, 1);

      const secondReport = emptyCsvMigrationReport();
      await migrateCsvFile(client, fixtureTodo, 'todo', secondReport);
      await migrateCsvFile(client, fixtureDone, 'done', secondReport);
      assert.strictEqual(secondReport.stats.createdTasks, 0);
      assert.strictEqual(secondReport.stats.duplicateTasksSkipped, 5);
      assert.strictEqual(secondReport.stats.duplicateRecurringSkipped, 3);

      const todoTasks = await listTasksByStatus(client, 'todo');
      const waitingTasks = await listTasksByStatus(client, 'waiting');
      const recurringConfigs = await listRecurringConfigs(client);
      assert.strictEqual(todoTasks.length, 4);
      assert.strictEqual(waitingTasks.length, 1);
      assert.strictEqual(recurringConfigs.length, 3);
      assert.ok(todoTasks.some((task) => task.source === 'import' && task.comment?.includes('source_key=spreadsheet-todo:')));
      assert.ok(todoTasks.some((task) => task.comment?.includes('[REDACTED_SECRET]')));

      await writePortableExport(client, exportDir, {
        generatedAt: '2026-06-28T00:00:00.000Z',
        sourceEnvironment: 'test',
        sourceStack: 'test-stack',
        sourceRegion: 'eu-west-1',
        appGitSha: 'test-sha',
      });
      const validation = await validatePortableExport(exportDir);
      assert.strictEqual(validation.valid, true);
      const dryRun = await dryRunImport(exportDir);
      assert.strictEqual(dryRun.valid, true);
      assert.strictEqual(dryRun.wouldWrite.tasks, 5);
      assert.strictEqual(dryRun.wouldWrite.recurring_configs, 3);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
      await stopLocal();
    }
  });
});
