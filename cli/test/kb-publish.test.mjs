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
const { batches, isManagedPath, planPublication, sha256 } = await import("../src/knowledgePublish.mjs");

const ROOTS = ["content", "_docs", "workflow-templates", "document-templates"];
const known = (...values) => new Set(values.map((value) => (value === null ? null : sha256(Buffer.from(value)))));
const prodOf = (files) => Object.fromEntries(Object.entries(files).map(([file, body]) => [file, { sha256: sha256(Buffer.from(body)), size: body.length }]));

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

describe("publication plan", () => {
  test("publishes what prod still has from Git, skips what already matches, refuses the rest", () => {
    const plan = planPublication([
      { path: "content/edit.md", head: Buffer.from("new"), known: known("old") },
      { path: "content/create.md", head: Buffer.from("born"), known: known(null) },
      { path: "content/delete.md", head: null, known: known("doomed") },
      { path: "content/current.md", head: Buffer.from("same"), known: known("before") },
      { path: "content/gone-both.md", head: null, known: known("x") },
      { path: "content/web-edit.md", head: Buffer.from("git"), known: known("base") },
      { path: "content/web-delete.md", head: Buffer.from("git"), known: known("base") },
      { path: "content/web-create.md", head: Buffer.from("git"), known: known(null) },
      { path: "content/mirrored.md", head: Buffer.from("git v3"), known: known("v1", "mirrored v2") },
    ], prodOf({
      "content/edit.md": "old",
      "content/delete.md": "doomed",
      "content/current.md": "same",
      "content/web-edit.md": "edited on the web",
      "content/web-create.md": "created on the web",
      "content/mirrored.md": "mirrored v2",
    }));
    assert.deepEqual(plan.mutations.map(({ path: file, operation }) => [file, operation]), [
      ["content/create.md", "create"],
      ["content/delete.md", "delete"],
      ["content/edit.md", "edit"],
      ["content/mirrored.md", "edit"],
    ]);
    assert.equal(Buffer.from(plan.mutations[0].base64, "base64").toString(), "born");
    assert.deepEqual(plan.current, ["content/current.md", "content/gone-both.md"]);
    assert.deepEqual(plan.conflicts, [
      { path: "content/web-create.md", prod: "differs" },
      { path: "content/web-delete.md", prod: "absent" },
      { path: "content/web-edit.md", prod: "differs" },
    ]);
  });

  test("splits large publications into request-sized batches and refuses an oversized file", () => {
    const mutation = (name, size) => ({ path: name, operation: "edit", base64: "a".repeat(size) });
    assert.deepEqual(batches([mutation("a", 40), mutation("b", 40), mutation("c", 40)], 220).map((batch) => batch.map((item) => item.path)), [["a", "b"], ["c"]]);
    assert.throws(() => batches([mutation("huge", 500)], 220), /too large/);
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

  function portal(prodFiles, revision = "rev-1") {
    let current = revision;
    const calls = fakePortal({
      "GET /knowledge/manifest": () => ({ revision: current, roots: ROOTS, entries: prodOf(prodFiles) }),
      "POST /knowledge/publish": ({ body }) => {
        if (body.expectedRevision !== current) return { status: 409, body: { error: "Knowledge changed" } };
        current = `${current}+`;
        return { revision: current };
      },
    });
    return calls;
  }

  test("publishes only managed changes in the range, with exact bytes and the commit in the message", async () => {
    write("content/a.md", "a1");
    write("content/gone.md", "bye");
    write("scripts/tool.py", "v1");
    const base = commit("base");
    write("content/a.md", "a2\r\n");
    write("content/images/x.png", Buffer.from([0, 255, 10]));
    unlinkSync(path.join(repo, "content/gone.md"));
    write("scripts/tool.py", "v2");
    write("README.md", "docs");
    const head = commit("change");
    const calls = portal({ "content/a.md": "a1", "content/gone.md": "bye" });
    const io = captureIo();
    assert.equal(await run(["kb", "publish", "--base", base, "--repo", repo, "--json"], io), 0);
    const publishes = calls.filter((call) => call.method === "POST");
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].body.expectedRevision, "rev-1");
    assert.equal(publishes[0].body.message, `Publish knowledge ${head}`);
    assert.deepEqual(publishes[0].body.mutations.map((item) => [item.path, item.base64 && Buffer.from(item.base64, "base64").toString("hex"), item.absent]), [
      ["content/a.md", Buffer.from("a2\r\n").toString("hex"), false],
      ["content/gone.md", undefined, undefined],
      ["content/images/x.png", "00ff0a", true],
    ]);
    assert.equal(io.json().revision, "rev-1+");
  });

  test("refuses the whole publication and names files prod changed since Git saw them", async () => {
    write("content/a.md", "a1");
    write("content/b.md", "b1");
    const base = commit("base");
    write("content/a.md", "a2");
    write("content/b.md", "b2");
    commit("change");
    const calls = portal({ "content/a.md": "a1", "content/b.md": "edited on the web" });
    const io = captureIo();
    assert.equal(await run(["kb", "publish", "--base", base, "--repo", repo], io), 5);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    assert.match(io.errors.join("\n"), /content\/b\.md/);
    assert.doesNotMatch(io.errors.join("\n"), /content\/a\.md/);
  });

  test("a wider base still accepts versions the mirror committed inside the range", async () => {
    write("content/a.md", "git v1");
    const lastPublished = commit("published");
    write("content/a.md", "web v2");
    commit("Daily knowledge snapshot");
    write("content/a.md", "git v3");
    write("content/b.md", "skipped push");
    commit("change");
    const calls = portal({ "content/a.md": "web v2" });
    assert.equal(await run(["kb", "publish", "--base", lastPublished, "--repo", repo], captureIo()), 0);
    const [published] = calls.filter((call) => call.method === "POST");
    assert.deepEqual(published.body.mutations.map((item) => item.path), ["content/a.md", "content/b.md"]);
  });

  test("dry run and an already-published range send nothing", async () => {
    write("content/a.md", "a1");
    const base = commit("base");
    write("content/a.md", "a2");
    commit("change");
    let calls = portal({ "content/a.md": "a1" });
    let io = captureIo();
    assert.equal(await run(["kb", "publish", "--base", base, "--repo", repo, "--dry-run"], io), 0);
    assert.match(io.text(), /would edit content\/a\.md/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
    calls = portal({ "content/a.md": "a2" });
    io = captureIo();
    assert.equal(await run(["kb", "publish", "--base", base, "--repo", repo], io), 0);
    assert.match(io.text(), /Nothing to publish/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });

  test("requires a resolvable base", async () => {
    write("content/a.md", "a1");
    commit("base");
    portal({});
    assert.equal(await run(["kb", "publish", "--repo", repo], captureIo()), 2);
    assert.equal(await run(["kb", "publish", "--base", "nope", "--repo", repo], captureIo()), 2);
  });
});
