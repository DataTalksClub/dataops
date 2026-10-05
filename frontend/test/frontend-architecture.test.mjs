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

    assert.deepEqual(oversized, [], "frontend modules may not exceed 1,000 lines");
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

function frontendAssetFiles() {
  const manifest = JSON.parse(read("backend/src/docs/frontend-assets.json"));
  return manifest.files;
}

/**
 * Count the arguments of every call to `functionName` in `source`.
 *
 * Nested calls and trailing commas are tolerated so the scan reports the real
 * call shape instead of raw comma counts.
 */
function callArgumentCounts(source, functionName) {
  const counts = [];
  const pattern = new RegExp(`\\b${functionName}\\(`, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let segment = "";
    const segments = [];
    for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
      const character = source[index];
      if ("([{".includes(character)) {
        depth += 1;
        if (depth === 1) continue;
      } else if (")]}".includes(character)) {
        depth -= 1;
        if (depth === 0) break;
      } else if (character === "," && depth === 1) {
        segments.push(segment);
        segment = "";
        continue;
      }
      segment += character;
    }
    segments.push(segment);
    counts.push(segments.filter((value) => value.trim() !== "").length);
  }
  return counts;
}

describe("shell ownership contract", () => {
  test("keeps removed shell toolbar and borrowed save controls out of production source", () => {
    const removed = [
      ["#back-button selector", /(?<![\w-])#back-button\b/],
      ["#breadcrumb selector", /(?<![\w-])#breadcrumb\b/],
      ["#toolbar-title selector", /(?<![\w-])#toolbar-title\b/],
      ["global #save-state selector", /(?<![\w-])#save-state\b/],
      ["global .save-state class", /(?<![\w-])\.save-state\b/],
      ["global #discard-button selector", /(?<![\w-])#discard-button\b/],
      ["global #save-button selector", /(?<![\w-])#save-button\b/],
      ["back-button element", /id="back-button"/],
      ["breadcrumb element", /id="breadcrumb"/],
      ["toolbar-title element", /id="toolbar-title"/],
      ["save-state element", /id="save-state"/],
      ["discard-button element", /id="discard-button"/],
      ["save-button element", /id="save-button"/],
      ["backButton binding", /(?<![A-Za-z])backButton\b/],
      ["breadcrumb binding", /(?<![A-Za-z])breadcrumb\b/],
      ["toolbarTitle binding", /(?<![A-Za-z])toolbarTitle\b/],
      ["saveState binding", /(?<![A-Za-z])saveState\b/],
      ["saveButton binding", /(?<![A-Za-z])saveButton\b/],
      ["discardButton binding", /(?<![A-Za-z])discardButton\b/],
      ["setPageTitle writer", /\bsetPageTitle\b/],
      ["runtime editor chrome relocation", /\bcreateEditorChrome\b/],
      ["page-title coupled title resize", /\bgetResizeDocumentTitle\b/],
      ["Workspace navigation caption", /<div class="section-label">\s*Workspace\s*<\/div>/],
      ["#sidebar-resize element or selector", /(?<![\w-])#sidebar-resize\b/],
      ["resizing state class", /(?<![\w-])is-resizing-sidebar\b/],
      ["custom sidebar width storage", /dtc-sidebar-width/],
      ["sidebarResize binding", /\bsidebarResize\b/],
      ["attachSidebarResize writer", /\battachSidebarResize\b/],
      ["custom sidebar width writer", /\bsetSidebarWidth\b/],
      ["custom sidebar width restorer", /\brestoreSidebarWidth\b/],
      ["sidebar-only knowledge control class", /\bdocs-sidebar-only\b/],
      ["mobile New button id", /\bmobile-new-button\b/],
      ["mobileNewButton binding", /\bmobileNewButton\b/],
      ["new-document-button selector", /\bnew-document-button\b/],
      ["newDocumentButton binding", /\bnewDocumentButton\b/],
      ["doc-pin-button selector", /\bdoc-pin-button\b/],
      ["docPinButton binding", /\bdocPinButton\b/],
      ["knowledge pin UI", /\bpinned\b/i],
      ["recently viewed UI", /\brecently-viewed\b|\brecentlyViewed\b/i],
      ["recent-list selector", /\brecent-list\b/],
      ["recentList binding", /\brecentList\b/],
      ["changes-toggle selector", /\bchanges-toggle\b/],
      ["changesToggle binding", /\bchangesToggle\b/],
      ["filter-toggle selector", /\bfilter-toggle\b/],
      ["filterToggle binding", /\bfilterToggle\b/],
      ["filters expanded storage", /dtc-filters-expanded/],
      ["current pin storage", /dtc-pinned/],
      ["recently viewed storage", /dtc-recently-viewed/],
      ["toggleCurrentDocPin API", /\btoggleCurrentDocPin\b/],
      ["restoreFiltersExpanded API", /\brestoreFiltersExpanded\b/],
      ["setFiltersExpanded API", /\bsetFiltersExpanded\b/],
    ];

    const ghosts = [];
    for (const file of frontendAssetFiles()) {
      const source = read(`frontend/${file}`);
      for (const [name, pattern] of removed) {
        if (pattern.test(source)) ghosts.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(ghosts, []);
  });

  test("gives Process Docs ownership of its creation action", () => {
    const producers = frontendJavaScriptFiles().filter((file) =>
      read(`frontend/${file}`).includes('className = "primary-button ops-docs-create"'),
    );
    assert.deepEqual(producers, ["src/surfaces/knowledge/process-docs.js"]);
    assert.match(
      read("frontend/src/surfaces/knowledge/process-docs.js"),
      /createButton\.addEventListener\("click", \(\) => showCreate\(\)\);/,
    );
    const admin = read("frontend/src/surfaces/operations/admin.js");
    assert.doesNotMatch(admin, /\bshowCreate\b|New process doc/);

    assert.match(admin, /renderSurfaceHeader\("Admin"/);
  });

  test("writes route titles through a single-argument contract", () => {
    const composition = read("frontend/src/runtime/surface-composition.js");
    assert.match(composition, /function setRouteTitle\(title\) \{/);
    assert.doesNotMatch(composition, /function setRouteTitle\([^)]*,/);
    // The removed second argument had a single producer: the breadcrumb path.
    assert.deepEqual(
      frontendAssetFiles().filter((file) =>
        /\boperationsViewPath\b/.test(read(`frontend/${file}`)),
      ),
      [],
    );

    const overloaded = [];
    for (const file of frontendAssetFiles().filter((name) => name.endsWith(".js"))) {
      const source = read(`frontend/${file}`);
      callArgumentCounts(source, "setRouteTitle").forEach((count, index) => {
        if (count > 1) overloaded.push(`${file}: call ${index + 1} passes ${count} arguments`);
      });
    }
    assert.deepEqual(overloaded, []);
  });

  test("gives the editor surface ownership of its save controls", () => {
    const markup = read("frontend/index.html");
    const editorView = markup.slice(
      markup.indexOf('<section id="editor-view"'),
      markup.indexOf('<section id="create-view"'),
    );
    for (const id of [
      "editor-inline-status",
      "editor-save-state",
      "editor-discard-button",
      "editor-save-button",
    ]) {
      assert.ok(editorView.includes(`id="${id}"`), `${id} belongs to the editor view`);
    }
    assert.match(
      editorView,
      /id="editor-save-state"[^>]*tabindex="-1"/,
      "save state receives completed mutation focus",
    );

    assert.doesNotMatch(markup, /page-toolbar|toolbar-actions/, "the shell has no top toolbar");
    assert.match(markup, /<footer class="sidebar-footer">/, "global actions live in the sidebar footer");
    const sidebar = markup.slice(
      markup.indexOf('<aside id="sidebar"'),
      markup.indexOf("</aside>"),
    );
    for (const id of ["sidebar-expand-button", "help-button", "work-bell-button", "settings-button"]) {
      assert.ok(sidebar.includes(`id="${id}"`), `${id} belongs to the sidebar`);
    }
    for (const id of ["view-toggle-button", "doc-menu-button"]) {
      assert.ok(editorView.includes(`id="${id}"`), `${id} belongs to the editor view`);
    }

    const bindings = read("frontend/src/shell/dom-bindings.js");
    assert.match(bindings, /editorInlineStatus: "#editor-inline-status"/);
    assert.match(bindings, /editorSaveState: "#editor-save-state"/);
    assert.match(bindings, /editorDiscardButton: "#editor-discard-button"/);
    assert.match(bindings, /editorSaveButton: "#editor-save-button"/);
    assert.equal(
      bindings.match(/dom\.editorSaveButton\.addEventListener\("click", handlers\.saveCurrentDocument\)/g)
        ?.length,
      1,
    );
    assert.equal(
      bindings.match(/dom\.editorDiscardButton\.addEventListener\("click", handlers\.discardDraft\)/g)
        ?.length,
      1,
    );

    const editorIndex = read("frontend/src/surfaces/document-editor/index.js");
    assert.doesNotMatch(editorIndex, /createElement\("footer"\)/);
    assert.match(
      editorIndex,
      /writeEditorFeedback\(context\.editorInlineStatus, message, options\)/,
    );

    const lifecycle = read("frontend/src/surfaces/document-editor/lifecycle.js");
    assert.match(lifecycle, /editorSaveButton\.disabled = !hasChanges;/);
    assert.match(lifecycle, /editorDiscardButton\.disabled = !documentState\.hasDraft;/);
    assert.match(lifecycle, /editorSaveState\.textContent = message;/);
    assert.match(lifecycle, /restoreMutationFocus\(\);/);
    assert.doesNotMatch(lifecycle, /has-changes|classList\.(?:add|remove|toggle)\("flash"\)/);

    const events = read("frontend/src/runtime/application-events.js");
    assert.match(events, /!editorSaveButton\.disabled/);
  });

  test("shows editor mutation controls only on the editor route", () => {
    const styles = read("frontend/src/styles.css");
    assert.match(
      styles,
      /body\[data-view="library"\] \.editor-view,[\s\S]*?body\[data-view="create"\] \.editor-view \{\n  display: none;\n\}/,
    );
    assert.doesNotMatch(styles, /\.editor-view #(?:save|discard)-button/);
    assert.doesNotMatch(styles, /display: none !important;\n\}\n\n\.editor-view \.save-state/);
  });
});

function uncommentCss(styles) {
  return styles.replace(/\/\*[\s\S]*?\*\//g, "");
}

function firstCssRuleBody(styles, selector) {
  const uncommented = uncommentCss(styles);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = uncommented.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing ${selector} rule`);
  return match[1];
}

function cssDeclarations(body) {
  const declarations = {};
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    declarations[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return declarations;
}

function cssPx(value) {
  if (!value || value === "0") return 0;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  assert.ok(match, `expected a px length, got ${JSON.stringify(value)}`);
  return Number(match[1]);
}

function boxSidePx(declarations, kind, side) {
  const longhand = declarations[`${kind}-${side}`];
  if (longhand) return cssPx(longhand);
  const inline = side === "left" ? declarations[`${kind}-inline-start`] : null;
  if (inline) return cssPx(inline);
  const shorthand = declarations[kind];
  if (!shorthand) return 0;
  const parts = shorthand.split(/\s+/);
  if (parts.length === 1) return cssPx(parts[0]);
  if (parts.length === 2 || parts.length === 3) {
    return cssPx(side === "left" || side === "right" ? parts[1] : parts[0]);
  }
  const index = { top: 0, right: 1, bottom: 2, left: 3 }[side];
  return cssPx(parts[index]);
}

describe("workspace nested nav indent contract", () => {
  test("nested Tasks labels share the parent-text column, not an extra 10px inset", () => {
    const styles = read("frontend/src/styles.css");
    const submenu = cssDeclarations(firstCssRuleBody(styles, ".workspace-nav-submenu"));
    const submenuLeft = boxSidePx(submenu, "margin", "left") + boxSidePx(submenu, "padding", "left");
    assert.equal(
      submenuLeft,
      30,
      ".workspace-nav-submenu left inset must total 30px, not 40px from combining margin-left: 30px with padding-left: 10px",
    );

    const parent = cssDeclarations(firstCssRuleBody(styles, ".workspace-nav-button"));
    const icon = cssDeclarations(firstCssRuleBody(styles, ".workspace-nav-icon"));
    const nested = cssDeclarations(firstCssRuleBody(styles, ".workspace-subnav-button"));
    const parentTextColumn =
      boxSidePx(parent, "padding", "left") + cssPx(icon.width) + cssPx(parent.gap);
    const nestedTextColumn = submenuLeft + boxSidePx(nested, "padding", "left");
    assert.equal(parentTextColumn, 40);
    assert.equal(nestedTextColumn, parentTextColumn);
    assert.equal(cssPx(nested["font-size"]), 13);
    assert.equal(nested.color, "var(--dk-text-muted)");
    assert.match(
      firstCssRuleBody(styles, ".workspace-subnav-button:hover"),
      /background:\s*var\(--dk-bg-hover\)/,
    );
    assert.match(
      firstCssRuleBody(styles, ".workspace-subnav-button.is-active"),
      /background:\s*var\(--dk-accent-soft\)/,
    );
    assert.match(
      styles,
      /@media \(max-width: 820px\) \{[\s\S]*?\.workspace-subnav-button \{\s*min-height: 44px;/,
    );
    assert.doesNotMatch(styles, /#tasks-nav-submenu/);
    assert.match(
      read("frontend/index.html"),
      /id="tasks-nav-submenu" class="workspace-nav-submenu"/,
    );
  });

  test("app CSS never uses a colored single-edge accent", () => {
    const styles = uncommentCss(read("frontend/src/styles.css"));
    assert.doesNotMatch(
      styles,
      /border-(?:left|top)(?:-width)?:\s*[2-9]px/,
    );
    assert.doesNotMatch(
      styles,
      /box-shadow:\s*inset\s+(?:[1-9]px\s+0|0\s+[1-9]px)/,
    );
    assert.doesNotMatch(
      styles,
      /border-(?:top|left|right|bottom)-color:\s*var\(--(?:dk-(?:danger|warning|success|info|accent)|attention)-/,
    );
    assert.doesNotMatch(styles, /\.(?:home-task-marker|intake-row-marker)\b/);
    assert.match(
      firstCssRuleBody(styles, 'body[data-workspace-view="tasks"] .ops-queue-group'),
      /border:\s*1px solid var\(--dk-border-default\)/,
    );
    assert.doesNotMatch(
      firstCssRuleBody(styles, 'body[data-workspace-view="tasks"] .ops-queue-group'),
      /border-top:/,
    );
  });
});
