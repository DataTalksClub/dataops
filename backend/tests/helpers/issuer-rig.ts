/**
 * Shared-issuer JWT test rig for backend tests: an in-process JWKS endpoint
 * plus mint helpers matching the shared issuer's token shape.
 */
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** Serve one RSA JWK set on a loopback port; the caller closes the server. */
export async function startJwksServer(keys: Array<Record<string, unknown>>): Promise<ReturnType<typeof createServer>> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** An RSA signing pair: mint with `privateKey`, publish `jwk`. */
export function generateSigningKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

/** Mint an RS256 JWT; alg 'none' mints an unsigned token (for reject tests). */
export function mintJwt(
  claims: Record<string, unknown>,
  { privateKey, kid, alg = 'RS256' }: { privateKey?: Buffer | import('crypto').KeyObject; kid?: string; alg?: string } = {},
): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc(alg ? { alg, kid, typ: 'JWT' } : { typ: 'JWT' });
  const body = enc(claims);
  const signature = !alg || alg === 'none'
    ? ''
    : signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Human access-token claims exactly as the shared issuer mints them. */
export function humanClaims(issuer: string, overrides: Record<string, unknown> = {}) {
  const t = nowSeconds();
  return {
    iss: issuer,
    aud: 'http://localhost/mcp',
    sub: 'user-1',
    email: 'agent@dtc.dev',
    email_verified: true,
    scope: 'openid mcp admin',
    client_id: 'dtc-cli',
    token_use: 'access',
    iat: t,
    nbf: t,
    exp: t + 3600,
    jti: 'jti-human',
    ...overrides,
  };
}

/** Service access-token claims (client_credentials grant). */
export function serviceClaims(issuer: string, overrides: Record<string, unknown> = {}) {
  const t = nowSeconds();
  return {
    iss: issuer,
    aud: 'https://ops.dtc.dev',
    sub: 'service:dataops-invoice-reader',
    client_id: 'dataops-invoice-reader',
    scope: 'invoice:read',
    email: null,
    email_verified: false,
    token_use: 'access',
    grant_type: 'client_credentials',
    iat: t,
    nbf: t,
    exp: t + 900,
    jti: 'jti-service',
    ...overrides,
  };
}
