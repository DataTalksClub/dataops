import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("frontend coverage development contract", () => {
  test("counts every production frontend module in coverage", () => {
    const config = JSON.parse(read(".c8rc.json"));

    assert.equal(config.all, true);
    assert.equal(config.src, "frontend/src");
    assert.deepEqual(config.include, ["frontend/src/**/*.js"]);
    assert.ok(config.reporter.includes("text"));
    assert.ok(config.reporter.includes("json-summary"));
    assert.equal(config.checkCoverage, true);
    assert.equal(config.lines, 21.42);
    assert.equal(config.statements, 21.42);
    assert.equal(config.functions, undefined);
    assert.equal(config.branches, undefined);
  });

  test("exposes coverage locally and enforces it in CI", () => {
    const rootPackage = JSON.parse(read("package.json"));
    const makefile = read("Makefile");
    const workflow = read(".github/workflows/deploy-dataops-v1.yml");
    const gitignore = read(".gitignore");

    assert.match(rootPackage.scripts["test:frontend:coverage"], /^c8 /);
    assert.match(makefile, /^test-frontend-coverage:/m);
    assert.match(makefile, /npm run test:frontend:coverage/);
    assert.match(makefile, /^ci:[\s\S]*\$\(MAKE\) test-frontend-coverage/m);
    assert.match(workflow, /Run frontend unit coverage\n\s+run: npm run test:frontend:coverage/);
    assert.match(gitignore, /^coverage\/$/m);
  });
});
