import { getClient } from '../db/client';
import { getUser } from '../db/users';
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  createApiToken,
  createDeviceGrant,
  deleteApiToken,
  deleteDeviceGrant,
  deviceGrantExhausted,
  countDeviceGrantAttempt,
  getDeviceGrantByDeviceCode,
  getDeviceGrantByUserCode,
  listApiTokens,
  normalizeUserCode,
  resolveDeviceGrant,
} from '../db/cliAuth';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return {};
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function requestIp(event: LambdaEvent): string {
  const forwarded = headerValue(event.headers, 'x-forwarded-for');
  return forwarded.split(',')[0].trim() || 'unknown';
}

function portalBaseUrl(event: LambdaEvent): string {
  const configured = process.env.DATAOPS_PORTAL_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  const host = headerValue(event.headers, 'x-forwarded-host') || headerValue(event.headers, 'host');
  const forwardedProto = headerValue(event.headers, 'x-forwarded-proto');
  // Local development is served over http; everything else is https.
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = forwardedProto || (isLoopback ? 'http' : 'https');
  return host ? `${proto}://${host}` : '';
}

/** A label the operator can recognise in the approval page and token list. */
function sanitizeLabel(value: unknown): string {
  const label = String(value || '').trim().slice(0, 80);
  return label || 'DataOps CLI';
}

/**
 * Device authorization grant (RFC 8628 shaped) plus API token management.
 *
 * The CLI never sees the portal's identity provider: the portal authenticates
 * the human in the browser as it always does, and this route exchanges that
 * confirmation for a bearer token the CLI can hold.
 */
async function handleCliAuthRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/auth/device') && !path.startsWith('/api/tokens')) {
    return null;
  }

  const client = await getClient();
  const actorId = headerValue(event.headers, 'x-user-id');

  try {
    // POST /api/auth/device — the CLI starts a login. No credential required.
    if (method === 'POST' && path === '/api/auth/device') {
      const body = parseBody(event);
      if (!body) return json(400, { error: 'Invalid JSON body' });
      const { grant, deviceCode, userCode } = await createDeviceGrant(client, {
        label: sanitizeLabel(body.label),
        requestIp: requestIp(event),
      });
      const base = portalBaseUrl(event);
      return json(200, {
        deviceCode,
        userCode,
        verificationUri: `${base}/#/device`,
        verificationUriComplete: `${base}/#/device?userCode=${encodeURIComponent(userCode)}`,
        expiresAt: grant.expiresAt,
        expiresIn: Math.max(0, Math.round((Date.parse(grant.expiresAt) - Date.now()) / 1000)),
        interval: DEVICE_POLL_INTERVAL_SECONDS,
      });
    }

    // POST /api/auth/device/token — the CLI polls for the result.
    if (method === 'POST' && path === '/api/auth/device/token') {
      const body = parseBody(event);
      if (!body) return json(400, { error: 'Invalid JSON body' });
      const deviceCode = String(body.deviceCode || '');
      if (!deviceCode) return json(400, { error: 'deviceCode is required' });
      const grant = await getDeviceGrantByDeviceCode(client, deviceCode);
      if (!grant) return json(400, { error: 'expired_token' });
      if (grant.status === 'pending') return json(400, { error: 'authorization_pending' });
      if (grant.status === 'denied') {
        await deleteDeviceGrant(client, grant);
        return json(400, { error: 'access_denied' });
      }
      const user = grant.userId ? await getUser(client, grant.userId) : null;
      if (!user || user.disabled) {
        await deleteDeviceGrant(client, grant);
        return json(400, { error: 'access_denied' });
      }
      const { apiToken, token } = await createApiToken(client, {
        userId: user.id,
        label: grant.label,
        source: 'device',
      });
      // The grant is single use: the approval it carries has been spent.
      await deleteDeviceGrant(client, grant);
      return json(200, {
        token,
        tokenId: apiToken.id,
        expiresAt: apiToken.expiresAt,
        user: { id: user.id, name: user.name, email: user.email },
      });
    }

    // GET /api/auth/device/pending?userCode=... — what the browser is about to
    // authorize. Requires a signed-in operator.
    if (method === 'GET' && path === '/api/auth/device/pending') {
      if (!actorId) return json(401, { error: 'Unauthorized' });
      const userCode = normalizeUserCode(
        (event.queryStringParameters && event.queryStringParameters.userCode) || '',
      );
      if (!userCode) return json(400, { error: 'A complete user code is required' });
      const grant = await getDeviceGrantByUserCode(client, userCode);
      if (!grant || grant.status !== 'pending') return json(404, { error: 'Not found' });
      const attempts = await countDeviceGrantAttempt(client, grant);
      if (attempts > 5) {
        await deleteDeviceGrant(client, grant);
        return json(404, { error: 'Not found' });
      }
      return json(200, {
        label: grant.label,
        requestIp: grant.requestIp,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
      });
    }

    // POST /api/auth/device/approve — the human decides. Portal session only.
    if (method === 'POST' && path === '/api/auth/device/approve') {
      if (!actorId) return json(401, { error: 'Unauthorized' });
      const body = parseBody(event);
      if (!body) return json(400, { error: 'Invalid JSON body' });
      const userCode = normalizeUserCode(String(body.userCode || ''));
      if (!userCode) return json(400, { error: 'A complete user code is required' });
      const approve = body.approve !== false;
      const grant = await getDeviceGrantByUserCode(client, userCode);
      if (!grant || grant.status !== 'pending' || deviceGrantExhausted(grant)) {
        return json(404, { error: 'That code is not waiting for confirmation.' });
      }
      const user = await getUser(client, actorId);
      if (!user || user.disabled) return json(401, { error: 'Unauthorized' });
      await resolveDeviceGrant(client, grant, {
        status: approve ? 'approved' : 'denied',
        userId: user.id,
      });
      return json(200, { status: approve ? 'approved' : 'denied', label: grant.label });
    }

    // GET /api/tokens — the caller's own credentials.
    if (method === 'GET' && path === '/api/tokens') {
      if (!actorId) return json(401, { error: 'Unauthorized' });
      return json(200, { tokens: await listApiTokens(client, actorId) });
    }

    // DELETE /api/tokens/:id — revoke. Owners only; ids are token hashes.
    if (method === 'DELETE' && path.startsWith('/api/tokens/')) {
      if (!actorId) return json(401, { error: 'Unauthorized' });
      const id = decodeURIComponent(path.slice('/api/tokens/'.length).replace(/\/$/, ''));
      if (!id) return json(400, { error: 'Token id is required' });
      const owned = await listApiTokens(client, actorId);
      if (!owned.some((token) => token.id === id)) return json(404, { error: 'Not found' });
      await deleteApiToken(client, actorId, id);
      return json(204, {});
    }

    return null;
  } catch (err: unknown) {
    console.error('CLI auth route error:', err);
    return json(500, { error: 'Internal server error' });
  }
}

export { handleCliAuthRoutes };
