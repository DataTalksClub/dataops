import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import vm from "node:vm";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appSource = readFileSync(
  path.join(repoRoot, "frontend/src/app.js"),
  "utf8",
);
const shellMarkup = readFileSync(
  path.join(repoRoot, "frontend/index.html"),
  "utf8",
);
const browserCharacterization = readFileSync(
  path.join(
    repoRoot,
    "backend/e2e/frontend-module-characterization.spec.js",
  ),
  "utf8",
);

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(
    appSource,
  );
  assert.ok(match, `production function ${name} must exist`);
  const start = match.index;
  const parametersStart = appSource.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < appSource.length; index += 1) {
    if (appSource[index] === "(") parameterDepth += 1;
    if (appSource[index] === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  assert.ok(parametersEnd > parametersStart, `${name} parameters must balance`);
  const open = appSource.indexOf("{", parametersEnd);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < appSource.length; index += 1) {
    const character = appSource[index];
    const next = appSource[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  assert.fail(`production function ${name} is not balanced`);
}

function productionFunction(name, globals = {}) {
  return vm.runInNewContext(`(${functionSource(name)})`, globals);
}

function assertInOrder(source, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `${marker} must follow the prior coordinator step`);
    cursor = next;
  }
}

describe("app shell coordinator characterization", () => {
  test("resolves the API base from explicit metadata before same-origin fallback", () => {
    const metaFirst = productionFunction("resolveApiBase", {
      document: {
        querySelector: () => ({ content: "  https://api.example.test/base  " }),
      },
      window: { location: { origin: "https://portal.example.test" } },
    });
    assert.equal(metaFirst(), "https://api.example.test/base");

    const sameOrigin = productionFunction("resolveApiBase", {
      document: { querySelector: () => null },
      window: { location: { origin: "https://portal.example.test" } },
    });
    assert.equal(sameOrigin(), "https://portal.example.test");

    const unavailableLocation = productionFunction("resolveApiBase", {
      document: { querySelector: () => null },
      window: {
        get location() {
          throw new Error("location unavailable");
        },
      },
    });
    assert.equal(unavailableLocation(), "");
    assert.match(appSource, /function apiUrl\(path\) \{\s*return new URL\(path, API_BASE\);/);
  });

  test("normalizes account initials, authenticated payloads, and local preview actors", () => {
    const accountInitials = productionFunction("accountInitials");
    assert.equal(accountInitials(" Grace Meyer "), "GM");
    assert.equal(accountInitials("Alexey"), "A");
    assert.equal(accountInitials(""), "?");

    const currentOperatorFromPayload = productionFunction(
      "currentOperatorFromPayload",
    );
    const user = { id: "alexey", name: "Alexey" };
    assert.equal(currentOperatorFromPayload({ user }), user);
    assert.deepEqual(currentOperatorFromPayload({ actor: user }), user);
    assert.deepEqual(currentOperatorFromPayload(user), user);
    assert.equal(currentOperatorFromPayload(null), null);

    const localPreviewActor = productionFunction("localPreviewActor");
    const member = { id: "grace", email: "grace@datatalks.club" };
    const preview = localPreviewActor(
      [member],
      { actorEmail: " Grace@DataTalks.Club ", localPreview: true },
    );
    assert.equal(preview.user, member);
    assert.equal(preview.localPreview, true);
    assert.equal(localPreviewActor([], { actorEmail: "missing@example.test" }), null);
  });

  test("keeps signed-in identity separate from the selected teammate work scope", () => {
    const renderIdentity = functionSource("renderAccountIdentity");
    const refreshIdentity = functionSource("refreshAccountIdentity");
    assert.match(renderIdentity, /const actor = accountIdentityState\.user;/);
    assert.match(renderIdentity, /const workOwner = activeWorkOwner\(\);/);
    assert.match(renderIdentity, /Showing work for \$\{menuName\}; signed in as \$\{actorName\}/);
    assert.match(renderIdentity, /isActor \? "My work" : "Teammate’s work"/);
    assert.match(renderIdentity, /accountIdentityState\.selectedOwnerId = String\(member\.id\)/);
    assert.doesNotMatch(renderIdentity, /accountIdentityState\.user\s*=/);
    assert.match(refreshIdentity, /user: actor,[\s\S]*selectedOwnerId,/);
    assert.match(shellMarkup, /<small>Signed in as<\/small>/);
    assert.match(shellMarkup, /id="account-work-scope-list"[^>]+role="radiogroup"/);
  });

  test("persists and restores theme, sidebar visibility, and bounded sidebar width", () => {
    assert.match(functionSource("setDarkMode"), /localStorage\.setItem\("dtc-theme", on \? "dark" : "light"\)/);
    assert.match(functionSource("restoreDarkMode"), /localStorage\.getItem\("dtc-theme"\)/);
    assert.match(functionSource("setSidebarCollapsed"), /localStorage\.setItem\("dtc-sidebar-collapsed", collapsed \? "1" : "0"\)/);
    assert.match(functionSource("restoreSidebarCollapsed"), /localStorage\.getItem\("dtc-sidebar-collapsed"\) === "1"/);
    assert.match(functionSource("restoreSidebarWidth"), /w >= 180 && w <= 600/);
    assert.match(functionSource("attachSidebarResize"), /Math\.max\([\s\S]*200,[\s\S]*Math\.min\(560,/);
    assert.match(functionSource("attachSidebarResize"), /localStorage\.setItem\("dtc-sidebar-width", String\(w\)\)/);
    assert.match(shellMarkup, /id="theme-toggle-button"[^>]+aria-pressed="false"/);
    assert.match(shellMarkup, /id="sidebar-collapse-button"/);
  });

  test("commits canonical routes synchronously before route-specific hydration", () => {
    const commit = functionSource("commitWorkspaceRoute");
    const hydrate = functionSource("hydrateWorkspaceRoute");
    const navigate = functionSource("navigateCanonicalWorkspace");
    assertInOrder(commit, [
      "activeWorkspaceRoute = route",
      "resetTaskPanel()",
      "closeSettingsMenu()",
      "documentList.replaceChildren()",
      "refreshDocuments()",
      "if (bundleId) prepareBundlePanel(bundleId)",
      "if (taskId) prepareTaskPanel(taskId)",
    ]);
    for (const routePath of [
      "/inbox",
      "/tasks",
      "/templates",
      "/assistants",
      "/notifications",
      "/artifacts",
      "/users",
      "/cards",
      "/cards/archive",
      "/recurring",
    ]) {
      assert.ok(hydrate.includes(`"${routePath}"`), `${routePath} hydration is retained`);
    }
    assertInOrder(navigate, [
      "commitWorkspaceRoute(route, token, options)",
      "hydrateWorkspaceRoute(route, token)",
      "restoreWorkspaceEntityFocus",
    ]);
    assert.match(functionSource("applyWorkspaceRoute"), /canLeaveCurrentDocument\(\)/);
    assert.match(functionSource("applyWorkspaceRoute"), /history:\s*"none"/);
  });

  test("keeps notification counts, panel states, dismissal, and retryable failures coherent", () => {
    const refresh = functionSource("refreshWorkBell");
    const indicators = functionSource("syncWorkBellIndicators");
    const panel = functionSource("renderWorkBellPanel");
    const dismiss = functionSource("dismissWorkNotification");
    assert.match(refresh, /request\(workApiUrl\("\/api\/notifications"\)\)/);
    assert.match(refresh, /workBellNotifications = \[\];[\s\S]*Notifications API request failed/);
    assert.match(indicators, /const indicatorText = workBellError \? "!" : String\(count\)/);
    assert.match(panel, /Notifications unavailable:/);
    assert.match(panel, /You’re all caught up\./);
    assert.match(panel, /dismiss\.dataset\.dismissNotification = notification\.id/);
    assert.match(panel, /Select Dismiss to retry\./);
    assert.match(dismiss, /\/dismiss`[\s\S]*\{ method: "PUT" \}/);
    assert.match(dismiss, /workBellNotifications = workBellNotifications\.filter/);
    assert.match(dismiss, /workBellDismissErrors\.set/);
    assert.match(shellMarkup, /id="work-bell-panel"[^>]+role="dialog"/);
  });

  test("retains recoverable entity states, modal focus, and bounded toast lifetimes", () => {
    const entityState = functionSource("renderEntityLoadState");
    assert.match(entityState, /status === "error" \? "alert" : "status"/);
    assert.match(entityState, /status === "not-found"/);
    assert.match(entityState, /status === "mismatch"/);
    assert.match(entityState, /retryButton\.addEventListener\("click", retry\)/);
    assert.match(entityState, /requestAnimationFrame\(\(\) => state\.focus\(\)\)/);

    const confirm = functionSource("confirmDialog");
    const resolve = functionSource("resolveConfirm");
    assert.match(confirm, /confirmCancel\.focus\(\)/);
    assert.match(resolve, /if \(opener\?\.isConnected\) opener\.focus\(\)/);
    assert.match(functionSource("showUndoToast"), /setTimeout\(hideUndoToast, 8000\)/);
    assert.match(functionSource("showErrorToast"), /}, 10000\)/);
    assertInOrder(functionSource("reportError"), [
      "setStatus(message)",
      "showErrorToast(message)",
    ]);
  });

  test("restores shell settings before bootstrap and does not gate hash routes on documents", () => {
    assertInOrder(appSource, [
      "restoreDarkMode();",
      "restoreSidebarCollapsed();",
      "restoreSidebarWidth();",
      "attachSidebarResize();",
      "syncSidebarShellState();",
      "showLibrary({ updateUrl: false });",
      "refreshChangesPanel();",
      "updateSaveState();",
      "const documentsReady = loadDocuments();",
      "const initialRouteReadyPromise = Promise.resolve().then",
      "refreshGitStatus();",
    ]);
    assert.match(
      appSource,
      /window\.location\.hash \|\| window\.location\.pathname === "\/"[\s\S]*\? openInitialRoute\(\)[\s\S]*: documentsReady\.then\(\(\) => openInitialRoute\(\)\)/,
    );
    assert.match(appSource, /window\.addEventListener\("popstate", scheduleCurrentBrowserLocation\)/);
    assert.match(appSource, /window\.addEventListener\("hashchange", scheduleCurrentBrowserLocation\)/);
  });

  test("keeps isolated browser pointers for shell interaction and invalid-route recovery", () => {
    assert.match(browserCharacterization, /shell, Home, and account scope retain their primary DOM and interactions/);
    assert.match(browserCharacterization, /locator\("#settings-button"\)\.click\(\)/);
    assert.match(browserCharacterization, /locator\("#sidebar-collapse-button"\)\.click\(\)/);
    assert.match(browserCharacterization, /invalid hashes recover to Home and unknown programmatic navigation is a no-op/);
    assert.match(browserCharacterization, /toHaveURL\(`\$\{baseURL\}\/\#\/`\)/);
    assert.match(browserCharacterization, /expect\(errors\)\.toEqual\(\[\]\)/);
  });
});
