import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const matrixPath = resolve(repoRoot, "backend", "e2e", "frontend-capabilities.json");
const matrixText = readFileSync(matrixPath, "utf8");
const matrix = JSON.parse(matrixText);

const REQUIRED = {
  session: {
    route: "/login | /logout",
    states: ["signed-out-redirect", "expired-denied", "disabled-denied", "operator-cookie-ready", "admin-cookie-ready", "api-json-denial", "no-bearer-fallback"],
  },
  settings: {
    route: "/#/ (Settings panel)",
    states: ["operator-ready", "admin-ready", "desktop-focus-close", "mobile-focus-close", "logout"],
  },
  home: { route: "/#/", states: ["loading", "empty", "ready", "partial-failure"] },
  inbox: {
    route: "/#/inbox?intakeId=<id>",
    states: ["empty", "filtered-exact", "new", "triaged", "blocked-due", "blocked-future", "attached", "converted", "assistant-ready", "duplicate", "ignored", "archived", "validation", "conflict", "server-failure", "stale-not-found"],
  },
  tasks: {
    route: "/#/tasks?taskId=<id>&date=<date>&cardId=<id>&contextCardId=<id>",
    states: ["empty", "waiting", "blocked", "done", "create-select-update", "file-proof", "combined-context", "sop-link", "stale-not-found", "conflict", "failure"],
  },
  workflows: {
    route: "/#/cards?cardId=<id>&taskId=<id>",
    states: ["empty", "active", "staged", "completed", "deep-link-return", "mismatch", "not-found", "failure"],
  },
  templates: {
    route: "/#/templates?templateId=<id>",
    states: ["operator-read", "operator-denied", "admin-create", "admin-edit", "admin-delete", "clean", "dirty", "validation", "conflict", "referenced-409", "failure", "stale-not-found"],
  },
  recurring: {
    route: "/#/recurring",
    states: ["empty", "ready", "pause", "resume", "delete-unreferenced", "delete-referenced-409", "permission-denied", "failure"],
  },
  assistants: {
    route: "/#/assistants?assistantJobId=<id>",
    states: ["loading", "empty", "list", "exact-detail", "deep-link-reload", "stale-not-found", "unavailable"],
  },
  artifacts: {
    route: "/#/artifacts",
    states: ["empty", "available", "authorized-action", "unavailable", "not-found", "failure"],
  },
  notifications: {
    route: "/#/notifications",
    states: ["empty", "task-linked", "dismiss-success", "dismiss-failure", "counts-update"],
  },
  bookkeeping: {
    route: "/#/bookkeeping",
    states: ["empty", "configured", "validation", "upload-link", "report", "failure"],
  },
  sponsors: {
    route: "/#/sponsors?bookingId=<id>",
    states: ["empty", "ready-detail", "operator-safe-read", "admin-mutation", "operator-denied", "conflict", "not-found", "failure"],
  },
  newsletter: {
    route: "/#/newsletter",
    states: ["empty", "populated", "create-edit-reload", "validation", "conflict", "failure"],
  },
  calendar: {
    route: "/#/calendar",
    states: ["empty", "populated", "create-edit-reload", "overlays-alerts", "week-date-navigation", "validation", "conflict", "failure"],
  },
  "mailing-exports": {
    route: "/#/mailing-exports",
    states: ["no-configs", "ready", "running", "completed", "failed"],
  },
  "process-docs": {
    route: "/#/processes",
    states: ["loading", "empty", "result-detail", "create-read-edit", "backlinks", "validation", "git-failure"],
  },
  admin: { route: "/#/admin", states: ["loading", "empty", "ready-read-only", "failure"] },
  users: {
    route: "/#/users",
    states: ["operator-read-only", "admin-create", "admin-edit", "admin-disable", "validation", "operator-403", "spoof-denial", "failure"],
  },
};

const REQUIRED_ROLES = ["signed-out", "expired-session", "disabled-user", "operator", "admin"];
const REQUIRED_APIS = {
  session: ["/api/me", "/api/*", "/work/api/*"],
  settings: ["/api/me", "/logout"],
  home: ["/api/tasks", "/api/cards", "/api/notifications", "/docs/process-quality"],
  inbox: ["/api/intake"],
  tasks: ["/api/tasks", "/api/files", "/api/artifacts", "/docs", "/content/*"],
  workflows: ["/api/cards", "/api/tasks", "/api/artifacts"],
  templates: ["/api/templates", "/api/cards"],
  recurring: ["/api/recurring"],
  assistants: ["/api/assistant-jobs", "/api/artifacts"],
  artifacts: ["/api/artifacts", "/api/files"],
  notifications: ["/api/notifications", "/api/tasks"],
  bookkeeping: ["/api/bookkeeping/*"],
  sponsors: ["/api/sponsor-crm/*"],
  newsletter: ["/api/newsletter-slots"],
  calendar: ["/api/calendar-items"],
  "mailing-exports": ["/api/mailing-exports"],
  "process-docs": ["/docs", "/search", "/content/*", "/docs/registry", "/docs/backlinks"],
  admin: ["/docs/process-quality", "/git/status", "/git/log"],
  users: ["/api/users", "/api/me"],
};
const REQUIRED_STATE_ROLE_OVERRIDES = {
  "session.signed-out-redirect": ["signed-out"],
  "session.expired-denied": ["expired-session"],
  "session.disabled-denied": ["disabled-user"],
  "session.operator-cookie-ready": ["operator"],
  "session.admin-cookie-ready": ["admin"],
  "session.api-json-denial": ["signed-out", "expired-session", "disabled-user"],
  "session.no-bearer-fallback": ["operator", "admin"],
  "settings.operator-ready": ["operator"],
  "settings.admin-ready": ["admin"],
  "templates.operator-read": ["operator"],
  "templates.operator-denied": ["operator"],
  "templates.admin-create": ["admin"],
  "templates.admin-edit": ["admin"],
  "templates.admin-delete": ["admin"],
  "templates.clean": ["admin"],
  "templates.dirty": ["admin"],
  "templates.validation": ["admin"],
  "templates.conflict": ["admin"],
  "templates.referenced-409": ["admin"],
  "templates.failure": ["admin"],
  "recurring.pause": ["admin"],
  "recurring.resume": ["admin"],
  "recurring.delete-unreferenced": ["admin"],
  "recurring.delete-referenced-409": ["admin"],
  "recurring.permission-denied": ["operator"],
  "recurring.failure": ["admin"],
  "sponsors.operator-safe-read": ["operator"],
  "sponsors.admin-mutation": ["admin"],
  "sponsors.operator-denied": ["operator"],
  "sponsors.conflict": ["admin"],
  "users.operator-read-only": ["operator"],
  "users.admin-create": ["admin"],
  "users.admin-edit": ["admin"],
  "users.admin-disable": ["admin"],
  "users.validation": ["admin"],
  "users.operator-403": ["operator"],
  "users.spoof-denial": ["operator"],
};
const REQUIRED_ROUTE_SET = [
  "/#/",
  "/#/inbox?intakeId=<id>",
  "/#/tasks?taskId=<id>&date=<date>&cardId=<id>&contextCardId=<id>",
  "/#/cards?cardId=<id>&taskId=<id>",
  "/#/assistants?assistantJobId=<id>",
  "/#/templates?templateId=<id>",
  "/#/recurring",
  "/#/artifacts",
  "/#/notifications",
  "/#/bookkeeping",
  "/#/sponsors?bookingId=<id>",
  "/#/newsletter",
  "/#/calendar",
  "/#/mailing-exports",
  "/#/processes",
  "/#/admin",
  "/#/users",
];
const ALLOWED_KINDS = new Set(["loading", "empty", "ready", "stale", "permission", "error"]);
const FORBIDDEN_EVIDENCE_TYPES = new Set(["api-only", "marker-only", "parity-only", "screenshot-only", "source-string"]);

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function literalTestDeclarations(source) {
  const declarations = [];
  const pattern = /\btest\s*\(\s*(["'`])([^\n]*?)\1\s*,/g;
  for (const match of source.matchAll(pattern)) {
    declarations.push({ title: match[2], index: match.index, declaration: match[0] });
  }
  return declarations;
}

function validatePointer(pointer, stateId) {
  assert.equal(pointer.type, matrix.evidencePolicy.acceptedType, `${stateId} has non-normal evidence type`);
  assert.ok(!FORBIDDEN_EVIDENCE_TYPES.has(pointer.type), `${stateId} uses forbidden evidence type ${pointer.type}`);
  assert.match(pointer.file, /^backend\/e2e\/[a-z0-9-]+\.spec\.js$/, `${stateId} must point into the normal E2E suite`);
  assert.doesNotMatch(pointer.file, /(?:^|\/)(?:api-|.*artifact|.*convergence|frontend-parity)/, `${stateId} points to a non-behavior spec class`);
  assert.ok(pointer.title && pointer.title.trim() === pointer.title, `${stateId} needs an exact non-empty test title`);
  assert.doesNotMatch(pointer.title, /(?:marker|source[- ]string|screenshot[- ]only|parity[- ]only|asset hash)/i, `${stateId} points to forbidden evidence by title`);

  const absolute = resolve(repoRoot, pointer.file);
  assert.ok(absolute.startsWith(`${repoRoot}${sep}`), `${stateId} pointer escapes the repository`);
  assert.ok(existsSync(absolute), `${stateId} evidence file does not exist: ${pointer.file}`);
  const source = readFileSync(absolute, "utf8");
  const declarations = literalTestDeclarations(source);
  const matches = declarations.filter((entry) => entry.title === pointer.title);
  assert.equal(matches.length, 1, `${stateId} title must resolve exactly once in ${pointer.file}: ${pointer.title}`);

  const current = matches[0];
  const next = declarations.find((entry) => entry.index > current.index);
  const testBody = source.slice(current.index, next?.index ?? source.length);
  assert.match(current.declaration + testBody.slice(current.declaration.length, current.declaration.length + 180), /async\s*\(\s*\{[^}]*\b(?:page|browser)\b/, `${stateId} is API-only rather than browser behavior`);
  assert.match(testBody, /\b(?:page\.(?:goto|locator|getByRole|getByText|reload)|newPage|portalPage)\s*\(/, `${stateId} does not drive browser behavior`);
  assert.match(testBody, /\bexpect\s*\(/, `${stateId} has no behavior assertion`);
  assert.doesNotMatch(testBody, /\b(?:page|context)\.route\s*\(|\broute\.(?:fulfill|abort)\s*\(/, `${stateId} uses forbidden browser request interception`);
  if (stateId.startsWith("assistants.")) {
    assert.doesNotMatch(testBody, /data-assistant-(?:save|lifecycle)|\/api\/assistant-jobs\/[^\s"'`]+\/(?:submit|run|approve|reject|retry|cancel)/, `${stateId} incorrectly counts assistant lifecycle mutation evidence owned by issue 158`);
  }
}

test("frontend capability matrix has the canonical schema, routes, APIs, roles, and states", () => {
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.contract, "canonical-frontend-capability-coverage");
  assert.equal(matrix.stateRoleSemantics, "A state inherits its capability roleIds unless the state declares a narrower roleIds array.");
  assert.equal(matrix.evidencePolicy.acceptedType, "normal-real-browser");
  assert.equal(matrix.evidencePolicy.browserInterceptionAllowed, false);
  assert.deepEqual(sorted(matrix.evidencePolicy.forbiddenTypes), sorted(FORBIDDEN_EVIDENCE_TYPES));

  assert.ok(Array.isArray(matrix.roles));
  assert.deepEqual(sorted(matrix.roles.map((role) => role.id)), sorted(REQUIRED_ROLES));
  for (const role of matrix.roles) assert.ok(role.description.length >= 12, `${role.id} needs a useful description`);

  assert.ok(Array.isArray(matrix.capabilities));
  assert.deepEqual(sorted(matrix.capabilities.map((capability) => capability.id)), sorted(Object.keys(REQUIRED)));
  assertUnique(matrix.capabilities.map((capability) => capability.id), "capability IDs");
  const stateIds = matrix.capabilities.flatMap((capability) => capability.states.map((state) => state.id));
  assertUnique(stateIds, "state IDs");

  for (const capability of matrix.capabilities) {
    const expected = REQUIRED[capability.id];
    assert.equal(capability.route, expected.route, `${capability.id} route drifted`);
    assert.ok(capability.surface.length >= 3, `${capability.id} needs a surface name`);
    assert.ok(Array.isArray(capability.apiBoundaries) && capability.apiBoundaries.length > 0, `${capability.id} needs an API boundary`);
    assertUnique(capability.apiBoundaries, `${capability.id} API boundaries`);
    assert.deepEqual(sorted(capability.apiBoundaries), sorted(REQUIRED_APIS[capability.id]), `${capability.id} API boundary coverage drifted`);
    assert.ok(Array.isArray(capability.roleIds) && capability.roleIds.length > 0, `${capability.id} needs roles`);
    assertUnique(capability.roleIds, `${capability.id} role IDs`);
    for (const roleId of capability.roleIds) assert.ok(REQUIRED_ROLES.includes(roleId), `${capability.id} has unknown role ${roleId}`);
    const expectedRoles = capability.id === "session" ? REQUIRED_ROLES : ["operator", "admin"];
    assert.deepEqual(sorted(capability.roleIds), sorted(expectedRoles), `${capability.id} role coverage drifted`);

    const expectedStateIds = expected.states.map((suffix) => `${capability.id}.${suffix}`);
    assert.deepEqual(sorted(capability.states.map((state) => state.id)), sorted(expectedStateIds), `${capability.id} state coverage drifted`);
    assertUnique(capability.states.map((state) => state.id), `${capability.id} state IDs`);
    for (const state of capability.states) {
      assert.ok(ALLOWED_KINDS.has(state.kind), `${state.id} has unknown state kind`);
      assert.ok(state.description.length >= 12, `${state.id} needs a useful behavior description`);
      const expectedStateRoles = REQUIRED_STATE_ROLE_OVERRIDES[state.id] ?? capability.roleIds;
      const effectiveStateRoles = state.roleIds ?? capability.roleIds;
      assert.ok(Array.isArray(effectiveStateRoles) && effectiveStateRoles.length > 0, `${state.id} needs effective roles`);
      assertUnique(effectiveStateRoles, `${state.id} role IDs`);
      for (const roleId of effectiveStateRoles) assert.ok(capability.roleIds.includes(roleId), `${state.id} role ${roleId} is outside its capability`);
      assert.deepEqual(sorted(effectiveStateRoles), sorted(expectedStateRoles), `${state.id} role-state coverage drifted`);
      if (!REQUIRED_STATE_ROLE_OVERRIDES[state.id]) assert.equal(state.roleIds, undefined, `${state.id} has a redundant or uncontracted role override`);
      assert.ok(state.coverage && ["covered", "gap"].includes(state.coverage.status), `${state.id} needs explicit coverage status`);
      if (state.coverage.status === "covered") {
        assert.ok(Array.isArray(state.coverage.evidence) && state.coverage.evidence.length > 0, `${state.id} needs evidence`);
        assert.equal(state.coverage.requiredBehavior, undefined, `${state.id} cannot be both covered and a gap`);
      } else {
        assert.equal(state.coverage.evidence, undefined, `${state.id} gap cannot claim evidence`);
        assert.ok(state.coverage.requiredBehavior?.length >= 20, `${state.id} gap needs an exact required behavior`);
      }
    }
  }

  const retainedRoutes = matrix.capabilities
    .filter((capability) => capability.route.startsWith("/#/") && capability.id !== "settings")
    .map((capability) => capability.route);
  assert.deepEqual(sorted(retainedRoutes), sorted(REQUIRED_ROUTE_SET), "all 17 retained routes must be classified exactly once");
  assert.ok(matrix.capabilities.find((capability) => capability.id === "home").states.some((state) => state.id === "home.ready"), "home.ready is the durable #161 evidence slot");
});

test("covered cells resolve to exact unique normal real-browser behavior tests", () => {
  const pointerKeys = [];
  for (const capability of matrix.capabilities) {
    for (const state of capability.states) {
      if (state.coverage.status !== "covered") continue;
      for (const pointer of state.coverage.evidence) {
        validatePointer(pointer, state.id);
        pointerKeys.push(`${state.id}\u0000${pointer.file}\u0000${pointer.title}`);
      }
    }
  }
  assertUnique(pointerKeys, "state evidence pointers");
});

test("matrix content is public-safe", () => {
  assert.doesNotMatch(matrixText, /https?:\/\//i, "matrix must not contain private or external links");
  assert.doesNotMatch(matrixText, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "matrix must not contain contact details");
  assert.doesNotMatch(matrixText, /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|aws_secret_access_key|client_secret|password\s*[=:]/i, "matrix must not contain credentials-adjacent material");
  assert.doesNotMatch(matrixText, /\.\.\/(?:dtc-operations|datatasks|podcast-assistant)|dataops-knowledge|recorder\.google|loom\.com/i, "matrix must not cross the public knowledge boundary");
  assert.doesNotMatch(matrixText, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, "matrix must not contain production-like identifiers");
});

test("local CI and both deployment workflow paths verify the SAM frontend immediately after build", () => {
  const verifier = "node backend/scripts/verify-frontend-artifact.mjs --source frontend --artifact .aws-sam/build/BackendFunction";
  const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");
  const verifyTarget = makefile.match(/^verify-sam-frontend:\s*\n((?:\t.*\n)+)/m);
  assert.ok(verifyTarget, "Makefile needs verify-sam-frontend target");
  assert.equal(verifyTarget[1].trim(), verifier, "verify-sam-frontend must inspect the actual BackendFunction artifact");
  const ciTarget = makefile.match(/^ci:\s*\n((?:\t.*\n)+)/m);
  assert.ok(ciTarget, "Makefile needs ci target");
  const ciCommands = ciTarget[1].trim().split("\n").map((line) => line.trim());
  // Both targets run the same frontend unit suite; test-frontend-coverage adds the c8 gate.
  const frontendUnitTargets = ["$(MAKE) test-frontend-unit", "$(MAKE) test-frontend-coverage"];
  assert.equal(ciCommands.filter((line) => frontendUnitTargets.includes(line)).length, 1, "make ci must run frontend unit tests exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) sam-build").length, 1, "make ci must build SAM exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) verify-sam-frontend").length, 1, "make ci must verify SAM exactly once");
  const makeBuild = ciCommands.indexOf("$(MAKE) sam-build");
  const makeVerify = ciCommands.indexOf("$(MAKE) verify-sam-frontend");
  assert.equal(makeVerify, makeBuild + 1, "make ci must verify immediately after sam-build");

  const workflow = readFileSync(resolve(repoRoot, ".github", "workflows", "deploy-dataops-v1.yml"), "utf8");
  function workflowJob(name, nextName) {
    const startMarker = `  ${name}:\n`;
    const start = workflow.indexOf(startMarker);
    assert.notEqual(start, -1, `workflow needs ${name} job`);
    const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + startMarker.length) : workflow.length;
    assert.notEqual(end, -1, `workflow needs ${nextName} job after ${name}`);
    return workflow.slice(start, end);
  }
  for (const [name, body] of [["checks", workflowJob("checks", "deploy")], ["deploy", workflowJob("deploy")]]) {
    const frontendUnitRuns = ["run: npm run test:frontend:unit", "run: npm run test:frontend:coverage"]
      .reduce((count, command) => count + body.split(command).length - 1, 0);
    assert.equal(frontendUnitRuns, 1, `${name} must run frontend unit tests exactly once`);
    const buildCommand = "run: make sam-build";
    const verifyCommand = `run: ${verifier}`;
    assert.equal(body.split(buildCommand).length - 1, 1, `${name} must build SAM exactly once`);
    assert.equal(body.split(verifyCommand).length - 1, 1, `${name} must verify the actual BackendFunction exactly once`);
    const buildAt = body.indexOf(buildCommand);
    const verifyAt = body.indexOf(verifyCommand);
    assert.ok(buildAt < verifyAt, `${name} must verify after SAM build`);
    const between = body.slice(buildAt + buildCommand.length, verifyAt);
    assert.doesNotMatch(between, /^\s*run:/m, `${name} must verify immediately after SAM build with no intervening command`);
    if (name === "deploy") {
      const deployAt = body.indexOf("sam deploy");
      assert.ok(deployAt > verifyAt, "deploy job must verify the SAM frontend before sam deploy");
    }
  }
});

test("every required state has accepted behavior evidence", () => {
  const gaps = matrix.capabilities.flatMap((capability) => capability.states)
    .filter((state) => state.coverage.status === "gap")
    .map((state) => `${state.id}: ${state.coverage.requiredBehavior}`);
  assert.deepEqual(gaps, [], `uncovered frontend capability states:\n${gaps.join("\n")}`);
});
