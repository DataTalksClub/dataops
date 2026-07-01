const { test, expect } = require('@playwright/test');

const GRACE_ID = '00000000-0000-0000-0000-000000000001';
const VALERIIA_ID = '00000000-0000-0000-0000-000000000002';
const ALEXEY_ID = '00000000-0000-0000-0000-000000000003';

// The 11 seeded template types
const SEEDED_TYPES = [
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
];

// The 11 seeded template names (unique to seeded data)
const SEEDED_NAMES = [
  'Newsletter',
  'Book of the Week',
  'Podcast',
  'Webinar',
  'Workshop',
  'Open-Source Spotlight',
  'Course',
  'Social Media Weekly',
  'Tax Report',
  'Maven Lightning Lesson',
  'Office Hours',
];

/**
 * Helper to fetch all templates and filter to only the seeded ones.
 * Seeded templates are identified by having both a known type AND defaultAssigneeId set to Grace.
 * Other E2E tests may create additional templates with the same type but without defaultAssigneeId.
 */
async function getSeededTemplates(request) {
  const res = await request.get('/api/templates');
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.templates.filter((t) =>
    SEEDED_TYPES.includes(t.type) && t.defaultAssigneeId === GRACE_ID
  );
}

/**
 * Helper to find a specific seeded template by name.
 */
function findSeeded(templates, name) {
  return templates.find((t) => t.name === name && t.defaultAssigneeId === GRACE_ID);
}

test.describe('Seed templates - all 11 templates (issue #21)', () => {

  // Scenario: Seed script creates all 11 templates
  test('GET /api/templates returns all 11 seeded templates with correct names and types', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    expect(templates.length).toBeGreaterThanOrEqual(11);

    const types = [...new Set(templates.map((t) => t.type))].sort();
    expect(types).toEqual(SEEDED_TYPES);

    const expectedNames = [
      'Book of the Week',
      'Course',
      'Maven Lightning Lesson',
      'Newsletter',
      'Office Hours',
      'Open-Source Spotlight',
      'Podcast',
      'Social Media Weekly',
      'Tax Report',
      'Webinar',
      'Workshop',
    ];

    for (const name of expectedNames) {
      expect(templates.some((t) => t.name === name)).toBe(true);
    }
  });

  // Scenario: Newsletter template has correct structure
  test('Newsletter template has correct type, emoji, tags, trigger, task definitions, references, and bundleLinkDefinitions', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    const newsletter = templates.find((t) => t.type === 'newsletter' && t.name === 'Newsletter');
    expect(newsletter).toBeTruthy();

    expect(newsletter.emoji).toBe('\u{1F4F0}');
    expect(newsletter.tags).toEqual(['Newsletter']);
    expect(newsletter.triggerType).toBe('automatic');
    expect(newsletter.triggerSchedule).toBe('0 9 * * 1');
    expect(newsletter.triggerLeadDays).toBe(14);
    expect(newsletter.defaultAssigneeId).toBe(GRACE_ID);
    expect(newsletter.taskDefinitions.length).toBe(15);

    // References
    expect(newsletter.references.length).toBeGreaterThanOrEqual(2);
    expect(newsletter.references.some((r) => r.name === 'Process documents')).toBe(true);

    // Bundle link definitions
    expect(newsletter.bundleLinkDefinitions.length).toBe(4);
    const linkNames = newsletter.bundleLinkDefinitions.map((l) => l.name);
    expect(linkNames).toContain('Sponsorship document');
    expect(linkNames).toContain('Mailchimp newsletter');
    expect(linkNames).toContain('LinkedIn');
    expect(linkNames).toContain('X');
  });

  // Scenario: Task definitions have instructionsUrl from templates.md
  test('Newsletter tasks have instructionsUrl, the create-sponsorship-document task has correct URL', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    const newsletter = templates.find((t) => t.type === 'newsletter' && t.name === 'Newsletter');

    const createSponsorship = newsletter.taskDefinitions.find((td) => td.refId === 'create-sponsorship-document');
    expect(createSponsorship).toBeTruthy();
    expect(createSponsorship.instructionsUrl).toContain('docs.google.com');
    expect(createSponsorship.requiredLinkName).toBe('Sponsorship document');

    // Check that most tasks have instructionsUrl
    const withInstructions = newsletter.taskDefinitions.filter((td) => td.instructionsUrl);
    expect(withInstructions.length).toBeGreaterThanOrEqual(14);
  });

  // Scenario: Podcast template has tasks with milestones
  test('Podcast template has correct tasks with milestones and assignee overrides', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    const podcast = templates.find((t) => t.type === 'podcast' && t.name === 'Podcast');
    expect(podcast).toBeTruthy();
    expect(podcast.taskDefinitions.length).toBe(42);

    // Actual stream milestone
    const actualStream = podcast.taskDefinitions.find((td) => td.refId === 'actual-stream');
    expect(actualStream).toBeTruthy();
    expect(actualStream.isMilestone).toBe(true);
    expect(actualStream.offsetDays).toBe(0);
    expect(actualStream.stageOnComplete).toBe('after-event');

    // Remind -7d milestone
    const remind7d = podcast.taskDefinitions.find((td) => td.refId === 'remind-guest-7d');
    expect(remind7d).toBeTruthy();
    expect(remind7d.isMilestone).toBe(true);
    expect(remind7d.offsetDays).toBe(-7);

    // Remind -1d milestone
    const remind1d = podcast.taskDefinitions.find((td) => td.refId === 'remind-guest-1d');
    expect(remind1d).toBeTruthy();
    expect(remind1d.isMilestone).toBe(true);
    expect(remind1d.offsetDays).toBe(-1);

    // Assignee overrides
    const upload = podcast.taskDefinitions.find((td) => td.refId === 'upload-recording-dropbox');
    expect(upload.assigneeId).toBe(ALEXEY_ID);

    const newsletterTask = podcast.taskDefinitions.find((td) => td.refId === 'add-podcast-webpage-newsletter');
    expect(newsletterTask.assigneeId).toBe(VALERIIA_ID);

    // +7d social media milestone
    const socialMedia = podcast.taskDefinitions.find((td) => td.refId === 'schedule-posts-guest-recommendations');
    expect(socialMedia.isMilestone).toBe(true);
    expect(socialMedia.offsetDays).toBe(7);
    expect(socialMedia.stageOnComplete).toBe('done');
  });

  // Scenario: Social Media Weekly template has all-milestone tasks
  test('Social Media Weekly template has 5 all-milestone tasks with days 0-4', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    const socialMedia = templates.find((t) => t.type === 'social-media' && t.name === 'Social Media Weekly');
    expect(socialMedia).toBeTruthy();
    expect(socialMedia.taskDefinitions.length).toBe(5);
    expect(socialMedia.triggerType).toBe('automatic');

    for (const td of socialMedia.taskDefinitions) {
      expect(td.isMilestone).toBe(true);
    }

    const offsets = socialMedia.taskDefinitions.map((td) => td.offsetDays).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 1, 2, 3, 4]);
  });

  // Scenario: Tax Report template splits bank statement task
  test('Tax Report template has 9 tasks with separate Finom and Revolut bank statement tasks', async ({ request }) => {
    const templates = await getSeededTemplates(request);
    const taxReport = templates.find((t) => t.type === 'tax-report' && t.name === 'Tax Report');
    expect(taxReport).toBeTruthy();
    expect(taxReport.taskDefinitions.length).toBe(9);

    const finom = taxReport.taskDefinitions.find((td) => td.refId === 'create-bank-statements-finom');
    expect(finom).toBeTruthy();
    expect(finom.instructionsUrl).toContain('198F0Z2auEkvRGHXgD5k2zYx7Cjk2mW6sUHuGeNspsYU');
    expect(finom.requiresFile).toBe(true);

    const revolut = taxReport.taskDefinitions.find((td) => td.refId === 'create-bank-statements-revolut');
    expect(revolut).toBeTruthy();
    expect(revolut.instructionsUrl).toContain('1gzRoauqf8UVmJogYV4VphrgADesOrBpFSkOc-8uTq4Q');
    expect(revolut.requiresFile).toBe(true);

    expect(finom.instructionsUrl).not.toBe(revolut.instructionsUrl);
  });

  // Scenario: Templates with assignee overrides use correct user IDs
  test('Tasks marked with assignee overrides have correct user IDs', async ({ request }) => {
    const templates = await getSeededTemplates(request);

    // Newsletter: Valeriia on content blocks
    const newsletter = templates.find((t) => t.type === 'newsletter' && t.name === 'Newsletter');
    const bookBlock = newsletter.taskDefinitions.find((td) => td.refId === 'fill-book-of-the-week-block');
    expect(bookBlock.assigneeId).toBe(VALERIIA_ID);

    // Podcast: Alexey on recording upload
    const podcast = templates.find((t) => t.type === 'podcast' && t.name === 'Podcast');
    const uploadRec = podcast.taskDefinitions.find((td) => td.refId === 'upload-recording-dropbox');
    expect(uploadRec.assigneeId).toBe(ALEXEY_ID);

    // Office Hours: Alexey on Zoom video link
    const officeHours = templates.find((t) => t.type === 'office-hours' && t.name === 'Office Hours');
    const zoomLink = officeHours.taskDefinitions.find((td) => td.refId === 'alexey-send-zoom-link');
    expect(zoomLink.assigneeId).toBe(ALEXEY_ID);

    // Maven LL: Alexey on content sending
    const mavenLL = templates.find((t) => t.type === 'maven-ll' && t.name === 'Maven Lightning Lesson');
    const sendContent = mavenLL.taskDefinitions.find((td) => td.refId === 'alexey-send-content');
    expect(sendContent.assigneeId).toBe(ALEXEY_ID);

    // Course: Valeriia on description prep
    const course = templates.find((t) => t.type === 'course' && t.name === 'Course');
    const prepDesc = course.taskDefinitions.find((td) => td.refId === 'prepare-description-event');
    expect(prepDesc.assigneeId).toBe(VALERIIA_ID);
  });

  // Scenario: All seeded templates have defaultAssigneeId set to Grace
  test('All 11 seeded templates have defaultAssigneeId set to Grace', async ({ request }) => {
    const templates = await getSeededTemplates(request);

    // Filter to only seeded templates by name
    const seededNames = [
      'Newsletter', 'Book of the Week', 'Podcast', 'Webinar', 'Workshop',
      'Open-Source Spotlight', 'Course', 'Social Media Weekly', 'Tax Report',
      'Maven Lightning Lesson', 'Office Hours',
    ];

    for (const name of seededNames) {
      const t = templates.find((tmpl) => tmpl.name === name);
      expect(t).toBeTruthy();
      expect(t.defaultAssigneeId).toBe(GRACE_ID);
    }
  });

  // Scenario: Automatic templates have correct trigger configuration
  test('Automatic templates have correct trigger configuration', async ({ request }) => {
    const templates = await getSeededTemplates(request);

    const newsletter = templates.find((t) => t.type === 'newsletter' && t.name === 'Newsletter');
    expect(newsletter.triggerType).toBe('automatic');
    expect(newsletter.triggerSchedule).toBe('0 9 * * 1');
    expect(newsletter.triggerLeadDays).toBe(14);

    const socialMedia = templates.find((t) => t.type === 'social-media' && t.name === 'Social Media Weekly');
    expect(socialMedia.triggerType).toBe('automatic');
    expect(socialMedia.triggerSchedule).toBe('0 9 * * 5');
    expect(socialMedia.triggerLeadDays).toBe(0);

    const taxReport = templates.find((t) => t.type === 'tax-report' && t.name === 'Tax Report');
    expect(taxReport.triggerType).toBe('automatic');
    expect(taxReport.triggerSchedule).toBe('0 9 1 * *');
    expect(taxReport.triggerLeadDays).toBe(0);
  });

  // Scenario: Each template has correct type, emoji, and tags
  test('Each seeded template has correct type, emoji, and tags', async ({ request }) => {
    const templates = await getSeededTemplates(request);

    const expected = {
      Newsletter: { type: 'newsletter', emoji: '\u{1F4F0}', tags: ['Newsletter'] },
      'Book of the Week': { type: 'book-of-the-week', emoji: '\u{1F4DA}', tags: ['Book of the Week'] },
      Podcast: { type: 'podcast', emoji: '\u{1F399}\u{FE0F}', tags: ['Podcast'] },
      Webinar: { type: 'webinar', emoji: '\u{1F4FA}', tags: ['Webinar'] },
      Workshop: { type: 'workshop', emoji: '\u{1F527}', tags: ['Workshop'] },
      'Open-Source Spotlight': { type: 'oss', emoji: '\u{2699}\u{FE0F}', tags: ['Open-Source Spotlight'] },
      Course: { type: 'course', emoji: '\u{1F393}', tags: ['Course'] },
      'Social Media Weekly': { type: 'social-media', emoji: '\u{1F4F1}', tags: ['Social media'] },
      'Tax Report': { type: 'tax-report', emoji: '', tags: ['Tax', 'Finance'] },
      'Maven Lightning Lesson': { type: 'maven-ll', emoji: '\u{1F4FA}', tags: ['Maven', 'Maven Lightning Lesson'] },
      'Office Hours': { type: 'office-hours', emoji: '\u{1F4FA}', tags: ['Office Hours'] },
    };

    for (const [name, exp] of Object.entries(expected)) {
      const t = templates.find((tmpl) => tmpl.name === name);
      expect(t).toBeTruthy();
      expect(t.type).toBe(exp.type);
      expect(t.emoji).toBe(exp.emoji);
      expect(t.tags).toEqual(exp.tags);
    }
  });

  // Scenario: Seed script is idempotent (consistent seeded data)
  test('Seeded templates are consistently available across requests', async ({ request }) => {
    const templates1 = await getSeededTemplates(request);
    const seededNames1 = templates1.filter((t) =>
      ['Newsletter', 'Podcast', 'Tax Report'].includes(t.name)
    );
    expect(seededNames1.length).toBe(3);

    const templates2 = await getSeededTemplates(request);
    const seededNames2 = templates2.filter((t) =>
      ['Newsletter', 'Podcast', 'Tax Report'].includes(t.name)
    );
    expect(seededNames2.length).toBe(3);

    // IDs should be the same (not re-created)
    for (const name of ['Newsletter', 'Podcast', 'Tax Report']) {
      const t1 = seededNames1.find((t) => t.name === name);
      const t2 = seededNames2.find((t) => t.name === name);
      expect(t1.id).toBe(t2.id);
    }
  });
});
