import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
import { createUser } from '../src/db/users';
import { humanBearer } from './helpers/human-bearer';
import { setQnaClientForTests } from '../src/qna/service';
import { createQnaClient, type QnaClient, type QnaQuestion } from '../src/qna/client';
import type { LambdaResponse, Template } from '../src/types';

describe('Event card audience Q&A (qna.dtcdev.click)', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let adminUserId: string;
  let adminToken: string;
  let podcast: Template;
  let webinar: Template;
  let workshop: Template;
  let newsletter: Template;
  let closeStep: Template;
  const rooms = new Map<string, { slug: string; state: string; key: string; admins: string[] }>();
  const questions: QnaQuestion[] = [
    { questionId: 'q1', text: 'What is dbt?', authorName: 'Maria', status: 'visible', score: 4, pinned: false, createdAt: '2026-12-01T18:00:00Z', answeredAt: null },
    { questionId: 'q2', text: 'Why Lambda?', authorName: null, status: 'answered', score: 1, pinned: false, createdAt: '2026-12-01T18:05:00Z', answeredAt: '2026-12-01T18:30:00Z' },
  ];
  let failClose = false;
  const fake: QnaClient = {
    async createRoom(input) {
      for (const [id, r] of rooms) if (r.key === input.idempotencyKey) return { roomId: id, slug: r.slug, url: `https://qna.dtcdev.click/r/${r.slug}`, presentUrl: `https://qna.dtcdev.click/admin/rooms/${id}/present`, state: 'open' };
      const id = `room-${rooms.size + 1}`;
      rooms.set(id, { slug: input.slug, state: 'open', key: input.idempotencyKey, admins: [] });
      return { roomId: id, slug: input.slug, url: `https://qna.dtcdev.click/r/${input.slug}`, presentUrl: `https://qna.dtcdev.click/admin/rooms/${id}/present`, state: 'open' };
    },
    async addRoomAdmin(roomId, email) {
      const r = rooms.get(roomId)!;
      if (!r.admins.includes(email)) r.admins.push(email);
    },
    async closeRoom(roomId) {
      if (failClose) throw new Error('Q&A service down');
      const r = rooms.get(roomId)!;
      r.state = 'closed';
      return { roomId, slug: r.slug, url: '', presentUrl: '', state: 'closed' };
    },
    async listQuestions() { return questions; },
  };

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    const user = await createUser(client, { email: 'qna-admin@datatalks.club', name: 'Qna Admin', passwordHash: 'unused', role: 'admin' });
    adminUserId = user.id;
    adminToken = await humanBearer(client, adminUserId);
    setQnaClientForTests(fake);
    const tasks = [{ refId: 'run', description: 'Run the event', offsetDays: 0 }];
    const make = (name: string, type: string, taskDefinitions: any[] = tasks) => createTemplate(client, { name, type, origin: 'git', sourcePath: `workflow-templates/${type}.yaml`, sourceRevision: `sha-${type}`, triggerType: 'manual', taskDefinitions });
    podcast = await make('Podcast', 'podcast');
    webinar = await make('Webinar', 'webinar');
    workshop = await make('Workshop', 'workshop');
    newsletter = await make('Newsletter', 'newsletter');
    closeStep = await make('Webinar close', 'webinar', [{ refId: 'close-qna-save-questions', description: 'Close Q&A and save all audience questions', offsetDays: 1 }]);
  });

  after(async () => {
    setQnaClientForTests(null);
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  function req(method: string, path: string, body?: unknown) {
    return handler({
      httpMethod: method, path,
      headers: { authorization: `Bearer ${adminToken}`, 'x-user-id': adminUserId, host: 'ops.dtcdev.click', 'x-forwarded-proto': 'https' },
      queryStringParameters: null,
      body: body === undefined ? null : JSON.stringify(body),
    }, {}) as Promise<LambdaResponse>;
  }
  const payload = (r: LambdaResponse): any => JSON.parse(r.body);
  const newCard = (templateId: string, title: string) => req('POST', '/api/cards', { templateId, title, anchorDate: '2026-12-01' });

  it('creates one Q&A room per podcast, webinar and workshop Card, grants host admin, and fills announcement', async () => {
    for (const [tpl, title] of [[podcast, 'Podcast One'], [webinar, 'Webinar One With A Very Long Event Title That Exceeds Forty Eight Characters'], [workshop, 'Workshop One']] as const) {
      const res = await newCard(tpl.id, title);
      assert.strictEqual(res.statusCode, 201);
      const card = payload(res).card ?? payload(res);
      assert.match(card.qna.url, /^https:\/\/qna\.dtcdev\.click\/r\//);
      assert.ok(card.qna.slug.length >= 3 && card.qna.slug.length <= 48, `slug ${card.qna.slug} length ${card.qna.slug.length}`);
      assert.deepStrictEqual(rooms.get(card.qna.roomId)?.admins, ['alexey@datatalks.club']);
      const read = payload(await req('GET', `/api/cards/${card.id}`)).card ?? payload(await req('GET', `/api/cards/${card.id}`));
      assert.strictEqual(read.qna.url, card.qna.url);
      const ann = payload(await req('GET', `/api/cards/${card.id}/qna/announcement`));
      assert.strictEqual(ann.qnaUrl, card.qna.url);
      assert.ok(ann.text.includes(card.qna.url));
    }
  });

  it('waits until an undated event Card gets a date before creating its Q&A room', async () => {
    const { createCardFromInput } = await import('../src/cards/createCard');
    const undated = await createCardFromInput(
      client,
      { id: adminUserId, isAdmin: true, testBypass: false },
      { templateId: podcast.id, title: 'Undated Podcast' },
      { provisionalAnchorDate: '2026-12-20' },
    );
    assert.strictEqual(undated.ok, true, !undated.ok ? undated.response.body : '');
    if (!undated.ok) return;
    assert.strictEqual(undated.card.anchorDate, undefined);
    assert.strictEqual(undated.card.qna, undefined);

    const datedRes = await req('PUT', `/api/cards/${undated.card.id}`, {
      anchorDate: '2026-12-20',
      expectedVersion: undated.card.version,
    });
    assert.strictEqual(datedRes.statusCode, 200, datedRes.body);
    const dated = payload(datedRes).card ?? payload(datedRes);
    assert.match(dated.qna.url, /^https:\/\/qna\.dtcdev\.click\/r\//);
    assert.deepStrictEqual(rooms.get(dated.qna.roomId)?.admins, ['alexey@datatalks.club']);
  });

  it('gives other formats no room', async () => {
    const res = await newCard(newsletter.id, 'Newsletter One');
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual((payload(res).card ?? payload(res)).qna, undefined);
  });

  it('keeps card creation working when the Q&A service is down', async () => {
    setQnaClientForTests({ ...fake, createRoom: async () => { throw new Error('down'); } });
    const res = await newCard(webinar.id, 'Webinar Outage');
    assert.strictEqual(res.statusCode, 201);
    const card = payload(res).card ?? payload(res);
    assert.strictEqual(card.qna, undefined);
    setQnaClientForTests(fake);
    const ensured = await req('POST', `/api/cards/${card.id}/qna`);
    assert.strictEqual(ensured.statusCode, 200);
    assert.ok(payload(ensured).qna.url);
    const again = await req('POST', `/api/cards/${card.id}/qna`);
    assert.strictEqual(payload(again).qna.roomId, payload(ensured).qna.roomId);
  });

  it('serves the live questions, then the saved copy after the close step', async () => {
    const created = payload(await newCard(closeStep.id, 'Webinar Close'));
    const c = created.card ?? created;
    const live = payload(await req('GET', `/api/cards/${c.id}/qna/questions`));
    assert.strictEqual(live.source, 'live');
    assert.strictEqual(live.state, 'open');
    assert.strictEqual(live.questions.length, 2);

    const tasks = payload(await req('GET', `/api/cards/${c.id}/tasks`));
    const task = (tasks.tasks ?? tasks).find((t: any) => t.templateTaskRef === 'close-qna-save-questions');
    assert.ok(task, 'close step task exists');

    failClose = true;
    const failed = await req('PUT', `/api/tasks/${task.id}`, { status: 'done', expectedVersion: task.version });
    assert.strictEqual(failed.statusCode, 502);
    failClose = false;

    const done = await req('PUT', `/api/tasks/${task.id}`, { status: 'done', expectedVersion: task.version });
    assert.strictEqual(done.statusCode, 200, done.body);
    const after = payload(await req('GET', `/api/cards/${c.id}`));
    const stored = (after.card ?? after).qna;
    assert.ok(stored.closedAt && stored.questionsSavedAt);
    assert.strictEqual(stored.questions.length, 2);
    const saved = payload(await req('GET', `/api/cards/${c.id}/qna/questions`));
    assert.strictEqual(saved.source, 'saved');
    assert.strictEqual(saved.state, 'closed');
    assert.strictEqual(saved.questions[0].text, 'What is dbt?');
  });

  it('backfills only event Cards that have no room', async () => {
    setQnaClientForTests({ ...fake, createRoom: async () => { throw new Error('down'); } });
    const a = payload(await newCard(podcast.id, 'Podcast Backfill'));
    setQnaClientForTests(fake);
    const result = payload(await req('POST', '/api/cards/qna/backfill'));
    assert.ok(result.created.includes((a.card ?? a).id));
    assert.deepStrictEqual(result.failed, []);
    const second = payload(await req('POST', '/api/cards/qna/backfill'));
    assert.deepStrictEqual(second.created, []);
  });

  it('the real client speaks the DataQnA API without leaking the key', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const http = createQnaClient(async (url: any, init: any) => {
      seen.push({ url: String(url), init });
      const body = String(url).includes('/questions')
        ? { items: [{ question_id: 'a', text: 't', author_name: 'M', anonymous: true, status: 'visible', score: 2, pinned: false, created_at: 'x' }], next_cursor: null }
        : { room_id: 'r1', slug: 's', url: 'https://qna.dtcdev.click/r/s', present_url: 'p', state: 'open' };
      return new Response(JSON.stringify(body), { status: 200 });
    }, async () => 'dq_secret');
    const room = await http.createRoom({ title: 'T', slug: 's', description: 'd', idempotencyKey: 'k' });
    assert.strictEqual(room.url, 'https://qna.dtcdev.click/r/s');
    await http.addRoomAdmin('r1', 'alexey@datatalks.club');
    const qs = await http.listQuestions('r1');
    assert.strictEqual(qs[0].authorName, null);
    assert.strictEqual(seen[0].init.headers.authorization, 'Bearer dq_secret');
    assert.ok(seen[0].url.startsWith('https://qna.dtcdev.click/api/v1/rooms'));
    assert.strictEqual(seen[1].url, 'https://qna.dtcdev.click/api/v1/rooms/r1/admins');
    assert.strictEqual(seen[1].init.body, JSON.stringify({ email: 'alexey@datatalks.club' }));
  });
});
