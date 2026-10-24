import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The knowledge publish job runs this CLI from a checkout without installed
 * dependencies, so no CLI module may resolve a third-party package at
 * import time. These tests recreate that environment: an isolated temp dir
 * holding the CLI and its shared queue helper (deliberately NO node_modules,
 * and nothing resolvable from parent directories), then spawn a real
 * `node` child process in it.
 */
describe("CLI without installed dependencies", () => {
  const tmpBase = process.platform === "win32" ? tmpdir() : "/tmp";

  function cleanCheckout(t) {
    const root = mkdtempSync(path.join(tmpBase, "dataops-clean-cli-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, "cli");
    mkdirSync(dir);
    const frontend = path.join(root, "frontend");
    mkdirSync(path.join(frontend, "src", "core"), { recursive: true });
    cpSync(path.join(repoCli, "../frontend/package.json"), path.join(frontend, "package.json"));
    cpSync(path.join(repoCli, "../frontend/src/core/task-attention.js"), path.join(frontend, "src/core/task-attention.js"));
    for (const entry of ["bin", "src"]) {
      cpSync(path.join(repoCli, entry), path.join(dir, entry), { recursive: true });
    }
    cpSync(path.join(repoCli, "package.json"), path.join(dir, "package.json"));
    return dir;
  }

  function runCli(t, dir, argv, extraEnv = {}) {
    const configDir = mkdtempSync(path.join(tmpBase, "dataops-cli-isolated-"));
    t.after(() => rmSync(configDir, { recursive: true, force: true }));
    // The child must resolve modules exactly as the checkout lays them out:
    // NODE_PATH is stripped so no parent-process lookup can leak in
    // (ESM normally ignores it, but the receipt must match the claim).
    const { NODE_PATH: _nodePath, ...baseEnv } = process.env;
    void _nodePath;
    return spawnSync(
      process.execPath,
      [path.join(dir, "bin", "dataops.mjs"), ...argv],
      {
        cwd: dir,
        timeout: 30000,
        encoding: "utf8",
        env: {
          ...baseEnv,
          DATAOPS_CONFIG_DIR: configDir,
          DATAOPS_URL: "http://127.0.0.1:9",
          DATAOPS_TOKEN: "dops_test",
          ...extraEnv,
        },
      },
    );
  }

  test("kb help loads with no dependencies installed", async (t) => {
    const dir = cleanCheckout(t);
    const result = runCli(t, dir, ["kb", "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(result.stderr, /js-yaml/);
    assert.match(result.stdout, /dataops kb/);
  });

  test("templates help loads with no dependencies installed", async (t) => {
    const dir = cleanCheckout(t);
    const result = runCli(t, dir, ["templates", "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(result.stdout, /--from-file/);
  });

  test("YAML template files fail with a usage error, not a module crash", async (t) => {
    const dir = cleanCheckout(t);
    const file = path.join(dir, "def.yaml");
    writeFileSync(file, "name: Fresh\ntype: fresh-type\ntrigger:\n  mode: manual\ntasks:\n  - id: a\n    name: A\n    schedule:\n      offset_days: 0\n");
    const result = runCli(t, dir, ["templates", "create", "--file", file]);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(result.stderr, /js-yaml/);
    assert.match(result.stderr, /JSON/);
  });

  test("JSON template files never attempt the YAML import", async (t) => {
    const dir = cleanCheckout(t);
    const file = path.join(dir, "def.json");
    writeFileSync(file, JSON.stringify({
      name: "Fresh", type: "fresh-type",
      tasks: [{ id: "a", name: "A", schedule: { offset_days: 0 } }],
    }));
    // No portal listens here: the point is reaching the network layer,
    // which proves definition parsing completed without touching js-yaml.
    const result = runCli(t, dir, ["templates", "create", "--file", file]);
    assert.equal(result.status, 7, result.stderr);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(result.stderr, /js-yaml/);
  });
});
