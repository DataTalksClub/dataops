import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

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
    states: ["empty", "active", "staged", "completed", "template-update-review", "template-update-conflict", "deep-link-return", "mismatch", "not-found", "failure"],
  },
  templates: {
    route: "/#/templates?templateId=<id>",
    states: ["read-only", "source-revision", "create-card", "reviewed-card-batch", "method-not-allowed", "failure", "stale-not-found"],
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
    states: [
      "loading",
      "empty",
      "filters.url-reload-clear-search",
      "result-detail",
      "create-read-edit",
      "draft-management",
      "partial-save-failure",
      "backlinks",
      "validation",
      "git-failure",
      "unavailable",
    ],
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

test("frontend capability matrix has the canonical schema, routes, APIs, roles, and states", () => {
  assert.equal(matrix.schemaVersion, 2);
  assert.equal(matrix.contract, "canonical-frontend-capability-coverage");
  assert.equal(matrix.stateRoleSemantics, "A state with roleIds requires passing evidence for every listed role; otherwise one passing role inherited from the capability is sufficient.");
  assert.equal(matrix.evidencePolicy.acceptedType, "same-run-playwright-annotation");
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
      assert.deepEqual(state.coverage, { status: "runtime" }, `${state.id} must be completed by same-run browser evidence`);
    }
  }

  const retainedRoutes = matrix.capabilities
    .filter((capability) => capability.route.startsWith("/#/") && capability.id !== "settings")
    .map((capability) => capability.route);
  assert.deepEqual(sorted(retainedRoutes), sorted(REQUIRED_ROUTE_SET), "all 17 retained routes must be classified exactly once");
  assert.ok(matrix.capabilities.find((capability) => capability.id === "home").states.some((state) => state.id === "home.ready"), "home.ready is the durable #161 evidence slot");
});

test("catalog coverage carries no file, title, selector, or source identity", () => {
  const forbiddenIdentityKeys = new Set(["file", "fileName", "line", "selector", "source", "sourcePath", "spec", "testTitle", "title"]);
  for (const capability of matrix.capabilities) {
    for (const state of capability.states) {
      assert.deepEqual(Object.keys(state.coverage), ["status"], `${state.id} coverage must contain no test identity`);
      assert.deepEqual(state.coverage, { status: "runtime" });
    }
  }
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!forbiddenIdentityKeys.has(key), `catalog contains forbidden evidence identity key ${key}`);
      visit(nested);
    }
  };
  visit(matrix);
});

test("matrix content is public-safe", () => {
  assert.doesNotMatch(matrixText, /https?:\/\//i, "matrix must not contain private or external links");
  assert.doesNotMatch(matrixText, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "matrix must not contain contact details");
  assert.doesNotMatch(matrixText, /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|aws_secret_access_key|client_secret|password\s*[=:]/i, "matrix must not contain credentials-adjacent material");
  assert.doesNotMatch(matrixText, /\.\.\/(?:dtc-operations|datatasks|podcast-assistant)|dataops-knowledge|recorder\.google|loom\.com/i, "matrix must not cross the public knowledge boundary");
  assert.doesNotMatch(matrixText, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, "matrix must not contain production-like identifiers");
});

test("local CI and the deployment workflow gate the exact SAM frontend artifact without rebuilding", () => {
  const verifier = "node backend/scripts/verify-frontend-artifact.mjs --source frontend --artifact .aws-sam/build/BackendFunction";
  const runtimeVerifier = "node backend/scripts/verify-runtime-boundary.mjs .aws-sam/build/BackendFunction";
  const isolationTest = "node --test backend/scripts/frontend-artifact.test.mjs";
  const makefile = readFileSync(resolve(repoRoot, "Makefile"), "utf8");
  const verifyTarget = makefile.match(/^verify-sam-frontend:\s*\n((?:\t.*\n)+)/m);
  assert.ok(verifyTarget, "Makefile needs verify-sam-frontend target");
  assert.equal(verifyTarget[1].trim(), verifier, "verify-sam-frontend must inspect the actual BackendFunction artifact");
  const runtimeTarget = makefile.match(/^verify-sam-runtime-boundary:\s*\n((?:\t.*\n)+)/m);
  assert.ok(runtimeTarget, "Makefile needs verify-sam-runtime-boundary target");
  assert.equal(runtimeTarget[1].trim(), runtimeVerifier, "runtime boundary must inspect the actual BackendFunction artifact");
  const isolationTarget = makefile.match(/^test-sam-frontend-isolation:\s*\n((?:\t.*\n)+)/m);
  assert.ok(isolationTarget, "Makefile needs test-sam-frontend-isolation target");
  assert.equal(isolationTarget[1].trim(), isolationTest, "frontend isolation must consume the existing artifact without rebuilding");
  for (const target of [verifyTarget[1], runtimeTarget[1], isolationTarget[1]]) {
    assert.doesNotMatch(target, /sam build|npm (?:ci|install)|migrat|import|restore|backfill/i, "artifact gates must not rebuild, install, or run data-movement tooling");
  }
  const ciTarget = makefile.match(/^ci:\s*\n((?:\t.*\n)+)/m);
  assert.ok(ciTarget, "Makefile needs ci target");
  const ciCommands = ciTarget[1].trim().split("\n").map((line) => line.trim());
  // Both targets run the same frontend unit suite; test-frontend-coverage adds the c8 gate.
  const frontendUnitTargets = ["$(MAKE) test-frontend-unit", "$(MAKE) test-frontend-coverage"];
  assert.equal(ciCommands.filter((line) => frontendUnitTargets.includes(line)).length, 1, "make ci must run frontend unit tests exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) sam-build").length, 1, "make ci must build SAM exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) verify-sam-frontend").length, 1, "make ci must verify SAM exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) verify-sam-runtime-boundary").length, 1, "make ci must verify the runtime boundary exactly once");
  assert.equal(ciCommands.filter((line) => line === "$(MAKE) test-sam-frontend-isolation").length, 1, "make ci must run frontend isolation exactly once");
  const makeBuild = ciCommands.indexOf("$(MAKE) sam-build");
  const makeVerify = ciCommands.indexOf("$(MAKE) verify-sam-frontend");
  const makeRuntime = ciCommands.indexOf("$(MAKE) verify-sam-runtime-boundary");
  const makeIsolation = ciCommands.indexOf("$(MAKE) test-sam-frontend-isolation");
  assert.equal(makeVerify, makeBuild + 1, "make ci must verify immediately after sam-build");
  assert.equal(makeRuntime, makeVerify + 1, "make ci must run the runtime boundary after frontend verification");
  assert.equal(makeIsolation, makeRuntime + 1, "make ci must run isolation after the static artifact gates");

  const workflow = readFileSync(resolve(repoRoot, ".github", "workflows", "deploy-dataops-v1.yml"), "utf8");
  function workflowJob(name, nextName) {
    const startMarker = `  ${name}:\n`;
    const start = workflow.indexOf(startMarker);
    assert.notEqual(start, -1, `workflow needs ${name} job`);
    const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + startMarker.length) : workflow.length;
    assert.notEqual(end, -1, `workflow needs ${nextName} job after ${name}`);
    return workflow.slice(start, end);
  }
  const buildCommand = "run: make sam-build";
  const verifyCommand = "run: make verify-sam-frontend";
  const runtimeCommand = "run: make verify-sam-runtime-boundary";
  const isolationCommand = "run: make test-sam-frontend-isolation";
  const checks = workflowJob("checks", "deploy");
  const deploy = workflowJob("deploy");

  // The SAM artifact is built once, on the deploy path, because that build is
  // the one that ships. The guard therefore has to sit in the deploy job: a
  // check that only runs off the critical path proves nothing about what is
  // deployed. The checks job keeps template validation so a malformed template
  // still fails before deploy.
  const frontendUnitRuns = ["run: npm run test:frontend:unit", "run: npm run test:frontend:coverage"]
    .reduce((count, command) => count + checks.split(command).length - 1, 0);
  assert.equal(frontendUnitRuns, 1, "checks must run frontend unit tests exactly once");
  assert.match(checks, /run: make sam-validate/, "checks must validate the SAM template");
  assert.equal(checks.split(buildCommand).length - 1, 0, "checks must not duplicate the deploy job's SAM build");
  assert.equal(checks.split(verifyCommand).length - 1, 0, "checks must not verify an artifact it does not build");
  assert.equal(checks.split(runtimeCommand).length - 1, 0, "checks must not inspect a runtime artifact it does not build");
  assert.equal(checks.split(isolationCommand).length - 1, 0, "checks must not test an artifact it does not build");

  assert.equal(deploy.split(buildCommand).length - 1, 1, "deploy must build SAM exactly once");
  assert.equal(deploy.split(verifyCommand).length - 1, 1, "deploy must verify the actual BackendFunction exactly once");
  assert.equal(deploy.split(runtimeCommand).length - 1, 1, "deploy must verify the actual BackendFunction runtime boundary exactly once");
  assert.equal(deploy.split(isolationCommand).length - 1, 1, "deploy must run the actual BackendFunction isolation contract exactly once");
  const buildAt = deploy.indexOf(buildCommand);
  const verifyAt = deploy.indexOf(verifyCommand);
  const runtimeAt = deploy.indexOf(runtimeCommand);
  const isolationAt = deploy.indexOf(isolationCommand);
  assert.ok(buildAt < verifyAt, "deploy must verify after SAM build");
  const between = deploy.slice(buildAt + buildCommand.length, verifyAt);
  assert.doesNotMatch(between, /^\s*run:/m, "deploy must verify immediately after SAM build with no intervening command");
  assert.ok(verifyAt < runtimeAt && runtimeAt < isolationAt, "deploy must run static, runtime, then isolation gates in order");
  const deployAt = deploy.indexOf("sam deploy");
  assert.ok(deployAt > isolationAt, "deploy job must finish every artifact gate before sam deploy");
});

test("runtime completeness stays in the one independent Playwright run", () => {
  const e2eWorkflow = yaml.load(readFileSync(resolve(repoRoot, ".github", "workflows", "validate-backend-e2e.yml"), "utf8"));
  const deployWorkflow = yaml.load(readFileSync(resolve(repoRoot, ".github", "workflows", "deploy-dataops-v1.yml"), "utf8"));
  const backendPackage = JSON.parse(readFileSync(resolve(repoRoot, "backend", "package.json"), "utf8"));
  const commands = (workflow) => Object.values(workflow.jobs || {})
    .flatMap((job) => job.steps || [])
    .flatMap((step) => typeof step.run === "string" ? [step.run.trim()] : []);

  const e2eCommands = commands(e2eWorkflow);
  assert.equal(e2eCommands.filter((command) => command === "npm --prefix backend run test:e2e").length, 1, "independent E2E must invoke the full backend browser command once");
  assert.equal(e2eCommands.filter((command) => /playwright\s+test/.test(command)).length, 0, "workflow must not add a second direct Playwright invocation");
  assert.equal(backendPackage.scripts["test:e2e"], "DATAOPS_CAPABILITY_COVERAGE=1 npx playwright test");
  assert.doesNotMatch(backendPackage.scripts["test:e2e"], /--list|\.spec\.|&&\s*(?:npx|npm).*playwright/);

  const deployCommands = commands(deployWorkflow).join("\n");
  assert.doesNotMatch(deployCommands, /playwright|test:e2e|DATAOPS_CAPABILITY_COVERAGE/i, "deploy must stay independent of browser coverage");
  const uploads = Object.values(e2eWorkflow.jobs || {})
    .flatMap((job) => job.steps || [])
    .filter((step) => step.uses === "actions/upload-artifact@v4");
  assert.ok(uploads.some((step) => /backend\/playwright-report\/[\s\S]*backend\/test-results\//.test(step.with?.path || "")), "independent E2E failure upload must retain both reports and result evidence");
});
