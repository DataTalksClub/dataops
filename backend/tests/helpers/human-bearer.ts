/**
 * Human bearer credentials for backend tests.
 *
 * A human reaches the API either with the portal browser cookie or, on the
 * CLI, with a shared-issuer JWT whose verified email maps to one enabled user.
 * Browser session tokens are never accepted as bearers, so tests that need a
 * signed-in human over `Authorization: Bearer` mint a shared-issuer JWT here.
 *
 * The first call starts one loopback JWKS endpoint for the test process and
 * points the backend's issuer configuration at it. Node's test runner gives
 * every test file its own process, so this never leaks across files.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { DATAOPS_API_RESOURCE, resetSharedIssuerCaches } from '../../src/auth/sharedIssuer';
import { getUser } from '../../src/db/users';
import { generateSigningKey, humanClaims, mintJwt, startJwksServer } from './issuer-rig';

const KID = 'human-bearer-test-key';

let rig: Promise<{ issuer: string; privateKey: ReturnType<typeof generateSigningKey>['privateKey'] }> | null = null;

function startRig() {
  rig ??= (async () => {
    const signingKey = generateSigningKey(KID);
    const server = await startJwksServer([signingKey.jwk]);
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('JWKS server has no port');
    const issuer = `http://127.0.0.1:${address.port}`;
    process.env.OAUTH_ISSUER_URL = issuer;
    process.env.OAUTH_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    resetSharedIssuerCaches();
    return { issuer, privateKey: signingKey.privateKey };
  })();
  return rig;
}

/** A bearer JWT for an arbitrary verified email (unknown or ambiguous users). */
export async function humanBearerForEmail(email: string): Promise<string> {
  const { issuer, privateKey } = await startRig();
  return mintJwt(
    humanClaims(issuer, { sub: `test:${email}`, email, aud: DATAOPS_API_RESOURCE }),
    { privateKey, kid: KID },
  );
}

/** A bearer JWT for an existing user, resolved by that user's email. */
export async function humanBearer(client: DynamoDBDocumentClient, userId: string): Promise<string> {
  const user = await getUser(client, userId);
  if (!user || !user.email) throw new Error(`Test user ${userId} must exist with an email to sign in`);
  return humanBearerForEmail(user.email);
}
