import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  planTrelloActiveCard,
  trelloChecklistItemsToTasks,
  type TrelloCard,
  type TrelloChecklist,
} from '../scripts/import-trello-csv';

const LOOM = 'https://www.loom.com/share/fd4b9b66aa0d434bbd80225d19065dd8';
const TEMPLATE = 'https://docs.google.com/document/d/abc/edit';

const card = {
  id: 'card-1',
  name: 'Newsletter 2031-03-04',
  due: '2031-03-04T00:00:00.000Z',
  closed: false,
  isTemplate: false,
  idList: 'list-1',
  idChecklists: ['cl-1'],
  labels: [],
  attachments: [],
} as TrelloCard;

const checklists: TrelloChecklist[] = [{
  id: 'cl-1',
  name: 'Create a new newsletter edition',
  pos: 1,
  checkItems: [
    { id: 'i-1', name: `Fill up the sponsored block ([doc](${TEMPLATE}), [video](${LOOM}))`, pos: 1, state: 'incomplete' },
    { id: 'i-2', name: `Create a MailChimp campaign [video](${LOOM})`, pos: 2, state: 'incomplete' },
  ],
}] as TrelloChecklist[];

describe('Trello import keeps Loom walkthroughs out of Task materials', () => {
  it('reports a Loom in a checklist item instead of storing it on the Task', () => {
    const plan = planTrelloActiveCard(card, 'Preparation', checklists);
    const [first, second] = plan.tasks;

    assert.strictEqual(first.description, 'Fill up the sponsored block');
    assert.strictEqual(first.instructionsUrl, TEMPLATE);
    assert.strictEqual(first.materials, undefined);
    assert.ok(!JSON.stringify(first).includes('loom.com'));

    // A Loom that is the item's only link is not taken as its instructions.
    assert.strictEqual(second.description, 'Create a MailChimp campaign');
    assert.strictEqual(second.instructionsUrl, undefined);
    assert.ok(!JSON.stringify(second).includes('loom.com'));

    assert.deepStrictEqual(
      plan.warnings.filter((warning) => warning.startsWith('loom walkthrough:')),
      [
        `loom walkthrough: ${LOOM} in Fill up the sponsored block`,
        `loom walkthrough: ${LOOM} in Create a MailChimp campaign`,
      ],
    );
  });

  it('moves other title links into materials', () => {
    const [task] = trelloChecklistItemsToTasks(card, [{
      id: 'cl-1', name: 'Other tasks', pos: 1, checkItems: [
        { id: 'i-1', name: `Announce it ([steps](${TEMPLATE}), [video](${LOOM})) [template](https://example.com/t)`, pos: 1, state: 'incomplete' },
      ],
    }] as TrelloChecklist[], 'card-1');
    assert.strictEqual(task.description, 'Announce it');
    assert.strictEqual(task.instructionsUrl, TEMPLATE);
    assert.deepStrictEqual(task.materials, [{ url: 'https://example.com/t', label: 'template' }]);
  });
});
