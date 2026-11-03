import path from 'node:path';

import { createClient } from '../api.mjs';
import { AuthError, UsageError } from '../errors.mjs';
import {
  hostOperatorConfigDir,
  hubSharedConfigDir,
  resolveProfileFromDir,
  saveProfileToDir,
} from '../config.mjs';
import { sessionCredential } from './auth.mjs';

const TOKEN_SCOPES = ['kb:write', 'templates:write', 'cards:write', 'newsletter:write'];
const TOKEN_HELP = `dataops tokens - manage scoped headless-agent credentials

Usage
  dataops tokens create --label LABEL [--scope SCOPE[,SCOPE...]] [--url URL]
      [--admin-config-dir DIR] [--config-dir DIR]
  dataops tokens list [--url URL] [--admin-config-dir DIR]
  dataops tokens revoke TOKEN_ID [--url URL] [--admin-config-dir DIR]

The admin credential comes from the host operator config directory by default.
Create writes the one-time bearer value directly to the Hub shared DataOps
credential file (owner-only permissions) and never prints it. The default
scopes are ${TOKEN_SCOPES.join(', ')}. Tokens expire after 90 days.
`;

export const summary = 'Issue and revoke admin-managed scoped agent tokens';
export const help = TOKEN_HELP;
export const commands = {
  create,
  list,
  revoke,
};

async function create(args, io) {
  const label = typeof args.label === 'string' ? args.label.trim() : '';
  if (!label) throw new UsageError('tokens create requires --label LABEL.');
  const scopes = parseScopes(args.scope);
  const { profile, configDir } = adminProfile(args);
  const targetDir = path.resolve(String(args.configDir || hubSharedConfigDir()));
  if (targetDir === path.resolve(configDir)) {
    throw new UsageError('The Hub agent credential directory must be separate from the host admin credential directory.');
  }
  const existing = resolveProfileFromDir(targetDir, { url: profile.url });
  if (existing.tokenId) {
    throw new UsageError('An agent token is already stored for this portal. Revoke it with `dataops logout` before issuing a replacement.');
  }

  const admin = clientFor(profile);
  const issued = await admin.post('/api/tokens', { label, scopes });
  if (typeof issued?.token !== 'string' || !issued.apiToken?.id) {
    throw new Error('The server did not return a complete token credential.');
  }

  let credentialsPath;
  try {
    credentialsPath = saveProfileToDir(targetDir, profile.url, {
      kind: 'agent',
      token: issued.token,
      tokenId: issued.apiToken.id,
      label: issued.apiToken.label,
      scopes: issued.apiToken.scopes,
      expiresAt: issued.apiToken.expiresAt,
      user: issued.apiToken.userId ? { id: issued.apiToken.userId } : null,
    });
  } catch (error) {
    try {
      await admin.delete(`/api/tokens/${encodeURIComponent(issued.apiToken.id)}`);
    } catch {
      // Keep the secret out of diagnostics; an admin can remove the orphan by
      // id from the token inventory if the server was unreachable.
    }
    throw new UsageError(`The token could not be stored outside the repository at ${targetDir}; any issued token was revoked when reachable.`);
  }

  const result = { apiToken: issued.apiToken, credentialsPath };
  if (!args.json) io.print(`Agent token ${issued.apiToken.label} saved to ${credentialsPath} (${issued.apiToken.scopes.join(', ')}).`);
  return result;
}

async function list(args, io) {
  const { profile } = adminProfile(args);
  const result = await clientFor(profile).get('/api/tokens');
  if (!args.json) {
    for (const token of result.tokens || []) {
      io.print(`${token.id}  ${token.label}  ${token.scopes.join(', ')}  expires ${token.expiresAt}`);
    }
    if (!(result.tokens || []).length) io.print('No active agent tokens.');
  }
  return result;
}

async function revoke(args, io) {
  const id = args._?.[0];
  if (!id) throw new UsageError('tokens revoke requires TOKEN_ID.');
  const { profile } = adminProfile(args);
  const result = await clientFor(profile).delete(`/api/tokens/${encodeURIComponent(id)}`);
  if (!args.json) io.print(result.revoked ? `Revoked agent token ${id}.` : `No active agent token ${id}.`);
  return result;
}

function adminProfile(args) {
  const configDir = path.resolve(String(args.adminConfigDir || hostOperatorConfigDir()));
  const profile = resolveProfileFromDir(configDir, { url: args.url });
  if (!profile.token && !profile.accessToken && !profile.clientId) {
    throw new AuthError(`No admin DataOps credential was found in ${configDir}. Sign in as an admin or pass --admin-config-dir.`);
  }
  profile.configDir = configDir;
  return { profile, configDir };
}

function clientFor(profile) {
  return createClient({ url: profile.url, credential: sessionCredential(profile) });
}

function parseScopes(raw) {
  if (raw === undefined) return [...TOKEN_SCOPES];
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  const scopes = [...new Set(values)];
  if (!scopes.length || scopes.some((scope) => !TOKEN_SCOPES.includes(scope))) {
    throw new UsageError(`--scope must contain one or more of: ${TOKEN_SCOPES.join(', ')}.`);
  }
  return scopes;
}
