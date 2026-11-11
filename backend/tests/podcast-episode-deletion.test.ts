import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deletionBlockers, previewEpisodeDeletion, executeEpisodeDeletion, EPISODE_DELETION_POLICY } from '../src/podcast/episodeDeletion';
import type { PodcastEpisode } from '../src/db/podcastEpisodes';
import { handlePodcastEpisodeRoutes } from '../src/routes/podcastEpisodes';
import { templateLink } from './helpers/cardTemplate';
import { TABLE_CARDS, TABLE_PODCAST_EPISODES } from '../src/db/tableNames';

const episode: PodcastEpisode = {
  id: 'synthetic-test',
  title: 'Synthetic Test Title',
  guests: [{ name: 'Synthetic Guest' }],
  recordingDate: '2026-11-01',
  status: 'cancelled',
  version: 2,
  createdAt: '',
  updatedAt: '',
  cardId: 'gone-card',
};
const confirmed = {
  [episode.id]: {
    version: 2,
    evidence: 'synthetic exact identity approval',
    title: 'Synthetic Test Title',
    guests: ['Synthetic Guest'],
    recordingDate: '2026-11-01',
  },
};
function storage(options: { card?: boolean; tasks?: boolean; hold?: string; conflict?: boolean; operator?: boolean; episodeOverride?: PodcastEpisode } = {}) {
  const calls: string[] = [];
  const activeEpisode = options.episodeOverride ?? episode;
  const client = { send: async (command: any) => {
    const name = command.constructor.name;
    calls.push(name);
    if (name === 'DeleteCommand' && options.conflict) throw Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' });
    if (name === 'GetCommand') return { Item: command.input.TableName === TABLE_PODCAST_EPISODES ? activeEpisode
      : command.input.TableName === TABLE_CARDS ? options.card ? { id: 'gone-card', version: 1, taskCount: 0, openTaskCount: 0, status: 'active', stage: 'preparation', ...templateLink() } : undefined
      : options.operator ? { id: 'operator', role: 'operator' } : undefined };
    if (name === 'QueryCommand') return { Items: options.tasks ? [{ id: 'orphan-task', version: 1, taskHistory: [] }] : [] };
    if (name === 'ScanCommand') return { Items: options.hold ? [{ id: 'hold', cardId: 'gone-card', status: options.hold, date: '2026-01-01', proposedAt: '' }] : [] };
    return {};
  } } as unknown as DynamoDBDocumentClient;
  return { client, calls };
}

test('only the four confirmed test UUIDs are allowlisted; unconfirmed, mismatched, arbitrary, and real identities are refused', () => {
  assert.deepEqual(Object.keys(EPISODE_DELETION_POLICY), [
    '0ba64623-47cb-40d8-a395-e1131d5f0b8d',
    'c452570a-f682-49d5-8b4b-0837cf71e47c',
    'faa77c54-e560-435f-9199-6574b84d84ae',
    'bcbfb38a-0bd0-4996-bf9c-ae89f3b86042',
  ]);
  for (const [id, entry] of Object.entries(EPISODE_DELETION_POLICY)) {
    assert.ok(entry?.evidence);
    const matching: PodcastEpisode = {
      ...episode,
      id,
      version: entry!.version,
      title: entry!.title,
      guests: entry!.guests.map(name => ({ name })),
      recordingDate: entry!.recordingDate,
    };
    assert.deepEqual(deletionBlockers(matching, EPISODE_DELETION_POLICY), []);
    assert.ok(deletionBlockers({ ...matching, title: 'Different Title' }, EPISODE_DELETION_POLICY).includes('Confirmed episode identity fields changed'));
    assert.ok(deletionBlockers({ ...matching, guests: [{ name: 'Different Guest' }] }, EPISODE_DELETION_POLICY).includes('Confirmed episode identity fields changed'));
    assert.ok(deletionBlockers({ ...matching, recordingDate: '2026-12-31' }, EPISODE_DELETION_POLICY).includes('Confirmed episode identity fields changed'));
  }
  assert.ok(deletionBlockers(episode, { [episode.id]: null }).includes('Exact episode identity is not confirmed'));
  for (const id of ['unknown', '12182f05-0dc0-4e75-9232-02eb0a3b1541', '622b0b8b-817d-4bf8-be94-1be467406810', 'aedaf06e-187f-48c7-8096-477d34db097f']) {
    assert.ok(deletionBlockers({ ...episode, id }, EPISODE_DELETION_POLICY).includes('Episode is not allowlisted'));
  }
});

test('confirmed identity and version do not override cancelled/publication safeguards', () => {
  assert.deepEqual(deletionBlockers(episode, confirmed), []);
  for (const changes of [{ version: 3 }, { status: 'booked' }, { season: 25 }, { episode: 1 }, { releaseDate: '2026-01-01' }, { websiteSlug: 'real' }, { scheduleSourceKey: 'real' }, { links: { youtube: 'https://example.test' } }, { publication: { website: {} } }]) {
    assert.ok(deletionBlockers({ ...episode, ...changes } as PodcastEpisode, confirmed).length);
  }
});

test('preview is read-only and stale Card does not block an authorized delete', async () => {
  const { client, calls } = storage();
  assert.equal((await previewEpisodeDeletion(client, episode, confirmed)).cardState, 'stale');
  assert.ok(calls.every(name => ['GetCommand', 'QueryCommand', 'ScanCommand'].includes(name)));
  assert.equal((await executeEpisodeDeletion(client, episode, confirmed)).deleted, true);
  assert.equal(calls.filter(name => name === 'DeleteCommand').length, 1);
});

test('references block deletion; released holds allow it; version conflicts propagate', async () => {
  for (const options of [{ card: true }, { tasks: true }, { hold: 'tentative' }, { hold: 'confirmed' }]) {
    const { client, calls } = storage(options);
    assert.equal((await executeEpisodeDeletion(client, episode, confirmed)).deleted, false);
    assert.ok(!calls.includes('DeleteCommand'));
  }
  assert.equal((await executeEpisodeDeletion(storage({ hold: 'released' }).client, episode, confirmed)).deleted, true);
  await assert.rejects(executeEpisodeDeletion(storage({ conflict: true }).client, episode, confirmed), /changed/);
});

test('HTTP requires admin, explicit confirmation and server allowlist; dry-run uses GET only', async () => {
  const path = `/api/podcast-episodes/${episode.id}`;
  const { client, calls } = storage();
  const preview = await handlePodcastEpisodeRoutes(path, 'GET', { httpMethod: 'GET', path, headers: {}, queryStringParameters: { deletePreview: 'true' } }, client);
  assert.equal(preview.statusCode, 200);
  assert.equal(JSON.parse(preview.body).dryRun, true);
  assert.equal((await handlePodcastEpisodeRoutes(path, 'DELETE', { httpMethod: 'GET', path, headers: {}, body: JSON.stringify({ version: 2 }) }, client)).statusCode, 400);
  assert.equal((await handlePodcastEpisodeRoutes(path, 'DELETE', { httpMethod: 'GET', path, headers: {}, body: JSON.stringify({ version: 2, yes: true }) }, client)).statusCode, 409);
  assert.ok(!calls.includes('DeleteCommand'));
  const operator = storage({ operator: true });
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await handlePodcastEpisodeRoutes(path, method, { httpMethod: method, path, headers: { 'x-user-id': 'operator' }, queryStringParameters: { deletePreview: 'true' }, body: JSON.stringify({ version: 2, yes: true }) }, operator.client)).statusCode, 403);
  }
});
