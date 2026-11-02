import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { UsageError } from "./errors.mjs";

// Credentials are secrets on a shared machine: the directory and file are
// owner-only, and the token is never accepted as a command line argument
// because that lands in shell history and `ps` output.
const XDG_BASE = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const CONFIG_DIR =
  process.env.DATAOPS_CONFIG_DIR ||
  path.join(XDG_BASE, "dataops");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");

/** The production portal; used when no --url, DATAOPS_URL, or login names another. */
export const DEFAULT_URL = "https://ops.dtcdev.click";

/**
 * Resolve the Hub-owned shared DataOps credential directory (`<hub-config>/shared/dataops`).
 * Inside a Hub managed session, HOME/XDG_CONFIG_HOME lives under
 * `<hub-config>/managed-engines/<engine>/home`.
 */
export function hubSharedConfigDir() {
  const marker = `${path.sep}managed-engines${path.sep}`;
  for (const candidate of [XDG_BASE, homedir()]) {
    const idx = candidate.indexOf(marker);
    if (idx > 0) {
      const hubRoot = candidate.slice(0, idx);
      return path.join(hubRoot, "shared", "dataops");
    }
  }
  return path.join(XDG_BASE, "agent-hub", "shared", "dataops");
}

/**
 * When running inside a Hub managed engine, return the host operator's
 * `~/.config/dataops` directory so `dataops tokens create` can use the host
 * admin credential to mint a scoped shared session token.
 */
export function hostOperatorConfigDir() {
  const marker = `${path.sep}managed-engines${path.sep}`;
  for (const candidate of [XDG_BASE, homedir()]) {
    const idx = candidate.indexOf(marker);
    if (idx > 0) {
      const hubRoot = candidate.slice(0, idx);
      return path.join(path.dirname(hubRoot), "dataops");
    }
  }
  return CONFIG_DIR;
}

function activeCredentialsPath() {
  if (process.env.DATAOPS_CONFIG_DIR) return CREDENTIALS_PATH;
  if (existsSync(CREDENTIALS_PATH)) return CREDENTIALS_PATH;
  const marker = `${path.sep}managed-engines${path.sep}`;
  if (XDG_BASE.includes(marker) || homedir().includes(marker)) {
    const sharedPath = path.join(hubSharedConfigDir(), "credentials.json");
    if (existsSync(sharedPath)) return sharedPath;
  }
  return CREDENTIALS_PATH;
}

export function credentialsPath() {
  return activeCredentialsPath();
}

export function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function assertOutsideGitRepo(targetDir) {
  const resolved = path.resolve(targetDir);
  const sysTmp = path.resolve(tmpdir());
  if (
    resolved === sysTmp ||
    resolved.startsWith(`${sysTmp}${path.sep}`) ||
    resolved.includes(`${path.sep}.tmp${path.sep}`)
  ) {
    return;
  }
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      throw new UsageError(
        `Refusing to store DataOps credentials inside a git repository (${current}). Store tokens outside repos (for example in ~/.config/agent-hub/shared/dataops).`,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readStoreAt(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function readStore() {
  return readStoreAt(activeCredentialsPath());
}

function writeStoreAt(dir, store) {
  const resolvedDir = path.resolve(dir);
  const filePath = path.join(resolvedDir, "credentials.json");
  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  chmodSync(resolvedDir, 0o700);
  const temporary = path.join(resolvedDir, `.credentials-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      mode: 0o600, flag: "wx",
    });
    renameSync(temporary, filePath);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return filePath;
}

function writeStore(store) {
  const targetDir = path.dirname(activeCredentialsPath());
  writeStoreAt(targetDir, store);
}

export function saveProfileToDir(dir, url, profile) {
  assertOutsideGitRepo(dir);
  const resolvedDir = path.resolve(dir);
  const filePath = path.join(resolvedDir, "credentials.json");
  const store = readStoreAt(filePath);
  store.profiles = store.profiles || {};
  store.profiles[normalizeUrl(url)] = profile;
  store.defaultUrl = normalizeUrl(url);
  return writeStoreAt(resolvedDir, store);
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

export function resolveProfileFromDir(dir, options = {}) {
  const store = readStoreAt(path.join(path.resolve(dir), "credentials.json"));
  const url = normalizeUrl(
    options.url || process.env.DATAOPS_URL || store.defaultUrl || DEFAULT_URL,
  );
  const profile = (store.profiles || {})[url];
  if (!profile?.token) return { url, token: "", source: "none" };
  return {
    url,
    token: profile.token,
    tokenId: profile.tokenId || "",
    label: profile.label || "",
    scopes: Array.isArray(profile.scopes) ? profile.scopes : null,
    expiresAt: profile.expiresAt || "",
    user: profile.user || null,
    kind: profile.kind || "user",
    source: "file",
  };
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
    label: profile.label || "",
    scopes: Array.isArray(profile.scopes) ? profile.scopes : null,
    expiresAt: profile.expiresAt || "",
    user: profile.user || null,
    kind: profile.kind || "user",
    source: "file",
  };
}
