import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

describe("dakit token adoption contract", () => {
  test("the vendored tokens are a byte-copy of the dakit build output", (t) => {
    const upstream = path.join(repoRoot, "../dakit/dist/tokens.css");
    if (!existsSync(upstream)) return t.skip("no ../dakit checkout beside this repo");
    assert.equal(
      read("frontend/src/dakit/tokens.css"),
      readFileSync(upstream, "utf8"),
      "frontend/src/dakit/tokens.css drifted from ../dakit/dist/tokens.css;"
        + " re-copy it: cp ../dakit/dist/tokens.css frontend/src/dakit/tokens.css",
    );
  });

  test("every entry surface loads the vendored tokens and the manifest serves them", () => {
    assert.match(
      read("frontend/index.html"),
      /<link rel="stylesheet" href="\/src\/dakit\/tokens\.css">/,
      "index.html must load the dakit tokens before the app stylesheet",
    );

    const manifest = JSON.parse(read("backend/src/docs/frontend-assets.json"));
    assert.ok(
      manifest.files.includes("src/dakit/tokens.css"),
      "backend/src/docs/frontend-assets.json must serve src/dakit/tokens.css;"
        + " the deployed handler 404s anything the manifest does not list",
    );
  });
});
