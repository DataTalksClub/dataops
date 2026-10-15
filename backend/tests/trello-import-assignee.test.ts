import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  assigneeDirectoryFromUsers,
  extractAssigneeHint,
  setAssigneeDirectory,
  setImportDefaultAssignee,
  trelloChecklistItemsToTasks,
  type TrelloCard,
} from '../scripts/import-trello-csv';

const VALERIIA = 'user-valeriia';
const ALEXEY = 'user-alexey';
const ORIN = 'user-orin';

const directory = assigneeDirectoryFromUsers([
  { id: VALERIIA, name: 'Valeriia' },
  { id: ALEXEY, name: 'Alexey' },
  { id: ORIN, name: 'Orin Vale' },
  { id: 'user-gone', name: 'Grace', disabled: true },
]);

describe('Trello import extracts the assignee named in a task title', () => {
  for (const [title, description, assigneeId] of [
    ['[Other tasks] Add the podcast webpage to the newsletter **– Valeriia**', '[Other tasks] Add the podcast webpage to the newsletter', VALERIIA],
    ['Fill up "Podcast" block ** – Valeriia**', 'Fill up "Podcast" block', VALERIIA],
    ['Upload the recording to the shared folder in dropbox **– Alexey**', 'Upload the recording to the shared folder in dropbox', ALEXEY],
    ['Review the draft – **Orin Vale**', 'Review the draft', ORIN],
    ['Review the draft - orin', 'Review the draft', ORIN],
    ['Send invoice -- Alexey', 'Send invoice', ALEXEY],
    ['Send invoice (assignee: Valeriia) today', 'Send invoice today', VALERIIA],
  ] as const) {
    it(JSON.stringify(title), () => {
      assert.deepStrictEqual(extractAssigneeHint(title, directory), { description, assigneeId });
    });
  }

  it('stores a user id, never a name or placeholder', () => {
    assert.strictEqual(extractAssigneeHint('Do it **– Valeriia**', directory).assigneeId, VALERIIA);
  });

  for (const title of [
    'Announce the event - one week before',
    'Adding timecodes to YouTube videos - UPDATE',
    '[Event creation] Send Luma link to Valeriia for newsletter',
    'Email the sponsor – **2 weeks before the newsletter date**',
    "Comment from Alexey's account on LinkedIn",
  ]) {
    it(`leaves ${JSON.stringify(title)} alone`, () => {
      assert.deepStrictEqual(extractAssigneeHint(title, directory), { description: title, assigneeId: null });
    });
  }

  it('warns on a bold name with no account, and keeps it in the title', () => {
    const title = 'Fill in the announcement **– Natalia**';
    assert.deepStrictEqual(extractAssigneeHint(title, directory), {
      description: title, assigneeId: null, unknownName: 'Natalia',
    });
  });

  it('treats a disabled account as unknown', () => {
    assert.strictEqual(extractAssigneeHint('Pay the bill **– Grace**', directory).unknownName, 'Grace');
  });

  it('warns on an explicit unknown assignee', () => {
    assert.strictEqual(extractAssigneeHint('Pay (assignee: Bob)', directory).unknownName, 'Bob');
  });

  it('does not resolve an ambiguous first name', () => {
    const ambiguous = assigneeDirectoryFromUsers([{ id: 'a', name: 'Anna One' }, { id: 'b', name: 'Anna Two' }]);
    assert.strictEqual(extractAssigneeHint('Write it - Anna', ambiguous).assigneeId, null);
    assert.strictEqual(extractAssigneeHint('Write it - Anna Two', ambiguous).assigneeId, 'b');
  });
});

describe('Trello import assigns imported Tasks', () => {
  it('a named person wins; a nameless Task goes to the workspace default', () => {
    setAssigneeDirectory(directory);
    setImportDefaultAssignee(ORIN);
    try {
      const card = {
        id: 'card-1', name: 'Weekly email 2031-03-04', idChecklists: ['cl-1'], due: '2031-03-04T00:00:00.000Z',
      } as unknown as TrelloCard;
      const tasks = trelloChecklistItemsToTasks(card, [{
        id: 'cl-1', name: 'Other tasks', pos: 1, checkItems: [
          { id: 'i-1', name: 'Add the podcast webpage to the newsletter **– Valeriia**', pos: 1, state: 'incomplete' },
          { id: 'i-2', name: 'Schedule the posts', pos: 2, state: 'incomplete' },
        ],
      }], 'card-1');
      assert.deepStrictEqual(
        tasks.map((task) => [task.description, task.assigneeId]),
        [
          ['Add the podcast webpage to the newsletter', VALERIIA],
          ['Schedule the posts', ORIN],
        ],
      );
    } finally {
      setAssigneeDirectory(new Map());
      setImportDefaultAssignee(null);
    }
  });
});
