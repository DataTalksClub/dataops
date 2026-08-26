import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import vm from "node:vm";

import {
  createApiClient,
  resolveApiBase,
} from "../src/shell/api.js";
import {
  accountInitials,
  currentOperatorFromPayload,
  localPreviewActor,
} from "../src/shell/account.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appSource = readFileSync(
  path.join(repoRoot, "frontend/src/app.js"),
  "utf8",
);
const applicationSource = readFileSync(
  path.join(repoRoot, "frontend/src/runtime/application.js"),
  "utf8",
);
const applicationEventsSource = readFileSync(
  path.join(repoRoot, "frontend/src/runtime/application-events.js"),
  "utf8",
);
const feedbackSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/feedback.js"),
  "utf8",
);
const preferencesSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/preferences.js"),
  "utf8",
);
const accountSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/account.js"),
  "utf8",
);
const notificationsSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/notifications.js"),
  "utf8",
);
const navigationSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/navigation.js"),
  "utf8",
);
const bootstrapSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/bootstrap.js"),
  "utf8",
);
const domBindingsSource = readFileSync(
  path.join(repoRoot, "frontend/src/shell/dom-bindings.js"),
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

function functionSource(name, source = appSource) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(
    source,
  );
  assert.ok(match, `production function ${name} must exist`);
  const start = match.index;
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  assert.ok(parametersEnd > parametersStart, `${name} parameters must balance`);
  const open = source.indexOf("{", parametersEnd);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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
      if (depth === 0) return source.slice(start, index + 1);
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
    const metaFirst = resolveApiBase({
      documentRef: {
        querySelector: () => ({ content: "  https://api.example.test/base  " }),
      },
      windowRef: { location: { origin: "https://portal.example.test" } },
    });
    assert.equal(metaFirst, "https://api.example.test/base");

    const sameOrigin = resolveApiBase({
      documentRef: { querySelector: () => null },
      windowRef: { location: { origin: "https://portal.example.test" } },
    });
    assert.equal(sameOrigin, "https://portal.example.test");

    const unavailableLocation = resolveApiBase({
      documentRef: { querySelector: () => null },
      windowRef: {
        get location() {
          throw new Error("location unavailable");
        },
      },
    });
    assert.equal(unavailableLocation, "");
    const { apiUrl } = createApiClient({
      apiBase: "https://portal.example.test",
      fetchImpl: () => assert.fail("request was not expected"),
      storage: { getItem: () => null },
    });
    assert.equal(
      apiUrl("/api/example").href,
      "https://portal.example.test/api/example",
    );
  });

  test("normalizes account initials, authenticated payloads, and local preview actors", () => {
    assert.equal(accountInitials(" Grace Meyer "), "GM");
    assert.equal(accountInitials("Alexey"), "A");
    assert.equal(accountInitials(""), "?");

    const user = { id: "alexey", name: "Alexey" };
    assert.equal(currentOperatorFromPayload({ user }), user);
    assert.deepEqual(currentOperatorFromPayload({ actor: user }), user);
    assert.deepEqual(currentOperatorFromPayload(user), user);
    assert.equal(currentOperatorFromPayload(null), null);

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
    const renderIdentity = functionSource("renderAccountIdentity", accountSource);
    const refreshIdentity = functionSource("refreshAccountIdentity", accountSource);
    assert.match(renderIdentity, /const actor = identityState\.user;/);
    assert.match(renderIdentity, /const workOwner = activeWorkOwner\(\);/);
    assert.match(renderIdentity, /Showing work for \$\{menuName\}; signed in as \$\{actorName\}/);
    assert.match(renderIdentity, /isActor \? "My work" : "Teammate’s work"/);
    assert.match(renderIdentity, /identityState\.selectedOwnerId = String\(member\.id\)/);
    assert.doesNotMatch(renderIdentity, /identityState\.user\s*=/);
    assert.match(refreshIdentity, /user: actor,[\s\S]*selectedOwnerId,/);
    assert.match(shellMarkup, /<small>Signed in as<\/small>/);
    assert.match(shellMarkup, /id="account-work-scope-list"[^>]+role="radiogroup"/);
  });

  test("persists theme and sidebar visibility while deleting custom resize state", () => {
    assert.match(functionSource("setDarkMode", preferencesSource), /storage\.setItem\("dtc-theme", on \? "dark" : "light"\)/);
    assert.match(functionSource("restoreDarkMode", preferencesSource), /storage\.getItem\("dtc-theme"\)/);
    assert.match(functionSource("setSidebarCollapsed", preferencesSource), /storage\.setItem\("dtc-sidebar-collapsed", collapsed \? "1" : "0"\)/);
    assert.match(functionSource("restoreSidebarCollapsed", preferencesSource), /storage\.getItem\("dtc-sidebar-collapsed"\) === "1"/);
    assert.doesNotMatch(preferencesSource, /\b(?:attachSidebarResize|restoreSidebarWidth|setSidebarWidth)\b/);
    assert.doesNotMatch(preferencesSource, /dtc-sidebar-width/);
    assert.doesNotMatch(shellMarkup, /id="sidebar-resize"/);
    assert.doesNotMatch(shellMarkup, /<div class="section-label">\s*Workspace\s*<\/div>/);
    assert.match(shellMarkup, /id="theme-toggle-button"[^>]+aria-pressed="false"/);
    assert.match(shellMarkup, /id="sidebar-collapse-button"/);
  });

  test("commits canonical routes synchronously before route-specific hydration", () => {
    const commit = functionSource("commitWorkspaceRoute", navigationSource);
    const hydrate = functionSource("hydrateWorkspaceRoute", navigationSource);
    const navigate = functionSource(
      "navigateCanonicalWorkspace",
      navigationSource,
    );
    assertInOrder(commit, [
      "activeRoute = route",
      "resetTaskPanel()",
      "closeSettingsMenu()",
      "documentList.replaceChildren()",
      "refreshDocuments()",
      "if (cardId) prepareCardPanel(cardId)",
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
    assert.match(
      functionSource("applyWorkspaceRoute", navigationSource),
      /canLeaveCurrentDocument\(\)/,
    );
    assert.match(
      functionSource("applyWorkspaceRoute", navigationSource),
      /history:\s*"none"/,
    );
  });

  test("keeps notification counts, panel states, dismissal, and retryable failures coherent", () => {
    const refresh = functionSource("refreshWorkBell", notificationsSource);
    const indicators = functionSource(
      "syncWorkBellIndicators",
      notificationsSource,
    );
    const panel = functionSource("renderWorkBellPanel", notificationsSource);
    const dismiss = functionSource(
      "dismissWorkNotification",
      notificationsSource,
    );
    const loadMore = functionSource(
      "loadMoreNotifications",
      notificationsSource,
    );
    assert.match(notificationsSource, /import \{ createCollectionLoader \}/);
    assert.match(
      notificationsSource,
      /createCollectionLoader\(\{\s*request,\s*collection: "notifications",/,
    );
    assert.match(refresh, /await notificationLoader\.load\(\)/);
    assert.doesNotMatch(refresh, /\brequest\s*\(/);
    assert.match(loadMore, /await notificationLoader\.loadMore\(\)/);
    assert.match(indicators, /notificationState\.failed && count === 0 \? "!" : String\(count\)/);
    assert.match(panel, /Notifications unavailable:/);
    assert.match(panel, /You’re all caught up\./);
    assert.match(panel, /dismiss\.dataset\.dismissNotification = notification\.id/);
    assert.match(panel, /Select Dismiss to retry\./);
    assert.match(dismiss, /\/dismiss`[\s\S]*\{ method: "PUT" \}/);
    assert.match(dismiss, /locallyDismissedIds\.add\(notification\.id\)/);
    assert.doesNotMatch(dismiss, /notifications\s*=\s*notifications\.filter/);
    assert.match(dismiss, /dismissErrors\.set/);
    assert.match(shellMarkup, /id="work-bell-panel"[^>]+role="dialog"/);
  });

  test("retains recoverable entity states, modal focus, and bounded toast lifetimes", () => {
    const entityState = functionSource("renderEntityLoadState", feedbackSource);
    assert.match(entityState, /status === "error" \? "alert" : "status"/);
    assert.match(entityState, /status === "not-found"/);
    assert.match(entityState, /status === "mismatch"/);
    assert.match(entityState, /retryButton\.addEventListener\("click", retry\)/);
    assert.match(
      entityState,
      /requestAnimationFrameImpl\(\(\) => state\.focus\(\)\)/,
    );

    const confirm = functionSource("confirmDialog", feedbackSource);
    const resolve = functionSource("resolveConfirm", feedbackSource);
    assert.match(confirm, /confirmCancel\.focus\(\)/);
    assert.match(resolve, /if \(opener\?\.isConnected\) opener\.focus\(\)/);
    assert.match(
      functionSource("showUndoToast", feedbackSource),
      /setTimeoutImpl\(hideUndoToast, 8000\)/,
    );
    assert.match(
      functionSource("showErrorToast", feedbackSource),
      /}, 10000\)/,
    );
    assertInOrder(functionSource("reportError", feedbackSource), [
      "setStatus(message)",
      "showErrorToast(message)",
    ]);
  });

  test("restores shell settings before bootstrap and does not gate hash routes on documents", () => {
    const initializeAppShell = functionSource(
      "initializeAppShell",
      bootstrapSource,
    );
    assertInOrder(initializeAppShell, [
      "restoreDarkMode();",
      "restoreSidebarCollapsed();",
      "syncSidebarShellState();",
      "showLibrary({ updateUrl: false });",
      "refreshChangesPanel();",
      "updateSaveState();",
      "const documentsReady = loadDocuments();",
      "navigationShell.initializeRouting(documentsReady);",
      "refreshGitStatus();",
    ]);
    const initialize = functionSource("initializeRouting", navigationSource);
    assert.match(
      initialize,
      /locationRef\.hash \|\| locationRef\.pathname === "\/"[\s\S]*\? openInitialRoute\(\)[\s\S]*: documentsReady\.then\(openInitialRoute\)/,
    );
    assert.match(
      domBindingsSource,
      /"popstate",[\s\S]*handlers\.scheduleCurrentBrowserLocation/,
    );
    assert.match(
      domBindingsSource,
      /"hashchange",[\s\S]*handlers\.scheduleCurrentBrowserLocation/,
    );
    assert.match(
      applicationEventsSource,
      /scheduleCurrentBrowserLocation:\s*navigationShell\.scheduleCurrentBrowserLocation/,
    );
  });

  test("keeps isolated browser pointers for shell interaction and invalid-route recovery", () => {
    assert.match(browserCharacterization, /shell, Home, and account scope retain their primary DOM and interactions/);
    assert.match(browserCharacterization, /keeps fixed-width sidebar and accessible drawer flows/);
    assert.match(browserCharacterization, /locator\("#sidebar-resize"\)\)\.toHaveCount\(0\)/);
    assert.match(browserCharacterization, /locator\("#settings-button"\)\.click\(\)/);
    assert.match(browserCharacterization, /locator\("#sidebar-collapse-button"\)\.click\(\)/);
    assert.match(browserCharacterization, /invalid hashes recover to Home and unknown programmatic navigation is a no-op/);
    assert.match(browserCharacterization, /toHaveURL\(`\$\{baseURL\}\/\#\/`\)/);
    assert.match(browserCharacterization, /expect\(errors\)\.toEqual\(\[\]\)/);
  });
});
