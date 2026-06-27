import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listTemplates } from '../src/db/templates';
import { seed, DEFAULT_TEMPLATES } from '../scripts/seed-templates';

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';
const ALEXEY_ID = '00000000-0000-0000-0000-000000000003';

describe('Seed script', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('creates 11 default templates when none exist', async () => {
    const beforeList = await listTemplates(client);
    assert.strictEqual(beforeList.length, 0);

    await seed();

    const afterList = await listTemplates(client);
    assert.strictEqual(afterList.length, 11);

    const types = afterList.map((t) => t.type).sort();
    assert.deepStrictEqual(types, [
      'book-of-the-week',
      'course',
      'maven-ll',
      'newsletter',
      'office-hours',
      'oss',
      'podcast',
      'social-media',
      'tax-report',
      'webinar',
      'workshop',
    ]);
  });

  it('is idempotent — running seed twice does not duplicate templates', async () => {
    const beforeSecondRun = await listTemplates(client);
    const countBefore = beforeSecondRun.length;
    assert.ok(countBefore > 0, 'Templates should already exist from previous test');

    await seed();

    const afterSecondRun = await listTemplates(client);
    assert.strictEqual(afterSecondRun.length, countBefore, 'Template count should not change after second seed');
  });

  it('force flag deletes and recreates templates', async () => {
    const beforeForce = await listTemplates(client);
    const originalIds = beforeForce.map((t) => t.id).sort();
    assert.strictEqual(beforeForce.length, 11);

    await seed(true);

    const afterForce = await listTemplates(client);
    assert.strictEqual(afterForce.length, 11, 'Should still have 11 templates after force re-seed');

    const newIds = afterForce.map((t) => t.id).sort();
    assert.notDeepStrictEqual(newIds, originalIds, 'Template IDs should differ after force re-seed');
  });

  it('Newsletter template has correct structure', async () => {
    const templates = await listTemplates(client);
    const newsletter = templates.find((t) => t.type === 'newsletter');
    assert.ok(newsletter, 'Newsletter template should exist');

    assert.strictEqual(newsletter.name, 'Newsletter');
    assert.strictEqual(newsletter.emoji, '\u{1F4F0}');
    assert.deepStrictEqual(newsletter.tags, ['Newsletter']);
    assert.strictEqual(newsletter.triggerType, 'automatic');
    assert.strictEqual(newsletter.triggerSchedule, '0 9 * * 1');
    assert.strictEqual(newsletter.triggerLeadDays, 14);
    assert.strictEqual(newsletter.defaultAssigneeId, GRACE_ID);
    assert.strictEqual(newsletter.taskDefinitions!.length, 15);

    // Check references
    assert.ok(newsletter.references!.length >= 2, 'Should have at least 2 references');
    assert.ok(newsletter.references!.some((r) => r.name === 'Process documents'));

    // Check bundleLinkDefinitions
    assert.strictEqual(newsletter.bundleLinkDefinitions!.length, 4);
    const linkNames = newsletter.bundleLinkDefinitions!.map((l) => l.name);
    assert.ok(linkNames.includes('Sponsorship document'));
    assert.ok(linkNames.includes('Mailchimp newsletter'));
    assert.ok(linkNames.includes('LinkedIn'));
    assert.ok(linkNames.includes('X'));

    // Check first task has instructionsUrl
    const createSponsorship = newsletter.taskDefinitions!.find((td) => td.refId === 'create-sponsorship-document');
    assert.ok(createSponsorship, 'create-sponsorship-document task should exist');
    assert.ok(createSponsorship.instructionsUrl, 'Should have instructionsUrl');
    assert.ok(createSponsorship.instructionsUrl!.includes('docs.google.com'));
    assert.strictEqual(createSponsorship.requiredLinkName, 'Sponsorship document');
  });

  it('Podcast template has correct tasks with milestones', async () => {
    const templates = await listTemplates(client);
    const podcast = templates.find((t) => t.type === 'podcast');
    assert.ok(podcast, 'Podcast template should exist');
    assert.strictEqual(podcast.taskDefinitions!.length, 42);

    // Check "Actual stream" milestone
    const actualStream = podcast.taskDefinitions!.find((td) => td.refId === 'actual-stream');
    assert.ok(actualStream);
    assert.strictEqual(actualStream.isMilestone, true);
    assert.strictEqual(actualStream.offsetDays, 0);
    assert.strictEqual(actualStream.stageOnComplete, 'after-event');
    assert.strictEqual(actualStream.requiredLinkName, 'Youtube');

    // Check -7d reminder milestone
    const remind7d = podcast.taskDefinitions!.find((td) => td.refId === 'remind-guest-7d');
    assert.ok(remind7d);
    assert.strictEqual(remind7d.isMilestone, true);
    assert.strictEqual(remind7d.offsetDays, -7);

    // Check -1d reminder milestone
    const remind1d = podcast.taskDefinitions!.find((td) => td.refId === 'remind-guest-1d');
    assert.ok(remind1d);
    assert.strictEqual(remind1d.isMilestone, true);
    assert.strictEqual(remind1d.offsetDays, -1);

    // Check Alexey assignee on upload recording
    const upload = podcast.taskDefinitions!.find((td) => td.refId === 'upload-recording-dropbox');
    assert.ok(upload);
    assert.strictEqual(upload.assigneeId, ALEXEY_ID);

    // Check Valeriia assignee on newsletter task
    const newsletter = podcast.taskDefinitions!.find((td) => td.refId === 'add-podcast-webpage-newsletter');
    assert.ok(newsletter);
    assert.strictEqual(newsletter.assigneeId, VALERIIA_ID);

    // Check +7d social media milestone
    const socialMedia = podcast.taskDefinitions!.find((td) => td.refId === 'schedule-posts-guest-recommendations');
    assert.ok(socialMedia);
    assert.strictEqual(socialMedia.isMilestone, true);
    assert.strictEqual(socialMedia.offsetDays, 7);
    assert.strictEqual(socialMedia.stageOnComplete, 'done');
  });

  it('Social Media Weekly template has all-milestone tasks', async () => {
    const templates = await listTemplates(client);
    const socialMedia = templates.find((t) => t.type === 'social-media');
    assert.ok(socialMedia);
    assert.strictEqual(socialMedia.taskDefinitions!.length, 5);

    // All tasks should be milestones
    for (const td of socialMedia.taskDefinitions!) {
      assert.strictEqual(td.isMilestone, true, `Task ${td.refId} should be a milestone`);
    }

    // Check offset days 0-4 (Mon-Fri)
    const offsets = socialMedia.taskDefinitions!.map((td) => td.offsetDays).sort((a, b) => a - b);
    assert.deepStrictEqual(offsets, [0, 1, 2, 3, 4]);

    assert.strictEqual(socialMedia.triggerType, 'automatic');
  });

  it('Tax Report template splits bank statement task into two', async () => {
    const templates = await listTemplates(client);
    const taxReport = templates.find((t) => t.type === 'tax-report');
    assert.ok(taxReport);
    assert.strictEqual(taxReport.taskDefinitions!.length, 9);

    const finom = taxReport.taskDefinitions!.find((td) => td.refId === 'create-bank-statements-finom');
    assert.ok(finom, 'Finom bank statement task should exist');
    assert.ok(finom.instructionsUrl, 'Finom task should have instructionsUrl');
    assert.ok(finom.instructionsUrl!.includes('198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU'));
    assert.strictEqual(finom.requiresFile, true);

    const revolut = taxReport.taskDefinitions!.find((td) => td.refId === 'create-bank-statements-revolut');
    assert.ok(revolut, 'Revolut bank statement task should exist');
    assert.ok(revolut.instructionsUrl, 'Revolut task should have instructionsUrl');
    assert.ok(revolut.instructionsUrl!.includes('1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q'));
    assert.strictEqual(revolut.requiresFile, true);

    // Finom and Revolut should have different instructionsUrls
    assert.notStrictEqual(finom.instructionsUrl, revolut.instructionsUrl);
  });

  it('templates with assignee overrides use correct user IDs', async () => {
    const templates = await listTemplates(client);

    // Newsletter: Valeriia on content blocks
    const newsletter = templates.find((t) => t.type === 'newsletter');
    const bookBlock = newsletter!.taskDefinitions!.find((td) => td.refId === 'fill-book-of-the-week-block');
    assert.strictEqual(bookBlock!.assigneeId, VALERIIA_ID);

    // Podcast: Alexey on recording upload
    const podcast = templates.find((t) => t.type === 'podcast');
    const uploadRec = podcast!.taskDefinitions!.find((td) => td.refId === 'upload-recording-dropbox');
    assert.strictEqual(uploadRec!.assigneeId, ALEXEY_ID);

    // Office Hours: Alexey on Zoom video link
    const officeHours = templates.find((t) => t.type === 'office-hours');
    const zoomLink = officeHours!.taskDefinitions!.find((td) => td.refId === 'alexey-send-zoom-link');
    assert.strictEqual(zoomLink!.assigneeId, ALEXEY_ID);

    // Maven LL: Alexey on content sending
    const mavenLL = templates.find((t) => t.type === 'maven-ll');
    const sendContent = mavenLL!.taskDefinitions!.find((td) => td.refId === 'alexey-send-content');
    assert.strictEqual(sendContent!.assigneeId, ALEXEY_ID);

    // Course: Valeriia on description prep
    const course = templates.find((t) => t.type === 'course');
    const prepDesc = course!.taskDefinitions!.find((td) => td.refId === 'prepare-description-event');
    assert.strictEqual(prepDesc!.assigneeId, VALERIIA_ID);
  });

  it('all templates have defaultAssigneeId set to Grace', async () => {
    const templates = await listTemplates(client);
    for (const t of templates) {
      assert.strictEqual(t.defaultAssigneeId, GRACE_ID, `Template ${t.name} should have defaultAssigneeId set to Grace`);
    }
  });

  it('DEFAULT_TEMPLATES has all 11 entries with correct task counts', () => {
    assert.strictEqual(DEFAULT_TEMPLATES.length, 11);

    const expected: Record<string, number> = {
      newsletter: 15,
      'book-of-the-week': 21,
      podcast: 42,
      webinar: 32,
      workshop: 36,
      oss: 14,
      course: 8,
      'social-media': 5,
      'tax-report': 9,
      'maven-ll': 7,
      'office-hours': 5,
    };

    for (const tmpl of DEFAULT_TEMPLATES) {
      const expectedCount = expected[tmpl.type];
      assert.ok(expectedCount !== undefined, `Unknown template type: ${tmpl.type}`);
      assert.strictEqual(
        tmpl.taskDefinitions.length,
        expectedCount,
        `${tmpl.type} should have ${expectedCount} tasks but has ${tmpl.taskDefinitions.length}`
      );
    }
  });

  it('requiresFile is set on tasks that produce file deliverables', async () => {
    const templates = await listTemplates(client);

    // Newsletter: Create an Invoice
    const newsletter = templates.find((t) => t.type === 'newsletter');
    const invoice = newsletter!.taskDefinitions!.find((td) => td.refId === 'create-invoice');
    assert.strictEqual(invoice!.requiresFile, true);

    // Podcast: Create a banner
    const podcast = templates.find((t) => t.type === 'podcast');
    const banner = podcast!.taskDefinitions!.find((td) => td.refId === 'create-banner-figma');
    assert.strictEqual(banner!.requiresFile, true);

    // Tax Report: zip archive
    const taxReport = templates.find((t) => t.type === 'tax-report');
    const zip = taxReport!.taskDefinitions!.find((td) => td.refId === 'prepare-zip-send-accounting');
    assert.strictEqual(zip!.requiresFile, true);
  });

  it('trigger configuration is correct for automatic templates', async () => {
    const templates = await listTemplates(client);

    const newsletter = templates.find((t) => t.type === 'newsletter');
    assert.strictEqual(newsletter!.triggerType, 'automatic');
    assert.strictEqual(newsletter!.triggerSchedule, '0 9 * * 1');
    assert.strictEqual(newsletter!.triggerLeadDays, 14);

    const socialMedia = templates.find((t) => t.type === 'social-media');
    assert.strictEqual(socialMedia!.triggerType, 'automatic');
    assert.strictEqual(socialMedia!.triggerSchedule, '0 9 * * 5');
    assert.strictEqual(socialMedia!.triggerLeadDays, 0);

    const taxReport = templates.find((t) => t.type === 'tax-report');
    assert.strictEqual(taxReport!.triggerType, 'automatic');
    assert.strictEqual(taxReport!.triggerSchedule, '0 9 1 * *');
    assert.strictEqual(taxReport!.triggerLeadDays, 0);
  });

  it('Webinar template has correct task definitions', async () => {
    const templates = await listTemplates(client);
    const webinar = templates.find((t) => t.type === 'webinar');
    assert.ok(webinar);
    assert.strictEqual(webinar.taskDefinitions!.length, 32);
    assert.strictEqual(webinar.emoji, '\u{1F4FA}');
    assert.deepStrictEqual(webinar.tags, ['Webinar']);
  });

  it('Workshop template has correct task definitions with invoice tasks', async () => {
    const templates = await listTemplates(client);
    const workshop = templates.find((t) => t.type === 'workshop');
    assert.ok(workshop);
    assert.strictEqual(workshop.taskDefinitions!.length, 36);

    const invoiceTask = workshop.taskDefinitions!.find((td) => td.refId === 'prepare-send-invoice');
    assert.ok(invoiceTask);
    assert.strictEqual(invoiceTask.requiresFile, true);

    const checkInvoice = workshop.taskDefinitions!.find((td) => td.refId === 'check-invoice-paid');
    assert.ok(checkInvoice);
  });

  it('Book of the Week template has correct task definitions', async () => {
    const templates = await listTemplates(client);
    const botw = templates.find((t) => t.type === 'book-of-the-week');
    assert.ok(botw);
    assert.strictEqual(botw.taskDefinitions!.length, 21);
    assert.strictEqual(botw.emoji, '\u{1F4DA}');
    assert.deepStrictEqual(botw.tags, ['Book of the Week']);
  });

  it('Open-Source Spotlight template has 14 task definitions', async () => {
    const templates = await listTemplates(client);
    const oss = templates.find((t) => t.type === 'oss');
    assert.ok(oss);
    assert.strictEqual(oss.taskDefinitions!.length, 14);
    assert.strictEqual(oss.emoji, '\u{2699}\u{FE0F}');
    assert.deepStrictEqual(oss.tags, ['Open-Source Spotlight']);
  });

  it('Maven Lightning Lesson template has 7 task definitions', async () => {
    const templates = await listTemplates(client);
    const maven = templates.find((t) => t.type === 'maven-ll');
    assert.ok(maven);
    assert.strictEqual(maven.taskDefinitions!.length, 7);
    assert.strictEqual(maven.emoji, '\u{1F4FA}');
    assert.deepStrictEqual(maven.tags, ['Maven', 'Maven Lightning Lesson']);
  });

  it('Office Hours template has 5 task definitions', async () => {
    const templates = await listTemplates(client);
    const oh = templates.find((t) => t.type === 'office-hours');
    assert.ok(oh);
    assert.strictEqual(oh.taskDefinitions!.length, 5);
    assert.strictEqual(oh.emoji, '\u{1F4FA}');
    assert.deepStrictEqual(oh.tags, ['Office Hours']);
  });
});
