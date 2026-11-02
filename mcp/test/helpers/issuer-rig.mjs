/**
 * Shared-issuer JWT test rig: an in-process JWKS endpoint plus mint and
 * claim helpers matching the shared issuer's token shape.
 */
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:http';

/** Serve one RSA JWK set on a loopback port; caller closes the server. */
export async function startJwksServer(keys) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** An RSA signing pair: `mint` with .privateKey, publish .jwk. */
export function generateSigningKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

/** Mint an RS256 JWT; alg 'none' mints an unsigned token (for reject tests). */
export function mintJwt(claims, { privateKey, kid, alg = 'RS256' } = {}) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc(alg ? { alg, kid, typ: 'JWT' } : { typ: 'JWT' });
  const body = enc(claims);
  const signature = alg === 'none'
    ? ''
    : signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Human access-token claims exactly as the shared issuer mints them. */
export function humanClaims(issuer, overrides = {}) {
  const t = nowSeconds();
  return {
    iss: issuer,
    aud: 'http://localhost/mcp',
    sub: 'user-1',
    email: 'agent@datatalks.club',
    email_verified: true,
    scope: 'openid mcp admin',
    client_id: 'dtc-cli',
    token_use: 'access',
    iat: t,
    nbf: t,
    exp: t + 3600,
    jti: 'jti-1',
    ...overrides,
  };
}
