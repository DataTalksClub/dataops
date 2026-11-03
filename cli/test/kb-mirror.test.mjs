import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { planMirror, sha256, threeWayMerge, walkLineage } = await import("../src/knowledgePublish.mjs");

const ROOTS = ["content", "_docs", "workflow-templates", "document-templates"];
const h = (value) => (value === null ? null : sha256(Buffer.from(value)));
const states = (...values) => new Set(values.map(h));
const prodOf = (files) => Object.fromEntries(Object.entries(files).map(([file, body]) => [file, { sha256: h(body), size: body.length }]));

describe("three-way merge", () => {
  test("combines edits to different lines and flags edits to the same line", () => {
    const clean = threeWayMerge({
      ours: Buffer.from("Git changed the top\nmiddle\n"),
      baseBytes: Buffer.from("top\nmiddle\n"),
      theirs: Buffer.from("top\nmiddle\nprod changed the bottom\n"),
    });
    assert.equal(clean.conflicts, false);
    assert.equal(clean.bytes.toString(), "Git changed the top\nmiddle\nprod changed the bottom\n");
    const dirty = threeWayMerge({
      ours: Buffer.from("git line\n"),
      baseBytes: Buffer.from("base line\n"),
      theirs: Buffer.from("prod line\n"),
    });
    assert.equal(dirty.conflicts, true);
  });
});

describe("mirror planning", () => {
  const fileOf = (files) => new Map(Object.entries(files).map(([file, body]) => [file, { bytes: Buffer.from(body), sha: h(body) }]));
  const version = (body) => ({ sha256: body === null ? null : h(body), deleted: body === null, revision: `rev-${body}` });

  test("mirrors prod-ahead edits verbatim: edits, creations and deletions", async () => {
    const bodies = { "content/a.md": "web edit", "content/gone.md": null, "content/web-created.md": "web only" };
    const files = fileOf({ "content/a.md": "git copy", "content/gone.md": "git copy" });
    const prod = prodOf(Object.fromEntries(Object.entries(bodies).filter(([, body]) => body !== null)));
    const pages = {
      "content/a.md": [{ versions: [version("web edit"), version("git copy")], cursor: null }],
      "content/gone.md": [{ versions: [version(null), version("git copy")], cursor: null }],
      "content/web-created.md": [{ versions: [version("web only")], cursor: null }],
    };
    const plan = await planMirror({
      files, prod,
      known: (file) => ({ "content/a.md": states("git copy"), "content/gone.md": states("git copy"), "content/web-created.md": states() }[file]),
      page: async (file) => pages[file][0],
      version: async (file) => (bodies[file] === null || bodies[file] === undefined ? null : Buffer.from(bodies[file])),
      recordedBytes: () => new Map(),
    });
    assert.deepEqual(plan.writes.map(({ path: file, operation, merged }) => [file, operation, merged]), [
      ["content/a.md", "edit", false],
      ["content/gone.md", "delete", false],
      ["content/web-created.md", "create", false],
    ]);
    assert.deepEqual(plan.conflicts, []);
  });

  test("resolves a both-sides change by merging against the newest prod version Git recorded", async () => {
    const prodBody = "git top\nmiddle\nprod bottom\n";
    const files = fileOf({ "content/both.md": "git top\nmiddle\n" });
    const prod = prodOf({ "content/both.md": prodBody });
    const baseBytes = Buffer.from("top\nmiddle\n");
    const pages = { "content/both.md": [{ versions: [version(prodBody), version("top\nmiddle\n")], cursor: null }] };
    const plan = await planMirror({
      files, prod,
      known: () => states("top\nmiddle\n", "git top\nmiddle\n"),
      page: async (file) => pages[file][0],
      version: async () => Buffer.from(prodBody),
      recordedBytes: () => new Map([[h("top\nmiddle\n"), baseBytes]]),
    });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.writes.map(({ path: file, operation, merged }) => [file, operation, merged]), [["content/both.md", "edit", true]]);
    assert.equal(plan.writes[0].bytes.toString(), "git top\nmiddle\nprod bottom\n");
  });

  test("reports a same-line clash, a prod deletion against a Git edit, and an unknown prod lineage", async () => {
    const bodies = { "content/clash.md": "prod line\n", "content/alien.md": "prod rewrite" };
    const files = fileOf({ "content/clash.md": "git line\n", "content/prod-gone.md": "git edit\n", "content/alien.md": "git copy" });
    const prod = prodOf(bodies);
    const base = Buffer.from("base line\n");
    const pages = {
      "content/clash.md": [{ versions: [version("prod line\n"), version("base line\n")], cursor: null }],
      "content/prod-gone.md": [{ versions: [version(null), version("base line\n")], cursor: null }],
      "content/alien.md": [{ versions: [version("prod rewrite")], cursor: null }],
    };
    const plan = await planMirror({
      files, prod,
      known: () => states("base line\n", "git line\n", "git edit\n"),
      page: async (file) => pages[file][0],
      version: async (file) => (bodies[file] ? Buffer.from(bodies[file]) : null),
      recordedBytes: () => new Map([[h("base line\n"), base]]),
    });
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(plan.conflicts.map(({ path: file, prod: side, reason }) => [file, side, reason]), [
      ["content/alien.md", "differs", "prod lineage reaches no version Git recorded"],
      ["content/clash.md", "differs", "both sides changed the same lines; resolve them by hand"],
      ["content/prod-gone.md", "absent", "prod deleted it after the version Git recorded, and Git edited it too"],
    ]);
  });

  test("gives prod's copy back when Git deleted the file after the shared base", async () => {
    const files = new Map();
    const prod = prodOf({ "content/revived.md": "prod content" });
    const pages = { "content/revived.md": [{ versions: [version("prod content"), version("old base")], cursor: null }] };
    const plan = await planMirror({
      files, prod,
      known: () => states("old base", null),
      page: async (file) => pages[file][0],
      version: async () => Buffer.from("prod content"),
      recordedBytes: () => new Map([[h("old base"), Buffer.from("old base")]]),
    });
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.writes.map(({ path: file, operation }) => [file, operation]), [["content/revived.md", "create"]]);
    assert.equal(plan.writes[0].bytes.toString(), "prod content");
  });

  test("refuses prod bytes that do not match the manifest sha256", async () => {
    const files = fileOf({ "content/a.md": "git copy" });
    const prod = prodOf({ "content/a.md": "web edit" });
    await assert.rejects(
      () => planMirror({
        files, prod,
        known: () => states("git copy"),
        page: async () => ({ versions: [version("web edit"), version("git copy")], cursor: null }),
        version: async () => Buffer.from("tampered"),
        recordedBytes: () => new Map(),
      }),
      /do not match the manifest/,
    );
  });

  test("walkLineage stops at the version Git recorded and reports whether prod's chain ended", async () => {
    const recorded = states("v2");
    const pages = [
      { versions: [version("web")], cursor: "c1" },
      { versions: [version("v2"), version("v1")], cursor: null },
    ];
    const fetched = [];
    const lineage = await walkLineage(async () => pages[fetched.length++], "content/a.md", recorded);
    assert.deepEqual(lineage.states.map((state) => state.sha), [h("web"), h("v2"), h("v1")]);
    assert.equal(lineage.complete, true);
    assert.equal(fetched.length, 2, "the walk must not fetch a third page");
  });
});

describe("kb mirror from a Git checkout", () => {
  let repo;
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), body);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const read = (file) => readFileSync(path.join(repo, file), "utf8");

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "dataops-kb-mirror-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("remote", "add", "origin", "git@github.com:ExampleOrg/knowledge.git");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(repo, { recursive: true, force: true });
  });

  function portal(prodFiles, history) {
    return fakePortal({
      "GET /knowledge/manifest": () => ({ revision: "rev-current", roots: ROOTS, entries: prodOf(prodFiles) }),
      "GET /knowledge/history": ({ query }) => ({
        versions: (history[query.path] || []).map((body) => ({ sha256: h(body), deleted: body === null, revision: `rev-${body}` })),
        cursor: null,
      }),
      "GET /knowledge/download": ({ query }) => ({ url: `https://portal.test/storage?path=${encodeURIComponent(query.path)}` }),
      "GET /storage": ({ query }) => new Response(prodFiles[query.path] ?? "", { status: 200, headers: { "content-type": "application/octet-stream" } }),
    });
  }

  test("applies prod edits, merges both-sides changes, and exits 5 on same-line clashes", async () => {
    write("content/merge.md", "top\nmiddle\nbottom\n");
    write("content/clash.md", "one line\n");
    write("content/ahead.md", "git copy");
    write("content/gone.md", "delete me\n");
    commit("base");
    write("content/merge.md", "git top\nmiddle\nbottom\n");
    write("content/clash.md", "git one line\n");
    commit("git edits");
    const prodFiles = {
      "content/merge.md": "git top\nmiddle\nprod bottom\n",
      "content/clash.md": "prod one line\n",
      "content/ahead.md": "web edit",
      "content/web-created.md": "web only",
    };
    const history = {
      "content/merge.md": ["git top\nmiddle\nprod bottom\n", "top\nmiddle\nbottom\n"],
      "content/clash.md": ["prod one line\n", "one line\n"],
      "content/ahead.md": ["web edit", "git copy"],
      "content/gone.md": [null, "delete me\n"],
      "content/web-created.md": ["web only"],
    };
    portal(prodFiles, history);
    const io = captureIo();
    assert.equal(await run(["kb", "mirror", "--repo", repo], io), 5);
    assert.equal(read("content/merge.md"), "git top\nmiddle\nprod bottom\n");
    assert.equal(read("content/clash.md"), "git one line\n", "a same-line clash must leave the file untouched");
    assert.equal(read("content/ahead.md"), "web edit");
    assert.equal(read("content/web-created.md"), "web only");
    assert.equal(existsSync(path.join(repo, "content/gone.md")), false);
    assert.equal(git("rev-parse", "HEAD").length, 40, "the mirror must not commit");
    const applied = io.out.filter((line) => /^(merged|edit|create|delete) /.test(line));
    assert.deepEqual(applied, [
      "edit content/ahead.md",
      "delete content/gone.md",
      "merged content/merge.md",
      "create content/web-created.md",
    ]);
    assert.match(io.errors.join("\n"), /content\/clash\.md/);
    assert.match(io.errors.join("\n"), /the clean mirror was applied to the working tree/);
  });

  test("dry run prints the mirror and writes nothing", async () => {
    write("content/ahead.md", "git copy");
    commit("base");
    portal({ "content/ahead.md": "web edit" }, { "content/ahead.md": ["web edit", "git copy"] });
    const io = captureIo();
    assert.equal(await run(["kb", "mirror", "--repo", repo, "--dry-run"], io), 0);
    assert.equal(read("content/ahead.md"), "git copy");
    assert.match(io.text(), /would edit content\/ahead\.md/);
    assert.match(io.text(), /Dry run: 1 file/);
  });

  test("a matching prod mirrors nothing", async () => {
    write("content/a.md", "same");
    commit("base");
    const calls = portal({ "content/a.md": "same" }, { "content/a.md": ["same"] });
    const io = captureIo();
    assert.equal(await run(["kb", "mirror", "--repo", repo], io), 0);
    assert.match(io.text(), /Mirrored 0 file/);
    assert.equal(calls.filter((call) => call.route === "/knowledge/version").length, 0);
  });

  test("downloads binary and large managed files through file storage", async () => {
    const originalImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const prodImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const originalLarge = Buffer.alloc(4_100_000, 0x41);
    const prodLarge = Buffer.alloc(4_100_000, 0x42);
    write("content/image.png", originalImage);
    write("content/large.md", originalLarge);
    commit("base");
    portal(
      { "content/image.png": prodImage, "content/large.md": prodLarge },
      { "content/image.png": [prodImage, originalImage], "content/large.md": [prodLarge, originalLarge] },
    );

    assert.equal(await run(["kb", "mirror", "--repo", repo], captureIo()), 0);
    assert.deepEqual(readFileSync(path.join(repo, "content/image.png")), prodImage);
    assert.deepEqual(readFileSync(path.join(repo, "content/large.md")), prodLarge);
  });

  test("rejects an unresolvable commit", async () => {
    write("content/a.md", "a1");
    commit("base");
    portal({}, {});
    assert.equal(await run(["kb", "mirror", "--head", "nope", "--repo", repo], captureIo()), 2);
  });
});
