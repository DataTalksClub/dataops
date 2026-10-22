import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createTemplate, instantiateTemplate } from '../src/db/templates';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import {
  evaluateRequiredWhenSignal,
  readRequiredWhen,
  resolveConditionalValidation,
} from '../src/cards/conditionalRequired';
import { templateLink } from './helpers/cardTemplate';

const ANCHOR = '2026-10-28';

async function makeTemplate(client: DynamoDBDocumentClient, validation: Record<string, unknown>) {
  return createTemplate(client, {
    name: 'Newsletter template',
    taskDefinitions: [
      { refId: 'fill-event-block', description: 'Fill up "Event" block', offsetDays: 0 },
      {
        refId: 'fill-podcast-block',
        description: 'Fill up "Podcast" block',
        offsetDays: 0,
        validation,
      },
    ],
  });
}

async function instantiateOnFreshCard(
  client: DynamoDBDocumentClient,
  templateId: string,
  anchorDate: string,
) {
  const cardId = `card-${Math.random().toString(36).slice(2)}`;
  await createCard(client, { ...templateLink(), id: cardId, title: 'Weekly email', anchorDate });
  return instantiateTemplate(client, templateId, cardId, anchorDate);
}

const podcastValidation = () => ({
  optional: true,
  requiredWhen: { signal: 'podcast-release-previous-week', windowDays: 7 },
  skipClosure: { allowedStatuses: ['no podcast this week'] },
});

describe('conditional requiredness', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });

  after(stopLocal);

  it('marks the Podcast block required when an episode released the previous week', async () => {
    await createPodcastEpisode(client, {
      title: 'Synthetic release',
      guests: [{ name: 'Ada Example' }],
      releaseDate: '2026-10-22',
      status: 'published',
    });
    const template = await makeTemplate(client, podcastValidation());
    const tasks = await instantiateOnFreshCard(client, template.id, ANCHOR);
    const podcast = tasks.find((task) => task.templateTaskRef === 'fill-podcast-block');
    assert.ok(podcast);
    const validation = podcast.validation as Record<string, unknown>;
    assert.strictEqual(validation.optional, false);
    assert.strictEqual(validation.requiredReason, 'Podcast released last week');
    assert.strictEqual(validation.skipClosure, undefined);
    const event = tasks.find((task) => task.templateTaskRef === 'fill-event-block');
    assert.deepStrictEqual(event?.validation, undefined);
  });

  it('keeps the Podcast block optional with its N/A path when nothing released', async () => {
    const template = await makeTemplate(client, podcastValidation());
    // Far from the October release above: the window is quiet.
    const tasks = await instantiateOnFreshCard(client, template.id, '2026-11-25');
    const podcast = tasks.find((task) => task.templateTaskRef === 'fill-podcast-block');
    assert.ok(podcast);
    const validation = podcast.validation as Record<string, unknown>;
    assert.strictEqual(validation.optional, true);
    assert.strictEqual(validation.optionalNote, 'No podcast release last week');
    assert.deepStrictEqual(
      (validation.skipClosure as Record<string, unknown>).allowedStatuses,
      ['no podcast this week'],
    );
  });

  it('ignores scheduled-but-unreleased and undated episodes', async () => {
    await createPodcastEpisode(client, {
      title: 'Synthetic scheduled',
      guests: [{ name: 'Grace Sample' }],
      releaseDate: '2026-11-20',
      status: 'scheduled',
    });
    await createPodcastEpisode(client, {
      title: 'Synthetic undated',
      guests: [{ name: 'Alan Sample' }],
      releaseDate: null,
      status: 'published',
    });
    const template = await makeTemplate(client, podcastValidation());
    const tasks = await instantiateOnFreshCard(client, template.id, '2026-11-25');
    const podcast = tasks.find((task) => task.templateTaskRef === 'fill-podcast-block');
    assert.strictEqual((podcast?.validation as Record<string, unknown>).optional, true);
  });

  it('fails loudly on unknown signals and malformed declarations', async () => {
    assert.deepStrictEqual(readRequiredWhen(undefined), { config: null, error: null });
    assert.deepStrictEqual(
      readRequiredWhen({ requiredWhen: { enabled: false, signal: 'podcast-release-previous-week' } }),
      { config: null, error: null },
    );
    assert.match(
      readRequiredWhen({ requiredWhen: { signal: '' } }).error || '',
      /signal must be a non-empty string/,
    );
    await assert.rejects(
      evaluateRequiredWhenSignal(client, 'no-such-signal', { anchorDate: ANCHOR, windowDays: 7 }),
      /Unknown conditional-required signal: 'no-such-signal'/,
    );
    const template = await makeTemplate(client, { requiredWhen: { signal: 'no-such-signal' } });
    await assert.rejects(
      instantiateOnFreshCard(client, template.id, ANCHOR),
      /Unknown conditional-required signal/,
    );
    const broken = await makeTemplate(client, { requiredWhen: { signal: '' } });
    await assert.rejects(
      resolveConditionalValidation(client, { refId: 'x', validation: broken.taskDefinitions?.[1]?.validation }, ANCHOR),
      /signal must be a non-empty string/,
    );
  });
});
