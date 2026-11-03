import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApiError, createClient } from "../api.mjs";
import { AuthError, UsageError } from "../errors.mjs";
import {
  deleteProfile,
  resolveProfile,
  resolveProfileFromDir,
  saveProfile,
  saveProfileToDir,
  credentialsPath,
  hubSharedConfigDir,
  hostOperatorConfigDir,
} from "../config.mjs";

export const ISSUER = "https://oauth.dtcdev.click";
const CLI_CLIENT_ID = "dtc-cli";
const API_RESOURCE = "https://ops.dtcdev.click";

/** Tests and air-gapped deployments can point the CLI at another issuer. */
function issuerBase() {
  return (process.env.DTC_OAUTH_ISSUER || ISSUER).replace(/\/$/, "");
}
const GRANT_DEVICE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * When the issuer (or a portal Lambda URL) hands back a verification page on
 * a raw host, keep the human-facing origin of the target portal instead,
 * preserving path, query and hash.
 */
export function rewriteVerificationUri(rawUri, targetBaseUrl) {
  if (!rawUri || !targetBaseUrl) return rawUri;
  try {
    const parsedUri = new URL(rawUri);
    const targetOrigin = new URL(targetBaseUrl).origin;
    if (parsedUri.origin !== targetOrigin) {
      return `${targetOrigin}${parsedUri.pathname}${parsedUri.search}${parsedUri.hash}`;
    }
    return rawUri;
  } catch {
    return rawUri;
  }
}

function defaultLabel() {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
}

function defaultAgentLabel() {
  return `hub-sessions@${hostname()}`;
}

/** The device-login loop lives in DataTalksClub/auth. Find that checkout. */
async function sharedDeviceLogin() {
  const home = process.env.DTC_AUTH_HOME;
  const candidates = [];
  if (home) candidates.push(path.join(home, "dtc_device_login", "login.mjs"));
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, "auth", "dtc_device_login", "login.mjs"));
    candidates.push(path.join(path.dirname(dir), "auth", "dtc_device_login", "login.mjs"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "Shared device login was not found. Clone DataTalksClub/auth next to this repo or set DTC_AUTH_HOME.",
    );
  }
  return import(pathToFileURL(found).href);
}

/** Claims of a shared-issuer access token, without verifying the signature. */
function claimsOf(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** Token endpoint calls speak x-www-form-urlencoded (RFC 6749). */
async function issuerTokenForm(body) {
  const response = await fetch(`${issuerBase()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function assertHttpsOrLoopback(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Credentials require HTTPS outside local development.");
  }
}

/**
 * The portal speaks camelCase device-grant JSON; the shared issuer speaks
 * the RFC names and takes the poll on its form-encoded token endpoint. The
 * shared loop drives both through this translating `post`.
 */
async function issuerDeviceLogin({ label, prompt, presentUri }) {
  const { deviceLogin, DeviceLoginError } = await sharedDeviceLogin();
  const post = async (target, body) => {
    if (target.endsWith("/oauth/token")) {
      return issuerTokenForm(body);
    }
    const response = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };
  try {
    return await deviceLogin({
      post,
      baseUrl: issuerBase(),
      startPath: "/oauth/device",
      tokenPath: "/oauth/token",
      startBody: { client_id: CLI_CLIENT_ID, resource: API_RESOURCE, scope: "openid email profile offline_access mcp admin" },
      prompt,
      presentUri,
    });
  } catch (error) {
    if (!(error instanceof DeviceLoginError)) throw error;
    if (error.code === "expired_token" || error.code === "timeout") {
      throw new Error("The code expired. Run `dataops login` again.");
    }
    throw new Error(error.message);
  }
}

/**
 * Human login: the shared issuer's device grant. The browser half runs on
 * oauth.dtcdev.click (Google SSO restricted to verified @datatalks.club
 * accounts), which is why this still works over SSH with no local browser.
 */
export async function login(args, io) {
  const url = args.url || process.env.DATAOPS_URL || resolveProfile().url;
  if (args.serviceTokenStdin !== undefined) {
    if (args.serviceTokenStdin !== true) throw new Error("Pass the service credential through stdin, never as an argument.");
    return serviceLogin(args, io, url);
  }
  const label = args.label || defaultLabel();
  const payload = await issuerDeviceLogin({
    label,
    prompt: (text) => io.print(text),
    presentUri: (uri) => uri,
  });
  const profile = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + (Number(payload.expires_in) || 3600) * 1000).toISOString(),
    user: userFromToken(payload.access_token),
    label,
  };
  const client = createClient({ url, token: profile.accessToken });
  const identity = await client.get("/api/me");
  if (identity.user) profile.user = identity.user;
  saveProfile(url, profile);
  if (args.json) return { ...payload, user: profile.user, url };
  io.print("");
  io.print(`  Signed in as ${profile.user?.name || profile.user?.email || "unknown user"}.`);
  io.print(`  Session stored in ${credentialsPath()} (refreshable until the issuer revokes it).`);
  return { user: profile.user, url };
}

function userFromToken(jwt) {
  const claims = claimsOf(jwt);
  return claims.email ? { id: claims.sub, email: claims.email, name: claims.email } : null;
}

/**
 * Service login: mint once with client_credentials to verify the credential
 * and learn its scopes; the secret stays local and tokens are minted per run.
 */
async function serviceLogin(args, io, url) {
  const parsedBase = new URL(url);
  if (parsedBase.protocol !== "https:" && !(parsedBase.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedBase.hostname))) {
    throw new Error("Service credentials require HTTPS outside local development.");
  }
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    throw new Error('Pass a JSON document {"clientId","clientSecret"} through stdin.');
  }
  const { clientId, clientSecret } = input || {};
  if (!clientId || !clientSecret) throw new Error('Both "clientId" and "clientSecret" are required.');
  const minted = await mintServiceToken({ clientId, clientSecret });
  const client = createClient({ url, token: minted.accessToken });
  const identity = await client.get("/api/me");
  if (!identity.service?.id) throw new Error("The credential was not accepted as a service principal.");
  saveProfile(url, {
    kind: "service",
    clientId,
    clientSecret,
    user: null,
    label: identity.service.id,
    scopes: identity.service.scopes,
  });
  io.print(`Service credential configured for ${url} (${(identity.service.scopes || []).join(", ")}).`);
  return identity;
}

async function mintServiceToken({ clientId, clientSecret }) {
  const { status, body } = await issuerTokenForm({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    resource: API_RESOURCE,
  });
  if (status !== 200 || !body?.access_token) {
    throw new AuthError(body?.error === "invalid_client"
      ? "The issuer refused the client id or secret."
      : `Token mint failed: ${body?.error || `HTTP ${status}`}`);
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
  };
}

/** Rotate a single-use refresh token for a fresh access token. */
export async function refreshTokens(profile) {
  if (!profile.refreshToken) throw new AuthError("No refreshable session. Run `dataops login`.");
  const filePath = profile.configDir
    ? path.join(path.resolve(profile.configDir), "credentials.json")
    : credentialsPath();
  return withCredentialsLock(filePath, async () => {
    const current = resolveProfileFromDir(path.dirname(filePath), { url: profile.url });
    if (hasNewerSession(current, profile)) return current;

    const { status, body } = await issuerTokenForm({
      grant_type: "refresh_token",
      refresh_token: profile.refreshToken,
      client_id: CLI_CLIENT_ID,
    });
    if (status !== 200 || !body?.access_token) {
      const reason = body?.error_description || body?.error || `HTTP ${status}`;
      throw new AuthError(`Token refresh failed: ${reason}`);
    }
    const updated = {
      ...profile,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || profile.refreshToken,
      expiresAt: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString(),
    };
    if (profile.configDir) {
      const { configDir, ...stored } = updated;
      saveProfileToDir(profile.configDir, profile.url, stored);
    } else saveProfile(profile.url, updated);
    return updated;
  });
}

function hasNewerSession(current, requested) {
  if (!current.refreshToken || !current.accessToken) return false;
  if (current.refreshToken !== requested.refreshToken) return true;
  return current.accessToken !== requested.accessToken &&
    Date.parse(current.expiresAt || "") > Date.parse(requested.expiresAt || "");
}

/** Serialize refresh-token rotation across processes sharing one credential file. */
async function withCredentialsLock(credentialsFile, action) {
  const lockPath = `${credentialsFile}.lock`;
  mkdirSync(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch (error) {
      if (lockFd !== undefined) {
        closeSync(lockFd);
        lockFd = undefined;
        try { unlinkSync(lockPath); } catch {}
      }
      if (error.code !== "EEXIST") throw error;
      removeDeadRefreshLock(lockPath);
      if (Date.now() >= deadline) throw new AuthError("Timed out waiting for another DataOps session refresh.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const lockStat = fstatSync(lockFd);
  try {
    return await action();
  } finally {
    closeSync(lockFd);
    try {
      const currentStat = lstatSync(lockPath);
      if (currentStat.dev === lockStat.dev && currentStat.ino === lockStat.ino) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function removeDeadRefreshLock(lockPath) {
  let stat;
  try { stat = lstatSync(lockPath); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let lock;
  try {
    const fd = openSync(lockPath, "r");
    try {
      const buffer = Buffer.alloc(256);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      lock = JSON.parse(buffer.toString("utf8", 0, size));
    } finally { closeSync(fd); }
  } catch {
    if (Date.now() - stat.mtimeMs > 30_000) unlinkIfSameFile(lockPath, stat);
    return;
  }
  if (!Number.isInteger(lock.pid) || !processIsAlive(lock.pid)) unlinkIfSameFile(lockPath, stat);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function unlinkIfSameFile(filePath, expectedStat) {
  try {
    const currentStat = lstatSync(filePath);
    if (currentStat.dev === expectedStat.dev && currentStat.ino === expectedStat.ino) unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function logout(args, io) {
  const profile = resolveProfile(args);
  if (profile.source === "environment") {
    throw new Error("DATAOPS_TOKEN is set; unset it to drop the environment credential.");
  }
  if (!profile.token && !profile.accessToken && !profile.clientId) {
    io.print("Not signed in.");
    return { status: "signed-out" };
  }
  if (profile.kind === "agent" && profile.tokenId) {
    const client = createClient({ url: profile.url, credential: sessionCredential(profile) });
    try {
      await client.delete("/api/tokens/self");
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      // An administrator may already have revoked the credential.
    }
    deleteProfile(profile.url);
    io.print("Signed out and revoked this agent token.");
    return { status: "signed-out" };
  }
  // Revoke at the issuer first: deleting only the local copy leaves a live
  // refresh family behind. Service credentials carry no refresh token; the
  // secret itself is the only state, so removing it ends the login.
  if (profile.refreshToken) {
    try {
      await fetch(`${issuerBase()}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: profile.refreshToken, client_id: CLI_CLIENT_ID }).toString(),
      });
    } catch {
      // The issuer may be unreachable; the local removal still happens.
    }
  }
  deleteProfile(profile.url);
  io.print(profile.clientId
    ? "Removed the local service credential. Rotate or disable its issuer client to revoke server access."
    : "Signed out and revoked this machine's session at the issuer.");
  return { status: "signed-out" };
}

export async function whoami(args, io) {
  const profile = resolveProfile(args);
  if (!profile.token && !profile.accessToken && !profile.clientId) {
    throw new AuthError("Not signed in. Run `dataops login`, or set DATAOPS_TOKEN.");
  }
  const client = createClient({ url: profile.url, credential: sessionCredential(profile) });
  const result = await client.get("/api/me");
  if (args.json) return { ...result, portal: profile.url, credential: profile.source === "environment" ? "DATAOPS_TOKEN" : credentialsPath() };
  const user = result.user || {};
  io.print(result.service ? `${result.service.id} (${(result.service.scopes || []).join(", ")})` : `${user.name || "unknown"} <${user.email || "unknown"}>`);
  if (result.apiToken) {
    io.print(`token: ${result.apiToken.label} (${String(result.apiToken.id || "").slice(0, 8)})`);
    io.print(`scopes: ${(result.apiToken.scopes || []).join(", ")}`);
  }
  if (user.role) io.print(`role: ${user.role}`);
  io.print(`portal: ${profile.url}`);
  io.print(`credential: ${profile.source === "environment" ? "DATAOPS_TOKEN" : credentialsPath()}`);
  return result;
}

/**
 * A credential provider for createClient: expires the stored access token
 * proactively, rotates the refresh token on 401, and mints fresh service
 * tokens per exchange. Returns a static token for environment credentials.
 */
export function sessionCredential(profile) {
  if (profile.kind === "service" && profile.clientId) {
    let minted = null;
    return async () => {
      if (!minted || minted.expiresAt <= Date.now() + 30_000) {
        minted = await mintServiceToken({ clientId: profile.clientId, clientSecret: profile.clientSecret });
      }
      return minted.accessToken;
    };
  }
  if (profile.accessToken) {
    let current = { token: profile.accessToken, expiresAt: Date.parse(profile.expiresAt || 0) };
    const credential = async () => {
      if (current.expiresAt <= Date.now() + 60_000) {
        const refreshed = await refreshTokens(profile);
        current = { token: refreshed.accessToken, expiresAt: Date.parse(refreshed.expiresAt) };
      }
      return current.token;
    };
    credential.refresh = async () => {
      const refreshed = await refreshTokens(profile);
      current = { token: refreshed.accessToken, expiresAt: Date.parse(refreshed.expiresAt) };
      return current.token;
    };
    return credential;
  }
    // Anything else is a static token (environment override or a stored
  // deployment secret): present it as-is.
  return async () => profile.token || null;
}

