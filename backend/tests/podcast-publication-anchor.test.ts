import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createCard, getCard } from '../src/db/cards';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { createTask, getTask, updateTask } from '../src/db/tasks';
import { templateLink } from './helpers/cardTemplate';
import { handler } from '../src/handler';

const invoke = (method: string, path: string, body?: unknown) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) },
    {},
  ) as Promise<{ statusCode: number; body: string }>;
const data = (response: { body: string }) => JSON.parse(response.body);

describe('podcast publication date as the second Card anchor', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  async function recordedEpisode(season: number) {
    const card = await createCard(client, {
      ...templateLink(),
      title: 'Anchor card',
      anchorDate: '2026-11-02',
      templateDefinitionSnapshot: { tags: [], sourceDocIds: [], references: [], cardLinkDefinitions: [], taskRefs: [] },
    });
    const task = (fields: Record<string, unknown>) =>
      createTask(client, { cardId: card.id, ...fields } as Parameters<typeof createTask>[1]);
    // Recording-anchored work keeps the recording date.
    const edit = await task({ description: 'Edit audio', date: '2026-11-05', templateTaskRef: 'edit', templateOffsetDays: 3 });
    // Publication-anchored work: page before release, verify on release day.
    const page = await task({ description: 'Create page', date: '2026-11-05', templateTaskRef: 'page', templateOffsetDays: -3, templateAnchor: 'end' });
    const verify = await task({ description: 'Verify live', date: '2026-11-05', templateTaskRef: 'verify', templateOffsetDays: 0, templateAnchor: 'end' });
    const done = await task({ description: 'Draft clips', date: '2026-11-04', templateTaskRef: 'clips', templateOffsetDays: -9, templateAnchor: 'end' });
    await updateTask(client, done.id, { expectedVersion: done.version, patch: { status: 'done', completedAt: '2026-11-04T10:00:00.000Z' } });
    const episode = await createPodcastEpisode(client, {
      title: 'Anchor Episode',
      guests: [{ name: 'Anchor Guest' }],
      recordingDate: '2026-11-02',
      status: 'recorded',
      season,
      episode: 1,
      releaseDate: season === 41 ? '2026-12-04' : '2026-12-11',
      releaseAssignmentStatus: 'provisional',
      cardId: card.id,
    } as Parameters<typeof createPodcastEpisode>[1]);
    return { card, edit, page, verify, done, episode };
  }

  it('final assignment pins card.endDate and moves only open publication-anchored Tasks', async () => {
    const { card, edit, page, verify, done, episode } = await recordedEpisode(41);
    const response = await invoke('PUT', `/api/podcast-episodes/${episode.id}`, {
      version: episode.version,
      releaseAssignmentStatus: 'final',
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = data(response);
    assert.equal(body.releaseAssignmentStatus, 'final');
    assert.equal(body.publicationAnchor.endDate, '2026-12-04');
    assert.equal((await getCard(client, card.id))?.endDate, '2026-12-04');
    assert.equal((await getTask(client, page.id))?.date, '2026-12-01');
    assert.equal((await getTask(client, verify.id))?.date, '2026-12-04');
    assert.equal((await getTask(client, edit.id))?.date, '2026-11-05');
    const kept = await getTask(client, done.id);
    assert.equal(kept?.date, '2026-11-04');
    assert.equal(kept?.status, 'done');
    // A final slot without provider proof is not fully scheduled.
    assert.equal(body.release.fullyScheduled, false);
    assert.ok(body.release.warnings.some((w: { code: string }) => w.code === 'missing-provider-schedule'));

    const moved = await invoke('PUT', `/api/podcast-episodes/${episode.id}`, {
      version: body.version,
      releaseDate: '2026-12-18',
      releaseAssignmentStatus: 'final',
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await getTask(client, page.id))?.date, '2026-12-15');
    const history = (await getTask(client, page.id))?.taskHistory ?? [];
    assert.equal(history.at(-1)?.action, 'scheduled');
  });

  it('a recorded episode with a provisional slot warns until it is confirmed final', async () => {
    const { episode } = await recordedEpisode(42);
    const shown = data(await invoke('GET', `/api/podcast-episodes/${episode.id}`));
    assert.equal(shown.releaseAssignmentStatus, 'provisional');
    assert.deepStrictEqual(shown.release.warnings.map((w: { code: string }) => w.code), ['slot-not-final']);
  });
});
