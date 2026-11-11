import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTitle, suggestedTitle, titleReviewError } from '../src/events/titleQuality';
import { inspectEventTitle, approveEventTitle } from '../src/events/titleReview';
import { validateTaskTitleQuality, validateDoneProofOnCreate } from '../src/routes/taskValidation';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createTemplate } from '../src/db/templates';
import { createCard, getCardConsistent, updateCard } from '../src/db/cards';
import { createPodcastEpisode, updatePodcastEpisode } from '../src/db/podcastEpisodes';
import { putCalendarHold, getCalendarHold } from '../src/db/calendarHolds';
import { buildHold } from '../src/calendar/holds';
import { handler } from '../src/handler';
import { templateLink } from './helpers/cardTemplate';

describe('event title spelling and review', () => {
  it('handles small words, colon boundaries, acronyms, hyphens and brand spellings', () => {
    assert.equal(suggestedTitle('the use of SQL and AI: a guide to CI/CD with MCP and Ad-Hoc iPhone Tools'), 'The Use of SQL and AI: A Guide to CI/CD with MCP and Ad-Hoc iPhone Tools');
    for (const word of 'a an the and or of to in on for with at'.split(' ')) {
      const capped = word[0].toUpperCase()+word.slice(1);
      assert.equal(suggestedTitle(`${word} Guide: ${word} Guide ${word.toUpperCase()} SQL`), `${capped} Guide: ${capped} Guide ${word} SQL`);
    }
    assert.equal(suggestedTitle('Using dbt and pandas with scikit-learn'), 'Using dbt and pandas with scikit-learn');
    assert.equal(suggestedTitle('Using `some_code` at https://example.com/foo with eBay'), 'Using `some_code` at https://example.com/foo with eBay');
    assert.equal(checkTitle('AI with Vincent van der Meer', ['Vincent van der Meer']).issues.length, 0);
  });
  it('flags guest-only placeholders, allows drafts to plan and requires review', () => {
    assert.ok(checkTitle('Podcast conversation with Julien').issues.some(i => i.code === 'guest_only'));
    assert.ok(checkTitle('Podcast with Julien', ['Julien']).issues.some(i => i.code === 'guest_only'));
    assert.equal(checkTitle('Workshop with SQL').issues.length, 0, 'no universal semantic regex');
    assert.equal(checkTitle('TBD: Topic Needed').planningAllowed, true);
    assert.match(titleReviewError('TBD', undefined)!, /planning/);
    assert.ok(checkTitle('Databricks FDE').issues.some(i => i.code === 'breadth_review'));
    assert.equal(checkTitle('Forward Deployed Engineering').issues.length, 0);
    assert.match(titleReviewError('Forward Deployed Engineering', undefined)!, /approve-title/);
  });
});

describe('all-event title approval uses only internal review writes', () => {
  before(async () => { await startLocal(); await createTables(await getClient()); });
  after(async () => { await stopLocal(); });
  it('reviews all event types with CAS, invalidates stale review and gates configured completion', async () => {
    const client = await getClient();
    for (const type of ['workshop', 'webinar', 'podcast', 'custom-event']) {
      const template = await createTemplate(client, { name: `Title ${type}`, type, taskDefinitions: [] });
      const card = await createCard(client, { title: 'Forward Deployed Engineering', ...templateLink(template) });
      assert.equal((await inspectEventTitle(client, card.id)).approved, false);
      const task = { cardId: card.id, validation: { titleQuality: 'topic-approval' } };
      assert.match((await validateTaskTitleQuality(client, task))!, /approve-title/);
      await assert.rejects(approveEventTitle(client, card.id, { expectedVersion: card.version, meaningful: true }, 'operator'), /broad/);
      const approved = await approveEventTitle(client, card.id, { expectedVersion: card.version, meaningful: true, broad: true, consistent: true, note: 'Agreed audience skill; all title copies checked' }, 'operator');
      assert.equal(approved.approved, true);
      assert.equal((await getCardConsistent(client, card.id))!.title, card.title, 'does not rename');
      assert.equal(await validateTaskTitleQuality(client, task), null);
      await assert.rejects(approveEventTitle(client, card.id, { expectedVersion: card.version }, 'operator'), /Card changed/);
      await updateCard(client, card.id, { expectedVersion: approved.expectedVersion, patch: { title: 'Building AI Systems' } });
      assert.match((await validateDoneProofOnCreate(client, task))!, /approve-title/);
      assert.equal(await validateTaskTitleQuality(client, { cardId: card.id }), null, 'ordinary tasks and invitations have no new gate');
    }
  });
  it('detects episode/Card/hold drift without changing confirmed copies', async () => {
    const client = await getClient();
    const template = await createTemplate(client, { name: 'Copies', type: 'podcast', cardTitle: '{title} · {guests}', taskDefinitions: [] });
    const card = await createCard(client, { title: 'Building AI Systems · Example Guest', ...templateLink(template) });
    const episode = await createPodcastEpisode(client, { title: 'Building AI Systems', guests: [{ name: 'Example Guest' }], cardId: card.id, status: 'booked' });
    const hold = { ...buildHold({ date: '2038-10-29', title: 'Old Confirmed Topic', topic: 'Old Confirmed Topic', cardId: card.id, durationMinutes: 60 }, 'operator'), id: `hold_${card.id}`, status: 'confirmed' as const };
    await putCalendarHold(client, hold);
    const check = await inspectEventTitle(client, episode.id);
    assert.deepEqual(check.mismatches, ['hold title/topic']);
    await assert.rejects(approveEventTitle(client, card.id, { expectedVersion: card.version, meaningful: true, broad: true, consistent: true, note: 'checked' }, 'operator'), /Reconcile/);
    assert.equal((await getCalendarHold(client, hold.id))!.title, 'Old Confirmed Topic');
    await updatePodcastEpisode(client, episode, { title: 'Different Agreed Topic' });
    assert.ok((await inspectEventTitle(client, card.id)).mismatches.includes('Card'));
  });
  it('returns save-time warnings and permits a visibly draft Card', async () => {
    const client = await getClient();
    const template = await createTemplate(client, { name: 'Draft', type: 'workshop', taskDefinitions: [] });
    const card = await createCard(client, { title: 'Original Topic', ...templateLink(template) });
    const response = await handler({ httpMethod: 'PUT', path: `/api/cards/${card.id}`, body: JSON.stringify({ title: 'TBD: Topic Needed', expectedVersion: card.version }), headers: { 'x-user-id': 'test-operator' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).titleQuality.draft, true);
    await assert.rejects(approveEventTitle(client, card.id, { expectedVersion: card.version + 1, meaningful: true, broad: true, consistent: true, note: 'checked' }, 'operator'), /Draft/);
  });
  it('checks arbitrary titles through the authenticated API without writes', async () => {
    const response = await handler({ httpMethod: 'POST', path: '/api/events/title-check', body: JSON.stringify({ title: 'finding a job in computer vision' }), headers: { 'x-user-id': 'test-operator' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).suggestedTitle, 'Finding a Job in Computer Vision');
  });
});
