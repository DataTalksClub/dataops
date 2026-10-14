import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApiError, createClient } from "../api.mjs";
import { AuthError } from "../errors.mjs";
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

/**
 * Device authorization grant. The browser half runs wherever the operator
 * already has a portal session, which is why this works over SSH: nothing
 * here needs a browser on this machine.
 */
export async function login(args, io) {
  const url = args.url || process.env.DATAOPS_URL || resolveProfile().url;
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
  if (!profile.token) throw new AuthError("Not signed in. Run `dataops login`, or set DATAOPS_TOKEN.");
  const client = createClient(profile);
  const result = await client.get("/api/me");
  if (args.json) return { ...result, portal: client.base, credential: profile.source === "environment" ? "DATAOPS_TOKEN" : "file" };
  const user = result.user || {};
  io.print(result.service ? `${result.service.id} (${result.service.scopes.join(", ")})` : `${user.name || "unknown"} <${user.email || "unknown"}>`);
  if (user.role) io.print(`role: ${user.role}`);
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
