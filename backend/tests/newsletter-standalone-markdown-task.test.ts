/**
 * The stand-alone newsletter Markdown step ("Prepare and store standalone
 * newsletter Markdown") resolves itself instead of sitting open and overdue:
 * skipped when the sponsor supplies the text (the `sponsor-written` Card tag
 * or an already scheduled/sent issue), marked done when issue Markdown is
 * stored. All sponsors here are synthetic.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { getCard } from '../src/db/cards';
import { createTemplate } from '../src/db/templates';
import { listTasksByCard } from '../src/db/tasks';
import { syncStandaloneMarkdownTask } from '../src/newsletter/markdownTask';

const invoke = (method: string, pathName: string, body?: unknown, query: Record<string, string> = {}) =>
  handler({
    httpMethod: method,
    path: pathName,
    headers: {},
    queryStringParameters: query,
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
const data = (response: any) => JSON.parse(response.body);
const today = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const MARKDOWN_DESCRIPTION = 'Prepare and store standalone newsletter Markdown';

describe('stand-alone newsletter Markdown step', () => {
  let client: Awaited<ReturnType<typeof getClient>>;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SKIP_AUTH = 'true';
    client = await getClient(await startLocal());
    await createTables(client);
    await createTemplate(client, {
      name: 'Newsletter Standalone',
      type: 'newsletter-standalone',
      cardTitle: '{date} · {sponsor} · {variant}',
      cardLinkDefinitions: [{ name: 'Newsletter Markdown' }],
      taskDefinitions: [
        { refId: 'prepare-markdown', description: MARKDOWN_DESCRIPTION, offsetDays: -3 },
        { refId: 'schedule-send', description: 'Schedule the send', offsetDays: 0 },
      ],
    });
  });
  after(stopLocal);

  const createStandalone = async (publicationDate: string) => {
    const response = await invoke('POST', '/api/newsletter-issues', {
      kind: 'standalone',
      publicationDate,
      status: 'planned',
      slots: { primary: { sponsor: 'Synthetic Sponsor' } },
    });
    assert.equal(response.statusCode, 201, response.body);
    const issue = data(response);
    assert.ok(issue.cardId, 'a due stand-alone issue gets its Card at once');
    return issue;
  };

  const markdownTask = async (cardId: string) => {
    const tasks = await listTasksByCard(client, cardId);
    const found = tasks.find((task) => task.description === MARKDOWN_DESCRIPTION);
    assert.ok(found, 'the Card carries the Markdown step');
    return found;
  };

  it('skips the Markdown step when the Card is tagged sponsor-written', async () => {
    const issue = await createStandalone(addDays(today, 3));
    assert.equal((await markdownTask(issue.cardId)).status, 'todo');

    const card = await getCard(client, issue.cardId);
    const tagged = await invoke('PUT', `/api/cards/${issue.cardId}`, {
      expectedVersion: card!.version,
      tags: [...(card!.tags || []), 'sponsor-written'],
    });
    assert.equal(tagged.statusCode, 200, tagged.body);

    const step = await markdownTask(issue.cardId);
    assert.equal(step.status, 'skipped');
    assert.match(String(step.skipReason || ''), /sponsor/i);
    assert.ok(step.skippedAt, 'a skip carries its timestamp');
    const other = (await listTasksByCard(client, issue.cardId))
      .find((task) => task.description === 'Schedule the send');
    assert.equal(other?.status, 'todo', 'only the Markdown step is skipped');
  });

  it('skips the Markdown step when the issue is already scheduled', async () => {
    const issue = await createStandalone(addDays(today, 4));
    const updated = await invoke('PUT', `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      status: 'scheduled',
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(data(updated).markdownTask, 'skipped');

    const step = await markdownTask(issue.cardId);
    assert.equal(step.status, 'skipped');
    assert.match(String(step.skipReason || ''), /scheduled/);
  });

  it('marks the Markdown step done when issue Markdown is stored', async () => {
    const issue = await createStandalone(addDays(today, 5));
    const stored = await invoke('PUT', `/api/newsletter-issues/${issue.id}/markdown`, {
      issue: 'Subject: Synthetic stand-alone\n\nPreview: Synthetic preview.\n\n# Hello\n',
    });
    assert.equal(stored.statusCode, 200, stored.body);

    const step = await markdownTask(issue.cardId);
    assert.equal(step.status, 'done');
    assert.match(String(step.externalStatus || ''), /Markdown stored/);
  });

  it('leaves the Markdown step open when nothing resolves it', async () => {
    const issue = await createStandalone(addDays(today, 6));
    const updated = await invoke('PUT', `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      planningNote: 'Still waiting on the sponsor draft.',
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(data(updated).markdownTask, 'open');
    assert.equal((await markdownTask(issue.cardId)).status, 'todo');
  });

  it('ignores issues without a stand-alone Card', async () => {
    assert.equal(
      await syncStandaloneMarkdownTask(client, { kind: 'weekly', cardId: 'nope' } as any, 'system'),
      'none',
    );
    assert.equal(
      await syncStandaloneMarkdownTask(client, { kind: 'standalone' } as any, 'system'),
      'none',
    );
  });
});
