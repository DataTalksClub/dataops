import { describe, it } from 'node:test';
import assert from 'node:assert';

import { inferRequires } from '../scripts/required-resource-inference';
import {
  cardTemplateTypes,
  normaliseStepName,
  planRequiresBackfill,
  summarize,
} from '../scripts/backfill-task-requires';
import type { AuthoredRequires } from '../scripts/backfill-task-requires';

describe('required-resource inference', () => {
  it('reads the item text, not the checklist tag', () => {
    assert.deepStrictEqual(inferRequires('[YouTube video editing] Update the cover of the YouTube video'), ['youtube']);
    assert.deepStrictEqual(inferRequires('[Podcast page] Moving Podcast Audio in Dropbox'), ['dropbox']);
    assert.deepStrictEqual(inferRequires('Create events on Luma'), ['luma']);
    assert.deepStrictEqual(inferRequires('Invite people to Slack from Airtable'), ['slack', 'airtable']);
  });

  it('reads website-repo links as the website and only sending as email', () => {
    assert.deepStrictEqual(
      inferRequires('Add the event to the webpage ([site](https://github.com/DataTalksClub/datatalksclub.github.io/blob/x))'),
      ['website'],
    );
    assert.deepStrictEqual(inferRequires('Email the sponsor with the document'), ['gmail']);
    assert.deepStrictEqual(inferRequires("Obtain speaker's email"), []);
  });

  it('uses the instruction document area but not its slug', () => {
    assert.deepStrictEqual(inferRequires('Fill in the form', 'sop.newsletter.mailchimp.filling-the-youtube-block'), ['mailchimp']);
  });
});

describe('requires backfill plan', () => {
  const authored: AuthoredRequires = new Map([
    ['webinar', {
      byRef: new Map([['create-events-luma', ['luma', 'youtube']], ['agree-on-a-date', ['gmail']]]),
      byName: new Map([
        [normaliseStepName('Create events on Luma'), ['luma', 'youtube']],
        [normaliseStepName('Remove the beginning of the recording'), ['youtube']],
      ]),
    }],
  ]);
  const templateTypes = new Map([['tpl-1', 'webinar']]);

  it('prefers the linked template step, then the step name, then inference', () => {
    const cards = [{ id: 'card-1', tags: ['📺 [Webinar]', 'trello-import', 'webinar'] }];
    const cardTypes = cardTemplateTypes(cards, templateTypes, authored);
    assert.deepStrictEqual([...cardTypes], [['card-1', 'webinar']]);

    const plan = planRequiresBackfill([
      {
        PK: 'TASK#a', templateId: 'tpl-1', templateTaskRef: 'create-events-luma', description: 'Create events on Luma',
        templateDefinitionSnapshot: { description: 'Create events on Luma' }, version: 3,
      },
      {
        PK: 'TASK#b', cardId: 'card-1', description: '[YouTube video editing] Remove the beginning of the recording',
        systems: ['google-drive', 'luma', 'meetup', 'youtube'], version: 1,
      },
      { PK: 'TASK#c', cardId: 'card-1', description: 'Announce in Slack', systems: ['google-drive'], version: 1 },
      { PK: 'TASK#d', source: 'recurring', description: 'Create new cards', systems: ['trello', 'not-a-resource'], version: 1 },
      { PK: 'RECURRING#e', description: 'Invite people to Slack from Airtable', systems: ['airtable', 'slack'] },
      { PK: 'TASK#f', description: 'Already done', requires: ['slack'], version: 1 },
      { PK: 'TASK#h', description: 'Operator set', requires: ['luma'], systems: ['youtube'], version: 1 },
      { PK: 'RECURRINGRUN#g', description: 'ignored' },
    ], templateTypes, authored, cardTypes);

    const byPk = Object.fromEntries(plan.changes.map((change) => [change.pk, change]));
    assert.deepStrictEqual(Object.keys(byPk).sort(), ['RECURRING#e', 'TASK#a', 'TASK#b', 'TASK#c', 'TASK#d', 'TASK#h']);
    assert.deepStrictEqual(byPk['TASK#a'], {
      pk: 'TASK#a', kind: 'task', description: 'Create events on Luma', source: 'template',
      from: {}, requires: ['luma', 'youtube'], snapshot: true,
    });
    assert.strictEqual(byPk['TASK#b'].source, 'template-name');
    assert.deepStrictEqual(byPk['TASK#b'].requires, ['youtube'], 'card-wide imported systems are dropped');
    assert.deepStrictEqual(byPk['TASK#c'].requires, ['slack']);
    assert.deepStrictEqual(byPk['TASK#d'].requires, ['trello'], 'recurring systems keep known ids');
    assert.deepStrictEqual(byPk['RECURRING#e'].requires, ['airtable', 'slack']);
    assert.deepStrictEqual(byPk['TASK#h'].requires, ['luma'], 'an existing requires is kept; only systems goes');
    assert.strictEqual(byPk['TASK#h'].source, 'existing');
    assert.deepStrictEqual(plan.scanned, { tasks: 6, recurringConfigs: 1 });

    const summary = summarize(plan) as Record<string, any>;
    assert.strictEqual(summary.planned, 6);
    assert.strictEqual(summary.removesSystems, 5);
    assert.deepStrictEqual(summary.byResource.youtube, { total: 2, template: 1, 'template-name': 1, inferred: 0, existing: 0 });
  });
});
