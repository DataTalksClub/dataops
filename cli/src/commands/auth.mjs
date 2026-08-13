import { hostname, userInfo } from "node:os";

import { ApiError, createClient } from "../api.mjs";
import {
  deleteProfile,
  resolveProfile,
  saveProfile,
  credentialsPath,
} from "../config.mjs";

const DEFAULT_INTERVAL_SECONDS = 5;

function defaultLabel() {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return hostname();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Device authorization grant. The browser half runs wherever the operator
 * already has a portal session, which is why this works over SSH: nothing
 * here needs a browser on this machine.
 */
export async function login(args, io) {
  const url = args.url || process.env.DATAOPS_URL || resolveProfile().url;
  const client = createClient({ url });
  const label = args.label || defaultLabel();

  const start = await client.post(
    "/api/auth/device",
    { label },
    { anonymous: true },
  );
  const verificationUri =
    start.verificationUriComplete || start.verificationUri;

  io.print("");
  io.print(`  Confirm this code:  ${start.userCode}`);
  io.print(`  Open in a browser:  ${verificationUri}`);
  io.print("");
  io.print("  Open that link on a machine you trust and sign in as usual.");
  io.print("  Waiting for confirmation... (Ctrl-C to cancel)");

  let intervalMs =
    Math.max(1, Number(start.interval) || DEFAULT_INTERVAL_SECONDS) * 1000;
  const deadline = Date.parse(start.expiresAt) || Date.now() + 10 * 60 * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let result = null;
    try {
      result = await client.post(
        "/api/auth/device/token",
        { deviceCode: start.deviceCode },
        { anonymous: true },
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const code = String(error.message || "");
      // RFC 8628 polling vocabulary: back off when told to, keep waiting while
      // pending, and stop on a terminal answer.
      if (code === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      if (code === "authorization_pending") continue;
      if (code === "access_denied")
        throw new Error("The login was denied in the browser.");
      if (code === "expired_token")
        throw new Error("The code expired. Run `dataops login` again.");
      throw error;
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

  throw new Error(
    "The code expired before it was confirmed. Run `dataops login` again.",
  );
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
  io.print(`${user.name || "unknown"} <${user.email || "unknown"}>`);
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
