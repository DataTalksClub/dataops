import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCardTitle, planCardStructureUpdate, templateTypeForTag } from '../src/cards/cardTitleStructure';

describe('card title structure', () => {
  it('maps known tags to template types', () => {
    assert.strictEqual(templateTypeForTag('Newsletter'), 'newsletter');
    assert.strictEqual(templateTypeForTag('Podcast'), 'podcast');
    assert.strictEqual(templateTypeForTag('Webinar'), 'webinar');
    assert.strictEqual(templateTypeForTag('Workshop'), 'workshop');
    assert.strictEqual(templateTypeForTag('Book of the Week'), 'book-of-the-week');
    assert.strictEqual(templateTypeForTag('Open-Source Spotlight'), 'oss');
    assert.strictEqual(templateTypeForTag('Social media'), 'social-media');
    assert.strictEqual(templateTypeForTag('Maven LL'), 'maven-ll');
    assert.strictEqual(templateTypeForTag('Office Hours'), 'office-hours');
    assert.strictEqual(templateTypeForTag('Course'), 'course');
    assert.strictEqual(templateTypeForTag('Tax Report'), 'tax-report');
    assert.strictEqual(templateTypeForTag('Random'), null);
  });

  it('parses newsletter titles into tag, date, and clean title', () => {
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #294(14 SEP 2026) -Astronomer'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-09-14',
      cleanTitle: 'Weekly email #294 - Astronomer',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #298(20OCT 2026) -Astronomer'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-10-20',
      cleanTitle: 'Weekly email #298 - Astronomer',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #Secondary(07DEC 2026) -Snowplow'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-12-07',
      cleanTitle: 'Weekly email #Secondary - Snowplow',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #291(24  AUG 2026) -Meritmap'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-08-24',
      cleanTitle: 'Weekly email #291 - Meritmap',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email Stand-Alone(04 NOV 2026) -Snowplow'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-11-04',
      cleanTitle: 'Weekly email Stand-Alone - Snowplow',
    });
  });

  it('parses event titles into tag, date, and clean title', () => {
    assert.deepStrictEqual(
      parseCardTitle('[Podcast] 2026-AUG-17 - The Data Consultant Playbook - Tony Zeljkovic'),
      {
        tag: 'Podcast',
        templateType: 'podcast',
        date: '2026-08-17',
        cleanTitle: 'The Data Consultant Playbook - Tony Zeljkovic',
      },
    );
    assert.deepStrictEqual(parseCardTitle('[Webinar] 2026-SEPT-07-Topic- Daan Di Scala'), {
      tag: 'Webinar',
      templateType: 'webinar',
      date: '2026-09-07',
      cleanTitle: 'Topic - Daan Di Scala',
    });
    assert.deepStrictEqual(
      parseCardTitle('[Workshop] 2026-AUG-18 -Running Durable Agents in Production-Nicholas Lotz (Orkes)'),
      {
        tag: 'Workshop',
        templateType: 'workshop',
        date: '2026-08-18',
        cleanTitle: 'Running Durable Agents in Production-Nicholas Lotz (Orkes)',
      },
    );
    assert.deepStrictEqual(
      parseCardTitle('[Book of the Week] 2026-SEP-14 - Book - Maria Vechtomova(s)'),
      {
        tag: 'Book of the Week',
        templateType: 'book-of-the-week',
        date: '2026-09-14',
        cleanTitle: 'Book - Maria Vechtomova(s)',
      },
    );
  });

  it('ignores placeholder dates from Trello card templates', () => {
    const parsed = parseCardTitle('[Newsletter] Weekly email #XXX (DD MMM 2026) -sponsored');
    assert.strictEqual(parsed.date, null);
    assert.strictEqual(parsed.tag, 'Newsletter');
  });

  it('leaves already-structured titles untouched', () => {
    assert.deepStrictEqual(parseCardTitle('Weekly email #298 - Astronomer'), {
      tag: null,
      templateType: null,
      date: null,
      cleanTitle: 'Weekly email #298 - Astronomer',
    });
    assert.deepStrictEqual(parseCardTitle('Some card without tag'), {
      tag: null,
      templateType: null,
      date: null,
      cleanTitle: 'Some card without tag',
    });
  });

  it('never returns an empty clean title', () => {
    const parsed = parseCardTitle('[Podcast] 2026-AUG-17');
    assert.strictEqual(parsed.date, '2026-08-17');
    assert.ok(parsed.cleanTitle.length > 0);
  });
});

describe('planCardStructureUpdate', () => {
  const templates = new Map([
    ['newsletter', 'template-newsletter'],
    ['podcast', 'template-podcast'],
    ['webinar', 'template-webinar'],
  ]);

  it('plans template, anchor, and title updates for a legacy card', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate(
        { title: '[Newsletter] Weekly email #299(19OCT 2026) -Snowplow', anchorDate: '2026-08-11' },
        templates,
      ),
      {
        templateId: 'template-newsletter',
        anchorDate: '2026-10-19',
        title: 'Weekly email #299 - Snowplow',
      },
    );
  });

  it('never overwrites an existing templateId', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate(
        {
          title: '[Newsletter] Weekly email #299(19OCT 2026) -Snowplow',
          anchorDate: '2026-08-11',
          templateId: 'template-other',
        },
        templates,
      ),
      { anchorDate: '2026-10-19', title: 'Weekly email #299 - Snowplow' },
    );
  });

  it('skips cards that are already structured', () => {
    assert.strictEqual(
      planCardStructureUpdate(
        {
          title: 'Weekly email #299 - Snowplow',
          anchorDate: '2026-10-19',
          templateId: 'template-newsletter',
        },
        templates,
      ),
      null,
    );
  });

  it('keeps the full title when the tag names no known template', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate({ title: '[Random] Something (12OCT 2026)', anchorDate: '2026-08-11' }, templates),
      { anchorDate: '2026-10-12' },
    );
  });
});
