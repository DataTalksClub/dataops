/**
 * Identity, safe team projection, owner filters, Card ownership, and the
 * server-enforced Task-execution versus Task/Card-administration boundary.
 *
 * The rest of the unit suite runs with `SKIP_AUTH=true`. This file turns the
 * bypass off for its own process and drives real cookie and bearer identity
 * through `route()`, because the contract under test *is* the authorization
 * decision: what an operator may do to a teammate's work, what only an admin
 * may do, and what a deleted, disabled, or unsupported-role actor may never do.
 *
 * Both API prefixes are covered: the canonical `/api/*` surface and the
 * rewritten `/work/api/*` surface the browser uses.
 *
 * All people here are synthetic (`example.test`); no real person, production
 * id, or operational record appears.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createBrowserSession, createSession } from '../src/db/sessions';
import { createUserWithId, updateUser } from '../src/db/users';
import { createCard, getCardConsistent } from '../src/db/cards';
import { createTask, getTaskConsistent } from '../src/db/tasks';
import { route } from '../src/router';
import { hashPassword } from '../src/routes/auth';
import type { Card, LambdaEvent, LambdaResponse, ProjectedCard, Task } from '../src/types';

const AVERY = 'avery-operator';
const MORGAN = 'morgan-teammate';
const CASEY = 'casey-disabled';
const RILEY = 'riley-admin';
const ROWAN = 'rowan-unsupported-role';
const GHOST = 'ghost-teammate-that-was-deleted';

const PORTAL_CONFIG: Record<string, string> = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_JWKS_URL: 'https://issuer.example.test/pool/.well-known/jwks.json',
  AUTH_CLIENT_ID: 'dataops-client',
  AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
  AUTH_LOGOUT_URL: 'https://ops.example.test/',
  AUTH_SESSION_LIFETIME_SECONDS: '3600',
  DATAOPS_DOCS_DOMAIN: '1',
  WORK_ENGINE_AUTH_MODE: 'portal',
};

interface Request {
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  bearer?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

describe('signed-in identity, teammate projections, and the work authorization boundary', () => {
  let client: DynamoDBDocumentClient;
  const savedEnv: Record<string, string | undefined> = {};
  const sessions: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  async function invoke(request: Request): Promise<LambdaResponse> {
    const headers: Record<string, string> = { ...(request.headers || {}) };
    if (request.bearer) headers.authorization = `Bearer ${request.bearer}`;
    if (request.cookie) headers.cookie = `dataops_session=${request.cookie}`;
    const event: LambdaEvent = {
      httpMethod: request.method || 'GET',
      path: request.path,
      queryStringParameters: request.query || null,
      headers,
      body: request.body === undefined ? null : JSON.stringify(request.body),
    };
    return route(event, client);
  }

  function body(response: LambdaResponse): any {
    return JSON.parse(response.body);
  }

  /** Cookie identity needs the portal/docs single-origin configuration. */
  function usePortalCookieMode(): void {
    Object.assign(process.env, PORTAL_CONFIG);
  }

  /** Bearer identity defaults to API-only mode unless a test enables docs-domain portal mode. */
  function useBearerMode(): void {
    for (const key of Object.keys(PORTAL_CONFIG)) delete process.env[key];
  }

  async function seedWork(): Promise<{
    averyCard: Card;
    morganCard: Card;
    unownedCard: Card;
    summaryCard: Card;
  }> {
    const averyCard = await createCard(client, {
      title: 'Avery release checklist', anchorDate: '2031-03-04', ownerId: AVERY,
    });
    const morganCard = await createCard(client, {
      title: 'Morgan event checklist', anchorDate: '2031-03-05', ownerId: MORGAN,
    });
    const unownedCard = await createCard(client, {
      title: 'Legacy imported checklist', anchorDate: '2031-03-06',
    });
    const summaryCard = await createCard(client, {
      title: 'Task assignee summary', anchorDate: '2031-03-07', ownerId: MORGAN,
    });
    await createTask(client, {
      id: 'task-avery', description: 'Avery own task', date: '2031-03-04', assigneeId: AVERY,
    });
    await createTask(client, {
      id: 'task-morgan', description: 'Morgan teammate task', date: '2031-03-04',
      assigneeId: MORGAN, cardId: morganCard.id,
    });
    await createTask(client, {
      id: 'task-unassigned', description: 'Unassigned task', date: '2031-03-04',
    });
    await createTask(client, {
      id: 'task-casey', description: 'Retained disabled-owner task', date: '2031-03-05', assigneeId: CASEY,
    });
    await createTask(client, {
      id: 'task-summary-first', description: 'First summary contributor', date: '2031-03-07',
      assigneeId: CASEY, cardId: summaryCard.id,
    });
    await createTask(client, {
      id: 'task-summary-second', description: 'Second summary contributor', date: '2031-03-07',
      assigneeId: CASEY, cardId: summaryCard.id,
    });
    await createTask(client, {
      id: 'task-ghost', description: 'Retained stale-owner task', date: '2031-03-05', assigneeId: GHOST,
    });
    return {
      averyCard: (await getCardConsistent(client, averyCard.id))!,
      morganCard: (await getCardConsistent(client, morganCard.id))!,
      unownedCard: (await getCardConsistent(client, unownedCard.id))!,
      summaryCard: (await getCardConsistent(client, summaryCard.id))!,
    };
  }

  let work: {
    averyCard: Card;
    morganCard: Card;
    unownedCard: Card;
    summaryCard: Card;
  };

  before(async () => {
    for (const key of [...Object.keys(PORTAL_CONFIG), 'SKIP_AUTH']) savedEnv[key] = process.env[key];
    process.env.SKIP_AUTH = 'false';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);

    await createUserWithId(client, AVERY, { name: 'Avery Operator', email: 'avery@example.test', role: 'operator' });
    await createUserWithId(client, MORGAN, { name: 'Morgan Teammate', email: 'morgan@example.test', role: 'operator' });
    await createUserWithId(client, CASEY, { name: 'Casey Disabled', email: 'casey@example.test', role: 'operator', disabled: true });
    await createUserWithId(client, RILEY, { name: 'Riley Admin', email: 'riley@example.test', role: 'admin' });
    await createUserWithId(client, ROWAN, { name: 'Rowan Unsupported', email: 'rowan@example.test', role: 'auditor' });
    await updateUser(client, CASEY, { passwordHash: await hashPassword('casey-correct-password') });
    await updateUser(client, MORGAN, { passwordHash: await hashPassword('morgan-correct-password') });

    for (const userId of [AVERY, MORGAN, CASEY, RILEY, ROWAN]) {
      sessions[userId] = (await createSession(client, userId)).token;
      cookies[userId] = (await createBrowserSession(client, userId, { lifetimeSeconds: 3600 })).token;
    }
    work = await seedWork();
  });

  after(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await stopLocal();
  });

  beforeEach(() => {
    useBearerMode();
    process.env.SKIP_AUTH = 'false';
  });

  // ── Identity ───────────────────────────────────────────────────────────────

  it('returns the same signed-in identity from /api/me and /work/api/me for a bearer session', async () => {
    const canonical = body(await invoke({ path: '/api/me', bearer: sessions[AVERY] }));
    const work = body(await invoke({ path: '/work/api/me', bearer: sessions[AVERY] }));
    assert.deepStrictEqual(canonical, work);
    assert.strictEqual(canonical.user.id, AVERY);
    assert.strictEqual(canonical.user.name, 'Avery Operator');
    assert.strictEqual(canonical.user.email, 'avery@example.test');
    assert.strictEqual(canonical.user.role, 'operator');
    assert.strictEqual(canonical.user.disabled, false);
    assert.strictEqual(canonical.user.passwordHash, undefined);
    assert.strictEqual(canonical.token, undefined);
  });

  it('returns the same signed-in identity from /api/me and /work/api/me for a browser cookie', async () => {
    usePortalCookieMode();
    const canonical = await invoke({ path: '/api/me', cookie: cookies[MORGAN] });
    const proxied = await invoke({ path: '/work/api/me', cookie: cookies[MORGAN] });
    assert.strictEqual(canonical.statusCode, 200);
    assert.deepStrictEqual(body(canonical), body(proxied));
    assert.strictEqual(body(canonical).user.id, MORGAN);
    assert.strictEqual(body(canonical).user.disabled, false);
  });

  it('normalizes /work/api before docs-domain authorization for bearer identity', async () => {
    usePortalCookieMode();
    const requests: Request[] = [
      { path: '/api/me', bearer: sessions[AVERY] },
      { path: '/work/api/me', bearer: sessions[AVERY] },
      { path: '/api/me', bearer: 'not-a-real-token' },
      { path: '/work/api/me', bearer: 'not-a-real-token' },
      { path: '/api/me', bearer: sessions[CASEY] },
      { path: '/work/api/me', bearer: sessions[CASEY] },
    ];

    const responses = await Promise.all(requests.map(invoke));
    assert.deepStrictEqual(responses.map((response) => response.statusCode), [200, 200, 401, 401, 401, 401]);
    assert.deepStrictEqual(body(responses[0]), body(responses[1]));
    assert.strictEqual(body(responses[0]).user.id, AVERY);
    assert.deepStrictEqual(body(responses[2]), { error: 'Unauthorized' });
    assert.deepStrictEqual(body(responses[3]), { error: 'Unauthorized' });
    assert.deepStrictEqual(body(responses[4]), { error: 'Unauthorized' });
    assert.deepStrictEqual(body(responses[5]), { error: 'Unauthorized' });
  });

  it('rejects disabled-password login without revealing account state', async () => {
    const login = async (password: string): Promise<LambdaResponse> => invoke({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'casey@example.test', password },
    });

    const expected = {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":"Invalid email or password"}',
    } satisfies Partial<LambdaResponse>;
    assert.deepStrictEqual(await login('casey-correct-password'), expected);
    assert.deepStrictEqual(await login('casey-wrong-password'), expected);
  });

  it('aligns rewritten password-login availability with the configured auth mode', async () => {
    process.env.DATAOPS_DOCS_DOMAIN = '1';
    delete process.env.WORK_ENGINE_AUTH_MODE;
    for (const key of ['AUTH_BASE_URL', 'AUTH_ISSUER', 'AUTH_JWKS_URL', 'AUTH_CLIENT_ID', 'AUTH_CALLBACK_URL', 'AUTH_LOGOUT_URL']) {
      delete process.env[key];
    }

    const canonical = await invoke({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'morgan@example.test', password: 'morgan-correct-password' },
    });
    const proxied = await invoke({
      method: 'POST',
      path: '/work/api/auth/login',
      body: { email: 'morgan@example.test', password: 'morgan-correct-password' },
    });
    assert.strictEqual(canonical.statusCode, 200);
    assert.strictEqual(proxied.statusCode, 200);
    assert.deepStrictEqual(body(canonical).user, body(proxied).user);
    assert.strictEqual(body(proxied).user.id, MORGAN);
    assert.strictEqual(body(proxied).user.passwordHash, undefined);

    const disabled = await invoke({
      method: 'POST',
      path: '/work/api/auth/login',
      body: { email: 'casey@example.test', password: 'casey-correct-password' },
    });
    assert.deepStrictEqual(disabled, {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: '{"error":"Invalid email or password"}',
    } satisfies Partial<LambdaResponse>);

    usePortalCookieMode();
    const portalCanonical = await invoke({
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'morgan@example.test', password: 'morgan-correct-password' },
    });
    const portalProxied = await invoke({
      method: 'POST',
      path: '/work/api/auth/login',
      body: { email: 'morgan@example.test', password: 'morgan-correct-password' },
    });
    assert.deepStrictEqual(portalCanonical, {
      statusCode: 404,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: '{"error":"Not found"}',
    } satisfies Partial<LambdaResponse>);
    assert.deepStrictEqual(portalProxied, portalCanonical);
  });

  it('answers a missing, unknown, disabled, or deleted identity with JSON 401 at both prefixes', async () => {
    usePortalCookieMode();
    const deletedSession = (await createSession(client, GHOST)).token;
    const cases: Request[] = [
      { path: '/api/me' },
      { path: '/work/api/me' },
      { path: '/api/me', bearer: 'not-a-real-token' },
      { path: '/api/me', cookie: 'not-a-real-cookie' },
      { path: '/api/me', cookie: cookies[CASEY] },
      { path: '/work/api/me', cookie: cookies[CASEY] },
      { path: '/api/me', bearer: deletedSession },
    ];
    for (const request of cases) {
      const response = await invoke(request);
      assert.strictEqual(response.statusCode, 401, `${request.path} -> ${response.statusCode}`);
      const contentType = Object.entries(response.headers || {})
        .find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
      assert.match(String(contentType), /application\/json/);
      assert.deepStrictEqual(body(response), { error: 'Unauthorized' });
    }
  });

  // ── Safe team directory ────────────────────────────────────────────────────

  it('projects team members without email, password, session, or avatar data', async () => {
    const response = await invoke({ path: '/api/team-members', bearer: sessions[AVERY] });
    assert.strictEqual(response.statusCode, 200);
    const members = body(response).teamMembers as Record<string, unknown>[];
    const ids = members.map((member) => member.id);
    assert.deepStrictEqual([...ids].sort(), [AVERY, CASEY, MORGAN, RILEY].sort());
    for (const member of members) {
      assert.deepStrictEqual(
        Object.keys(member).sort(),
        ['active', 'available', 'disabled', 'id', 'name', 'role'],
      );
    }
    assert.strictEqual(response.body.includes('example.test'), false);
    assert.strictEqual(response.body.includes('passwordHash'), false);
    assert.strictEqual(response.body.includes(sessions[AVERY]), false);
  });

  it('keeps a disabled member listed as unavailable so historical ownership resolves', async () => {
    const members = body(await invoke({ path: '/api/team-members', bearer: sessions[RILEY] })).teamMembers;
    const casey = members.find((member: { id: string }) => member.id === CASEY);
    assert.deepStrictEqual(casey, {
      id: CASEY, name: 'Casey Disabled', role: 'operator', active: false, disabled: true, available: true,
    });
    const morgan = members.find((member: { id: string }) => member.id === MORGAN);
    assert.strictEqual(morgan.active, true);
    assert.strictEqual(morgan.disabled, false);
  });

  it('serves the same team projection from the rewritten /work/api prefix', async () => {
    const canonical = await invoke({ path: '/api/team-members', bearer: sessions[AVERY] });
    const proxied = await invoke({ path: '/work/api/team-members', bearer: sessions[AVERY] });
    assert.strictEqual(proxied.statusCode, 200);
    assert.deepStrictEqual(body(proxied), body(canonical));
  });

  it('refuses team reads for unsupported-role, disabled, and unauthenticated actors', async () => {
    const unsupported = await invoke({ path: '/api/team-members', bearer: sessions[ROWAN] });
    assert.strictEqual(unsupported.statusCode, 403);
    assert.strictEqual(body(unsupported).code, 'team_read_forbidden');

    usePortalCookieMode();
    const disabled = await invoke({ path: '/api/team-members', cookie: cookies[CASEY] });
    assert.strictEqual(disabled.statusCode, 401);

    useBearerMode();
    const anonymous = await invoke({ path: '/api/team-members' });
    assert.strictEqual(anonymous.statusCode, 401);
  });

  it('exposes no team mutation surface', async () => {
    const response = await invoke({ method: 'POST', path: '/api/team-members', bearer: sessions[RILEY], body: { name: 'New' } });
    assert.strictEqual(response.statusCode, 405);
  });

  // ── Owner filters and deep links ───────────────────────────────────────────

  function descriptions(response: LambdaResponse): string[] {
    return (body(response).tasks as Task[]).map((task) => task.description).sort();
  }

  it('scopes tasks to the verified actor for owner=me at both prefixes', async () => {
    const canonical = await invoke({ path: '/api/tasks', query: { owner: 'me' }, bearer: sessions[AVERY] });
    assert.strictEqual(canonical.statusCode, 200);
    assert.deepStrictEqual(descriptions(canonical), ['Avery own task']);
    assert.deepStrictEqual(body(canonical).owner, {
      id: AVERY, name: 'Avery Operator', role: 'operator', active: true, disabled: false, available: true,
    });
    const proxied = await invoke({ path: '/work/api/tasks', query: { owner: 'me' }, bearer: sessions[AVERY] });
    assert.deepStrictEqual(body(proxied), body(canonical));
  });

  it('resolves owner=me from the server session, not from a spoofed identity header', async () => {
    const response = await invoke({
      path: '/api/tasks',
      query: { owner: 'me' },
      bearer: sessions[AVERY],
      headers: { 'x-user-id': MORGAN },
    });
    assert.deepStrictEqual(descriptions(response), ['Avery own task']);
    assert.strictEqual(body(response).owner.id, AVERY);
  });

  it('returns a teammate scope with a safe assignee projection and no peer email', async () => {
    const response = await invoke({ path: '/api/tasks', query: { owner: MORGAN }, bearer: sessions[AVERY] });
    assert.deepStrictEqual(descriptions(response), ['Morgan teammate task']);
    const [task] = body(response).tasks;
    assert.strictEqual(task.assigneeId, MORGAN);
    assert.deepStrictEqual(task.assignee, {
      id: MORGAN, name: 'Morgan Teammate', role: 'operator', active: true, disabled: false, available: true,
    });
    assert.strictEqual(response.body.includes('morgan@example.test'), false);
  });

  it('separates team, unassigned, disabled-owner, and stale-owner scopes', async () => {
    const team = await invoke({ path: '/api/tasks', query: { owner: 'team' }, bearer: sessions[AVERY] });
    assert.deepStrictEqual(descriptions(team), ['Avery own task', 'Morgan teammate task']);
    assert.strictEqual(body(team).owner, undefined);

    const unassigned = await invoke({ path: '/api/tasks', query: { owner: 'unassigned' }, bearer: sessions[AVERY] });
    assert.deepStrictEqual(descriptions(unassigned), ['Unassigned task']);

    const disabled = await invoke({ path: '/api/tasks', query: { owner: CASEY }, bearer: sessions[AVERY] });
    assert.deepStrictEqual(descriptions(disabled), [
      'First summary contributor',
      'Retained disabled-owner task',
      'Second summary contributor',
    ]);
    assert.deepStrictEqual(body(disabled).owner, {
      id: CASEY, name: 'Casey Disabled', role: 'operator', active: false, disabled: true, available: true,
    });
  });

  it('keeps a stale owner deep link honest instead of falling back to another scope', async () => {
    const response = await invoke({ path: '/api/tasks', query: { owner: GHOST }, bearer: sessions[AVERY] });
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(descriptions(response), ['Retained stale-owner task']);
    assert.deepStrictEqual(body(response).owner, {
      id: GHOST, name: null, role: null, active: false, disabled: false, available: false,
    });
  });

  it('composes owner with an existing date, range, card, or status filter', async () => {
    const withDate = await invoke({
      path: '/api/tasks', query: { date: '2031-03-04', owner: MORGAN }, bearer: sessions[AVERY],
    });
    assert.deepStrictEqual(descriptions(withDate), ['Morgan teammate task']);

    const withRange = await invoke({
      path: '/api/tasks',
      query: { startDate: '2031-03-01', endDate: '2031-03-31', owner: 'unassigned' },
      bearer: sessions[AVERY],
    });
    assert.deepStrictEqual(descriptions(withRange), ['Unassigned task']);

    const withCard = await invoke({
      path: '/api/tasks', query: { cardId: work.morganCard.id, owner: 'me' }, bearer: sessions[AVERY],
    });
    assert.deepStrictEqual(descriptions(withCard), []);

    const withStatus = await invoke({
      path: '/api/tasks', query: { status: 'todo', owner: 'team' }, bearer: sessions[AVERY],
    });
    assert.deepStrictEqual(descriptions(withStatus), ['Avery own task', 'Morgan teammate task']);
  });

  it('rejects an empty owner value and still requires at least one filter', async () => {
    const empty = await invoke({ path: '/api/tasks', query: { owner: '  ' }, bearer: sessions[AVERY] });
    assert.strictEqual(empty.statusCode, 400);
    const none = await invoke({ path: '/api/tasks', bearer: sessions[AVERY] });
    assert.strictEqual(none.statusCode, 400);
    assert.match(body(none).error, /owner/);
  });

  it('refuses task reads for unsupported-role and unauthenticated actors', async () => {
    const unsupported = await invoke({ path: '/api/tasks', query: { owner: 'team' }, bearer: sessions[ROWAN] });
    assert.strictEqual(unsupported.statusCode, 403);
    assert.strictEqual(body(unsupported).code, 'team_read_forbidden');
    const anonymous = await invoke({ path: '/api/tasks', query: { owner: 'team' } });
    assert.strictEqual(anonymous.statusCode, 401);
  });

  // ── Card ownership ─────────────────────────────────────────────────────────

  it('gives an operator-created Card that operator as its owner', async () => {
    const response = await invoke({
      method: 'POST', path: '/api/cards', bearer: sessions[AVERY],
      body: { title: 'Avery created card', anchorDate: '2031-04-01' },
    });
    assert.strictEqual(response.statusCode, 201);
    assert.strictEqual(body(response).card.ownerId, AVERY);
    assert.strictEqual(body(response).card.owner.name, 'Avery Operator');
    const persisted = await getCardConsistent(client, body(response).card.id);
    assert.strictEqual(persisted!.ownerId, AVERY);
  });

  it('refuses an operator who tries to create work owned by a peer', async () => {
    const response = await invoke({
      method: 'POST', path: '/api/cards', bearer: sessions[AVERY],
      body: { title: 'Peer owned card', anchorDate: '2031-04-02', ownerId: MORGAN },
    });
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(body(response).code, 'work_admin_forbidden');
  });

  it('lets an admin own, reassign, and unassign a Card but not to a disabled or stale user', async () => {
    const created = body(await invoke({
      method: 'POST', path: '/api/cards', bearer: sessions[RILEY],
      body: { title: 'Admin created card', anchorDate: '2031-04-03', ownerId: MORGAN },
    })).card;
    assert.strictEqual(created.ownerId, MORGAN);

    const reassigned = await invoke({
      method: 'PUT', path: `/api/cards/${created.id}`, bearer: sessions[RILEY],
      body: { expectedVersion: created.version, ownerId: AVERY },
    });
    assert.strictEqual(reassigned.statusCode, 200);
    assert.strictEqual(body(reassigned).card.ownerId, AVERY);

    const unassigned = await invoke({
      method: 'PUT', path: `/api/cards/${created.id}`, bearer: sessions[RILEY],
      body: { expectedVersion: body(reassigned).card.version, ownerId: null },
    });
    assert.strictEqual(unassigned.statusCode, 200);
    assert.strictEqual(body(unassigned).card.ownerId, undefined);
    assert.strictEqual(body(unassigned).card.owner, undefined);

    const toDisabled = await invoke({
      method: 'PUT', path: `/api/cards/${created.id}`, bearer: sessions[RILEY],
      body: { expectedVersion: body(unassigned).card.version, ownerId: CASEY },
    });
    assert.strictEqual(toDisabled.statusCode, 400);

    const toGhost = await invoke({
      method: 'POST', path: '/api/cards', bearer: sessions[RILEY],
      body: { title: 'Stale owner card', anchorDate: '2031-04-04', ownerId: GHOST },
    });
    assert.strictEqual(toGhost.statusCode, 400);
  });

  it('filters Cards by owner and projects owners and Task assignees safely', async () => {
    const mine = await invoke({ path: '/api/cards', query: { owner: 'me' }, bearer: sessions[MORGAN] });
    assert.strictEqual(mine.statusCode, 200);
    assert.ok((body(mine).cards as Card[]).every((card) => card.ownerId === MORGAN));

    const unassigned = await invoke({ path: '/api/cards', query: { owner: 'unassigned' }, bearer: sessions[AVERY] });
    assert.ok((body(unassigned).cards as Card[]).some((card) => card.id === work.unownedCard.id));
    assert.ok((body(unassigned).cards as Card[]).every((card) => card.ownerId === undefined));

    const single = await invoke({ path: `/api/cards/${work.morganCard.id}`, bearer: sessions[AVERY] });
    assert.strictEqual(single.statusCode, 200);
    assert.strictEqual(body(single).card.owner.name, 'Morgan Teammate');
    assert.deepStrictEqual(body(single).card.taskAssignees.map((member: { id: string }) => member.id), [MORGAN]);

    const collection = await invoke({ path: '/api/cards', bearer: sessions[AVERY] });
    assert.strictEqual(collection.statusCode, 200);
    const listedSummary = (body(collection).cards as ProjectedCard[])
      .find((card) => card.id === work.summaryCard.id);
    assert.ok(listedSummary);
    assert.strictEqual(listedSummary.owner?.name, 'Morgan Teammate');
    assert.deepStrictEqual(listedSummary.taskAssignees, [{
      id: CASEY,
      name: 'Casey Disabled',
      role: 'operator',
      active: false,
      disabled: true,
      available: true,
    }]);
    assert.strictEqual(single.body.includes('morgan@example.test'), false);

    const cardTasks = await invoke({ path: `/api/cards/${work.morganCard.id}/tasks`, bearer: sessions[AVERY] });
    assert.strictEqual(cardTasks.statusCode, 200);
    assert.strictEqual(body(cardTasks).owner.id, MORGAN);
    assert.strictEqual(body(cardTasks).tasks[0].assignee.name, 'Morgan Teammate');
  });

  it('refuses direct administration of a teammate or unassigned Card, and allows the owner', async () => {
    const peer = await invoke({
      method: 'PUT', path: `/api/cards/${work.morganCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: work.morganCard.version, title: 'Renamed by a teammate' },
    });
    assert.strictEqual(peer.statusCode, 403);
    assert.strictEqual(body(peer).code, 'work_admin_forbidden');

    const unowned = await invoke({
      method: 'PUT', path: `/api/cards/${work.unownedCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: work.unownedCard.version, title: 'Claimed by an operator' },
    });
    assert.strictEqual(unowned.statusCode, 403);

    const adminOnUnowned = await invoke({
      method: 'PUT', path: `/api/cards/${work.unownedCard.id}`, bearer: sessions[RILEY],
      body: { expectedVersion: work.unownedCard.version, title: 'Recovered by an admin' },
    });
    assert.strictEqual(adminOnUnowned.statusCode, 200);
    work.unownedCard = (await getCardConsistent(client, work.unownedCard.id))!;

    const owner = await invoke({
      method: 'PUT', path: `/api/cards/${work.averyCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: work.averyCard.version, title: 'Renamed by its owner', stage: 'announced' },
    });
    assert.strictEqual(owner.statusCode, 200);
    assert.strictEqual(body(owner).card.title, 'Renamed by its owner');
    assert.strictEqual(body(owner).card.ownerId, AVERY);
    work.averyCard = (await getCardConsistent(client, work.averyCard.id))!;
  });

  it('refuses an operator who tries to take ownership of a Card they administer', async () => {
    const response = await invoke({
      method: 'PUT', path: `/api/cards/${work.averyCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: work.averyCard.version, ownerId: MORGAN },
    });
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(body(response).code, 'work_admin_forbidden');
    assert.strictEqual((await getCardConsistent(client, work.averyCard.id))!.ownerId, AVERY);
  });

  it('keeps a forbidden Card write forbidden rather than a stale-version conflict', async () => {
    const response = await invoke({
      method: 'PUT', path: `/api/cards/${work.morganCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: 99, title: 'Never applied' },
    });
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(body(response).code, 'work_admin_forbidden');
  });

  it('answers a missing Card with 404 and a real version race with 409', async () => {
    const missing = await invoke({
      method: 'PUT', path: '/api/cards/card-that-does-not-exist', bearer: sessions[RILEY],
      body: { expectedVersion: 1, title: 'Nothing to rename' },
    });
    assert.strictEqual(missing.statusCode, 404);

    const conflict = await invoke({
      method: 'PUT', path: `/api/cards/${work.averyCard.id}`, bearer: sessions[AVERY],
      body: { expectedVersion: work.averyCard.version + 5, title: 'Stale write' },
    });
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(body(conflict).code, 'card_version_conflict');
  });

  // ── Delegated Task execution ───────────────────────────────────────────────

  it('lets an operator complete a teammate Task with the real actor in history and a stable assignee', async () => {
    const before = (await getTaskConsistent(client, 'task-morgan'))!;
    const response = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { expectedVersion: before.version, status: 'done', comment: 'Handled while Morgan is away' },
    });
    assert.strictEqual(response.statusCode, 200);
    const task = body(response);
    assert.strictEqual(task.assigneeId, MORGAN, 'the assignee never changes');
    assert.strictEqual(task.completedBy, AVERY);
    assert.strictEqual(task.assignee.name, 'Morgan Teammate');
    const completion = task.taskHistory.filter((entry: { action: string }) => entry.action === 'completed').pop();
    assert.strictEqual(completion.actorId, AVERY);
    assert.ok(task.historyActors.some((actor: { id: string; name: string }) => actor.id === AVERY && actor.name === 'Avery Operator'));

    // The accepted Task/Card contract still applies, and Card ownership is
    // administrative metadata outside that aggregate.
    const card = (await getCardConsistent(client, work.morganCard.id))!;
    assert.strictEqual(card.openTaskCount, 0);
    assert.strictEqual(card.status, 'archived');
    assert.strictEqual(card.completedBy, AVERY);
    assert.strictEqual(card.ownerId, MORGAN);

    // Reopen it for the remaining cases and confirm the same rules apply.
    const reopened = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { expectedVersion: task.version, status: 'todo' },
    });
    assert.strictEqual(reopened.statusCode, 200);
    assert.strictEqual(body(reopened).assigneeId, MORGAN);
    const reactivated = (await getCardConsistent(client, work.morganCard.id))!;
    assert.strictEqual(reactivated.status, 'active');
    assert.strictEqual(reactivated.ownerId, MORGAN);
    work.morganCard = reactivated;
  });

  it('attributes an atomic waiting action to the verified actor, not to a spoofed header or the assignee', async () => {
    const before = (await getTaskConsistent(client, 'task-morgan'))!;
    const response = await invoke({
      method: 'POST', path: '/work/api/tasks/task-morgan/actions/mark-waiting',
      bearer: sessions[AVERY],
      headers: { 'x-user-id': RILEY },
      body: {
        expectedVersion: before.version,
        waitingFor: 'Venue confirmation',
        followUpAt: '2031-03-20',
        channel: 'email',
        note: 'Chased on behalf of Morgan',
      },
    });
    assert.strictEqual(response.statusCode, 200);
    const task = body(response);
    assert.strictEqual(task.status, 'waiting');
    assert.strictEqual(task.assigneeId, MORGAN);
    const waiting = task.taskHistory.filter((entry: { action: string }) => entry.action === 'waiting-started').pop();
    assert.strictEqual(waiting.actorId, AVERY);

    const resolved = await invoke({
      method: 'POST', path: '/api/tasks/task-morgan/actions/response-received',
      bearer: sessions[AVERY],
      body: { expectedVersion: task.version, note: 'Venue replied' },
    });
    assert.strictEqual(resolved.statusCode, 200);
    assert.strictEqual(body(resolved).assigneeId, MORGAN);
  });

  it('lets an operator work an unassigned Task without claiming it', async () => {
    const before = (await getTaskConsistent(client, 'task-unassigned'))!;
    const response = await invoke({
      method: 'PUT', path: '/api/tasks/task-unassigned', bearer: sessions[AVERY],
      body: { expectedVersion: before.version, comment: 'Picked up without claiming' },
    });
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(body(response).assigneeId, undefined);
    assert.strictEqual(body(response).assignee, undefined);
  });

  it('defaults a created Task to the verified actor and refuses operator assignment to a peer', async () => {
    const mine = await invoke({
      method: 'POST', path: '/api/tasks', bearer: sessions[AVERY],
      body: { description: 'Created without an assignee', date: '2031-05-01' },
    });
    assert.strictEqual(mine.statusCode, 201);
    assert.strictEqual(body(mine).assigneeId, AVERY);
    assert.strictEqual(body(mine).createdBy, AVERY);

    const peer = await invoke({
      method: 'POST', path: '/api/tasks', bearer: sessions[AVERY],
      body: { description: 'Created for a peer', date: '2031-05-01', assigneeId: MORGAN },
    });
    assert.strictEqual(peer.statusCode, 403);
    assert.strictEqual(body(peer).code, 'work_admin_forbidden');

    const byAdmin = await invoke({
      method: 'POST', path: '/api/tasks', bearer: sessions[RILEY],
      body: { description: 'Assigned by an admin', date: '2031-05-01', assigneeId: MORGAN },
    });
    assert.strictEqual(byAdmin.statusCode, 201);
    assert.strictEqual(body(byAdmin).assigneeId, MORGAN);
    assert.strictEqual(body(byAdmin).createdBy, RILEY);

    const toDisabled = await invoke({
      method: 'POST', path: '/api/tasks', bearer: sessions[RILEY],
      body: { description: 'Assigned to a disabled teammate', date: '2031-05-01', assigneeId: CASEY },
    });
    assert.strictEqual(toDisabled.statusCode, 400);
  });

  it('refuses reassignment, deletion, and peer membership changes by an operator', async () => {
    const before = (await getTaskConsistent(client, 'task-morgan'))!;

    const reassign = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { expectedVersion: before.version, assigneeId: AVERY },
    });
    assert.strictEqual(reassign.statusCode, 403);
    assert.strictEqual(body(reassign).code, 'work_admin_forbidden');

    const deletion = await invoke({
      method: 'DELETE', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { expectedVersion: before.version },
    });
    assert.strictEqual(deletion.statusCode, 403);
    assert.strictEqual(body(deletion).code, 'work_admin_forbidden');

    const ownTask = (await getTaskConsistent(client, 'task-avery'))!;
    const ownDeletion = await invoke({
      method: 'DELETE', path: '/api/tasks/task-avery', bearer: sessions[AVERY],
      body: { expectedVersion: ownTask.version },
    });
    assert.strictEqual(ownDeletion.statusCode, 403);

    const moveIntoPeerCard = await invoke({
      method: 'PUT', path: '/api/tasks/task-avery', bearer: sessions[AVERY],
      body: { expectedVersion: ownTask.version, cardId: work.morganCard.id },
    });
    assert.strictEqual(moveIntoPeerCard.statusCode, 403);
    assert.strictEqual(body(moveIntoPeerCard).code, 'work_admin_forbidden');

    // Nothing above may have been applied.
    const unchanged = (await getTaskConsistent(client, 'task-morgan'))!;
    assert.strictEqual(unchanged.assigneeId, MORGAN);
    assert.strictEqual(unchanged.version, before.version);
    assert.ok(await getTaskConsistent(client, 'task-avery'));
  });

  it('allows membership changes inside a Card the operator owns, and admin recovery elsewhere', async () => {
    const before = (await getTaskConsistent(client, 'task-avery'))!;
    const moved = await invoke({
      method: 'PUT', path: '/api/tasks/task-avery', bearer: sessions[AVERY],
      body: { expectedVersion: before.version, cardId: work.averyCard.id },
    });
    assert.strictEqual(moved.statusCode, 200);
    assert.strictEqual(body(moved).cardId, work.averyCard.id);

    const adminMove = await invoke({
      method: 'PUT', path: '/api/tasks/task-avery', bearer: sessions[RILEY],
      body: { expectedVersion: body(moved).version, cardId: work.morganCard.id },
    });
    assert.strictEqual(adminMove.statusCode, 200);
    assert.strictEqual(body(adminMove).cardId, work.morganCard.id);
    assert.strictEqual(body(adminMove).assigneeId, AVERY);
    assert.strictEqual((await getCardConsistent(client, work.morganCard.id))!.ownerId, MORGAN);

    const adminReassign = await invoke({
      method: 'PUT', path: '/api/tasks/task-avery', bearer: sessions[RILEY],
      body: { expectedVersion: body(adminMove).version, assigneeId: MORGAN },
    });
    assert.strictEqual(adminReassign.statusCode, 200);
    assert.strictEqual(body(adminReassign).assigneeId, MORGAN);

    const adminDelete = await invoke({
      method: 'DELETE', path: '/api/tasks/task-avery', bearer: sessions[RILEY],
      body: { expectedVersion: body(adminReassign).version },
    });
    assert.strictEqual(adminDelete.statusCode, 204);
    assert.strictEqual(await getTaskConsistent(client, 'task-avery'), null);
    work.morganCard = (await getCardConsistent(client, work.morganCard.id))!;
  });

  it('preserves the accepted expected-version conflict, stale-record, and validation answers', async () => {
    const current = (await getTaskConsistent(client, 'task-morgan'))!;

    const conflict = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { expectedVersion: current.version + 3, comment: 'Stale client' },
    });
    assert.strictEqual(conflict.statusCode, 409);
    assert.strictEqual(body(conflict).code, 'task_version_conflict');
    assert.strictEqual(body(conflict).currentVersion, current.version);

    const stale = await invoke({
      method: 'PUT', path: '/api/tasks/task-that-was-deleted', bearer: sessions[AVERY],
      body: { expectedVersion: 1, comment: 'Gone' },
    });
    assert.strictEqual(stale.statusCode, 404);
    assert.strictEqual(body(stale).code, 'task_not_found');

    const invalid = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      body: { comment: 'No precondition' },
    });
    assert.strictEqual(invalid.statusCode, 400);
  });

  it('never lets a browser-supplied identity header widen authority', async () => {
    const current = (await getTaskConsistent(client, 'task-morgan'))!;
    const spoofedAdmin = await invoke({
      method: 'DELETE', path: '/api/tasks/task-morgan', bearer: sessions[AVERY],
      headers: { 'x-user-id': RILEY, 'x-user-role': 'admin', 'x-portal-auth': 'true' },
      body: { expectedVersion: current.version },
    });
    assert.strictEqual(spoofedAdmin.statusCode, 403);
    assert.strictEqual(body(spoofedAdmin).code, 'work_admin_forbidden');
    assert.ok(await getTaskConsistent(client, 'task-morgan'));

    const headerOnly = await invoke({
      method: 'POST', path: '/api/tasks',
      headers: { 'x-user-id': RILEY },
      body: { description: 'Forged identity task', date: '2031-06-01' },
    });
    assert.strictEqual(headerOnly.statusCode, 401);
  });

  it('applies a role, disable, and delete decision on the very next request', async () => {
    const promoted = await createUserWithId(client, 'quinn-temporary', {
      name: 'Quinn Temporary', email: 'quinn@example.test', role: 'operator',
    });
    const token = (await createSession(client, promoted.id)).token;
    const task = (await getTaskConsistent(client, 'task-morgan'))!;

    const asOperator = await invoke({
      method: 'DELETE', path: '/api/tasks/task-morgan', bearer: token,
      body: { expectedVersion: task.version },
    });
    assert.strictEqual(asOperator.statusCode, 403);

    await updateUser(client, promoted.id, { role: 'admin' });
    const asAdmin = await invoke({ path: '/api/team-members', bearer: token });
    assert.strictEqual(asAdmin.statusCode, 200);

    await updateUser(client, promoted.id, { disabled: true });
    const asDisabled = await invoke({ path: '/api/team-members', bearer: token });
    assert.strictEqual(asDisabled.statusCode, 401);
    const disabledWrite = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: token,
      body: { expectedVersion: task.version, comment: 'Should not apply' },
    });
    assert.strictEqual(disabledWrite.statusCode, 401);
  });

  it('refuses work mutations for an unsupported-role actor with the stable admin code', async () => {
    const task = (await getTaskConsistent(client, 'task-morgan'))!;
    const response = await invoke({
      method: 'PUT', path: '/api/tasks/task-morgan', bearer: sessions[ROWAN],
      body: { expectedVersion: task.version, comment: 'Not allowed' },
    });
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(body(response).code, 'work_admin_forbidden');
  });

  it('leaks no password, token, cookie, or peer email through work projections', async () => {
    const responses = await Promise.all([
      invoke({ path: '/api/team-members', bearer: sessions[AVERY] }),
      invoke({ path: '/api/tasks', query: { owner: 'team' }, bearer: sessions[AVERY] }),
      invoke({ path: '/api/cards', query: { owner: 'team' }, bearer: sessions[AVERY] }),
      invoke({ path: `/api/cards/${work.morganCard.id}`, bearer: sessions[AVERY] }),
      invoke({ path: `/api/cards/${work.morganCard.id}/tasks`, bearer: sessions[AVERY] }),
    ]);
    for (const response of responses) {
      assert.strictEqual(response.statusCode, 200);
      for (const secret of ['passwordHash', 'example.test', 'dataops_session', sessions[AVERY], cookies[AVERY]]) {
        assert.strictEqual(response.body.includes(secret), false, `leaked ${secret}`);
      }
    }
  });
});
