import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { ORIGIN, MAX_BATCH_BYTES, apiMutation, batches, classify, isManagedPath, planReconcile, sha256 } = await import("../src/knowledgePublish.mjs");

const ROOTS = ["content", "_docs", "workflow-templates", "document-templates"];
const h = (value) => (value === null ? null : sha256(Buffer.from(value)));
const states = (...values) => new Set(values.map(h));
const prodOf = (files) => Object.fromEntries(Object.entries(files).map(([file, body]) => [file, { sha256: h(body), size: body.length }]));

describe("managed path filter", () => {
  test("accepts files under the managed roots and nothing else", () => {
    for (const file of ["content/a.md", "content/images/x/y.png", "_docs/model.csv", "workflow-templates/t.yaml", "document-templates/d.md"]) {
      assert.equal(isManagedPath(file, ROOTS), true, file);
    }
    for (const file of ["README.md", "scripts/build.py", "tests/test_a.py", "schemas/s.json", ".github/workflows/v.yml", "contents/a.md", "content", "content/../scripts/a.py", "_docsx/a.md"]) {
      assert.equal(isManagedPath(file, ROOTS), false, file);
    }
  });
});

describe("three-way classification", () => {
  test("publishes over a Git-recorded prod state, leaves prod-ahead edits, flags both-sides changes", () => {
    const known = states("v1", "v2");
    assert.equal(classify([h("v1"), ORIGIN], known, h("v2")), "publish");
    assert.equal(classify([null, ORIGIN], known, h("v2")), "conflict");
    assert.equal(classify([ORIGIN], known, h("v2")), "publish");
    assert.equal(classify([h("web"), h("v2"), ORIGIN], known, h("v2")), "ahead");
    assert.equal(classify([null, h("v2"), ORIGIN], known, h("v2")), "ahead");
    assert.equal(classify([h("web2"), h("web1"), h("v1"), ORIGIN], known, h("v2")), "conflict");
    assert.equal(classify([h("web"), ORIGIN], states(), null), "ahead");
    assert.equal(classify([h("web"), h("older web")], known, h("v2")), "conflict");
  });

  test("plans a reconcile over every managed path, not a diff", async () => {
    const files = new Map(Object.entries({
      "content/same.md": "same",
      "content/restored.md": "good",
      "content/new-in-git.md": "born",
      "content/web-ahead.md": "git base",
      "content/both.md": "git v2",
      "content/web-deleted.md": "git copy",
    }).map(([file, body]) => [file, { bytes: Buffer.from(body), sha: h(body) }]));
    const prod = prodOf({
      "content/same.md": "same",
      "content/restored.md": "damaged",
      "content/web-ahead.md": "web edit",
      "content/both.md": "web edit",
      "content/deleted-in-git.md": "old",
      "content/web-created.md": "web only",
    });
    const recorded = {
      "content/restored.md": states("good", "damaged"),
      "content/new-in-git.md": states("born"),
      "content/web-ahead.md": states("git base"),
      "content/both.md": states("git v1", "git v2"),
      "content/deleted-in-git.md": states("old", null),
      "content/web-created.md": states(),
      "content/web-deleted.md": states("git copy"),
    };
    const lineages = {
      "content/new-in-git.md": [ORIGIN],
      "content/web-ahead.md": [h("web edit"), h("git base"), ORIGIN],
      "content/both.md": [h("web edit"), h("git v1"), ORIGIN],
      "content/web-created.md": [h("web only"), ORIGIN],
      "content/web-deleted.md": [null, h("git copy"), ORIGIN],
    };
    const asked = [];
    const plan = await planReconcile({
      files, prod, known: (file) => recorded[file],
      lineage: async (file) => { asked.push(file); return lineages[file]; },
    });
    assert.deepEqual(plan.mutations.map(({ path: file, operation }) => [file, operation]), [
      ["content/deleted-in-git.md", "delete"],
      ["content/new-in-git.md", "create"],
      ["content/restored.md", "edit"],
    ]);
    assert.equal(Buffer.from(plan.mutations[2].base64, "base64").toString(), "good");
    assert.deepEqual(plan.ahead, ["content/web-ahead.md", "content/web-created.md", "content/web-deleted.md"]);
    assert.deepEqual(plan.conflicts, [{ path: "content/both.md", prod: "differs" }]);
    assert.equal(plan.unchanged, 1);
    assert.ok(!asked.includes("content/restored.md"));
  });

  test("splits large publications into request-sized batches and refuses an oversized file", () => {
    const mutation = (name, size) => ({ path: name, operation: "edit", base64: "a".repeat(size) });
    assert.deepEqual(batches([mutation("a", 40), mutation("b", 40), mutation("c", 40)], 220).map((batch) => batch.map((item) => item.path)), [["a", "b"], ["c"]]);
    assert.throws(() => batches([mutation("huge", 500)], 220), /too large/);
  });

  test("publishes a 3.5 MB file without exceeding the API request budget", () => {
    const large = { path: "_docs/audit/catalog.csv", operation: "edit", base64: Buffer.alloc(3_520_000, 97).toString("base64") };
    const next = { path: "content/next.md", operation: "edit", base64: Buffer.alloc(300_000, 98).toString("base64") };
    const result = batches([large, next]);
    assert.deepEqual(result.map(batch => batch.map(item => item.path)), [[large.path], [next.path]]);
    for (const batch of result) {
      const body = { expectedRevision: "r".repeat(64), message: "Publish repository commit", mutations: batch.map(apiMutation) };
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < MAX_BATCH_BYTES);
    }
    assert.throws(() => batches([{ ...large, base64: "a".repeat(MAX_BATCH_BYTES) }]), /too large/);
  });
});

describe("kb publish from a Git checkout", () => {
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

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "dataops-kb-publish-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    git("remote", "add", "origin", "git@github.com:ExampleOrg/knowledge.git");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(repo, { recursive: true, force: true });
  });

  /** prod files plus per-path history (newest first, null = deleted). */
  function portal(prodFiles, history = {}) {
    let current = "rev-1";
    return fakePortal({
      "GET /knowledge/manifest": () => ({ revision: current, roots: ROOTS, entries: prodOf(prodFiles) }),
      "GET /knowledge/history": ({ query }) => ({
        versions: (history[query.path] || []).map((body) => ({ sha256: h(body), deleted: body === null })),
        cursor: null,
      }),
      "POST /knowledge/publish": ({ body }) => {
        if (body.expectedRevision !== current) return { status: 409, body: { error: "Knowledge changed" } };
        current = `${current}+`;
        return { revision: current };
      },
    });
  }

  test("repairs files Git restored to an older version, with exact bytes and the commit in the message", async () => {
    write("content/sop.md", "good");
    write("content/gone.md", "bye");
    write("scripts/tool.py", "v1");
    commit("base");
    write("content/sop.md", "damaged");
    commit("Daily knowledge snapshot");
    write("content/sop.md", "good");
    write("content/images/x.png", Buffer.from([0, 255, 10]));
    unlinkSync(path.join(repo, "content/gone.md"));
    write("scripts/tool.py", "v2");
    write("README.md", "docs");
    const head = commit("restore");
    const calls = portal({ "content/sop.md": "damaged", "content/gone.md": "bye" }, { "content/images/x.png": [] });
    const io = captureIo();
    assert.equal(await run(["kb", "publish", "--head", head, "--repo", repo, "--json"], io), 0);
    const publishes = calls.filter((call) => call.method === "POST");
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].body.expectedRevision, "rev-1");
    assert.equal(publishes[0].body.message, `Publish knowledge ${head}`);
    assert.deepEqual(publishes[0].body.mutations.map((item) => [item.path, item.base64 && Buffer.from(item.base64, "base64").toString("hex"), item.absent]), [
      ["content/gone.md", undefined, undefined],
      ["content/images/x.png", "00ff0a", true],
      ["content/sop.md", Buffer.from("good").toString("hex"), false],
    ]);
    assert.equal(io.json().revision, "rev-1+");
  });

  test("leaves a prod-ahead web edit alone and publishes the rest", async () => {
    write("content/slack.md", "git");
    write("content/a.md", "a1");
    commit("base");
    write("content/a.md", "a2");
    commit("change");
    const calls = portal({ "content/slack.md": "web edit", "content/a.md": "a1" }, { "content/slack.md": ["web edit", "git"] });
    const io = captureIo();
    assert.equal(await run(["kb", "publish", "--repo", repo], io), 0);
    const [published] = calls.filter((call) => call.method === "POST");
    assert.deepEqual(published.body.mutations.map((item) => item.path), ["content/a.md"]);
    assert.match(io.text(), /prod ahead \(left for the daily mirror\) content\/slack\.md/);
  });

  test("publishes everything else, then fails naming files changed on both sides", async () => {
    write("content/a.md", "a1");
    write("content/b.md", "b1");
    commit("base");
    write("content/a.md", "a2");
    write("content/b.md", "b2");
    commit("change");
    const calls = portal({ "content/a.md": "a1", "content/b.md": "edited on the web" }, { "content/b.md": ["edited on the web", "b1"] });
    const io = captureIo();
    assert.equal(await run(["kb", "publish", "--repo", repo], io), 5);
    const [published] = calls.filter((call) => call.method === "POST");
    assert.deepEqual(published.body.mutations.map((item) => item.path), ["content/a.md"]);
    assert.match(io.errors.join("\n"), /content\/b\.md/);
    assert.doesNotMatch(io.errors.join("\n"), /content\/a\.md/);
  });

  test("dry run and an already-matching prod send nothing", async () => {
    write("content/a.md", "a1");
    commit("base");
    write("content/a.md", "a2");
    commit("change");
    let calls = portal({ "content/a.md": "a1" });
    let io = captureIo();
    assert.equal(await run(["kb", "publish", "--repo", repo, "--dry-run"], io), 0);
    assert.match(io.text(), /would edit content\/a\.md/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    calls = portal({ "content/a.md": "a2" });
    io = captureIo();
    assert.equal(await run(["kb", "publish", "--repo", repo], io), 0);
    assert.match(io.text(), /Nothing to publish/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });

  test("rejects an unresolvable commit and the retired --base", async () => {
    write("content/a.md", "a1");
    commit("base");
    portal({});
    assert.equal(await run(["kb", "publish", "--head", "nope", "--repo", repo], captureIo()), 2);
    assert.equal(await run(["kb", "publish", "--base", "HEAD", "--repo", repo], captureIo()), 2);
  });
});
