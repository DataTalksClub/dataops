import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { createTask, getTask } from '../src/db/tasks';
import { templateLink } from './helpers/cardTemplate';
import { handler } from '../src/handler';

const invoke = (method: string, path: string, body?: unknown) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) },
    {},
  ) as Promise<{ statusCode: number; body: string }>;
const data = (response: { body: string }) => JSON.parse(response.body);

const SCHEDULED_AT = '2026-10-23T17:00:00.000Z';
const scheduleBody = (version: number, audioSchedule: unknown) => ({
  version,
  publication: audioSchedule === null ? {} : {
    audioSchedule: {
      scheduledAt: SCHEDULED_AT,
      timezone: 'Europe/Berlin',
      observedAt: '2026-10-17T08:00:00.000Z',
    },
  },
});

describe('podcast Spotify schedule hook', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });

  after(stopLocal);

  async function episodeWithVerifyCard() {
    const card = await createCard(client, {
      ...templateLink(),
      title: 'Episode card',
      anchorDate: '2026-10-20',
      templateDefinitionSnapshot: {
        tags: [],
        sourceDocIds: [],
        references: [],
        cardLinkDefinitions: [],
        taskRefs: ['verify-ref', 'page-ref'],
        episodeStages: { published: 'verify-ref' },
      },
    });
    const verify = await createTask(client, {
      description: 'Verify the public playable Spotify episode',
      date: '2026-10-23',
      cardId: card.id,
      templateTaskRef: 'verify-ref',
    });
    const page = await createTask(client, {
      description: 'Release the website page',
      date: '2026-10-24',
      cardId: card.id,
      templateTaskRef: 'page-ref',
      dependsOn: [verify.id],
    });
    const created = await createPodcastEpisode(client, {
      title: 'Hook Episode',
      guests: [{ name: 'Tejas Example' }],
      recordingDate: '2026-10-20',
      status: 'booked',
      cardId: card.id,
    } as Parameters<typeof createPodcastEpisode>[1]);
    assert.equal(created.cardId, card.id);
    return { card, verify, page, episode: { id: created.id, version: created.version } };
  }

  it('times the verify task at the recorded schedule and reports it', async () => {
    const { verify, page, episode } = await episodeWithVerifyCard();
    const updated = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(episode.version, true)));
    assert.deepStrictEqual(updated.scheduleSync, { taskId: verify.id, notBeforeAt: SCHEDULED_AT });

    const timed = await getTask(client, verify.id);
    assert.strictEqual(timed?.notBeforeAt, SCHEDULED_AT);
    assert.strictEqual(timed?.taskHistory.at(-1)?.action, 'scheduled');

    // The downstream page keeps its own date: the schedule moves moments,
    // dates follow explicit parent moves.
    assert.strictEqual((await getTask(client, page.id))?.date, '2026-10-24');
  });

  it('re-recording the same schedule is a no-op', async () => {
    const { verify, episode } = await episodeWithVerifyCard();
    const first = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(episode.version, true)));
    assert.ok(first.scheduleSync);
    const second = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(first.version, true)));
    assert.strictEqual(second.scheduleSync, undefined);
    assert.strictEqual((await getTask(client, verify.id))?.notBeforeAt, SCHEDULED_AT);
  });

  it('removing the schedule unschedules a hook-timed task but keeps a hand-set moment', async () => {
    const { verify, episode } = await episodeWithVerifyCard();
    const first = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(episode.version, true)));
    const removed = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, {
      version: first.version,
      publication: {},
    }));
    assert.deepStrictEqual(removed.scheduleSync, { taskId: verify.id, notBeforeAt: null });
    assert.strictEqual((await getTask(client, verify.id))?.notBeforeAt, undefined);

    const retimed = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(removed.version, true)));
    const verifyTask = await getTask(client, verify.id);
    assert.ok(verifyTask);
    const handSet = await invoke('PUT', `/api/tasks/${verify.id}`, {
      expectedVersion: verifyTask!.version,
      notBeforeAt: '2026-10-25T09:00:00.000Z',
    });
    assert.equal(handSet.statusCode, 200);
    const removedAgain = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, {
      version: retimed.version,
      publication: {},
    }));
    assert.strictEqual(removedAgain.scheduleSync, undefined);
    assert.strictEqual((await getTask(client, verify.id))?.notBeforeAt, '2026-10-25T09:00:00.000Z');
  });

  it('leaves done verify tasks and cardless episodes alone', async () => {
    const { verify, episode } = await episodeWithVerifyCard();
    const done = await invoke('PUT', `/api/tasks/${verify.id}`, {
      expectedVersion: verify.version,
      status: 'done',
    });
    assert.equal(done.statusCode, 200);
    const updated = data(await invoke('PUT', `/api/podcast-episodes/${episode.id}`, scheduleBody(episode.version, true)));
    assert.strictEqual(updated.scheduleSync, undefined);
    assert.strictEqual((await getTask(client, verify.id))?.notBeforeAt, undefined);

    const cardless = await createPodcastEpisode(client, {
      title: 'Cardless Episode',
      guests: [{ name: 'No Card' }],
      recordingDate: '2026-10-20',
      status: 'booked',
    } as Parameters<typeof createPodcastEpisode>[1]);
    const scheduled = data(await invoke('PUT', `/api/podcast-episodes/${cardless.id}`, scheduleBody(cardless.version, true)));
    assert.strictEqual(scheduled.scheduleSync, undefined);
  });
});
