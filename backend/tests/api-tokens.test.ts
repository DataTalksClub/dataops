import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { isScopedTokenRequestAllowed, parseApiTokenScopes } from '../src/auth/tokenScopes';
import { createSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import { handleApiTokenRoutes } from '../src/routes/apiTokens';
import { handler } from '../src/handler';
import { TABLE_SESSIONS } from '../src/db/tableNames';
import { useTestDatabase } from './helpers/db';

const ADMIN_ID = 'api-token-admin';
const OPERATOR_ID = 'api-token-operator';
const SCOPES = ['kb:write', 'templates:write', 'cards:write', 'newsletter:write'];
const previousSkipAuth = process.env.SKIP_AUTH;

describe('scoped agent API tokens', () => {
  let client: Awaited<ReturnType<typeof useTestDatabase>>['client'];
  let adminSession: string;

  before(async () => {
    process.env.SKIP_AUTH = 'false';
    ({ client } = await useTestDatabase());
    await createUserWithId(client, ADMIN_ID, {
      name: 'Token admin', email: 'token-admin@example.test', role: 'admin',
    });
    await createUserWithId(client, OPERATOR_ID, {
      name: 'Token operator', email: 'token-operator@example.test', role: 'operator',
    });
    adminSession = (await createSession(client, ADMIN_ID)).token;
  });

  it('accepts only the four named write scopes and enforces route boundaries', () => {
    assert.deepEqual(parseApiTokenScopes('kb:write, templates:write,kb:write'), ['kb:write', 'templates:write']);
    assert.equal(parseApiTokenScopes('admin'), null);
    assert.equal(parseApiTokenScopes([]), null);
    assert.equal(isScopedTokenRequestAllowed(SCOPES, 'POST', '/api/cards'), true);
    assert.equal(isScopedTokenRequestAllowed(SCOPES, 'GET', '/api/templates'), true);
    assert.equal(isScopedTokenRequestAllowed(SCOPES, 'GET', '/api/users'), false);
    assert.equal(isScopedTokenRequestAllowed(SCOPES, 'POST', '/api/finance/invoices'), false);
    assert.equal(isScopedTokenRequestAllowed(['cards:write'], 'GET', '/api/newsletter-issues'), false);
    assert.equal(isScopedTokenRequestAllowed(['cards:write'], 'POST', '/api/sponsor-docs'), false);
    assert.equal(isScopedTokenRequestAllowed(['newsletter:write'], 'POST', '/api/sponsor-docs'), true);
    assert.equal(isScopedTokenRequestAllowed(['kb:write'], 'GET', '/api/team-members'), false);
  });

  it('lets admins issue, inventory, identify, and revoke a token without storing its raw value', async () => {
    const issuedResponse = await handleApiTokenRoutes('/api/tokens', 'POST', {
      headers: { 'x-user-id': ADMIN_ID },
      body: JSON.stringify({ label: 'hub-sessions@hetzner', scopes: SCOPES }),
    }, client);
    assert.equal(issuedResponse?.statusCode, 201);
    assert.equal(issuedResponse?.headers?.['Cache-Control'], 'no-store');
    const issued = JSON.parse(issuedResponse!.body);
    const bearer = issued.token as string;
    const apiToken = issued.apiToken;
    assert.match(bearer, /^dops_[a-f0-9]{64}$/);
    assert.equal(apiToken.label, 'hub-sessions@hetzner');
    assert.deepEqual(apiToken.scopes, SCOPES);
    assert.equal(Object.hasOwn(apiToken, 'tokenHash'), false);

    const operatorList = await handleApiTokenRoutes('/api/tokens', 'GET', {
      headers: { 'x-user-id': OPERATOR_ID },
    }, client);
    assert.equal(operatorList?.statusCode, 403);

    const listResponse = await handleApiTokenRoutes('/api/tokens', 'GET', {
      headers: { 'x-user-id': ADMIN_ID },
    }, client);
    assert.equal(listResponse?.statusCode, 200);
    assert.equal(JSON.stringify(listResponse?.body).includes(bearer), false);

    const storedRows = await client.send(new ScanCommand({ TableName: TABLE_SESSIONS }));
    assert.equal(JSON.stringify(storedRows.Items || []).includes(bearer), false);

    const identityResponse = await handler({
      httpMethod: 'GET',
      path: '/api/me',
      headers: { Authorization: `Bearer ${bearer}` },
    }, {});
    assert.equal(identityResponse.statusCode, 200);
    const identity = JSON.parse(identityResponse.body);
    assert.equal(identity.user.id, ADMIN_ID);
    assert.equal(identity.apiToken.label, 'hub-sessions@hetzner');
    assert.deepEqual(identity.apiToken.scopes, SCOPES);
    assert.equal(JSON.stringify(identity).includes(bearer), false);

    const revokedResponse = await handleApiTokenRoutes(`/api/tokens/${apiToken.id}`, 'DELETE', {
      headers: { 'x-user-id': ADMIN_ID },
    }, client);
    assert.deepEqual(JSON.parse(revokedResponse!.body), { revoked: true });
    const afterRevoke = await handler({
      httpMethod: 'GET',
      path: '/api/me',
      headers: { Authorization: `Bearer ${bearer}` },
    }, {});
    assert.equal(afterRevoke.statusCode, 401);
  });

  it('allows a scoped token to revoke itself', async () => {
    const issuedResponse = await handleApiTokenRoutes('/api/tokens', 'POST', {
      headers: { 'x-user-id': ADMIN_ID },
      body: JSON.stringify({ label: 'self-revoking-agent', scopes: ['cards:write'] }),
    }, client);
    const issued = JSON.parse(issuedResponse!.body);
    const selfRevoked = await handleApiTokenRoutes('/api/tokens/self', 'DELETE', {
      headers: { 'x-api-token-id': issued.apiToken.id },
    }, client);
    assert.deepEqual(JSON.parse(selfRevoked!.body), { revoked: true });
    const afterRevoke = await handler({
      httpMethod: 'GET',
      path: '/api/me',
      headers: { Authorization: `Bearer ${issued.token}` },
    }, {});
    assert.equal(afterRevoke.statusCode, 401);
  });
});

after(() => {
  if (previousSkipAuth === undefined) delete process.env.SKIP_AUTH;
  else process.env.SKIP_AUTH = previousSkipAuth;
});
