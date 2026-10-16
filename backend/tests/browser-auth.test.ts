import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { authErrorPage, handleCallback, logout, resetBrowserAuthCaches, signInRefusal, startLogin } from '../src/auth/browserAuth';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createBrowserSession, createSession, getSession } from '../src/db/sessions';
import { createUserWithId, getFormerUserByEmail, getUser, getUsersByNormalizedEmail, listUsers } from '../src/db/users';
import { deleteUser, disableUser } from '../src/db/userLifecycle';
import { handleUserRoutes } from '../src/routes/users';
import { route } from '../src/router';
import type { LambdaEvent, LambdaResponse } from '../src/types';

const CONFIG = {
  AUTH_BASE_URL: 'https://auth.example.test',
  AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_JWKS_URL: 'https://issuer.example.test/pool/.well-known/jwks.json',
  AUTH_CLIENT_ID: 'dataops-client',
  AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
  AUTH_LOGOUT_URL: 'https://ops.example.test/',
  AUTH_SESSION_LIFETIME_SECONDS: '3600',
  DATAOPS_DOCS_DOMAIN: '1',
  WORK_ENGINE_AUTH_MODE: 'portal',
  SKIP_AUTH: 'false',
};

function event(method: string, path: string, query: Record<string, string> = {}, cookie = ''): LambdaEvent {
  return { httpMethod: method, path, queryStringParameters: query, headers: cookie ? { cookie } : {} };
}

/** An admin adding a person on the Users page. */
async function adminAddsUser(name: string, email: string): Promise<LambdaResponse> {
  const body = JSON.stringify({ name, email });
  return handleUserRoutes('/api/users', 'POST', body, { httpMethod: 'POST', path: '/api/users', headers: { 'x-user-id': 'enabled-admin' }, body });
}

function cookiePair(response: LambdaResponse, name: string): string {
  const cookie = response.headers?.['set-cookie'] || '';
  const match = cookie.match(new RegExp(`(?:^|, )(${name}=[^;]*)`));
  assert.ok(match, `missing ${name} cookie`);
  return match[1];
}

function jwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'RS256', kid, typ: 'JWT' })}.${encoded(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
}

describe('shared Cognito browser authentication', () => {
  let client: DynamoDBDocumentClient;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  let nonce = '';
  let tokenClaims: Record<string, unknown> = {};
  let tokenStatus = 200;
  let jwksCalls = 0;
  let tokenCalls = 0;
  let lastTokenBody = '';
  const originalFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const key of Object.keys(CONFIG)) saved[key] = process.env[key];
    Object.assign(process.env, CONFIG);
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'enabled-admin', { name: 'Enabled Admin', email: 'Admin@DataTalks.Club', role: 'admin' });
    await createUserWithId(client, 'disabled-user', { name: 'Disabled', email: 'disabled@datatalks.club', role: 'operator', disabled: true });
  });

  after(async () => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await stopLocal();
  });

  beforeEach(() => {
    resetBrowserAuthCaches();
    tokenStatus = 200;
    jwksCalls = 0;
    tokenCalls = 0;
    lastTokenBody = '';
    tokenClaims = {};
    global.fetch = async (input, init) => {
      const url = String(input);
      if (url === CONFIG.AUTH_JWKS_URL) {
        jwksCalls += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === `${CONFIG.AUTH_BASE_URL}/oauth2/token`) {
        tokenCalls += 1;
        lastTokenBody = String(init?.body || '');
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: CONFIG.AUTH_ISSUER,
          aud: CONFIG.AUTH_CLIENT_ID,
          exp: now + 300,
          iat: now,
          nonce,
          token_use: 'id',
          email: 'admin@datatalks.club',
          email_verified: true,
          ...tokenClaims,
        };
        return new Response(JSON.stringify({ id_token: jwt(keys.privateKey, 'key-1', claims) }), { status: tokenStatus, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  });

  async function begin(returnTo = '/work'): Promise<{ state: string; txCookie: string; challenge: string }> {
    const response = await startLogin(event('GET', '/login', { return_to: returnTo }), client);
    assert.strictEqual(response.statusCode, 302);
    const url = new URL(response.headers!.location);
    nonce = url.searchParams.get('nonce')!;
    assert.strictEqual(url.origin, CONFIG.AUTH_BASE_URL);
    assert.strictEqual(url.pathname, '/oauth2/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), CONFIG.AUTH_CLIENT_ID);
    assert.strictEqual(url.searchParams.get('redirect_uri'), CONFIG.AUTH_CALLBACK_URL);
    assert.strictEqual(url.searchParams.get('response_type'), 'code');
    assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state')!.length >= 40);
    assert.ok(nonce.length >= 40);
    return {
      state: url.searchParams.get('state')!,
      challenge: url.searchParams.get('code_challenge')!,
      txCookie: cookiePair(response, 'dataops_oauth_tx'),
    };
  }

  async function complete(email = 'admin@datatalks.club'): Promise<LambdaResponse> {
    tokenClaims.email = email;
    const started = await begin();
    const response = await handleCallback(event('GET', '/auth/callback', { state: started.state, code: 'safe-code' }, started.txCookie), client);
    if (lastTokenBody) {
      const params = new URLSearchParams(lastTokenBody);
      assert.strictEqual(params.get('code'), 'safe-code');
      assert.strictEqual(params.get('client_id'), CONFIG.AUTH_CLIENT_ID);
      assert.strictEqual(params.get('redirect_uri'), CONFIG.AUTH_CALLBACK_URL);
      assert.strictEqual(params.get('grant_type'), 'authorization_code');
      assert.strictEqual(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), started.challenge);
    }
    return response;
  }

  it('constructs authorization with state, nonce and S256 PKCE and keeps the verifier server-side', async () => {
    const started = await begin('https://attacker.invalid/');
    assert.ok(started.state);
    assert.ok(started.challenge);
    assert.doesNotMatch(started.txCookie, /code_verifier|nonce/);
    assert.doesNotMatch(started.txCookie, new RegExp(started.state));
  });

  it('canonicalizes return targets and rejects open-redirect normalization tricks', async () => {
    const malicious = [
      '/\\evil.example',
      '//evil.example/path',
      'https://evil.example/path',
      'https://ops.example.test/work',
      '/%5cevil.example',
      '/%255cevil.example',
      '/%2f%2fevil.example',
      '/%252f%252fevil.example',
      '/work\u0009/evil.example',
      '/work\u007f/evil.example',
      '/work%0alocation:https://evil.example',
      '/work%09/evil.example',
      '/work%250d%250alocation:https://evil.example',
      '/auth%2fcallback',
      '/work/%2e%2e/auth/error',
    ];
    for (const returnTo of malicious) {
      const started = await begin(returnTo);
      const response = await handleCallback(event('GET', '/auth/callback', { state: started.state, code: 'safe-code' }, started.txCookie), client);
      assert.strictEqual(response.statusCode, 302, returnTo);
      assert.strictEqual(response.headers?.location, '/', returnTo);
      assert.strictEqual(new URL(response.headers!.location, new URL(CONFIG.AUTH_CALLBACK_URL).origin).origin, new URL(CONFIG.AUTH_CALLBACK_URL).origin);
    }

    const valid = await begin('/work?view=tasks#today');
    const validResponse = await handleCallback(event('GET', '/auth/callback', { state: valid.state, code: 'safe-code' }, valid.txCookie), client);
    assert.strictEqual(validResponse.headers?.location, '/work?view=tasks#today');
  });

  it('maps a verified case-normalized identity, creates an opaque bounded session and returns a clean URL', async () => {
    const response = await complete('  ADMIN@datatalks.club  ');
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual(response.headers?.location, '/work');
    assert.doesNotMatch(response.body, /safe-code|id_token|dataops_session/);
    const cookie = response.headers?.['set-cookie'] || '';
    assert.match(cookie, /dataops_session=[^;]+; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax/);
    const session = await getSession(client, cookiePair(response, 'dataops_session').split('=')[1]);
    assert.strictEqual(session?.userId, 'enabled-admin');
    assert.strictEqual(session?.sessionType, 'browser');
    assert.ok(session?.expiresAt);
  });

  it('stores the Google profile picture on every sign-in and serves it from /api/me', async () => {
    const first = 'https://lh3.googleusercontent.com/a/stub-first=s96-c';
    tokenClaims.picture = first;
    const response = await complete('admin@datatalks.club');
    assert.strictEqual(response.statusCode, 302);
    assert.strictEqual((await getUser(client, 'enabled-admin'))?.picture, first);
    const me = await route(event('GET', '/api/me', {}, cookiePair(response, 'dataops_session')), client);
    assert.strictEqual(JSON.parse(me.body).user.picture, first);

    // A changed photo replaces the old one at the next sign-in.
    const second = 'https://lh3.googleusercontent.com/a/stub-second=s96-c';
    tokenClaims.picture = second;
    await complete('admin@datatalks.club');
    assert.strictEqual((await getUser(client, 'enabled-admin'))?.picture, second);

    // Only Google's https photo host is kept; anything else, or no claim, clears it.
    for (const picture of ['http://lh3.googleusercontent.com/a/x', 'https://tracker.example/pixel.gif', 'https://googleusercontent.com.evil.test/a', undefined]) {
      tokenClaims.picture = picture;
      assert.strictEqual((await complete('admin@datatalks.club')).statusCode, 302);
      assert.strictEqual((await getUser(client, 'enabled-admin'))?.picture, undefined, String(picture));
    }
  });

  it('stores the picture of an added person signing in for the first time', async () => {
    assert.strictEqual((await adminAddsUser('Picture Newcomer', 'picture.newcomer@datatalks.club'))!.statusCode, 201);
    tokenClaims.picture = 'https://lh3.googleusercontent.com/a/stub-newcomer=s96-c';
    assert.strictEqual((await complete('picture.newcomer@datatalks.club')).statusCode, 302);
    const [user] = await getUsersByNormalizedEmail(client, 'picture.newcomer@datatalks.club');
    assert.strictEqual(user.picture, 'https://lh3.googleusercontent.com/a/stub-newcomer=s96-c');
  });

  it('does not touch the picture of a disabled account', async () => {
    tokenClaims.picture = 'https://lh3.googleusercontent.com/a/stub-disabled=s96-c';
    await complete('disabled@datatalks.club');
    assert.strictEqual((await getUser(client, 'disabled-user'))?.picture, undefined);
  });

  it('rejects mismatched state binding and callback replay before exchanging a code', async () => {
    const started = await begin();
    const wrong = await handleCallback(event('GET', '/auth/callback', { state: started.state, code: 'code' }, 'dataops_oauth_tx=wrong'), client);
    assert.strictEqual(wrong.statusCode, 303);
    assert.strictEqual(wrong.headers?.location, '/auth/error');
    const replay = await handleCallback(event('GET', '/auth/callback', { state: started.state, code: 'code' }, started.txCookie), client);
    assert.strictEqual(replay.statusCode, 303);
    assert.strictEqual(replay.headers?.location, '/auth/error');
    assert.strictEqual(tokenCalls, 0);
  });

  it('rejects expired transactions, provider errors and missing codes as one-time transactions', async () => {
    const old = new Date(Date.now() - 700_000);
    const expiredLogin = await startLogin(event('GET', '/login'), client, old);
    const expiredUrl = new URL(expiredLogin.headers!.location);
    const expired = await handleCallback(event('GET', '/auth/callback', { state: expiredUrl.searchParams.get('state')!, code: 'code' }, cookiePair(expiredLogin, 'dataops_oauth_tx')), client);
    assert.strictEqual(expired.statusCode, 303);
    const provider = await begin();
    assert.strictEqual((await handleCallback(event('GET', '/auth/callback', { state: provider.state, error: 'access_denied' }, provider.txCookie), client)).statusCode, 303);
    assert.strictEqual((await handleCallback(event('GET', '/auth/callback', { state: provider.state, code: 'later' }, provider.txCookie), client)).statusCode, 303);
    const missing = await begin();
    assert.strictEqual((await handleCallback(event('GET', '/auth/callback', { state: missing.state }, missing.txCookie), client)).statusCode, 303);
  });

  it('redirects callback failures to a clean, private, generic error page', async () => {
    tokenStatus = 400;
    const started = await begin('/work');
    const code = 'authorization-code-must-disappear';
    const response = await handleCallback(event('GET', '/auth/callback', { state: started.state, code }, started.txCookie), client);

    assert.strictEqual(response.statusCode, 303);
    assert.strictEqual(response.headers?.location, '/auth/error');
    assert.strictEqual(new URL(response.headers!.location, CONFIG.AUTH_CALLBACK_URL).search, '');
    assert.strictEqual(response.headers?.['cache-control'], 'no-store');
    assert.strictEqual(response.headers?.['referrer-policy'], 'no-referrer');
    assert.match(response.headers?.['set-cookie'] || '', /dataops_oauth_tx=;.*Max-Age=0/);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(`${code}|${started.state}`));

    const rendered = authErrorPage();
    assert.strictEqual(rendered.statusCode, 403);
    assert.strictEqual(rendered.headers?.['cache-control'], 'no-store');
    assert.strictEqual(rendered.headers?.['referrer-policy'], 'no-referrer');
    assert.match(rendered.body, /DataOps/);
    assert.match(rendered.body, /We couldn’t sign you in/);
    assert.match(rendered.body, /aria-labelledby="auth-error-title"/);
    assert.match(rendered.body, /href="\/login"/);
    assert.doesNotMatch(rendered.body, /authorization-code|state|token|verifier|session|access_denied/i);
  });

  it('rejects token exchange, issuer, audience, expiry, nbf, nonce and email verification failures', async () => {
    tokenStatus = 400;
    assert.strictEqual((await complete()).statusCode, 303);
    tokenStatus = 200;
    for (const claims of [
      { iss: 'https://wrong.invalid' },
      { aud: 'wrong-client' },
      { exp: 1 },
      { nbf: Math.floor(Date.now() / 1000) + 500 },
      { nonce: 'wrong' },
      { email_verified: false },
    ]) {
      tokenClaims = claims;
      assert.strictEqual((await complete()).statusCode, 303);
    }
    tokenClaims = {};
    assert.strictEqual((await complete('')).statusCode, 303);
  });

  it('refreshes JWKS for a missing key and rejects invalid signatures', async () => {
    const secondKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secondJwk = { ...secondKeys.publicKey.export({ format: 'jwk' }), kid: 'key-2', alg: 'RS256', use: 'sig' };
    let phase = 0;
    global.fetch = async (input, init) => {
      if (String(input) === CONFIG.AUTH_JWKS_URL) {
        jwksCalls += 1;
        phase += 1;
        return new Response(JSON.stringify({ keys: phase === 1 ? [jwk] : [secondJwk] }), { status: 200 });
      }
      const now = Math.floor(Date.now() / 1000);
      return new Response(JSON.stringify({ id_token: jwt(secondKeys.privateKey, 'key-2', { iss: CONFIG.AUTH_ISSUER, aud: CONFIG.AUTH_CLIENT_ID, exp: now + 60, nonce, token_use: 'id', email: 'admin@datatalks.club', email_verified: true }) }), { status: 200 });
    };
    assert.strictEqual((await complete()).statusCode, 302);
    assert.strictEqual(jwksCalls, 2);

    resetBrowserAuthCaches();
    phase = 0;
    global.fetch = async (input) => String(input) === CONFIG.AUTH_JWKS_URL
      ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
      : new Response(JSON.stringify({ id_token: jwt(secondKeys.privateKey, 'key-1', { iss: CONFIG.AUTH_ISSUER, aud: CONFIG.AUTH_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 60, nonce, token_use: 'id', email: 'admin@datatalks.club', email_verified: true }) }), { status: 200 });
    assert.strictEqual((await complete()).statusCode, 303);
  });

  it('never creates an account at sign-in: an unknown verified identity is refused as not added', async () => {
    tokenClaims.name = 'New Colleague';
    for (const email of ['  NEW.COLLEAGUE@DataTalks.Club  ', 'outside@example.com']) {
      const response = await complete(email);
      assert.strictEqual(response.statusCode, 303, email);
      assert.strictEqual(response.headers?.location, '/auth/error?reason=not_added', email);
      assert.doesNotMatch(response.headers?.['set-cookie'] || '', /dataops_session=[^;]/);
      assert.strictEqual((await getUsersByNormalizedEmail(client, email)).length, 0, email);
    }
    assert.strictEqual((await listUsers(client)).some((user) => user.email.includes('new.colleague')), false);
  });

  it('refuses unverified emails without saying whether an account exists', async () => {
    tokenClaims.email_verified = false;
    const response = await complete('admin@datatalks.club');
    assert.strictEqual(response.statusCode, 303);
    assert.strictEqual(response.headers?.location, '/auth/error');
  });

  it('signs in a person an admin added, then refuses them once disabled and once deleted', async () => {
    const created = (await adminAddsUser('Added Later', 'Added.Later@datatalks.club'))!;
    assert.strictEqual(created.statusCode, 201);
    const added = JSON.parse(created.body).user;
    assert.strictEqual(added.email, 'added.later@datatalks.club');
    assert.strictEqual(added.role, 'operator');

    const signedIn = await complete('added.later@datatalks.club');
    assert.strictEqual(signedIn.statusCode, 302);
    const me = await route(event('GET', '/api/me', {}, cookiePair(signedIn, 'dataops_session')), client);
    assert.strictEqual(JSON.parse(me.body).user.id, added.id);

    await disableUser(client, added.id, { actorId: 'enabled-admin' });
    const disabled = await complete('added.later@datatalks.club');
    assert.strictEqual(disabled.statusCode, 303);
    assert.strictEqual(disabled.headers?.location, '/auth/error?reason=disabled');

    await deleteUser(client, added.id, { actorId: 'enabled-admin' });
    const deleted = await complete('added.later@datatalks.club');
    assert.strictEqual(deleted.statusCode, 303);
    assert.strictEqual(deleted.headers?.location, '/auth/error?reason=deleted');
    // Signing in again did not bring the account back.
    assert.strictEqual((await getUsersByNormalizedEmail(client, 'added.later@datatalks.club')).length, 0);
    // The former-user record keeps a hash of the email, never the email.
    const former = await getFormerUserByEmail(client, 'ADDED.LATER@datatalks.club');
    assert.strictEqual(former?.id, added.id);
    assert.doesNotMatch(JSON.stringify(former), /added\.later|emailHash/);

    // Only an admin adding them again lets them back in.
    assert.strictEqual((await adminAddsUser('Added Later', 'added.later@datatalks.club'))!.statusCode, 201);
    // One email is one account: adding it twice is refused.
    const twice = (await adminAddsUser('Added Twice', ' ADDED.later@datatalks.club '))!;
    assert.strictEqual(twice.statusCode, 409);
    assert.strictEqual(JSON.parse(twice.body).code, 'email_taken');
    assert.strictEqual((await complete('added.later@datatalks.club')).statusCode, 302);
  });

  it('refuses a disabled account and an email shared by two accounts', async () => {
    const disabled = await complete('disabled@datatalks.club');
    assert.strictEqual(disabled.statusCode, 303);
    assert.strictEqual(disabled.headers?.location, '/auth/error?reason=disabled');
    await createUserWithId(client, 'duplicate-one', { name: 'Duplicate one', email: 'duplicate@datatalks.club', role: 'operator' });
    await createUserWithId(client, 'duplicate-two', { name: 'Duplicate two', email: 'DUPLICATE@datatalks.club', role: 'operator' });
    const duplicate = await complete('duplicate@datatalks.club');
    assert.strictEqual(duplicate.statusCode, 303);
    assert.strictEqual(duplicate.headers?.location, '/auth/error');
  });

  it('explains each refusal on the error page and ignores unknown reasons', () => {
    assert.match(authErrorPage(signInRefusal('not_added')).body, /Ask a DataOps admin to add you/);
    assert.match(authErrorPage(signInRefusal('disabled')).body, /account is disabled/);
    assert.match(authErrorPage(signInRefusal('deleted')).body, /account was deleted/);
    assert.strictEqual(signInRefusal('<script>'), null);
    assert.strictEqual(signInRefusal('toString'), null);
    assert.match(authErrorPage(signInRefusal('<script>')).body, /We couldn’t sign you in/);
  });

  it('serves pages and /api/me from the browser cookie, propagating the real local id and role', async () => {
    const response = await complete();
    const browserCookie = cookiePair(response, 'dataops_session');
    const me = await route(event('GET', '/api/me', {}, browserCookie), client);
    assert.strictEqual(me.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(me.body).user.role, 'admin');
    assert.strictEqual(JSON.parse(me.body).user.id, 'enabled-admin');
    const api = await route(event('GET', '/api/tasks'), client);
    assert.strictEqual(api.statusCode, 401);
    assert.match(api.headers?.['content-type'] || '', /application\/json/);
    const page = await route(event('GET', '/work'), client);
    assert.strictEqual(page.statusCode, 302);
    assert.strictEqual(page.headers?.location, '/login');
  });

  it('expires and revokes browser sessions while preserving legacy bearer-session expiry semantics', async () => {
    const expired = await createBrowserSession(client, 'enabled-admin', { now: new Date(Date.now() - 7200_000), lifetimeSeconds: 3600 });
    assert.strictEqual(await getSession(client, expired.token), null);
    const legacy = await createSession(client, 'enabled-admin');
    assert.ok(await getSession(client, legacy.token, new Date('2100-01-01')));

    const response = await complete();
    const browserCookie = cookiePair(response, 'dataops_session');
    const out = await logout(event('POST', '/logout', {}, browserCookie), client);
    assert.strictEqual(out.statusCode, 302);
    const location = new URL(out.headers!.location);
    assert.strictEqual(location.origin, CONFIG.AUTH_BASE_URL);
    assert.strictEqual(location.pathname, '/logout');
    assert.strictEqual(location.searchParams.get('client_id'), CONFIG.AUTH_CLIENT_ID);
    assert.strictEqual(location.searchParams.get('logout_uri'), CONFIG.AUTH_LOGOUT_URL);
    assert.match(out.headers?.['set-cookie'] || '', /Max-Age=0/);
    assert.strictEqual(await getSession(client, browserCookie.split('=')[1]), null);
  });

  it('keeps Basic auth from becoming a browser session and disables the legacy password login in portal mode', async () => {
    const basic = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
    assert.strictEqual((await route({ ...event('GET', '/work'), headers: { authorization: basic } }, client)).statusCode, 302);
    assert.strictEqual((await route(event('POST', '/api/auth/login'), client)).statusCode, 404);
  });
});
