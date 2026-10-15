/**
 * Publish a Git range of the knowledge repository to the DataOps knowledge
 * store without overwriting edits Git has not seen.
 *
 * For every managed file changed between `base` and `head`:
 *  - prod already equals head: nothing to do;
 *  - prod equals a version Git recorded in the range (the base copy, or a copy
 *    some commit in base..head wrote, including "absent"): publish head;
 *  - otherwise someone changed it in the web editor or the CLI since Git last
 *    saw it: refuse the whole publication and name the files.
 *
 * Accepting any version recorded in the range, not only the base copy, lets a
 * wider base (the last successful publish, when a later run was skipped) still
 * accept files the daily mirror brought into Git in between.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const ZERO = /^0+$/;
const REGULAR_MODES = new Set(["100644", "100755"]);
/** Request bodies stay well under the API's 6 MB payload limit. */
export const MAX_BATCH_BYTES = 4_000_000;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when `file` lies under one of the store's managed top-level roots. */
export function isManagedPath(file, roots) {
  const slash = file.indexOf("/");
  return slash > 0 && roots.includes(file.slice(0, slash)) && !file.split("/").some((part) => !part || part === "." || part === "..");
}

/**
 * Decide what to publish. `changes` are `{ path, head, known }` where `head`
 * is the head bytes (null when deleted) and `known` is the set of sha256
 * values Git recorded for the path in the range (null meaning absent).
 * `prod` maps a path to its published sha256.
 */
export function planPublication(changes, prod) {
  const mutations = [];
  const current = [];
  const conflicts = [];
  for (const change of [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const prodSha = prod[change.path]?.sha256 ?? null;
    const headSha = change.head ? sha256(change.head) : null;
    if (prodSha === headSha) {
      current.push(change.path);
    } else if (change.known.has(prodSha)) {
      if (!change.head) mutations.push({ path: change.path, operation: "delete" });
      else mutations.push({ path: change.path, operation: prodSha ? "edit" : "create", base64: change.head.toString("base64") });
    } else {
      conflicts.push({ path: change.path, prod: prodSha ? "differs" : "absent" });
    }
  }
  return { mutations, current, conflicts };
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
  const result = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: `${wanted.join("\n")}\n`, maxBuffer: 1 << 30 });
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

/**
 * The managed files changed between `base` and `head`, with head bytes and
 * every version (as sha256, null for absent) Git recorded for each in range.
 */
export function gitChanges(repo, base, head, roots) {
  const diff = parseRaw(git(repo, ["diff", "--raw", "--no-renames", "--no-abbrev", "-z", base, head, "--", ...roots], { encoding: "utf8" }))
    .filter((record) => isManagedPath(record.path, roots));
  const unsupported = diff.filter((record) => !ZERO.test(record.newMode) && !REGULAR_MODES.has(record.newMode));
  if (unsupported.length) {
    throw new Error(`Only regular files can be published; not: ${unsupported.map((record) => `${record.path} (mode ${record.newMode})`).join(", ")}`);
  }
  const changed = new Map(diff.map((record) => [record.path, { head: ZERO.test(record.newBlob) ? null : record.newBlob, versions: new Set([ZERO.test(record.oldBlob) ? null : record.oldBlob]) }]));
  if (changed.size) {
    const history = parseRaw(git(repo, ["log", "--raw", "--no-renames", "--no-abbrev", "-z", "--format=", `${base}..${head}`, "--", ...roots], { encoding: "utf8" }));
    for (const record of history) {
      const entry = changed.get(record.path);
      if (!entry) continue;
      for (const blob of [record.oldBlob, record.newBlob]) entry.versions.add(ZERO.test(blob) ? null : blob);
    }
  }
  const blobs = readBlobs(repo, [...changed.values()].flatMap((entry) => [entry.head, ...entry.versions]).filter(Boolean));
  return [...changed.entries()].map(([file, entry]) => ({
    path: file,
    head: entry.head ? blobs.get(entry.head) : null,
    known: new Set([...entry.versions].map((blob) => (blob ? sha256(blobs.get(blob)) : null))),
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
