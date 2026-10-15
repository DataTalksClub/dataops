import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  linkTrelloPlansToTemplates,
  planTrelloActiveCard,
  type TrelloCard,
  type TrelloChecklist,
} from '../scripts/import-trello-csv';
import type { Template } from '../src/types';

const podcast = {
  id: 'template-podcast',
  name: 'Podcast',
  type: 'podcast',
  version: 4,
  sourceRevision: 'rev-4',
  taskDefinitions: [
    { refId: 'invite', description: 'Invite guest', offsetDays: -14 },
    { refId: 'record', description: 'Record', offsetDays: 0 },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Template;

function trelloCard(id: string, name: string): TrelloCard {
  return {
    id, name, due: '2031-03-04T00:00:00.000Z', closed: false, isTemplate: false,
    idList: 'list-1', idChecklists: ['cl-1'], labels: [], attachments: [],
  } as TrelloCard;
}

const checklists = [{
  id: 'cl-1', name: 'Prepare', pos: 1,
  checkItems: [{ id: 'i-1', name: 'Invite the guest', pos: 1, state: 'complete' }],
}] as TrelloChecklist[];

describe('Trello import instantiates every Card from a Template', () => {
  it('links each imported Card to the Template its tag names and keeps the checklist as its own Tasks', () => {
    const plan = planTrelloActiveCard(trelloCard('c-1', '[Podcast] 2031-MAR-04 - Topic - Guest'), 'Preparation', checklists);
    linkTrelloPlansToTemplates([plan], [podcast]);
    assert.strictEqual(plan.card.templateId, 'template-podcast');
    assert.strictEqual(plan.card.templateVersion, 4);
    assert.deepStrictEqual(plan.card.selectedOptionalGroups, []);
    assert.deepStrictEqual((plan.card.templateDefinitionSnapshot as { taskRefs: string[] }).taskRefs, ['invite', 'record']);
    assert.strictEqual(plan.tasks.length, 1);
    assert.strictEqual(plan.tasks[0].templateId, undefined);
  });

  it('refuses the whole import when a card names no deployed Template', () => {
    const plans = [
      planTrelloActiveCard(trelloCard('c-1', '[Podcast] 2031-MAR-04 - Topic - Guest'), 'Preparation', checklists),
      planTrelloActiveCard(trelloCard('c-2', 'Fix the website footer'), 'Preparation', checklists),
    ];
    assert.throws(
      () => linkTrelloPlansToTemplates(plans, [podcast]),
      /Trello cards name no deployed Template[\s\S]*Fix the website footer \(type "other"\)/,
    );
    assert.strictEqual(plans[0].card.templateId, undefined, 'nothing is linked when any card is unmapped');
  });
});
