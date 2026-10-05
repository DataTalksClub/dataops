import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { readAppCss, uncommentCss } from "./support/app-css.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("dakit adoption contract", () => {
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

  test("the vendored bundle is the dakit build output with fonts re-pathed", (t) => {
    const upstream = path.join(repoRoot, "../dakit/dist/dakit.css");
    if (!existsSync(upstream)) return t.skip("no ../dakit checkout beside this repo");
    const rebased = readFileSync(upstream, "utf8")
      .replaceAll("../fonts/", "../assets/fonts/");
    assert.equal(
      read("frontend/src/dakit/dakit.css"),
      rebased,
      "frontend/src/dakit/dakit.css drifted from ../dakit/dist/dakit.css;"
        + " regenerate it: scripts/sync_dakit.sh",
    );
  });

  test("the entry surface loads tokens, bundle, and app styles in that order", () => {
    const head = read("frontend/index.html");
    const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]
      .map((match) => match[1]);
    assert.deepEqual(
      links,
      [
        "/src/dakit/tokens.css",
        "/src/dakit/dakit.css",
        "/src/styles/base.css",
        "/src/styles/review.css",
        "/src/styles/chrome.css",
        "/src/styles/finance.css",
        "/src/styles/operations.css",
        "/src/styles/cards.css",
        "/src/styles/planner.css",
        "/src/styles/responsive.css",
        "/src/styles/refinements.css",
        "/src/styles/admin.css",
        "/src/styles/tasks-boards.css",
        "/src/styles/tasks-panels.css",
        "/src/styles/knowledge.css",
        "/src/styles/editor.css",
        "/src/styles/overrides.css",
      ],
      "index.html must load the dakit tokens, then the dakit bundle, then the app stylesheets in slice order",
    );

    const manifest = JSON.parse(read("backend/src/docs/frontend-assets.json"));
    for (const asset of ["src/dakit/tokens.css", "src/dakit/dakit.css"]) {
      assert.ok(
        manifest.files.includes(asset),
        `backend/src/docs/frontend-assets.json must serve ${asset};`
          + " the deployed handler 404s anything the manifest does not list",
      );
    }
  });

  test("app CSS uses dakit semantic roles, not primitive ramps", () => {
    const styles = uncommentCss(readAppCss());
    assert.doesNotMatch(
      styles,
      /var\(--dk-(?:gray|blue|green|amber|red)-\d+\)/,
    );
    assert.match(
      styles,
      /--attention-due:\s*var\(--dk-warning-text\)/,
    );
    assert.match(
      styles,
      /--attention-waiting:\s*var\(--dk-text-faint\)/,
    );
  });
});
