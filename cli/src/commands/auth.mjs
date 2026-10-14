import { existsSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { isatty } from "node:tty";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApiError, createClient } from "../api.mjs";
import {
  deleteProfile,
  resolveProfile,
  saveProfile,
  credentialsPath,
} from "../config.mjs";

function defaultLabel() {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
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

/**
 * When the server returns a verification URI hosted on a raw internal hostname
 * (such as a direct Lambda function URL), rewrite it to the origin of the target
 * portal URL passed by the operator, keeping the path, query, hash and userCode intact.
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

/** The portal speaks camelCase. The shared loop speaks the device-grant names. */
function deviceStartFromPortal(payload) {
  const expiresIn = Number.isFinite(payload.expiresIn)
    ? payload.expiresIn
    : Math.max(0, Math.round((Date.parse(payload.expiresAt) - Date.now()) / 1000));
  return {
    device_code: payload.deviceCode,
    user_code: payload.userCode,
    verification_uri: payload.verificationUri,
    verification_uri_complete: payload.verificationUriComplete,
    expires_in: expiresIn,
    interval: payload.interval,
  };
}

/** Import only an already-issued user API token, never a browser session. */
async function importUserToken(url, args, io) {
  if (args.tokenStdin !== true || args.serviceTokenStdin !== undefined || args._?.length) {
    throw new Error("Use --token-stdin alone and pass the token through stdin, never as an argument.");
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("A valid portal URL is required for token import."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) {
    throw new Error("User token import requires HTTPS (HTTP is allowed only on loopback), without URL credentials, query, or fragment.");
  }
  if (isatty(0)) throw new Error("Token input must be piped or redirected; terminal input could echo the secret.");
  // Bound memory before reading, including when stdin is an arbitrarily large file.
  const input = Buffer.alloc(128);
  let length = 0;
  try {
    while (length < input.length) {
      const count = readSync(0, input, length, input.length - length, null);
      if (!count) break;
      length += count;
    }
  } catch { throw new Error("Could not read the user token from stdin."); }
  const token = input.subarray(0, length).toString("utf8").trim();
  if (length === input.length || !/^dops_[a-f0-9]{64}$/.test(token)) {
    throw new Error("Invalid user API token. Expected one issued dops_ user token on stdin.");
  }
  const client = createClient({
    url, token,
    // No redirect may forward this credential to a different endpoint or downgrade HTTPS.
    fetchImpl: (target, options) => fetch(target, {
      ...options, redirect: "error", signal: AbortSignal.timeout(15_000),
    }),
  });
  let identity, listed;
  try {
    identity = await client.get("/api/me");
    listed = await client.get("/api/tokens");
  } catch (error) {
    // Never print server bodies or underlying transport errors: they may echo a credential.
    if (error instanceof ApiError) {
      if ([401, 403].includes(error.status)) throw new Error("User token rejected: invalid, expired, revoked, or access denied. Stored credentials unchanged.");
      throw new Error(`User token validation failed (HTTP ${error.status}). Stored credentials unchanged.`);
    }
    throw new Error("Could not validate user token: network, timeout, or redirect failure. Stored credentials unchanged.");
  }
  const user = identity?.user;
  const tokenId = createHash("sha256").update(token).digest("hex");
  const entry = Array.isArray(listed?.tokens) ? listed.tokens.find(item => item?.id === tokenId) : null;
  if (!identity || identity.service !== undefined || !user ||
      typeof user.id !== "string" || !user.id.trim() ||
      typeof user.email !== "string" || !user.email.trim() || user.disabled === true ||
      !entry || entry.userId !== user.id || typeof entry.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= Date.now()) {
    throw new Error("The portal did not verify an active user API token and its owner. Stored credentials unchanged.");
  }
  // Only persist known fields; never echo arbitrary server payloads, even with --json.
  saveProfile(client.base, {
    token, tokenId, kind: "user", expiresAt: entry.expiresAt,
    user: { id: user.id, email: user.email, ...(typeof user.name === "string" ? { name: user.name } : {}) },
  });
  const result = { status: "signed-in", kind: "user" };
  if (!args.json) io.print("User token validated and saved.");
  return result;
}

/**
 * Device authorization grant. The browser half runs wherever the operator
 * already has a portal session, which is why this works over SSH: nothing
 * here needs a browser on this machine.
 */
export async function login(args, io) {
  const url = args.url || process.env.DATAOPS_URL || resolveProfile().url;
  if (args.tokenStdin !== undefined) return importUserToken(url, args, io);
  if (args.serviceTokenStdin !== undefined) {
    if (args.serviceTokenStdin !== true) throw new Error("Pass the service token through stdin, never as an argument.");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new Error("Service credentials require HTTPS outside local development.");
    }
    const token = readFileSync(0, "utf8").trim();
    if (!/^dops_svc_[a-f0-9]{64}$/.test(token)) throw new Error("Invalid service credential.");
    const serviceClient = createClient({ url, token });
    const identity = await serviceClient.get("/api/me");
    if (identity.service?.id !== "invoice-reader" || identity.service.scopes?.join(" ") !== "invoices:read") {
      throw new Error("The credential is not an invoice reader service credential.");
    }
    saveProfile(serviceClient.base, { token, kind: "service", label: identity.service.id, expiresAt: null });
    io.print(`Service credential configured for ${serviceClient.base} (invoices:read).`);
    return identity;
  }
  const client = createClient({ url });
  const label = args.label || defaultLabel();
  const { deviceLogin, DeviceLoginError } = await sharedDeviceLogin();
  const post = async (target, body) => {
    const route = target.startsWith(client.base) ? target.slice(client.base.length) : target;
    const polling = route === "/api/auth/device/token";
    const wireBody = polling ? { deviceCode: body.device_code } : body;
    try {
      const payload = await client.post(route, wireBody, { anonymous: true });
      return { status: 200, body: polling ? payload : deviceStartFromPortal(payload) };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const payload = error.body && typeof error.body === "object" ? error.body : { error: error.message };
      return { status: error.status, body: payload };
    }
  };
  let result;
  try {
    result = await deviceLogin({
      post,
      baseUrl: client.base,
      startBody: { label },
      prompt: (text) => io.print(text),
      presentUri: (uri) => rewriteVerificationUri(uri, client.base),
    });
  } catch (error) {
    if (!(error instanceof DeviceLoginError)) throw error;
    if (error.code === "expired_token" || error.code === "timeout") {
      throw new Error("The code expired. Run `dataops login` again.");
    }
    throw new Error(error.message);
  }

  saveProfile(client.base, {
    token: result.token,
    tokenId: result.tokenId,
    expiresAt: result.expiresAt,
    user: result.user,
    label,
  });
  if (args.json) return result;
  io.print("");
  io.print(
    `  Signed in as ${result.user?.name || result.user?.email || "unknown user"}.`,
  );
  io.print(
    `  Token stored in ${credentialsPath()} (expires ${result.expiresAt.slice(0, 10)}).`,
  );
  return result;
}

export async function logout(args, io) {
  const profile = resolveProfile(args);
  if (!profile.token) {
    io.print("Not signed in.");
    return { status: "signed-out" };
  }
  if (profile.source === "environment") {
    throw new Error(
      "DATAOPS_TOKEN is set; unset it or revoke the token with `dataops tokens revoke`.",
    );
  }
  const client = createClient(profile);
  if (profile.kind === "service") {
    deleteProfile(profile.url);
    io.print("Removed the local service credential. Rotate or disable its deployment digest to revoke server access.");
    return { status: "signed-out" };
  }
  // Revoke server-side first: deleting only the local copy leaves a live
  // credential behind.
  try {
    const listed = await client.get("/api/tokens");
    const current = (listed.tokens || []).find(
      (token) => token.id === profile.tokenId,
    );
    if (current)
      await client.delete(`/api/tokens/${encodeURIComponent(current.id)}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  deleteProfile(profile.url);
  io.print("Signed out and revoked this machine's token.");
  return { status: "signed-out" };
}

export async function whoami(args, io) {
  const profile = resolveProfile(args);
  if (!profile.token) throw new Error("Not signed in. Run `dataops login`.");
  const client = createClient(profile);
  const result = await client.get("/api/me");
  if (args.json) return result;
  const user = result.user || {};
  io.print(result.service ? `${result.service.id} (${result.service.scopes.join(", ")})` : `${user.name || "unknown"} <${user.email || "unknown"}>`);
  io.print(`portal: ${client.base}`);
  io.print(
    `credential: ${profile.source === "environment" ? "DATAOPS_TOKEN" : credentialsPath()}`,
  );
  return result;
}

export async function tokensList(args, io) {
  const profile = resolveProfile(args);
  const client = createClient(profile);
  const result = await client.get("/api/tokens");
  if (args.json) return result;
  const tokens = result.tokens || [];
  if (tokens.length === 0) {
    io.print("No API tokens.");
    return result;
  }
  for (const token of tokens) {
    io.print(
      [
        token.id.slice(0, 12),
        token.label,
        `expires ${token.expiresAt.slice(0, 10)}`,
        token.lastUsedAt
          ? `last used ${token.lastUsedAt.slice(0, 10)}`
          : "never used",
      ].join("  "),
    );
  }
  return result;
}

export async function tokensRevoke(args, io) {
  const id = args._[0];
  if (!id) throw new Error("Usage: dataops tokens revoke <id>");
  const profile = resolveProfile(args);
  const client = createClient(profile);
  const listed = await client.get("/api/tokens");
  const match = (listed.tokens || []).find(
    (token) => token.id === id || token.id.startsWith(id),
  );
  if (!match) throw new Error(`No token matching ${id}.`);
  await client.delete(`/api/tokens/${encodeURIComponent(match.id)}`);
  io.print(`Revoked ${match.label} (${match.id.slice(0, 12)}).`);
  return { status: "revoked", id: match.id };
}
