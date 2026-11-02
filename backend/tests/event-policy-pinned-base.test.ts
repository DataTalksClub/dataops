import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createTemplate } from '../src/db/templates';
import { resolveCardEventPolicy } from '../src/events/service';
import type { Card } from '../src/types';

const policy = {
  timeZone: 'Europe/Berlin', durationMinutes: 60, windows: { midday: '12:30', evening: '17:00' }, expiresDays: 7,
  titles: { proposed: '(Proposal) {title}', approved: '{title}' }, description: '{topic}', inviteText: '',
  guests: { proposal: false, approved: true, requiredEmails: [], leadMinutes: 5 }, zoom: { enabled: false },
  calendarAcceptance: { enabled: false, quorum: 'any' },
  notifications: Object.fromEntries(['propose', 'approve', 'reschedule', 'release'].map((t) => [t, { calendar: 'all', emails: [] }])),
};

describe('resolveCardEventPolicy on a pinned Git Template (eb5012d8)', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); });
  after(async () => { await stopLocal(); });

  it('falls back to the Git base eventPolicy when the pinned live definition has none', async () => {
    const t = await createTemplate(client, { name: 'Podcast', type: 'podcast-pinned', origin: 'git', pinned: true, base: { eventPolicy: policy }, tasks: [] });
    const r = await resolveCardEventPolicy(client, { id: 'card-1', templateId: t.id } as unknown as Card);
    assert.equal(r.templateId, t.id);
    assert.equal(r.policy.windows.midday, '12:30');
    assert.equal(r.policy.durationMinutes, 60);
  });

  it('still refuses when neither live nor base declares an eventPolicy', async () => {
    const t = await createTemplate(client, { name: 'Plain', type: 'plain-pinned', origin: 'git', pinned: true, base: {}, tasks: [] });
    await assert.rejects(resolveCardEventPolicy(client, { id: 'card-2', templateId: t.id } as unknown as Card), /does not declare an eventPolicy/);
  });
});
