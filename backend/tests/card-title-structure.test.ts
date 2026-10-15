import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hydrateStructuredCardFields,
  parseCardTitle,
  planCardStructureUpdate,
  templateTypeForTag,
} from '../src/cards/cardTitleStructure';

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

  it('parses newsletter titles into tag, date, issueNumber, sponsor, and clean title', () => {
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #294(14 SEP 2026) -Astronomer'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-09-14',
      issueNumber: '294',
      people: [],
      sponsor: 'Astronomer',
      secondarySponsors: [],
      cleanTitle: 'Weekly email',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #298(12OCT 2026) -Astronomer'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-10-12',
      issueNumber: '298',
      people: [],
      sponsor: 'Astronomer',
      secondarySponsors: [],
      cleanTitle: 'Weekly email',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #298(20OCT 2026) -Astronomer'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-10-20',
      issueNumber: '298',
      people: [],
      sponsor: 'Astronomer',
      secondarySponsors: [],
      cleanTitle: 'Weekly email',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #Secondary(07DEC 2026) -Snowplow'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-12-07',
      issueNumber: null,
      people: [],
      sponsor: 'Snowplow',
      secondarySponsors: [],
      cleanTitle: 'Weekly email #Secondary',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email Secondary (21 SEP 2026) -sponsored'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-09-21',
      issueNumber: null,
      people: [],
      sponsor: 'sponsored',
      secondarySponsors: [],
      cleanTitle: 'Weekly email Secondary',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email Stand-Alone(04 NOV 2026) -Snowplow'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-11-04',
      issueNumber: null,
      people: [],
      sponsor: 'Snowplow',
      secondarySponsors: [],
      cleanTitle: 'Weekly email Stand-Alone',
    });
    assert.deepStrictEqual(parseCardTitle('[Newsletter] Weekly email #300(28OCT 2026) -Astronomer & Snowplow'), {
      tag: 'Newsletter',
      templateType: 'newsletter',
      date: '2026-10-28',
      issueNumber: '300',
      people: [],
      sponsor: 'Astronomer',
      secondarySponsors: ['Snowplow'],
      cleanTitle: 'Weekly email',
    });
  });

  it('parses event titles into tag, date, people, and clean title', () => {
    assert.deepStrictEqual(
      parseCardTitle('[Podcast] 2026-AUG-17 - The Data Consultant Playbook - Tony Zeljkovic & Juan Manuel Perafan'),
      {
        tag: 'Podcast',
        templateType: 'podcast',
        date: '2026-08-17',
        issueNumber: null,
        people: ['Tony Zeljkovic', 'Juan Manuel Perafan'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'The Data Consultant Playbook',
      },
    );
    assert.deepStrictEqual(parseCardTitle('[Webinar] 2026-SEPT-07-Topic- Daan Di Scala'), {
      tag: 'Webinar',
      templateType: 'webinar',
      date: '2026-09-07',
      issueNumber: null,
      people: ['Daan Di Scala'],
      sponsor: null,
      secondarySponsors: [],
      cleanTitle: 'Topic',
    });
    assert.deepStrictEqual(
      parseCardTitle('[Workshop] 2026-JUL-21 - Tracking agents-James Borlase & Jordan Peck (Snowplow )'),
      {
        tag: 'Workshop',
        templateType: 'workshop',
        date: '2026-07-21',
        issueNumber: null,
        people: ['James Borlase', 'Jordan Peck (Snowplow)'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'Tracking agents',
      },
    );
    assert.deepStrictEqual(
      parseCardTitle('[Book of the Week] 2026-SEP-14 - Book - Maria Vechtomova(s)'),
      {
        tag: 'Book of the Week',
        templateType: 'book-of-the-week',
        date: '2026-09-14',
        issueNumber: null,
        people: ['Maria Vechtomova(s)'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'Book',
      },
    );
    assert.deepStrictEqual(
      parseCardTitle('[Webinar] 2026-09-07-Topic- Daan Di Scala'),
      {
        tag: 'Webinar',
        templateType: 'webinar',
        date: '2026-09-07',
        issueNumber: null,
        people: ['Daan Di Scala'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'Topic',
      },
    );
  });

  it('splits glued person segments but keeps hyphenated words intact', () => {
    assert.deepStrictEqual(
      parseCardTitle('[Podcast] 2026-AUG-03-Engineering AI-Powered Data Products-Radovan Bacovic'),
      {
        tag: 'Podcast',
        templateType: 'podcast',
        date: '2026-08-03',
        issueNumber: null,
        people: ['Radovan Bacovic'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'Engineering AI-Powered Data Products',
      },
    );
    assert.deepStrictEqual(
      parseCardTitle('[Webinar] 2026-SEP-14-ML Zoomcamp 2026 Pre-Course Live Q&A- Alexey Grigorev'),
      {
        tag: 'Webinar',
        templateType: 'webinar',
        date: '2026-09-14',
        issueNumber: null,
        people: ['Alexey Grigorev'],
        sponsor: null,
        secondarySponsors: [],
        cleanTitle: 'ML Zoomcamp 2026 Pre-Course Live Q&A',
      },
    );
  });

  it('ignores placeholder people and dates from Trello card templates', () => {
    const dated = parseCardTitle('[Newsletter] Weekly email #XXX (DD MMM 2026) -sponsored');
    assert.strictEqual(dated.date, null);
    assert.strictEqual(dated.tag, 'Newsletter');
    assert.strictEqual(dated.issueNumber, null);
    const person = parseCardTitle('[Podcast] 2026-SEP-08 - Topic - Name');
    assert.deepStrictEqual(person.people, []);
    assert.strictEqual(person.cleanTitle, 'Topic - Name');
  });

  it('leaves already-structured titles untouched', () => {
    assert.deepStrictEqual(parseCardTitle('Weekly email #298'), {
      tag: null,
      templateType: null,
      date: null,
      issueNumber: null,
      people: [],
      sponsor: null,
      secondarySponsors: [],
      cleanTitle: 'Weekly email #298',
    });
    assert.deepStrictEqual(parseCardTitle('Some card without tag'), {
      tag: null,
      templateType: null,
      date: null,
      issueNumber: null,
      people: [],
      sponsor: null,
      secondarySponsors: [],
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
  it('plans anchor, title, issueNumber, and sponsor updates for a legacy card', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate(
        { title: '[Newsletter] Weekly email #299(19OCT 2026) -Snowplow', anchorDate: '2026-08-11' }),
      {
        anchorDate: '2026-10-19',
        title: 'Weekly email',
        issueNumber: '299',
        sponsor: 'Snowplow',
      },
    );
  });

  it('plans people updates for event cards', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate(
        { title: '[Podcast] 2026-AUG-17 - Playbook - Tony Zeljkovic & Juan Manuel Perafan', anchorDate: '2026-08-17' }),
      {
        title: 'Playbook',
        people: ['Tony Zeljkovic', 'Juan Manuel Perafan'],
      },
    );
  });

  it('corrects stale sponsor and issue values from the title', () => {
    assert.deepStrictEqual(
      planCardStructureUpdate(
        {
          title: '[Newsletter] Weekly email #299(19OCT 2026) -Snowplow',
          anchorDate: '2026-08-11',
          sponsor: 'Acme',
        }),
      {
        anchorDate: '2026-10-19',
        title: 'Weekly email',
        issueNumber: '299',
        sponsor: 'Snowplow',
      },
    );
  });

  it('skips cards that are already structured', () => {
    assert.strictEqual(
      planCardStructureUpdate(
        {
          title: 'Weekly email',
          anchorDate: '2026-10-19',
          issueNumber: '299',
          sponsor: 'Snowplow',
        }),
      null,
    );
  });
});

describe('hydrateStructuredCardFields', () => {
  const templates = new Map([
    ['newsletter', 'tpl-newsletter'],
    ['webinar', 'tpl-webinar'],
  ]);

  it('hydrates legacy raw title fields onto a card object in-place', () => {
    const card: any = {
      id: 'card-1',
      title: '[Newsletter] Weekly email #298(12OCT 2026) -Astronomer',
      anchorDate: '2026-08-10',
      templateId: 'tpl-newsletter',
    };
    hydrateStructuredCardFields(card, templates);
    assert.strictEqual(card.templateId, 'tpl-newsletter');
    assert.strictEqual(card.anchorDate, '2026-10-12');
    assert.strictEqual(card.title, 'Weekly email');
    assert.strictEqual(card.issueNumber, '298');
    assert.strictEqual(card.sponsor, 'Astronomer');
  });

  it('does not overwrite existing structured values', () => {
    const card: any = {
      id: 'card-2',
      title: '[Newsletter] Weekly email #298(12OCT 2026) -Astronomer',
      templateId: 'tpl-custom',
      sponsor: 'CustomSponsor',
      issueNumber: '999',
    };
    hydrateStructuredCardFields(card, templates);
    assert.strictEqual(card.templateId, 'tpl-custom');
    assert.strictEqual(card.sponsor, 'CustomSponsor');
    assert.strictEqual(card.issueNumber, '999');
    assert.strictEqual(card.title, 'Weekly email');
  });

  it('never infers a Template from the title tag', () => {
    const card: any = {
      id: 'card-4',
      title: '[Webinar] 2026-SEP-15 - Talk - Speaker',
      anchorDate: '2026-09-15',
    };
    hydrateStructuredCardFields(card, templates);
    assert.strictEqual(card.templateId, undefined);
  });

  it('leaves cards with no tag and no structure untouched', () => {
    const card: any = {
      id: 'card-3',
      title: 'Fix website links',
      anchorDate: '2026-10-11',
    };
    hydrateStructuredCardFields(card, templates);
    assert.strictEqual(card.title, 'Fix website links');
    assert.strictEqual(card.templateId, undefined);
    assert.strictEqual(card.sponsor, undefined);
    assert.strictEqual(card.people, undefined);
  });
});
