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
 * Derived documents (workflow views, generated system overviews, the document
 * index) are the exception: the server regenerates them from Templates and
 * frontmatter after every publish, and its output is not byte-identical to
 * the Git scripts', so a prod copy that differs is never a human edit. Git's
 * copy always replaces it (`publish`); the server then regenerates it.
 * Derived registers (the external-link register) are the same kind of file:
 * the knowledge repository rebuilds them from the commit's content in every
 * reconcile and mirror snapshot, so Git never records the bytes another
 * publisher put in prod, and treating them as authored turns every later
 * content change into a "changed both in prod and in Git" conflict. Git's
 * copy, rebuilt from content that already carries prod's edits once the
 * mirror ran, always replaces prod's; the mirror never pulls them back.
 * "Absent" is a Git-recorded state only where Git deleted the path, or before
 * prod's first version of it.
 */
import { load as loadYaml } from "js-yaml";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ZERO = /^0+$/;
const REGULAR_MODES = new Set(["100644", "100755"]);
/** Leave 1 MB below Lambda's 6 MB limit for the request envelope and headers. */
export const MAX_BATCH_BYTES = 5_000_000;
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

const DERIVED_ID = /^id:\s*["']?(task-template\.tasks\.[a-z0-9-]+|reference\.indexes\.document-index)["']?\s*$/m;
const GENERATED_SYSTEM_MARKER = "<!-- This system page is seeded from the audit register.";
const SYSTEM_MAP_PATH = "content/00-start-here/business-system-map/system-overview.md";
/** Registers the knowledge repository regenerates from content on every reconcile. */
export const DERIVED_REGISTERS = new Set(["_docs/registers/external-link-register.csv"]);
const SYSTEM_MAP_ID = /^id:[ \t]*["']?system\.start-here\.business-system-map["']?[ \t]*\r?$/m;

/**
 * True when a Git copy is a derived document whose prod copy is never a
 * human edit: a task-template workflow view, the document index, a system
 * overview still carrying the generated-page marker (the server regenerates
 * these), or a derived register (the knowledge repository regenerates it).
 */
export function isDerivedDocument(file, bytes) {
  if (!bytes) return false;
  if (DERIVED_REGISTERS.has(file)) return true;
  if (!file.endsWith(".md")) return false;
  const text = bytes.toString("utf8");
  // A leading UTF-8 BOM is not content: normalize it before frontmatter
  // matching so BOM-prefixed generated pages classify like their plain form.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.startsWith("---\n")) return false;
  const end = body.indexOf("\n---", 4);
  if (end === -1) return false;
  const frontmatter = body.slice(4, end);
  if (DERIVED_ID.test(frontmatter)) return true;
  return /^doc_type:\s*["']?system-overview["']?\s*$/m.test(frontmatter) && body.slice(end).includes(GENERATED_SYSTEM_MARKER);
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
 * The mirror completes missing empty aliases and Python text IO converts CRLF
 * to LF before committing. Recognize exactly these representation changes;
 * never ignore authored metadata, whitespace in the body, or binary bytes.
 */
export function completedMirrorBytes(file, bytes, completeAliases = true) {
  if (!file.endsWith(".md") || bytes.includes(0)) return bytes;
  let text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) return bytes;
  text = text.replaceAll("\r\n", "\n");
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  let metadata;
  try { metadata = header && loadYaml(header[1]); } catch { return bytes; }
  if (completeAliases && metadata && typeof metadata.id === "string" && !Object.hasOwn(metadata, "aliases")) {
    const completed = header[0].replace(/^(id:[^\n]*)$/m, "$1\naliases: []");
    text = completed + text.slice(header[0].length);
  }
  return Buffer.from(text);
}

/**
 * Raw history hashes remain authoritative. Only use a completed identity after
 * downloading and verifying the original bytes, and finding those exact
 * completed bytes in Git. Cache pages because publish and mirror share walks.
 */
export function mirrorHistory({ page, version, known }) {
  const cache = new Map();
  return (file, cursor) => {
    const key = JSON.stringify([file, cursor]);
    if (!cache.has(key)) cache.set(key, (async () => {
      const result = await page(file, cursor);
      if (!file.endsWith(".md")) return result;
      const versions = [];
      for (const item of result.versions || []) {
        let state = item;
        if (!item.deleted && !known(file).has(item.sha256)) {
          const bytes = await version(file, item.revision);
          if (!bytes || sha256(bytes) !== item.sha256) {
            throw new Error(`${file}: history bytes do not match the recorded sha256`);
          }
          const completed = sha256(completedMirrorBytes(file, bytes));
          if (known(file).has(completed)) state = { ...item, sha256: completed };
        }
        versions.push(state);
        if (known(file).has(state.deleted ? null : state.sha256)) break;
      }
      return { ...result, versions };
    })());
    return cache.get(key);
  };
}

/** Run `fn` over `items` with at most `limit` calls in flight; rejects with the first error. */
export async function bounded(items, fn, limit) {
  let next = 0;
  let failed = false;
  let firstError;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failed) {
      try {
        await fn(items[next++]);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        throw error;
      }
    }
  });
  await Promise.allSettled(workers);
  if (failed) throw firstError;
}

/**
 * Plan a reconcile. `files` maps every managed path in the commit to
 * `{ bytes, sha }`; `prod` is the manifest's entries; `known(path)` returns
 * the Git-recorded states of a path; `page(path, cursor)` fetches one
 * /knowledge/history page `{ versions, cursor }` for a path whose current
 * state Git does not know. Pages are walked only until the verdict is
 * decided, and unrelated paths walk concurrently (`concurrency` at a time).
 */
export async function planReconcile({ files, prod, known, page, concurrency = 12 }) {
  const paths = [...new Set([...files.keys(), ...Object.keys(prod)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const verdicts = new Map();
  const lineagePending = [];
  for (const file of paths) {
    const head = files.get(file) || null;
    const headSha = head ? head.sha : null;
    const prodSha = prod[file]?.sha256 ?? null;
    if (prodSha === headSha) {
      verdicts.set(file, { verdict: "unchanged" });
      continue;
    }
    const recorded = known(file);
    if (head && isDerivedDocument(file, head.bytes)) verdicts.set(file, { verdict: "publish" });
    else if (recorded.has(prodSha)) verdicts.set(file, { verdict: "publish" });
    else lineagePending.push(file);
  }
  await bounded(lineagePending, async (file) => {
    const recorded = known(file);
    const headSha = files.get(file)?.sha ?? null;
    verdicts.set(file, { verdict: await classifyByHistory(page, file, recorded, headSha) });
  }, concurrency);
  const plan = { mutations: [], ahead: [], conflicts: [], unchanged: 0 };
  for (const file of paths) {
    const head = files.get(file) || null;
    const prodSha = prod[file]?.sha256 ?? null;
    const { verdict } = verdicts.get(file);
    if (verdict === "unchanged") {
      plan.unchanged += 1;
    } else if (verdict === "publish") {
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

function systemMapSections(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) return null;
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(text);
  if (!frontmatter || !SYSTEM_MAP_ID.test(frontmatter[1]) || frontmatter[1].match(/^id:/gm).length !== 1) return null;
  const body = text.slice(frontmatter[0].length);
  const title = /^(?:[ \t]*\r?\n)*# [^\r\n]+\r?\n/.exec(body);
  const boundary = [...body.matchAll(/^## Core systems[ \t]*\r?$/gm)];
  if (!title || boundary.length !== 1 || title[0].length > boundary[0].index) return null;
  const start = boundary[0].index;
  return { frontmatter: frontmatter[0], title: title[0], intro: body.slice(title[0].length, start), navigation: body.slice(start) };
}

/** The live map owns the introduction. The generator owns navigation. Both can edit frontmatter. */
export async function planPublish(options) {
  const { files, prod, known, page, version, recordedBytes } = options;
  const head = files.get(SYSTEM_MAP_PATH);
  const prodSha = prod[SYSTEM_MAP_PATH]?.sha256;
  if (!head || !prodSha || head.sha === prodSha) return planReconcile(options);

  const otherFiles = new Map(files);
  otherFiles.delete(SYSTEM_MAP_PATH);
  const otherProd = { ...prod };
  delete otherProd[SYSTEM_MAP_PATH];
  const [plan, current] = await Promise.all([
    planReconcile({ ...options, files: otherFiles, prod: otherProd }),
    version(SYSTEM_MAP_PATH),
  ]);
  if (!current || sha256(current) !== prodSha) {
    throw new Error(`${SYSTEM_MAP_PATH}: prod bytes do not match the manifest sha256`);
  }
  const conflict = (reason) => {
    plan.conflicts.push({ path: SYSTEM_MAP_PATH, prod: "differs", reason });
    return plan;
  };
  const incoming = systemMapSections(head.bytes);
  const live = systemMapSections(current);
  if (!incoming || !live) return conflict("expected the map ID and one Core systems boundary");

  // The full published blob can differ from every Git blob because of its intro.
  // Recognize Git-recorded metadata, title and navigation by exact section bytes.
  const recorded = recordedBytes(SYSTEM_MAP_PATH);
  const sections = [...recorded.values()].map(systemMapSections).filter(Boolean);
  const fields = ["frontmatter", "title", "navigation"];
  const unresolved = fields.filter((field) => incoming[field] !== live[field]
    && !sections.some((section) => section[field] === live[field]));
  let base;
  if (unresolved.length) {
    const lineage = await walkLineage(page, SYSTEM_MAP_PATH, known(SYSTEM_MAP_PATH));
    const shared = lineage.states.find(({ sha }) => known(SYSTEM_MAP_PATH).has(sha));
    const sharedBytes = shared && recorded.get(shared.sha);
    base = sharedBytes && systemMapSections(sharedBytes);
    if (!base) return conflict("no common map version with a verified section boundary");
  }

  const merged = { ...incoming, intro: live.intro };
  for (const field of unresolved) {
    const result = threeWayMerge({
      ours: Buffer.from(incoming[field]), baseBytes: Buffer.from(base[field]), theirs: Buffer.from(live[field]),
    });
    if (result.conflicts) return conflict(`both sides changed the same ${field} lines`);
    merged[field] = result.bytes.toString("utf8");
  }
  const bytes = Buffer.from(merged.frontmatter + merged.title + merged.intro + merged.navigation);
  if (!systemMapSections(bytes)) return conflict("merged map does not have one verified section boundary");
  if (bytes.equals(current)) plan.unchanged += 1;
  else {
    plan.mutations.push({ path: SYSTEM_MAP_PATH, operation: "edit", base64: bytes.toString("base64") });
    plan.mutations.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  return plan;
}

/**
 * Classify one path from its /knowledge/history pages, newest first. Each
 * page is fetched only while the verdict is still undecided: classification
 * reads the states up to the first one Git recorded (or the chain's origin),
 * so a decision rarely needs the whole lineage.
 */
async function classifyByHistory(page, file, recorded, headSha, maxPages = MAX_HISTORY_PAGES) {
  const states = [];
  let cursor;
  for (let pages = 0; pages < maxPages; pages++) {
    if (states.some((state) => state === ORIGIN || recorded.has(state))) break;
    const result = await page(file, cursor);
    for (const version of result.versions || []) states.push(version.deleted ? null : version.sha256);
    if (!result.cursor) {
      states.push(ORIGIN);
      break;
    }
    cursor = result.cursor;
  }
  return classify(states, recorded, headSha);
}

// ── Mirror ───────────────────────────────────────────────────────────────────

/**
 * Prod's lineage for one path, newest first, with the publication revision
 * that carried each state (the version endpoint needs it to serve bytes).
 * `complete` is true when the walk reached prod's first version; a walk that
 * stops at MAX_HISTORY_PAGES without reaching it leaves the lineage unknown.
 */
export async function walkLineage(page, file, recorded, maxPages = MAX_HISTORY_PAGES) {
  const states = [];
  let cursor;
  for (let pages = 0; pages < maxPages; pages++) {
    if (states.some((state) => state.sha === null ? recorded.has(null) : recorded.has(state.sha))) break;
    const result = await page(file, cursor);
    for (const version of result.versions || []) states.push({ sha: version.deleted ? null : version.sha256, revision: version.revision });
    if (!result.cursor) return { states, complete: true };
    cursor = result.cursor;
  }
  return { states, complete: false };
}

/**
 * Plan the daily mirror: the reverse of a publish. Prod-ahead edits become
 * working-tree writes verbatim; conflicts are resolved where possible by a
 * three-way merge against the newest prod version Git recorded (ours = the
 * commit's copy, base = that version's Git blob, theirs = prod's copy), and
 * reported for a human where a merge cannot decide. Inputs are planReconcile's
 * `files`/`prod`/`known`/`page`; `version(path)` returns prod's current bytes
 * for a path (null when prod deleted it); `recordedBytes(file)` maps a
 * Git-recorded sha256 of that path to the blob bytes it came from.
 */
export async function planMirror({ files, prod, known, page, version, recordedBytes, concurrency = 12 }) {
  const reconcile = await planReconcile({ files, prod, known, page, concurrency });
  const writes = [];
  const conflicts = [];
  const currentBytes = async (file) => {
    const bytes = await version(file);
    const entry = prod[file];
    if (bytes && entry && sha256(bytes) !== entry.sha256) {
      throw new Error(`${file}: prod bytes do not match the manifest sha256`);
    }
    return bytes ?? null;
  };
  // Prod changed, Git did not since the common version: prod's copy is the
  // merge result, byte for byte.
  await bounded(reconcile.ahead, async (file) => {
    const bytes = await currentBytes(file);
    writes.push({ path: file, bytes, operation: bytes === null ? "delete" : files.has(file) ? "edit" : "create", merged: false });
  }, concurrency);
  // Both sides moved: decide the base Git recorded, then merge or report.
  await bounded(reconcile.conflicts, async (item) => {
    const file = item.path;
    const recorded = known(file);
    const lineage = await walkLineage(page, file, recorded);
    const theirs = await currentBytes(file);
    const ours = files.get(file)?.bytes ?? null;
    const base = lineage.states.find((state) => state.sha === null ? recorded.has(null) : recorded.has(state.sha));
    if (base && base.sha !== null) {
      const baseBytes = recordedBytes(file)?.get(base.sha);
      if (!baseBytes) throw new Error(`${file}: no Git blob carries the base version prod started from (${base.sha})`);
      if (ours === null) {
        // Git deleted the path after the base version; prod still has content.
        writes.push({ path: file, bytes: theirs, operation: "create", merged: false });
      } else if (theirs === null) {
        conflicts.push({ path: file, prod: "absent", reason: "prod deleted it after the version Git recorded, and Git edited it too" });
      } else if (ours.includes(0) || theirs.includes(0)) {
        conflicts.push({ path: file, prod: "differs", reason: "both sides changed this binary file" });
      } else {
        const completeAliases = /^aliases: \[\]$/m.test(baseBytes.toString("utf8"));
        const merged = threeWayMerge({
          ours: completedMirrorBytes(file, ours, completeAliases),
          baseBytes: completedMirrorBytes(file, baseBytes, completeAliases),
          theirs: completedMirrorBytes(file, theirs, completeAliases),
        });
        if (merged.conflicts) conflicts.push({ path: file, prod: "differs", reason: "both sides changed the same lines; resolve them by hand" });
        else writes.push({ path: file, bytes: merged.bytes, operation: "edit", merged: true });
      }
    } else if (base) {
      conflicts.push({ path: file, prod: theirs === null ? "absent" : "differs", reason: "the newest version they share is a deletion" });
    } else if (lineage.complete) {
      if (ours === null && theirs !== null) writes.push({ path: file, bytes: theirs, operation: "create", merged: false });
      else conflicts.push({ path: file, prod: theirs === null ? "absent" : "differs", reason: "prod lineage reaches no version Git recorded" });
    } else {
      conflicts.push({ path: file, prod: theirs === null ? "absent" : "differs", reason: "prod history is longer than the mirror reads" });
    }
  }, concurrency);
  const order = (items) => items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { writes: order(writes), conflicts: order(conflicts), unchanged: reconcile.unchanged };
}

/**
 * A `git merge-file` three-way merge of text. Returns the merged bytes and
 * whether the sides touched the same lines (the caller never writes a merge
 * with conflicts: conflicted files are reported, never committed).
 */
export function threeWayMerge({ ours, baseBytes, theirs }) {
  const directory = mkdtempSync(join(tmpdir(), "kb-mirror-"));
  try {
    const write = (name, bytes) => {
      const file = join(directory, name);
      writeFileSync(file, bytes);
      return file;
    };
    const result = spawnSync("git", ["merge-file", "-p",
      "-L", "Git", "-L", "the version prod started from", "-L", "prod",
      write("ours", ours), write("base", baseBytes), write("theirs", theirs)],
      { maxBuffer: 2 ** 31 });
    if (result.status < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
    return { bytes: Buffer.from(result.stdout), conflicts: result.status > 0 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

/** Managed paths changed between two commits, with renames represented as delete/create. */
export function changedPaths(repo, base, head, roots) {
  const output = git(repo, ["diff", "--name-only", "-z", "--no-renames", base, head, "--", ...roots], { encoding: "utf8" });
  return new Set(output.split("\0").filter((file) => file && isManagedPath(file, roots)));
}

/**
 * Everything Git recorded for each of `paths` in the commit's history:
 * `states` is the sha256 of every blob it held plus null where a commit
 * deleted the path, and `bytes` maps each recorded sha256 to the blob's
 * contents. Publish classifies against `states`; the mirror merges against
 * `bytes`, because the newest prod version a path's Git history holds is the
 * base both sides started from.
 */
export function recordedVersions(repo, head, roots, paths) {
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
    const bytes = new Map([...entry.blobs].map((blob) => [sha256(blobs.get(blob)), blobs.get(blob)]));
    return [file, { states: new Set([...bytes.keys(), ...(entry.deleted ? [null] : [])]), bytes }];
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
  return basename(origin || top).replace(/\.git$/, "");
}
