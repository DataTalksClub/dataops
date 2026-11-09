import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createTask, getTaskConsistent, listTasksByCardConsistent, listTasksByStatus, updateTask } from '../src/db/tasks';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { getWorkspaceSettings, setDefaultAssignee } from '../src/db/workspaceSettings';
import { PORTAL_EDIT_TASK_SOURCE } from '../src/sponsorDocs/portalEditTask';
import { templateLink } from './helpers/cardTemplate';

describe('portal doc edits create one open Task for the owner team', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let staffUserId: string;
  let staffToken: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    const user = await createUser(client, { email: 'orin@datatalks.club', name: 'Orin', passwordHash: 'unused', role: 'admin' });
    staffUserId = user.id;
    staffToken = (await createSession(client, staffUserId)).token;
    const settings = await getWorkspaceSettings(client);
    await setDefaultAssignee(client, { defaultAssigneeId: staffUserId, expectedVersion: settings.version });
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  const staffReq = (method: string, path: string, body?: unknown) => handler({
    httpMethod: method, path,
    headers: { authorization: `Bearer ${staffToken}`, 'x-user-id': staffUserId, host: 'ops.dtcdev.click', 'x-forwarded-proto': 'https' },
    queryStringParameters: null, body: body === undefined ? null : JSON.stringify(body),
  }, {});

  const externalPut = (docId: string, code: string, content: Record<string, string>, status?: string) => handler({
    httpMethod: 'PUT', path: `/api/sponsor-docs/${docId}`,
    headers: { host: 'ops.dtcdev.click', 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.7', 'x-sponsor-doc-anonymous': 'true', 'x-sponsor-doc-code': code },
    queryStringParameters: null, body: JSON.stringify({ content, ...(status ? { status } : {}) }),
  }, {});

  const portalTasks = async (cardId: string) =>
    (await listTasksByCardConsistent(client, cardId)).filter((t) => t.source === PORTAL_EDIT_TASK_SOURCE);

  async function close(taskId: string) {
    const task = await getTaskConsistent(client, taskId);
    await updateTask(client, taskId, { currentTask: task!, expectedVersion: task!.version, patch: { status: 'done', completedBy: staffUserId, completedAt: new Date().toISOString() } });
  }

  async function createDoc(cardId: string, template: string) {
    const res = await staffReq('POST', '/api/sponsor-docs', { cardId, template, autoSendEmail: false });
    assert.strictEqual(res.statusCode, 201, res.body);
    return JSON.parse(res.body).doc as { id: string; accessCode: string; docUrl: string; content: Record<string, string> };
  }

  it('sponsor doc: burst of edits -> one open Task; edit after close -> new Task', async () => {
    const card = await createCard(client, {
      ...templateLink(), title: '[Newsletter] (02 NOV 2026) #310 - Acme', anchorDate: '2026-11-02', sponsor: 'Acme',
      cardLinks: [{ name: 'Sponsorship document', url: '' }],
    });
    await createTask(client, { description: 'Prepare newsletter', date: '2026-11-02', cardId: card.id });
    const doc = await createDoc(card.id, 'newsletter-main');
    assert.strictEqual((await portalTasks(card.id)).length, 0, 'staff creation raises nothing');

    assert.strictEqual((await externalPut(doc.id, doc.accessCode, { subjectLine: 'First subject' })).statusCode, 200);
    let tasks = await portalTasks(card.id);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].assigneeId, staffUserId);
    assert.strictEqual(tasks[0].status, 'todo');
    assert.strictEqual(tasks[0].link, doc.docUrl);
    assert.ok(!tasks[0].link!.includes('code='), 'task link never carries the access code');
    assert.match(tasks[0].description, /Acme/);
    assert.match(tasks[0].comment!, /subjectLine: \(empty\) → "First subject"/);

    // Same value again changes nothing -> no note, no task
    await externalPut(doc.id, doc.accessCode, { subjectLine: 'First subject' });
    // Burst
    await externalPut(doc.id, doc.accessCode, { subjectLine: 'Second subject' });
    await externalPut(doc.id, doc.accessCode, { previewText: 'Preview' });
    tasks = await portalTasks(card.id);
    assert.strictEqual(tasks.length, 1, 'burst stays on one open task');
    const notes = tasks[0].notesLog!.map((n) => n.text);
    assert.strictEqual(notes.length, 3);
    assert.match(notes[1], /"First subject" → "Second subject"/);
    assert.match(notes[2], /previewText/);

    await close(tasks[0].id);
    const third = await externalPut(doc.id, doc.accessCode, { subjectLine: 'Third subject' });
    assert.strictEqual(third.statusCode, 200, third.body);
    tasks = await portalTasks(card.id);
    assert.strictEqual(tasks.length, 2, 'edit after close opens a new task');
    assert.strictEqual(tasks.filter((t) => t.status === 'todo').length, 1);
  });

  it('staff edits do not raise a task', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Newsletter] (09 NOV 2026) #311 - Globex', anchorDate: '2026-11-09', sponsor: 'Globex', cardLinks: [{ name: 'Sponsorship document', url: '' }] });
    const doc = await createDoc(card.id, 'newsletter-main');
    const res = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { content: { subjectLine: 'Staff wording' } });
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual((await portalTasks(card.id)).length, 0);
  });

  it('guest doc (podcast episode brief): edits raise one task naming doc, card and fields', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Podcast] 2026-12-01 - Jane Doe', anchorDate: '2026-12-01', people: ['Jane Doe'] });
    await createPodcastEpisode(client, { title: 'Shipping ML features', guests: [{ name: 'Jane Doe' }], status: 'booked', recordingDate: '2026-12-01', cardId: card.id });
    const doc = await createDoc(card.id, 'podcast-episode-brief');
    const fieldKey = Object.keys(doc.content).find((key) => doc.content[key] === '' ) as string;
    assert.ok(fieldKey, 'brief has an editable field');

    assert.strictEqual((await externalPut(doc.id, doc.accessCode, { [fieldKey]: 'Guest wrote this' })).statusCode, 200);
    await externalPut(doc.id, doc.accessCode, { [fieldKey]: 'Guest rewrote this' });
    const tasks = await portalTasks(card.id);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].cardId, card.id);
    assert.match(tasks[0].description, /Jane Doe/);
    assert.ok(tasks[0].tags!.includes(`doc:${doc.id}`));
    assert.strictEqual(tasks[0].link, doc.docUrl);
    assert.match(tasks[0].notesLog!.map((n) => n.text).join('\n'), new RegExp(`${fieldKey}: "Guest wrote this" → "Guest rewrote this"`));
  });

  it('different docs on one card keep separate tasks', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Podcast] 2026-12-08 - Max Roe', anchorDate: '2026-12-08', people: ['Max Roe'] });
    await createPodcastEpisode(client, { title: 'Data contracts', guests: [{ name: 'Max Roe' }], status: 'booked', recordingDate: '2026-12-08', cardId: card.id });
    const a = await createDoc(card.id, 'podcast-episode-brief');
    const b = await createDoc(card.id, 'podcast');
    const key = (d: { content: Record<string, string> }) => Object.keys(d.content).find((k) => d.content[k] === '') as string;
    await externalPut(a.id, a.accessCode, { [key(a)]: 'x' });
    const resB = await externalPut(b.id, b.accessCode, { [key(b)]: 'y' });
    assert.strictEqual(resB.statusCode, 200, resB.body);
    assert.strictEqual((await portalTasks(card.id)).length, 2);
  });

  it('card archived since the last task closed: edit still opens a task naming the card', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Newsletter] (16 NOV 2026) #312 - Initech', anchorDate: '2026-11-16', sponsor: 'Initech', cardLinks: [{ name: 'Sponsorship document', url: '' }] });
    const only = await createTask(client, { description: 'Only task', date: '2026-11-16', cardId: card.id });
    const doc = await createDoc(card.id, 'newsletter-main');
    await close(only.id); // archives the card
    assert.strictEqual((await externalPut(doc.id, doc.accessCode, { subjectLine: 'Late edit' })).statusCode, 200);
    await externalPut(doc.id, doc.accessCode, { subjectLine: 'Later edit' });
    const open = (await listTasksByStatus(client, 'todo')).filter((t) => t.source === PORTAL_EDIT_TASK_SOURCE && t.tags?.includes(`doc:${doc.id}`));
    assert.strictEqual(open.length, 1, 'cardless dedupe finds the open task');
    assert.ok(open[0].tags!.includes(`card:${card.id}`));
    assert.match(open[0].description, /Initech/);
    assert.strictEqual(open[0].notesLog!.length, 2);
  });
});
