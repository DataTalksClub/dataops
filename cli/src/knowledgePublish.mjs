/**
 * Reconcile the DataOps knowledge store with a knowledge-repository commit
 * without overwriting edits Git has not seen.
 *
 * Every managed path whose prod copy (sha256 from /knowledge/manifest)
 * differs from the commit is classified three-way, with Git's history of the
 * path as the record of what Git has seen:
 *  - publish:   prod's copy is a version Git recorded for the path (or prod
 *               never had the path), so Git's copy replaces it;
 *  - ahead:     prod changed after a Git-recorded version that is still the
 *               commit's copy, i.e. a web or CLI edit the daily mirror has
 *               not brought into Git yet; it is left alone;
 *  - conflict:  prod changed after a Git-recorded version and Git changed
 *               the path too (or prod's lineage reaches no Git version);
 *               it is left alone and reported.
 * "Absent" is a Git-recorded state only where Git deleted the path, or before
 * prod's first version of it.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const ZERO = /^0+$/;
const REGULAR_MODES = new Set(["100644", "100755"]);
/** Request bodies stay well under the API's 6 MB payload limit. */
export const MAX_BATCH_BYTES = 4_000_000;
/** History pages read per diverged path before its lineage counts as unknown. */
export const MAX_HISTORY_PAGES = 20;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when `file` lies under one of the store's managed top-level roots. */
export function isManagedPath(file, roots) {
  const slash = file.indexOf("/");
  return slash > 0 && roots.includes(file.slice(0, slash)) && !file.split("/").some((part) => !part || part === "." || part === "..");
}

/** Prod's state before its first version of a path: absent, a state both sides share. */
export const ORIGIN = Symbol("origin");

/**
 * Classify one diverged path. `states` is prod's lineage newest first: the
 * current state, then older published states (sha256, or null when deleted),
 * ending with ORIGIN when the walk reached prod's first version. `known`
 * holds the states Git recorded for the path.
 */
export function classify(states, known, headSha) {
  const index = states.findIndex((state) => state === ORIGIN || known.has(state));
  if (index === 0) return "publish";
  if (index === -1) return "conflict";
  return (states[index] === ORIGIN ? null : states[index]) === headSha ? "ahead" : "conflict";
}

/**
 * Plan a reconcile. `files` maps every managed path in the commit to
 * `{ bytes, sha }`; `prod` is the manifest's entries; `known(path)` returns
 * the Git-recorded states of a path; `lineage(path)` resolves prod's states
 * (current first) for a path whose current state Git does not know.
 */
export async function planReconcile({ files, prod, known, lineage }) {
  const paths = [...new Set([...files.keys(), ...Object.keys(prod)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const plan = { mutations: [], ahead: [], conflicts: [], unchanged: 0 };
  for (const file of paths) {
    const head = files.get(file) || null;
    const headSha = head ? head.sha : null;
    const prodSha = prod[file]?.sha256 ?? null;
    if (prodSha === headSha) {
      plan.unchanged += 1;
      continue;
    }
    const recorded = known(file);
    const verdict = recorded.has(prodSha) ? "publish" : classify(await lineage(file), recorded, headSha);
    if (verdict === "publish") {
      if (!head) plan.mutations.push({ path: file, operation: "delete" });
      else plan.mutations.push({ path: file, operation: prodSha ? "edit" : "create", base64: head.bytes.toString("base64") });
    } else if (verdict === "ahead") {
      plan.ahead.push(file);
    } else {
      plan.conflicts.push({ path: file, prod: prodSha ? "differs" : "absent" });
    }
  }
  return plan;
}

/**
 * Prod's states for a path, newest first, from /knowledge/history pages:
 * each version's sha256 (null once deleted), the first being the current
 * state, then ORIGIN when the history is exhausted.
 */
export async function prodLineage(api, file, maxPages = MAX_HISTORY_PAGES) {
  const states = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const result = await api.get("/knowledge/history", { query: { path: file, cursor } });
    for (const version of result.versions || []) states.push(version.deleted ? null : version.sha256);
    cursor = result.cursor;
    if (!cursor) return [...states, ORIGIN];
  }
  return states;
}

/** The API body form of a planned mutation. */
export function apiMutation(mutation) {
  if (mutation.operation === "delete") return { path: mutation.path };
  return { path: mutation.path, base64: mutation.base64, absent: mutation.operation === "create" };
}

/** Split mutations into request-sized batches; a single oversized file is an error. */
export function batches(mutations, limit = MAX_BATCH_BYTES) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const mutation of mutations) {
    const bytes = mutation.path.length + (mutation.base64?.length || 0) + 64;
    if (bytes > limit) throw new Error(`${mutation.path} is too large to publish through the API (${mutation.base64.length} base64 bytes)`);
    if (batch.length && size + bytes > limit) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(mutation);
    size += bytes;
  }
  if (batch.length) out.push(batch);
  return out;
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30, ...options });
}

export function resolveCommit(repo, rev) {
  return git(repo, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { encoding: "utf8" }).trim();
}

/** Parse `--raw -z` records into { path, oldMode, newMode, oldBlob, newBlob }. */
export function parseRaw(output) {
  const tokens = output.split("\0");
  const records = [];
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i].replace(/^\n+/, "");
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode, oldBlob, newBlob] = meta.slice(1).split(" ");
    records.push({ path: tokens[++i], oldMode, newMode, oldBlob, newBlob });
  }
  return records;
}

function readBlobs(repo, shas) {
  const wanted = [...new Set(shas)];
  const blobs = new Map();
  if (!wanted.length) return blobs;
  const result = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: `${wanted.join("\n")}\n`, maxBuffer: 2 ** 31 });
  if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr}`);
  const out = result.stdout;
  let offset = 0;
  while (offset < out.length) {
    const newline = out.indexOf(10, offset);
    const [sha, type, size] = out.subarray(offset, newline).toString("utf8").split(" ");
    if (type !== "blob") throw new Error(`git object ${sha} is ${type || "missing"}, not a blob`);
    const start = newline + 1;
    blobs.set(sha, out.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

/** Every managed regular file in the commit: path -> { bytes, sha }. */
export function commitFiles(repo, head, roots) {
  const entries = git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", ...roots], { encoding: "utf8" })
    .split("\0").filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, blob] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), mode, type, blob };
    }).filter((entry) => isManagedPath(entry.path, roots));
  const unsupported = entries.filter((entry) => entry.type !== "blob" || !REGULAR_MODES.has(entry.mode));
  if (unsupported.length) {
    throw new Error(`Only regular files can be published; not: ${unsupported.map((entry) => `${entry.path} (mode ${entry.mode})`).join(", ")}`);
  }
  const blobs = readBlobs(repo, entries.map((entry) => entry.blob));
  return new Map(entries.map((entry) => {
    const bytes = blobs.get(entry.blob);
    return [entry.path, { bytes, sha: sha256(bytes) }];
  }));
}

/**
 * The states Git recorded for each of `paths` in the commit's history: the
 * sha256 of every blob it held, and null where a commit deleted it.
 */
export function recordedStates(repo, head, roots, paths) {
  const wanted = new Set(paths);
  const versions = new Map([...wanted].map((file) => [file, { blobs: new Set(), deleted: false }]));
  if (wanted.size) {
    const history = parseRaw(git(repo, ["log", "--raw", "--no-renames", "--no-abbrev", "-z", "--format=", head, "--", ...roots], { encoding: "utf8" }));
    for (const record of history) {
      const entry = versions.get(record.path);
      if (!entry) continue;
      if (!ZERO.test(record.oldBlob)) entry.blobs.add(record.oldBlob);
      if (ZERO.test(record.newBlob)) entry.deleted = true;
      else entry.blobs.add(record.newBlob);
    }
  }
  const blobs = readBlobs(repo, [...versions.values()].flatMap((entry) => [...entry.blobs]));
  return new Map([...versions.entries()].map(([file, entry]) => {
    const states = new Set([...entry.blobs].map((blob) => sha256(blobs.get(blob))));
    if (entry.deleted) states.add(null);
    return [file, states];
  }));
}

/** A short repository name for publication messages: the origin's, else the directory's. */
export function repositoryName(repo) {
  let origin = "";
  try {
    origin = git(repo, ["config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    origin = "";
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  return path.basename(origin || top).replace(/\.git$/, "");
}
