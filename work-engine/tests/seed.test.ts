import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listTemplates, instantiateTemplate } from '../src/db/templates';
import {
  seed,
  DEFAULT_TEMPLATES,
  NEWSLETTER_SOURCE_DOC_IDS,
  BOOK_OF_THE_WEEK_SOURCE_DOC_IDS,
  PODCAST_SOURCE_DOC_IDS,
  PODCAST_EXTERNAL_SOURCE_DOC_IDS,
  TAX_REPORT_SOURCE_DOC_IDS,
  OSS_SOURCE_DOC_IDS,
} from '../scripts/seed-templates';

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
    assert.deepStrictEqual(newsletter.phases!.map((phase) => phase.id), [
      'sponsor-intake',
      'draft-assembly',
      'send-prep',
      'publication',
      'promotion',
      'performance',
    ]);
    for (const docId of NEWSLETTER_SOURCE_DOC_IDS) {
      assert.ok(newsletter.sourceDocIds!.includes(docId), `Newsletter sourceDocIds should include ${docId}`);
    }

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
    assert.strictEqual(createSponsorship.instructionDocId, 'sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter');
    assert.strictEqual(createSponsorship.instructionStepId, undefined);
    assert.strictEqual(createSponsorship.requiredLinkName, 'Sponsorship document');
    assert.strictEqual(createSponsorship.phase, 'sponsor-intake');
    assert.deepStrictEqual(createSponsorship.proofRequirement, {
      type: 'url',
      label: 'Sponsorship document',
      required: true,
    });
    assert.deepStrictEqual((createSponsorship.validation as any).skipClosure.allowedStatuses, ['not sponsored this week']);

    const mailchimp = newsletter.taskDefinitions!.find((td) => td.refId === 'create-mailchimp-campaign');
    assert.ok(mailchimp);
    assert.strictEqual(mailchimp.instructionDocId, 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp');
    assert.strictEqual(mailchimp.instructionStepId, undefined);
    assert.strictEqual(mailchimp.requiredLinkName, 'Mailchimp newsletter');
    assert.deepStrictEqual(mailchimp.proofRequirement, {
      type: 'url',
      label: 'Mailchimp newsletter',
      required: true,
    });
    assert.strictEqual((mailchimp.validation as any).skipClosure, undefined);

    const sponsorEmail = newsletter.taskDefinitions!.find((td) => td.refId === 'email-sponsor');
    assert.ok(sponsorEmail);
    assert.strictEqual(sponsorEmail.instructionDocId, 'template.newsletter.send-sponsorship-document-2-weeks-before');
    assert.deepStrictEqual(sponsorEmail.proofRequirement, {
      type: 'comment',
      label: 'Email the sponsor with the sponsorship document - add Valeriia in communication confirmed',
      required: true,
    });
    assert.strictEqual((sponsorEmail.validation as any).waitingSemantics.waitingFor, 'sponsor content, graphics, or Valeriia review');
    assert.deepStrictEqual((sponsorEmail.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);
    assert.deepStrictEqual((sponsorEmail.validation as any).skipClosure.allowedStatuses, ['not sponsored this week']);
    assert.deepStrictEqual((sponsorEmail.validation as any).requiredBundleLinks, ['Sponsorship document']);

    const sponsoredBlock = newsletter.taskDefinitions!.find((td) => td.refId === 'fill-sponsored-block');
    assert.ok(sponsoredBlock);
    assert.strictEqual(sponsoredBlock.instructionDocId, 'sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter');
    assert.deepStrictEqual(sponsoredBlock.proofRequirement, {
      type: 'external-status',
      label: 'Sponsored block filled or issue confirmed unsponsored',
      required: true,
    });
    assert.strictEqual((sponsoredBlock.validation as any).waitingSemantics.waitingFor, 'approved sponsor copy, visual, and CTA');
    assert.deepStrictEqual((sponsoredBlock.validation as any).skipClosure.allowedStatuses, ['not sponsored this week']);
    assert.deepStrictEqual((sponsoredBlock.validation as any).requiredBundleLinks, ['Sponsorship document']);

    const bookBlock = newsletter.taskDefinitions!.find((td) => td.refId === 'fill-book-of-the-week-block');
    assert.ok(bookBlock);
    assert.strictEqual(bookBlock.instructionDocId, 'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block');
    assert.deepStrictEqual((bookBlock.validation as any).skipClosure.allowedStatuses, ['no book this week']);

    const eventBlock = newsletter.taskDefinitions!.find((td) => td.refId === 'fill-event-block');
    assert.ok(eventBlock);
    assert.strictEqual(eventBlock.instructionDocId, 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp');
    assert.deepStrictEqual((eventBlock.validation as any).skipClosure.allowedStatuses, ['no event block this week']);

    const articleBlock = newsletter.taskDefinitions!.find((td) => td.refId === 'fill-article-block');
    assert.ok(articleBlock);
    assert.strictEqual(articleBlock.instructionDocId, 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp');
    assert.deepStrictEqual((articleBlock.validation as any).skipClosure.allowedStatuses, ['no article block this week']);

    const scheduleNewsletter = newsletter.taskDefinitions!.find((td) => td.refId === 'schedule-email-newsletter');
    assert.ok(scheduleNewsletter);
    assert.strictEqual(scheduleNewsletter.instructionDocId, 'sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp');
    assert.strictEqual(scheduleNewsletter.stageOnComplete, 'announced');
    assert.deepStrictEqual(scheduleNewsletter.proofRequirement, {
      type: 'external-status',
      label: 'Mailchimp campaign scheduled',
      required: true,
    });
    assert.deepStrictEqual((scheduleNewsletter.validation as any).requiredBundleLinks, ['Mailchimp newsletter']);
    assert.strictEqual((scheduleNewsletter.validation as any).skipClosure, undefined);

    const invoice = newsletter.taskDefinitions!.find((td) => td.refId === 'create-invoice');
    assert.ok(invoice);
    assert.strictEqual(invoice.instructionDocId, 'sop.finance.bookkeeping.creating-invoices-in-finom');
    assert.strictEqual(invoice.requiresFile, true);
    assert.deepStrictEqual(invoice.proofRequirement, {
      type: 'file',
      label: 'Invoice PDF or invoice proof',
      required: true,
    });

    const linkedin = newsletter.taskDefinitions!.find((td) => td.refId === 'schedule-sponsorship-linkedin');
    assert.ok(linkedin);
    assert.strictEqual(linkedin.instructionDocId, 'sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content');
    assert.deepStrictEqual(linkedin.proofRequirement, { type: 'url', label: 'LinkedIn', required: true });
    assert.deepStrictEqual((linkedin.validation as any).skipClosure.allowedStatuses, ['not sponsored this week']);

    const twitter = newsletter.taskDefinitions!.find((td) => td.refId === 'schedule-sponsorship-twitter');
    assert.ok(twitter);
    assert.strictEqual(twitter.instructionDocId, 'sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content');
    assert.deepStrictEqual(twitter.proofRequirement, { type: 'url', label: 'X', required: true });

    const performance = newsletter.taskDefinitions!.find((td) => td.refId === 'add-newsletter-performance');
    assert.ok(performance);
    assert.strictEqual(performance.instructionDocId, 'sop.newsletter.mailchimp.filling-newsletter-statistics');
    assert.deepStrictEqual(performance.proofRequirement, {
      type: 'external-status',
      label: 'Newsletter, LinkedIn, and X performance stats recorded',
      required: true,
    });
    assert.deepStrictEqual((performance.validation as any).requiredBundleLinks, ['Mailchimp newsletter', 'LinkedIn', 'X']);
    assert.deepStrictEqual((performance.validation as any).skipClosure.suppresses['no social stats available'].bundleLinks, ['LinkedIn', 'X']);
    assert.strictEqual((performance.validation as any).skipClosure.suppresses['no social stats available'].proof, true);

    const done = newsletter.taskDefinitions!.find((td) => td.refId === 'send-performance-to-sponsor');
    assert.ok(done);
    assert.strictEqual(done.instructionDocId, 'template.newsletter.newsletter-performance');
    assert.strictEqual(done.stageOnComplete, 'done');
    assert.deepStrictEqual(done.proofRequirement, {
      type: 'comment',
      label: 'Send the performance of the newsletter to the sponsor confirmed',
      required: true,
    });
    assert.deepStrictEqual((done.validation as any).requiredBundleLinks, ['Mailchimp newsletter', 'LinkedIn', 'X']);
    assert.deepStrictEqual((done.validation as any).skipClosure.suppresses['not sponsored this week'].bundleLinks, ['*']);

    for (const td of newsletter.taskDefinitions!) {
      assert.ok(td.phase, `${td.refId} should declare a phase`);
      assert.ok(td.systems && td.systems.length > 0, `${td.refId} should declare systems`);
      assert.ok(td.proofRequirement, `${td.refId} should declare completion proof semantics`);
      assert.ok(td.validation && typeof td.validation === 'object', `${td.refId} should declare validation semantics`);
      assert.ok((td.validation as any).operatorAction, `${td.refId} should declare operator action`);
      assert.ok((td.validation as any).reminderSemantics, `${td.refId} should declare reminder semantics`);
      assert.ok((td.validation as any).dashboardStates, `${td.refId} should declare dashboard states`);
      assert.ok(td.instructionsUrl || td.instructionDocId, `${td.refId} should link operator instructions`);
    }
  });

  it('Newsletter template instantiates sample workflow tasks with V1 semantics', async () => {
    const templates = await listTemplates(client);
    const newsletter = templates.find((t) => t.type === 'newsletter');
    assert.ok(newsletter, 'Newsletter template should exist');

    const tasks = await instantiateTemplate(client, newsletter.id, 'bundle-newsletter-sample', '2026-07-20');
    assert.strictEqual(tasks.length, 15);

    const createSponsorship = tasks.find((task) => task.templateTaskRef === 'create-sponsorship-document');
    assert.ok(createSponsorship);
    assert.strictEqual(createSponsorship.date, '2026-07-06');
    assert.strictEqual(createSponsorship.phase, 'sponsor-intake');
    assert.strictEqual(createSponsorship.requiredLinkName, 'Sponsorship document');
    assert.deepStrictEqual(createSponsorship.proofRequirement, {
      type: 'url',
      label: 'Sponsorship document',
      required: true,
    });
    assert.deepStrictEqual((createSponsorship.validation as any).skipClosure.allowedStatuses, ['not sponsored this week']);

    const mailchimp = tasks.find((task) => task.templateTaskRef === 'create-mailchimp-campaign');
    assert.ok(mailchimp);
    assert.strictEqual(mailchimp.date, '2026-07-07');
    assert.strictEqual(mailchimp.instructionDocId, 'template.newsletter.create-newsletter-draft-from-template-in-mailchimp');
    assert.strictEqual(mailchimp.requiredLinkName, 'Mailchimp newsletter');

    const bookBlock = tasks.find((task) => task.templateTaskRef === 'fill-book-of-the-week-block');
    assert.ok(bookBlock);
    assert.strictEqual(bookBlock.date, '2026-07-09');
    assert.deepStrictEqual((bookBlock.validation as any).skipClosure.allowedStatuses, ['no book this week']);

    const schedule = tasks.find((task) => task.templateTaskRef === 'schedule-email-newsletter');
    assert.ok(schedule);
    assert.strictEqual(schedule.date, '2026-07-19');
    assert.strictEqual(schedule.stageOnComplete, 'announced');
    assert.deepStrictEqual(schedule.proofRequirement, {
      type: 'external-status',
      label: 'Mailchimp campaign scheduled',
      required: true,
    });

    const invoice = tasks.find((task) => task.templateTaskRef === 'create-invoice');
    assert.ok(invoice);
    assert.strictEqual(invoice.date, '2026-07-20');
    assert.strictEqual(invoice.requiresFile, true);
    assert.deepStrictEqual(invoice.proofRequirement, {
      type: 'file',
      label: 'Invoice PDF or invoice proof',
      required: true,
    });

    const sponsorLiveEmail = tasks.find((task) => task.templateTaskRef === 'send-email-sponsor-publication-live');
    assert.ok(sponsorLiveEmail);
    assert.strictEqual(sponsorLiveEmail.date, '2026-07-21');
    assert.deepStrictEqual((sponsorLiveEmail.validation as any).requiredBundleLinks, ['Mailchimp newsletter']);

    const linkedin = tasks.find((task) => task.templateTaskRef === 'schedule-sponsorship-linkedin');
    assert.ok(linkedin);
    assert.strictEqual(linkedin.date, '2026-07-22');
    assert.strictEqual(linkedin.requiredLinkName, 'LinkedIn');

    const twitter = tasks.find((task) => task.templateTaskRef === 'schedule-sponsorship-twitter');
    assert.ok(twitter);
    assert.strictEqual(twitter.date, '2026-07-23');
    assert.strictEqual(twitter.requiredLinkName, 'X');

    const performance = tasks.find((task) => task.templateTaskRef === 'add-newsletter-performance');
    assert.ok(performance);
    assert.strictEqual(performance.date, '2026-07-27');
    assert.deepStrictEqual((performance.validation as any).requiredBundleLinks, ['Mailchimp newsletter', 'LinkedIn', 'X']);

    const done = tasks.find((task) => task.templateTaskRef === 'send-performance-to-sponsor');
    assert.ok(done);
    assert.strictEqual(done.date, '2026-07-27');
    assert.strictEqual(done.stageOnComplete, 'done');
  });

  it('Podcast template has correct tasks with milestones', async () => {
    const templates = await listTemplates(client);
    const podcast = templates.find((t) => t.type === 'podcast');
    assert.ok(podcast, 'Podcast template should exist');
    assert.strictEqual(podcast.taskDefinitions!.length, 42);
    assert.ok(podcast.sourceDocIds!.includes('task-template.tasks.podcast'));
    assert.ok(podcast.sourceDocIds!.includes('sop.media.podcast.create-podcast-document'));
    assert.ok(podcast.sourceDocIds!.includes('assistant.podcast.process.podcast'));
    for (const docId of PODCAST_SOURCE_DOC_IDS) {
      assert.ok(podcast.sourceDocIds!.includes(docId), `Podcast sourceDocIds should include ${docId}`);
    }
    for (const externalDoc of PODCAST_EXTERNAL_SOURCE_DOC_IDS) {
      assert.ok(
        podcast.sourceDocIds!.includes(externalDoc.id),
        `Podcast sourceDocIds should preserve external assistant reference ${externalDoc.id}`
      );
      assert.ok(externalDoc.path.startsWith('assistants/podcast/'));
      assert.match(externalDoc.reason, /not indexed by the content registry/);
    }
    assert.strictEqual(podcast.triggerType, 'manual');
    assert.deepStrictEqual(podcast.phases!.map((phase) => phase.id), [
      'guest-intake',
      'prep-document',
      'event-setup',
      'pre-event-reminders',
      'live-stream',
      'post-production',
      'publication',
      'follow-up-archive',
    ]);

    const linkNames = podcast.bundleLinkDefinitions!.map((link) => link.name);
    for (const requiredLink of [
      'Guest email',
      'Podcast document',
      'Luma',
      'Meetup',
      'YouTube stream/video',
      'Transcription',
      'Spotify for Podcasters',
      'Public Spotify episode',
      'Apple Podcasts episode',
      'DTC webpage podcast link',
      'Dropbox recording folder',
      'Podcast banner or cover',
    ]) {
      assert.ok(linkNames.includes(requiredLink), `Podcast bundle should require ${requiredLink}`);
    }

    const createPodcastDocument = podcast.taskDefinitions!.find((td) => td.refId === 'create-podcast-document');
    assert.ok(createPodcastDocument);
    assert.strictEqual(createPodcastDocument.instructionDocId, 'sop.media.podcast.create-podcast-document');
    assert.strictEqual(createPodcastDocument.instructionStepId, '1');
    assert.strictEqual(createPodcastDocument.phase, 'prep-document');
    assert.deepStrictEqual(createPodcastDocument.proofRequirement, {
      type: 'url',
      label: 'Podcast document',
      required: true,
    });
    assert.deepStrictEqual(createPodcastDocument.artifactRefs, [
      {
        artifactId: 'artifact.dataops-podcast-draft',
        type: 'podcast-prep-draft',
        title: 'DataOps podcast assistant draft',
        status: 'planned',
      },
    ]);
    assert.deepStrictEqual(createPodcastDocument.assistantJobRefs, [
      {
        assistantJobId: 'assistant-job.podcast-prep-draft',
        assistantType: 'podcast',
        status: 'planned',
      },
    ]);

    // Check "Actual stream" milestone
    const actualStream = podcast.taskDefinitions!.find((td) => td.refId === 'actual-stream');
    assert.ok(actualStream);
    assert.strictEqual(actualStream.isMilestone, true);
    assert.strictEqual(actualStream.offsetDays, 0);
    assert.strictEqual(actualStream.stageOnComplete, 'after-event');
    assert.strictEqual(actualStream.requiredLinkName, 'YouTube stream/video');
    assert.deepStrictEqual(actualStream.proofRequirement, {
      type: 'url',
      label: 'YouTube stream/video',
      required: true,
    });

    // Check -7d reminder milestone
    const remind7d = podcast.taskDefinitions!.find((td) => td.refId === 'remind-guest-7d');
    assert.ok(remind7d);
    assert.strictEqual(remind7d.isMilestone, true);
    assert.strictEqual(remind7d.offsetDays, -7);
    assert.strictEqual((remind7d.validation as any).reminderSemantics.preEventReminder, true);

    // Check -1d reminder milestone
    const remind1d = podcast.taskDefinitions!.find((td) => td.refId === 'remind-guest-1d');
    assert.ok(remind1d);
    assert.strictEqual(remind1d.isMilestone, true);
    assert.strictEqual(remind1d.offsetDays, -1);
    assert.strictEqual((remind1d.validation as any).reminderSemantics.preEventReminder, true);

    // Check Alexey assignee on upload recording
    const upload = podcast.taskDefinitions!.find((td) => td.refId === 'upload-recording-dropbox');
    assert.ok(upload);
    assert.strictEqual(upload.assigneeId, ALEXEY_ID);
    assert.strictEqual(upload.requiredLinkName, 'Dropbox recording folder');

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

    for (const td of podcast.taskDefinitions!) {
      assert.ok(td.phase, `${td.refId} should declare a phase`);
      assert.ok(td.systems && td.systems.length > 0, `${td.refId} should declare systems`);
      assert.ok(td.proofRequirement, `${td.refId} should declare completion proof semantics`);
      assert.ok(td.validation && typeof td.validation === 'object', `${td.refId} should declare validation semantics`);
      assert.ok((td.validation as any).operatorAction, `${td.refId} should declare operator action`);
      assert.ok((td.validation as any).reminderSemantics, `${td.refId} should declare reminder semantics`);
      assert.ok((td.validation as any).dashboardStates, `${td.refId} should declare dashboard states`);
      assert.ok(td.instructionsUrl || td.instructionDocId, `${td.refId} should link operator instructions`);
    }
  });

  it('Podcast template instantiates sample workflow tasks with V1 semantics', async () => {
    const templates = await listTemplates(client);
    const podcast = templates.find((t) => t.type === 'podcast');
    assert.ok(podcast, 'Podcast template should exist');

    const tasks = await instantiateTemplate(client, podcast.id, 'bundle-podcast-sample', '2026-08-17');
    assert.strictEqual(tasks.length, 42);

    const createPodcastDocument = tasks.find((task) => task.templateTaskRef === 'create-podcast-document');
    assert.ok(createPodcastDocument);
    assert.strictEqual(createPodcastDocument.date, '2026-07-23');
    assert.strictEqual(createPodcastDocument.phase, 'prep-document');
    assert.strictEqual(createPodcastDocument.requiredLinkName, 'Podcast document');
    assert.deepStrictEqual(createPodcastDocument.proofRequirement, {
      type: 'url',
      label: 'Podcast document',
      required: true,
    });
    assert.deepStrictEqual(createPodcastDocument.artifactRefs, [
      {
        artifactId: 'artifact.dataops-podcast-draft',
        type: 'podcast-prep-draft',
        title: 'DataOps podcast assistant draft',
        status: 'planned',
      },
    ]);
    assert.deepStrictEqual(createPodcastDocument.assistantJobRefs, [
      {
        assistantJobId: 'assistant-job.podcast-prep-draft',
        assistantType: 'podcast',
        status: 'planned',
      },
    ]);

    const dateConfirmation = tasks.find((task) => task.templateTaskRef === 'agree-on-a-date');
    assert.ok(dateConfirmation);
    assert.strictEqual(dateConfirmation.date, '2026-07-22');
    assert.strictEqual((dateConfirmation.validation as any).waitingSemantics.waitingFor, 'guest date confirmation');
    assert.deepStrictEqual((dateConfirmation.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);

    const remind7d = tasks.find((task) => task.templateTaskRef === 'remind-guest-7d');
    assert.ok(remind7d);
    assert.strictEqual(remind7d.date, '2026-08-10');
    assert.strictEqual((remind7d.validation as any).reminderSemantics.preEventReminder, true);

    const actualStream = tasks.find((task) => task.templateTaskRef === 'actual-stream');
    assert.ok(actualStream);
    assert.strictEqual(actualStream.date, '2026-08-17');
    assert.strictEqual(actualStream.stageOnComplete, 'after-event');
    assert.strictEqual(actualStream.requiredLinkName, 'YouTube stream/video');

    const publish = tasks.find((task) => task.templateTaskRef === 'schedule-podcast-spotify');
    assert.ok(publish);
    assert.strictEqual(publish.date, '2026-08-21');
    assert.deepStrictEqual((publish.validation as any).requiredBundleLinks, [
      'Spotify for Podcasters',
      'Public Spotify episode',
      'Apple Podcasts episode',
    ]);

    const doneTask = tasks.find((task) => task.templateTaskRef === 'schedule-posts-guest-recommendations');
    assert.ok(doneTask);
    assert.strictEqual(doneTask.date, '2026-08-24');
    assert.strictEqual(doneTask.stageOnComplete, 'done');
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

  it('Tax Report template has operator-ready monthly proof metadata', async () => {
    const templates = await listTemplates(client);
    const taxReport = templates.find((t) => t.type === 'tax-report');
    assert.ok(taxReport);
    assert.strictEqual(taxReport.taskDefinitions!.length, 9);
    assert.strictEqual(taxReport.triggerType, 'automatic');
    assert.strictEqual(taxReport.triggerSchedule, '0 9 1 * *');
    assert.strictEqual(taxReport.triggerLeadDays, 0);
    assert.strictEqual(taxReport.defaultAssigneeId, GRACE_ID);
    assert.deepStrictEqual(taxReport.phases!.map((phase) => phase.id), [
      'report-intake',
      'reconciliation',
      'statements',
      'accountant-handoff',
      'cleanup',
    ]);
    for (const docId of TAX_REPORT_SOURCE_DOC_IDS) {
      assert.ok(taxReport.sourceDocIds!.includes(docId), `Tax Report sourceDocIds should include ${docId}`);
    }

    const linkNames = taxReport.bundleLinkDefinitions!.map((link) => link.name);
    assert.deepStrictEqual(linkNames, [
      'Monthly report/spreadsheet',
      'Accountant upload/share link',
      'Accountant email thread',
    ]);

    const refsAndOffsets = taxReport.taskDefinitions!.map((td) => [td.refId, td.offsetDays]);
    assert.deepStrictEqual(refsAndOffsets, [
      ['open-bookkeeping-report', 0],
      ['review-update-todos', 1],
      ['convert-currencies', 2],
      ['create-bank-statements-finom', 3],
      ['create-bank-statements-revolut', 3],
      ['cross-check-revolut-finom', 4],
      ['prepare-zip-send-accounting', 5],
      ['notify-accountants', 6],
      ['organize-invoices-folders', 7],
    ]);

    const openReport = taxReport.taskDefinitions!.find((td) => td.refId === 'open-bookkeeping-report');
    assert.ok(openReport);
    assert.strictEqual(openReport.requiredLinkName, 'Monthly report/spreadsheet');
    assert.strictEqual(openReport.instructionDocId, 'sop.finance.tax-reporting.monthly-tax-report');
    assert.strictEqual((openReport.validation as any).skipClosure.allowedStatuses[0], 'fixed monthly spreadsheet reused');
    assert.strictEqual((openReport.validation as any).skipClosure.suppresses['fixed monthly spreadsheet reused'].requiredLink, true);

    const reviewTodos = taxReport.taskDefinitions!.find((td) => td.refId === 'review-update-todos');
    assert.ok(reviewTodos);
    assert.strictEqual(reviewTodos.phase, 'reconciliation');
    assert.strictEqual(reviewTodos.instructionDocId, 'sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox');
    assert.deepStrictEqual(reviewTodos.proofRequirement, {
      type: 'external-status',
      label: 'No reportable transaction has unresolved TODO values; missing documents are listed',
      required: true,
    });
    assert.strictEqual((reviewTodos.validation as any).waitingSemantics.waitingFor, 'missing receipt, invoice, statement, owner clarification, or source document');

    const finom = taxReport.taskDefinitions!.find((td) => td.refId === 'create-bank-statements-finom');
    assert.ok(finom, 'Finom bank statement task should exist');
    assert.ok(finom.instructionsUrl, 'Finom task should have instructionsUrl');
    assert.ok(finom.instructionsUrl!.includes('198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU'));
    assert.strictEqual(finom.instructionDocId, 'sop.finance.bookkeeping.creating-bank-statements-in-finom');
    assert.strictEqual(finom.requiresFile, true);
    assert.deepStrictEqual(finom.proofRequirement, {
      type: 'file',
      label: 'Finom monthly statement file',
      required: true,
    });

    const revolut = taxReport.taskDefinitions!.find((td) => td.refId === 'create-bank-statements-revolut');
    assert.ok(revolut, 'Revolut bank statement task should exist');
    assert.ok(revolut.instructionsUrl, 'Revolut task should have instructionsUrl');
    assert.ok(revolut.instructionsUrl!.includes('1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q'));
    assert.strictEqual(revolut.instructionDocId, 'sop.finance.bookkeeping.creating-bank-statements-in-revolut');
    assert.strictEqual(revolut.requiresFile, true);
    assert.deepStrictEqual(revolut.proofRequirement, {
      type: 'file',
      label: 'Revolut monthly statement file',
      required: true,
    });

    assert.notStrictEqual(finom.instructionsUrl, revolut.instructionsUrl);

    const zip = taxReport.taskDefinitions!.find((td) => td.refId === 'prepare-zip-send-accounting');
    assert.ok(zip);
    assert.strictEqual(zip.requiresFile, true);
    assert.strictEqual(zip.requiredLinkName, 'Accountant upload/share link');
    assert.deepStrictEqual(zip.proofRequirement, {
      type: 'url',
      label: 'Accountant upload/share link',
      required: true,
    });
    assert.deepStrictEqual((zip.validation as any).requiredBundleLinks, ['Accountant upload/share link']);

    const notify = taxReport.taskDefinitions!.find((td) => td.refId === 'notify-accountants');
    assert.ok(notify);
    assert.strictEqual(notify.requiredLinkName, 'Accountant email thread');
    assert.strictEqual(notify.instructionDocId, 'sop.finance.bookkeeping.sending-reports-to-accountants-for-bookkeeping');
    assert.deepStrictEqual(notify.proofRequirement, {
      type: 'url',
      label: 'Accountant email thread',
      required: true,
    });
    assert.strictEqual((notify.validation as any).waitingSemantics.waitingFor, 'accountant acknowledgment or clarification');

    const done = taxReport.taskDefinitions!.find((td) => td.refId === 'organize-invoices-folders');
    assert.ok(done);
    assert.strictEqual(done.stageOnComplete, 'done');
    assert.strictEqual(done.instructionDocId, 'sop.finance.bookkeeping.preparing-a-zip-archive-with-invoices-and-send-reports-to-the-accountant');
    assert.deepStrictEqual((done.validation as any).requiredBundleLinks, [
      'Monthly report/spreadsheet',
      'Accountant upload/share link',
      'Accountant email thread',
    ]);

    for (const td of taxReport.taskDefinitions!) {
      assert.ok(td.phase, `${td.refId} should declare a phase`);
      assert.ok(td.systems && td.systems.length > 0, `${td.refId} should declare systems`);
      assert.ok(td.proofRequirement, `${td.refId} should declare completion proof semantics`);
      assert.ok(td.validation && typeof td.validation === 'object', `${td.refId} should declare validation semantics`);
      assert.ok((td.validation as any).operatorAction, `${td.refId} should declare operator action`);
      assert.ok((td.validation as any).reminderSemantics, `${td.refId} should declare reminder semantics`);
      assert.ok((td.validation as any).dashboardStates, `${td.refId} should declare dashboard states`);
      assert.ok((td.validation as any).dataSafety.noSensitiveFilesInGit, `${td.refId} should declare data safety`);
      assert.ok(td.instructionsUrl || td.instructionDocId, `${td.refId} should link operator instructions`);
    }
  });

  it('Tax Report template instantiates monthly due dates and completion gates', async () => {
    const templates = await listTemplates(client);
    const taxReport = templates.find((t) => t.type === 'tax-report');
    assert.ok(taxReport, 'Tax Report template should exist');

    const tasks = await instantiateTemplate(client, taxReport.id, 'bundle-tax-report-sample', '2026-09-01');
    assert.strictEqual(tasks.length, 9);

    const expectedDates: Record<string, string> = {
      'open-bookkeeping-report': '2026-09-01',
      'review-update-todos': '2026-09-02',
      'convert-currencies': '2026-09-03',
      'create-bank-statements-finom': '2026-09-04',
      'create-bank-statements-revolut': '2026-09-04',
      'cross-check-revolut-finom': '2026-09-05',
      'prepare-zip-send-accounting': '2026-09-06',
      'notify-accountants': '2026-09-07',
      'organize-invoices-folders': '2026-09-08',
    };
    for (const [ref, date] of Object.entries(expectedDates)) {
      const task = tasks.find((candidate) => candidate.templateTaskRef === ref);
      assert.ok(task, `${ref} should instantiate`);
      assert.strictEqual(task.date, date);
      assert.strictEqual(task.source, 'template');
      assert.ok(task.phase, `${ref} should preserve phase`);
      assert.ok(task.proofRequirement, `${ref} should preserve proofRequirement`);
    }

    const finom = tasks.find((task) => task.templateTaskRef === 'create-bank-statements-finom');
    assert.ok(finom);
    assert.strictEqual(finom.requiresFile, true);
    assert.deepStrictEqual(finom.proofRequirement, {
      type: 'file',
      label: 'Finom monthly statement file',
      required: true,
    });

    const zip = tasks.find((task) => task.templateTaskRef === 'prepare-zip-send-accounting');
    assert.ok(zip);
    assert.strictEqual(zip.requiresFile, true);
    assert.strictEqual(zip.requiredLinkName, 'Accountant upload/share link');

    const notify = tasks.find((task) => task.templateTaskRef === 'notify-accountants');
    assert.ok(notify);
    assert.strictEqual(notify.requiredLinkName, 'Accountant email thread');

    const done = tasks.find((task) => task.templateTaskRef === 'organize-invoices-folders');
    assert.ok(done);
    assert.strictEqual(done.stageOnComplete, 'done');
    assert.deepStrictEqual((done.validation as any).requiredBundleLinks, [
      'Monthly report/spreadsheet',
      'Accountant upload/share link',
      'Accountant email thread',
    ]);
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
    assert.strictEqual(botw.triggerType, 'manual');
    assert.deepStrictEqual(botw.phases!.map((phase) => [phase.id, phase.stage]), [
      ['author-outreach', 'preparation'],
      ['book-and-page-setup', 'preparation'],
      ['pre-event-promotion', 'preparation'],
      ['event-week', 'announced'],
      ['giveaway-closeout', 'after-event'],
    ]);
    for (const docId of BOOK_OF_THE_WEEK_SOURCE_DOC_IDS) {
      assert.ok(botw.sourceDocIds!.includes(docId), `Book of the Week sourceDocIds should include ${docId}`);
    }

    const linkNames = botw.bundleLinkDefinitions!.map((link) => link.name);
    for (const requiredLink of [
      'Author email',
      'Publisher or sponsor contact',
      'Book or publisher source link',
      'Website link',
      'LinkedIn announcement',
      'X announcement',
      'Slack announcement',
      'Author share proof',
      'Winner announcement',
      'Winner email handoff',
    ]) {
      assert.ok(linkNames.includes(requiredLink), `Book of the Week bundle should include ${requiredLink}`);
    }

    const newsletter = botw.taskDefinitions!.find((td) => td.refId === 'fill-newsletter-announcement');
    assert.ok(newsletter);
    assert.strictEqual(newsletter.offsetDays, -8);
    assert.strictEqual(newsletter.assigneeId, VALERIIA_ID);
    assert.strictEqual(newsletter.phase, 'pre-event-promotion');
    assert.strictEqual(newsletter.instructionDocId, 'sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block');

    for (const td of botw.taskDefinitions!) {
      assert.ok(td.phase, `${td.refId} should declare a phase`);
      assert.ok(td.systems && td.systems.length > 0, `${td.refId} should declare systems`);
      assert.ok(td.proofRequirement, `${td.refId} should declare completion proof semantics`);
      assert.ok(td.validation && typeof td.validation === 'object', `${td.refId} should declare validation semantics`);
      assert.ok((td.validation as any).operatorAction, `${td.refId} should declare operator action`);
      assert.ok((td.validation as any).reminderSemantics, `${td.refId} should declare reminder semantics`);
      assert.ok((td.validation as any).dashboardStates, `${td.refId} should declare dashboard states`);
      assert.ok(td.instructionsUrl || td.instructionDocId, `${td.refId} should link operator instructions`);
    }

    const waitingRefs = [
      'reach-out-to-book-authors',
      'agree-on-a-date',
      'remind-author-about-event',
      'ask-authors-share-event',
      'invite-author-to-slack',
      'authors-answer-questions',
      'collect-emails-from-winners',
      'contact-publisher-give-emails',
    ];
    for (const refId of waitingRefs) {
      const task = botw.taskDefinitions!.find((td) => td.refId === refId);
      assert.ok(task, `${refId} should exist`);
      assert.ok((task.validation as any).waitingSemantics, `${refId} should describe waiting semantics`);
      assert.deepStrictEqual((task.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);
    }

    const proofExpectations: Record<string, string> = {
      'create-web-page': 'Website link',
      'announce-event-linkedin': 'LinkedIn announcement',
      'announce-book-event-linkedin': 'LinkedIn announcement',
      'announce-book-event-twitter': 'X announcement',
      'announce-book-slack-channels': 'Slack announcement',
      'announce-winners-slack': 'Winner announcement',
      'contact-publisher-give-emails': 'Winner email handoff',
    };
    for (const [refId, requiredLinkName] of Object.entries(proofExpectations)) {
      const task = botw.taskDefinitions!.find((td) => td.refId === refId);
      assert.ok(task, `${refId} should exist`);
      assert.strictEqual(task.requiredLinkName, requiredLinkName);
      assert.deepStrictEqual(task.proofRequirement, {
        type: 'url',
        label: requiredLinkName,
        required: true,
      });
      assert.deepStrictEqual((task.validation as any).requiredBundleLinks, [requiredLinkName]);
    }

    const humanAcceptanceExpectations: Record<string, string> = {
      'fill-airtable-form-author': 'Airtable submission',
      'fill-airtable-form-book': 'Airtable submission',
      'create-web-page': 'Website publication',
      'announce-event-linkedin': 'LinkedIn',
      'announce-book-event-linkedin': 'LinkedIn',
      'comment-from-alexey-linkedin': "Alexey's LinkedIn account",
      'schedule-announcement-slack': 'Slack scheduling',
      'announce-book-slack-channels': 'Slack posting',
      'announce-winners-slack': 'Slack posting',
      'contact-publisher-give-emails': 'Publisher or author email handoff',
    };
    for (const [refId, expectedText] of Object.entries(humanAcceptanceExpectations)) {
      const task = botw.taskDefinitions!.find((td) => td.refId === refId);
      assert.ok(task, `${refId} should exist`);
      const acceptanceNote = (task.validation as any).acceptanceNote;
      assert.match(acceptanceNote, /\[HUMAN\]/, `${refId} should declare a human acceptance note`);
      assert.ok(acceptanceNote.includes(expectedText), `${refId} should mention ${expectedText}`);
    }

    const scheduleConfirmed = botw.taskDefinitions!.find((td) => td.refId === 'change-status-confirmed');
    assert.ok(scheduleConfirmed);
    assert.strictEqual(scheduleConfirmed.instructionDocId, 'sop.community.book-of-the-week.change-the-status-to-confirmed');
    assert.deepStrictEqual(scheduleConfirmed.proofRequirement, {
      type: 'external-status',
      label: 'Schedule spreadsheet status is confirmed',
      required: true,
    });

    const announced = botw.taskDefinitions!.find((td) => td.refId === 'announce-book-event-linkedin');
    assert.ok(announced);
    assert.strictEqual(announced.stageOnComplete, 'announced');

    const afterEvent = botw.taskDefinitions!.find((td) => td.refId === 'select-winners');
    assert.ok(afterEvent);
    assert.strictEqual(afterEvent.stageOnComplete, 'after-event');

    const done = botw.taskDefinitions!.find((td) => td.refId === 'contact-publisher-give-emails');
    assert.ok(done);
    assert.strictEqual(done.stageOnComplete, 'done');
  });

  it('Book of the Week template instantiates Monday anchor schedule with operator metadata', async () => {
    const templates = await listTemplates(client);
    const botw = templates.find((t) => t.type === 'book-of-the-week');
    assert.ok(botw);

    const tasks = await instantiateTemplate(client, botw.id, 'bundle-book-of-the-week-sample', '2026-07-06');
    assert.strictEqual(tasks.length, 21);

    const byRef = new Map(tasks.map((task) => [task.templateTaskRef, task]));
    assert.strictEqual(byRef.get('reach-out-to-book-authors')!.date, '2026-06-15');
    assert.strictEqual(byRef.get('agree-on-a-date')!.date, '2026-06-16');
    assert.strictEqual(byRef.get('change-status-confirmed')!.date, '2026-06-17');
    assert.strictEqual(byRef.get('fill-airtable-form-author')!.date, '2026-06-18');
    assert.strictEqual(byRef.get('fill-airtable-form-book')!.date, '2026-06-19');
    assert.strictEqual(byRef.get('create-web-page')!.date, '2026-06-20');
    assert.strictEqual(byRef.get('fill-newsletter-announcement')!.date, '2026-06-28');
    assert.strictEqual(byRef.get('announce-book-event-linkedin')!.date, '2026-07-06');
    assert.strictEqual(byRef.get('select-winners')!.date, '2026-07-10');
    assert.strictEqual(byRef.get('collect-emails-from-winners')!.date, '2026-07-11');
    assert.strictEqual(byRef.get('announce-winners-slack')!.date, '2026-07-12');
    assert.strictEqual(byRef.get('contact-publisher-give-emails')!.date, '2026-07-13');

    assert.strictEqual(byRef.get('reach-out-to-book-authors')!.assigneeId, GRACE_ID);
    assert.strictEqual(byRef.get('fill-newsletter-announcement')!.assigneeId, VALERIIA_ID);
    assert.strictEqual(byRef.get('create-web-page')!.requiredLinkName, 'Website link');
    assert.match((byRef.get('create-web-page')!.validation as any).acceptanceNote, /\[HUMAN\].*Website publication/);
    assert.match((byRef.get('fill-airtable-form-book')!.validation as any).acceptanceNote, /\[HUMAN\].*Airtable submission/);
    assert.deepStrictEqual(byRef.get('announce-book-slack-channels')!.proofRequirement, {
      type: 'url',
      label: 'Slack announcement',
      required: true,
    });
    assert.match((byRef.get('announce-book-slack-channels')!.validation as any).acceptanceNote, /\[HUMAN\].*Slack posting/);
    assert.strictEqual(byRef.get('announce-book-event-linkedin')!.stageOnComplete, 'announced');
    assert.strictEqual(byRef.get('select-winners')!.stageOnComplete, 'after-event');
    assert.strictEqual(byRef.get('contact-publisher-give-emails')!.stageOnComplete, 'done');
    assert.match((byRef.get('contact-publisher-give-emails')!.validation as any).acceptanceNote, /\[HUMAN\].*Publisher or author email handoff/);
    assert.strictEqual(byRef.get('invite-author-to-slack')!.instructionDocId, 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form');
    assert.deepStrictEqual((byRef.get('collect-emails-from-winners')!.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);
  });

  it('Open-Source Spotlight template has 14 task definitions', async () => {
    const templates = await listTemplates(client);
    const oss = templates.find((t) => t.type === 'oss');
    assert.ok(oss);
    assert.strictEqual(oss.taskDefinitions!.length, 14);
    assert.strictEqual(oss.emoji, '\u{2699}\u{FE0F}');
    assert.deepStrictEqual(oss.tags, ['Open-Source Spotlight']);
    assert.deepStrictEqual(oss.phases!.map((phase) => phase.id), [
      'lead-outreach',
      'recording-scheduling',
      'recording-intake',
      'video-production',
      'publication',
      'promotion-follow-up',
    ]);
    for (const docId of OSS_SOURCE_DOC_IDS) {
      assert.ok(oss.sourceDocIds!.includes(docId), `OSS sourceDocIds should include ${docId}`);
    }

    const linkNames = oss.bundleLinkDefinitions!.map((link) => link.name);
    assert.deepStrictEqual(linkNames, [
      'Guest email',
      'Tool GitHub',
      'Recording source',
      'YouTube',
      'Author review',
      'OSS playlist',
      'Social announcement',
    ]);
  });

  it('Open-Source Spotlight template maps operator proof, instructions, waiting, and stage semantics', async () => {
    const templates = await listTemplates(client);
    const oss = templates.find((t) => t.type === 'oss');
    assert.ok(oss);

    const outreach = oss.taskDefinitions!.find((td) => td.refId === 'reach-out-github-authors');
    assert.ok(outreach);
    assert.strictEqual(outreach.offsetDays, -21);
    assert.strictEqual(outreach.phase, 'lead-outreach');
    assert.strictEqual(outreach.instructionDocId, 'sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests');
    assert.deepStrictEqual(outreach.proofRequirement, {
      type: 'comment',
      label: 'Identify likely maintainers/contributors and start outreach from GitHub or community context confirmed',
      required: true,
    });
    assert.deepStrictEqual((outreach.validation as any).requiredBundleLinks, ['Tool GitHub']);
    assert.strictEqual((outreach.validation as any).waitingSemantics.waitingFor, 'author, maintainer, or project community reply');
    assert.deepStrictEqual((outreach.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);

    const author = oss.taskDefinitions!.find((td) => td.refId === 'reach-out-tool-author');
    assert.ok(author);
    assert.strictEqual(author.requiredLinkName, 'Guest email');
    assert.strictEqual(author.instructionDocId, 'template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool');
    assert.deepStrictEqual(author.proofRequirement, { type: 'url', label: 'Guest email', required: true });

    const youtubeDraft = oss.taskDefinitions!.find((td) => td.refId === 'download-upload-youtube');
    assert.ok(youtubeDraft);
    assert.strictEqual(youtubeDraft.requiredLinkName, 'YouTube');
    assert.strictEqual(
      youtubeDraft.instructionDocId,
      'reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube'
    );
    assert.deepStrictEqual((youtubeDraft.validation as any).requiredBundleLinks, ['Recording source', 'YouTube']);

    const review = oss.taskDefinitions!.find((td) => td.refId === 'ask-authors-review-codes');
    assert.ok(review);
    assert.strictEqual(review.instructionDocId, 'template.media.open-source-spotlight.oss-asking-for-revisions-and-links');
    assert.strictEqual((review.validation as any).waitingSemantics.waitingFor, 'author review, cut requests, or missing project links');
    assert.deepStrictEqual(review.proofRequirement, {
      type: 'comment',
      label: 'Author review request, timecodes, and link request sent',
      required: true,
    });

    const publication = oss.taskDefinitions!.find((td) => td.refId === 'schedule-youtube-video');
    assert.ok(publication);
    assert.strictEqual(publication.stageOnComplete, 'after-event');
    assert.strictEqual(publication.requiredLinkName, 'YouTube');
    assert.strictEqual(publication.instructionDocId, 'sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos');
    assert.deepStrictEqual(publication.proofRequirement, { type: 'url', label: 'YouTube', required: true });

    const social = oss.taskDefinitions!.find((td) => td.refId === 'schedule-social-media');
    assert.ok(social);
    assert.strictEqual(social.stageOnComplete, 'done');
    assert.strictEqual(social.requiredLinkName, 'Social announcement');
    assert.strictEqual(social.instructionDocId, 'reference.social-media.post-oss');
    assert.deepStrictEqual(social.proofRequirement, { type: 'url', label: 'Social announcement', required: true });
    assert.deepStrictEqual((social.validation as any).closureSemantics.requiredProof, ['Social announcement']);
  });

  it('Open-Source Spotlight instantiation preserves offsets and executable task metadata', async () => {
    const templates = await listTemplates(client);
    const oss = templates.find((t) => t.type === 'oss');
    assert.ok(oss);

    const tasks = await instantiateTemplate(client, oss.id, 'bundle-oss-operator-ready-1', '2026-07-22');
    assert.strictEqual(tasks.length, 14);

    const byRef = new Map(tasks.map((task) => [task.templateTaskRef, task]));
    assert.strictEqual(byRef.get('reach-out-github-authors')!.date, '2026-07-01');
    assert.strictEqual(byRef.get('reach-out-tool-author')!.date, '2026-07-02');
    assert.strictEqual(byRef.get('schedule-youtube-video')!.date, '2026-07-22');
    assert.strictEqual(byRef.get('tell-author-publish-date')!.date, '2026-07-22');
    assert.strictEqual(byRef.get('add-to-oss-playlist')!.date, '2026-07-23');
    assert.strictEqual(byRef.get('schedule-social-media')!.date, '2026-07-24');

    const youtubeDraft = byRef.get('download-upload-youtube')!;
    assert.strictEqual(youtubeDraft.requiredLinkName, 'YouTube');
    assert.deepStrictEqual(youtubeDraft.proofRequirement, { type: 'url', label: 'YouTube', required: true });
    assert.strictEqual(youtubeDraft.instructionDocId, 'reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube');
    assert.strictEqual(youtubeDraft.phase, 'recording-intake');

    const waiting = byRef.get('ask-authors-review-codes')!;
    assert.strictEqual((waiting.validation as any).waitingSemantics.waitingFor, 'author review, cut requests, or missing project links');
    assert.deepStrictEqual((waiting.validation as any).waitingSemantics.requires, ['waitingFor', 'followUpAt', 'comment']);

    const social = byRef.get('schedule-social-media')!;
    assert.strictEqual(social.stageOnComplete, 'done');
    assert.strictEqual(social.requiredLinkName, 'Social announcement');
    assert.deepStrictEqual(social.proofRequirement, { type: 'url', label: 'Social announcement', required: true });
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
