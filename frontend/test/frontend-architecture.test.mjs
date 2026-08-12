import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const MAX_MODULE_LINES = 1_000;
// Remove an entry as soon as that responsibility is split. Values are the
// measured pre-split ceiling and may never increase.
const oversizedMigrationBaseline = Object.freeze({});

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function frontendJavaScriptFiles() {
  const manifest = JSON.parse(read("backend/src/docs/frontend-assets.json"));
  return manifest.files.filter((file) => file.endsWith(".js"));
}

describe("frontend architecture contract", () => {
  test("prevents new or growing modules above 1,000 lines", () => {
    const oversized = frontendJavaScriptFiles()
      .map((file) => ({
        file,
        lines: read(`frontend/${file}`).split("\n").length,
      }))
      .filter(({ lines }) => lines > 1_000);

    assert.deepEqual(
      oversized.map(({ file }) => file).sort(),
      Object.keys(oversizedMigrationBaseline).sort(),
      "new oversized modules are forbidden; remove baseline entries after splitting",
    );
    for (const { file, lines } of oversized) {
      assert.ok(
        lines <= oversizedMigrationBaseline[file],
        `${file} grew from its ${oversizedMigrationBaseline[file]}-line migration ceiling to ${lines}`,
      );
      assert.ok(lines > MAX_MODULE_LINES);
    }
  });

  test("keeps production source readable", () => {
    const longLines = [];
    for (const file of frontendJavaScriptFiles()) {
      read(`frontend/${file}`)
        .split("\n")
        .forEach((line, index) => {
          if (line.length > 180) {
            longLines.push(`${file}:${index + 1} (${line.length} characters)`);
          }
        });
    }
    assert.deepEqual(longLines, []);
  });
});
