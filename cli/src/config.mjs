import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

// Credentials are secrets on a shared machine: the directory and file are
// owner-only, and the token is never accepted as a command line argument
// because that lands in shell history and `ps` output.
const CONFIG_DIR =
  process.env.DATAOPS_CONFIG_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
    "dataops",
  );
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");

/** The production portal; used when no --url, DATAOPS_URL, or login names another. */
export const DEFAULT_URL = "https://ops.dtcdev.click";

export function credentialsPath() {
  return CREDENTIALS_PATH;
}

export function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function readStore() {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function writeStore(store) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);
  const temporary = path.join(CONFIG_DIR, `.credentials-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600, flag: "wx",
    });
    renameSync(temporary, CREDENTIALS_PATH);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function saveProfile(url, profile) {
  const store = readStore();
  store.profiles = store.profiles || {};
  store.profiles[normalizeUrl(url)] = profile;
  store.defaultUrl = normalizeUrl(url);
  writeStore(store);
}

export function deleteProfile(url) {
  const store = readStore();
  const key = normalizeUrl(url);
  if (store.profiles) delete store.profiles[key];
  if (store.defaultUrl === key) {
    store.defaultUrl = Object.keys(store.profiles || {})[0] || "";
  }
  writeStore(store);
}

/**
 * Resolve which portal to talk to and with what credential. Environment wins
 * over stored state so CI can run without a login step.
 */
export function resolveProfile(options = {}) {
  const store = readStore();
  const url = normalizeUrl(
    options.url || process.env.DATAOPS_URL || store.defaultUrl || DEFAULT_URL,
  );
  const envToken = process.env.DATAOPS_TOKEN || "";
  if (envToken) return { url, token: envToken, source: "environment" };
  const profile = (store.profiles || {})[url];
  if (!profile?.token) return { url, token: "", source: "none" };
  return {
    url,
    token: profile.token,
    tokenId: profile.tokenId || "",
    expiresAt: profile.expiresAt || "",
    user: profile.user || null,
    kind: profile.kind || "user",
    source: "file",
  };
}
