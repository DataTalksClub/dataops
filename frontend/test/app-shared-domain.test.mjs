import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import vm from "node:vm";

import * as workspace from "../src/core/workspace.js";
import {
  FakeDocument,
  findAllByClass,
  findByText,
} from "./support/fake-dom.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appSource = readFileSync(
  path.join(repoRoot, "frontend/src/app.js"),
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
  assert.ok(match, `production function ${name} must exist in app.js`);
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

function productionFunctions(names, globals = {}) {
  const declarations = names.map(functionSource).join("\n\n");
  return vm.runInNewContext(
    `(function () {\n${declarations}\nreturn { ${names.join(", ")} };\n})()`,
    globals,
  );
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const adapterNames = [
  "settledPayload",
  "bundlesFromWorkPayload",
  "usersFromWorkPayload",
  "recurringConfigsFromPayload",
  "assistantJobsFromPayload",
  "currentOperatorIdFromPayload",
];

const workModelNames = [
  "bundlesFromWorkPayload",
  "usersFromWorkPayload",
  "normalizeOperationsWorkSnapshot",
  "normalizeBundleTaskMap",
  "sortWorkTasks",
  "taskSortDate",
  "sortActiveWorkBundles",
];

describe("app shared operations domain characterization", () => {
  test("pins the remaining app-owned model, quality, reference, and surface boundaries", () => {
    const expected = [
      ...adapterNames,
      "normalizeOperationsRecurringSnapshot",
      ...workModelNames.slice(2),
      "operationItemFromTask",
      "operationItemFromBundle",
      "summarizeWorkflowTemplate",
      "buildOperationsReferenceLinks",
      "renderProcessQualityHomeSection",
      "renderOperationsRuntimeState",
      "renderOperationsLane",
      "renderOperationsReference",
    ];
    for (const name of new Set(expected)) functionSource(name);

    assert.match(
      appSource,
      /createHomeSurface\([\s\S]*buildOperationsReferenceLinks,[\s\S]*normalizeOperationsWorkSnapshot,/,
    );
    assert.match(
      appSource,
      /createTasksSurface\([\s\S]*operationItemFromBundle,[\s\S]*sortWorkTasks,/,
    );
    assert.match(
      appSource,
      /createKnowledgeSurface\([\s\S]*buildOperationsReferenceLinks,[\s\S]*renderQualityFindingRow,/,
    );
  });

  test("normalizes work API collection envelopes and authenticated operator ids", () => {
    const adapters = productionFunctions(adapterNames);
    const bundle = { id: "card-1" };
    const user = { id: "grace" };
    const recurring = { id: "weekly" };
    const job = { id: "job-1" };

    assert.equal(adapters.settledPayload({ status: "fulfilled", value: bundle }), bundle);
    assert.deepEqual(plain(adapters.settledPayload({ status: "rejected" })), {});
    assert.equal(adapters.bundlesFromWorkPayload({ bundles: [bundle] })[0], bundle);
    assert.equal(adapters.bundlesFromWorkPayload({ items: [bundle] })[0], bundle);
    assert.equal(adapters.usersFromWorkPayload({ users: [user] })[0], user);
    assert.equal(
      adapters.recurringConfigsFromPayload({ configs: [recurring] })[0],
      recurring,
    );
    assert.equal(adapters.assistantJobsFromPayload({ jobs: [job] })[0], job);
    assert.deepEqual(plain(adapters.assistantJobsFromPayload(null)), []);
    assert.equal(adapters.currentOperatorIdFromPayload({ user }), "grace");
    assert.equal(adapters.currentOperatorIdFromPayload({ actor: { id: 42 } }), "42");
    assert.equal(adapters.currentOperatorIdFromPayload({ id: "alexey" }), "alexey");
    assert.equal(adapters.currentOperatorIdFromPayload({}), "");
  });

  test("creates honest empty snapshots for each independently loaded source", () => {
    const snapshots = productionFunctions([
      "emptyOperationsWorkSnapshot",
      "emptyOperationsRecurringSnapshot",
      "emptyOperationsArtifactSnapshot",
      "emptyOperationsAssistantSnapshot",
      "emptyOperationsQualitySnapshot",
    ]);

    assert.deepEqual(plain(snapshots.emptyOperationsWorkSnapshot()), {
      loaded: false,
      currentOperatorId: "",
      todayTasks: [],
      overdueTasks: [],
      waitingTasks: [],
      bundles: [],
      users: [],
      bundleTasks: {},
      errors: [],
      todayLoaded: false,
      overdueLoaded: false,
      waitingLoaded: false,
      bundlesLoaded: false,
      usersLoaded: false,
    });
    assert.deepEqual(plain(snapshots.emptyOperationsRecurringSnapshot()), {
      loaded: false,
      recurringConfigs: [],
      errors: [],
    });
    assert.deepEqual(plain(snapshots.emptyOperationsArtifactSnapshot()), {
      loaded: false,
      artifacts: [],
      errors: [],
    });
    assert.deepEqual(plain(snapshots.emptyOperationsAssistantSnapshot()), {
      loaded: false,
      jobs: [],
      errors: [],
    });
    assert.equal(snapshots.emptyOperationsQualitySnapshot().summary.total, 0);
    assert.deepEqual(plain(snapshots.emptyOperationsQualitySnapshot().validationErrors), []);
  });

  test("sorts recurring configs into enabled and disabled operational states", () => {
    const model = productionFunctions(
      [
        "recurringConfigsFromPayload",
        "normalizeOperationsRecurringSnapshot",
      ],
      {
        recurringConfigTitle: (config) => config.title,
      },
    ).normalizeOperationsRecurringSnapshot({
      loaded: true,
      configs: [
        { id: "off", title: "Alpha", enabled: false },
        { id: "on-z", title: "Zulu" },
        { id: "on-a", title: "Beta", enabled: true },
        null,
      ],
      errors: ["partial source"],
    });

    assert.deepEqual(model.configs.map((config) => config.id), [
      "on-a",
      "on-z",
      "off",
    ]);
    assert.deepEqual(model.enabled.map((config) => config.id), ["on-a", "on-z"]);
    assert.deepEqual(model.disabled.map((config) => config.id), ["off"]);
    assert.deepEqual(plain(model.errors), ["partial source"]);
  });

  test("derives per-lane work state, counts, maps, ordering, and partial truth", () => {
    const functions = productionFunctions(workModelNames, { ...workspace });
    const snapshot = functions.normalizeOperationsWorkSnapshot(
      {
        loaded: true,
        todayLoaded: true,
        overdueLoaded: false,
        waitingLoaded: true,
        bundlesLoaded: true,
        usersLoaded: false,
        currentOperatorId: "alexey",
        tasks: [
          { id: "today", title: "Today", date: "2026-08-13", status: "todo", bundleId: "card-1" },
          { id: "late", title: "Late", date: "2026-08-11", status: "todo", bundleId: "card-1" },
          { id: "wait", title: "Waiting", status: "waiting", followUpAt: "2026-08-13" },
          { id: "done", title: "Done", date: "2026-08-13", status: "done" },
        ],
        todayTasks: [{ id: "today", title: "Today", date: "2026-08-13" }],
        bundleTasks: {
          "card-1": [{ id: "today", title: "Today", date: "2026-08-13" }],
        },
        bundles: [
          { id: "card-1", title: "Risk card", status: "active", anchorDate: "2026-08-14" },
          { id: "archived", title: "Old", status: "archived" },
        ],
        users: [{ id: "alexey", name: "Alexey" }],
        todayTaskCount: 9,
        errors: ["overdue unavailable"],
      },
      { today: "2026-08-13" },
    );

    assert.equal(snapshot.todayLoaded, true);
    assert.equal(snapshot.overdueLoaded, false);
    assert.equal(snapshot.todayTaskCount, 9);
    assert.deepEqual(snapshot.todayTasks.map((task) => task.id), ["today"]);
    assert.deepEqual(snapshot.overdueTasks.map((task) => task.id), ["late"]);
    assert.deepEqual(snapshot.waitingTasks.map((task) => task.id), ["wait"]);
    assert.deepEqual(snapshot.activeBundles.map((card) => card.id), ["card-1"]);
    assert.equal(snapshot.bundlesById.get("card-1").title, "Risk card");
    assert.equal(snapshot.usersById.get("alexey").name, "Alexey");
    assert.deepEqual(snapshot.bundleTasks["card-1"].map((task) => task.id), [
      "today",
      "late",
    ]);
    assert.deepEqual(plain(snapshot.errors), ["overdue unavailable"]);
  });

  test("maps Tasks and Cards to operator-facing source, proof, risk, and next actions", () => {
    const functions = productionFunctions(
      [
        "labelizeWorkValue",
        "taskSourceLabel",
        "taskNextActionLabel",
        "operationItemFromTask",
        "operationItemFromBundle",
      ],
      {
        ...workspace,
        resolveAssigneeLabel: (id) => ({ grace: "Grace" })[id] || id,
      },
    );
    const waiting = {
      id: "task-1",
      title: "Confirm guest",
      status: "waiting",
      waitingFor: "speaker reply",
      followUpAt: "2026-08-13",
      date: "2026-08-12",
      source: "email_intake",
      assigneeId: "grace",
      bundleId: "card-1",
    };
    const item = functions.operationItemFromTask(waiting, {
      today: "2026-08-13",
      waiting: true,
    });
    assert.equal(item.title, "Confirm guest");
    assert.equal(item.summary, "Waiting for speaker reply; follow up Today");
    assert.equal(item.nextAction, "Follow up");
    assert.equal(item.risk, "medium");
    assert.match(item.meta, /Card - Email Intake - Owner Grace/);

    assert.equal(
      functions.taskNextActionLabel(
        { id: "proof", requiresFile: true },
        "2026-08-13",
      ),
      "Attach file",
    );
    assert.equal(functions.taskSourceLabel({ recurringConfigId: "weekly" }), "Recurring");
    assert.equal(functions.taskSourceLabel({ templateId: "podcast" }), "Card");
    assert.equal(functions.taskSourceLabel({}), "Ad hoc");

    const card = functions.operationItemFromBundle(
      { id: "card-1", title: "Podcast", stage: "preparation", anchorDate: "2026-08-14" },
      [waiting],
      { today: "2026-08-13" },
    );
    assert.equal(card.title, "Podcast");
    assert.equal(card.stage, "preparation");
    assert.match(card.summary, /Preparation - Anchor Tomorrow/);
  });

  test("projects Template and Process Doc vocabulary without duplicate operation rows", () => {
    const functions = productionFunctions(
      [
        "labelizeWorkValue",
        "normalizeTemplateMatchValue",
        "isWorkflowTemplateDoc",
        "summarizeWorkflowTemplate",
        "workflowSlugFromDoc",
        "isRecurringWorkflowSlug",
        "isAtRiskWorkflowSlug",
        "isFollowUpDoc",
        "operationItemFromTemplate",
        "operationItemFromDoc",
        "dedupeOperationItems",
      ],
      {
        basename: (value) => String(value).split("/").pop(),
        cleanPath: (value) => String(value).replace(/^\/+/, ""),
      },
    );
    const template = functions.summarizeWorkflowTemplate({
      path: "tasks/templates/newsletter.md",
      title: "Newsletter Task Template",
      summary: "Weekly send",
      tags: ["task-template", "email"],
    });
    assert.deepEqual(plain(template), {
      title: "Newsletter",
      summary: "Weekly send",
      path: "tasks/templates/newsletter.md",
      slug: "newsletter",
      tags: ["email"],
      recurring: true,
      atRisk: true,
    });
    assert.equal(functions.normalizeTemplateMatchValue("Email & Review Task Template"), "email-and-review");
    assert.equal(functions.isWorkflowTemplateDoc({ doc_type: "task-template", path: "x.md" }), true);
    assert.equal(functions.isFollowUpDoc({ title: "Waiting for reply", path: "notes/a.md" }), true);
    assert.equal(functions.isFollowUpDoc({ ...template, doc_type: "task-template" }), false);
    const projected = functions.operationItemFromTemplate(template);
    assert.equal(projected.meta, "Recurring · Watch");
    assert.deepEqual(
      plain(
        functions
          .dedupeOperationItems([
            projected,
            { ...projected, title: "Duplicate" },
            functions.operationItemFromDoc(
              { path: "notes/a.md", title: "A" },
              "Process Doc",
            ),
          ])
          .map((item) => item.title),
      ),
      ["Newsletter", "A"],
    );
  });

  test("builds curated internal Process references before public planning references", () => {
    const { buildOperationsReferenceLinks } = productionFunctions(
      ["buildOperationsReferenceLinks"],
      { basename: (value) => String(value).split("/").pop() },
    );
    const references = buildOperationsReferenceLinks([
      {
        path: "content/tasks/templates/newsletter.md",
        title: "Newsletter template",
        summary: "Internal process",
      },
      {
        path: "content/overview/reference/schedule.md",
        title: "Schedule",
      },
      { path: "content/unrelated.md", title: "Do not include" },
    ]);
    assert.deepEqual(
      plain(references.slice(0, 2).map((reference) => reference.title)),
      ["Newsletter template", "Schedule"],
    );
    assert.equal(references.length, 6);
    assert.equal(references[2].title, "DataOps V1 Goal");
    assert.equal(references.at(-1).title, "Merge Plan");
    assert.ok(references.slice(2).every((reference) => reference.summary === "Planning reference"));
  });

  test("keeps surface titles, descriptions, counts, and connection status honest", () => {
    const functions = productionFunctions(
      [
        "operationsViewTitle",
        "operationsViewPath",
        "surfaceDescription",
        "countLabel",
        "referenceCountLabel",
        "surfaceStatusText",
      ],
      {
        operationsAssistantSnapshot: { loaded: true, jobs: [{}, {}] },
        operationsArtifactSnapshot: { loaded: false, artifacts: [] },
        operationsQualitySnapshot: { loaded: true, findings: [{}] },
        tasksSectionTitle: workspace.tasksSectionTitle,
      },
    );
    assert.equal(functions.operationsViewTitle("home"), "Today");
    assert.equal(functions.operationsViewTitle("tasks", "templates"), "Tasks - Templates");
    assert.equal(functions.operationsViewPath("docs"), "Docs");
    assert.equal(functions.operationsViewPath("calendar"), "Workspace");
    assert.match(functions.surfaceDescription("queue"), /overdue, follow-up, waiting/);
    assert.equal(functions.referenceCountLabel("calendar", 1), "1 calendar item");
    assert.equal(functions.referenceCountLabel("bundles", 2), "2 bundles");
    assert.equal(functions.surfaceStatusText("assistants"), "2 assistant jobs.");
    assert.equal(functions.surfaceStatusText("artifacts"), "Artifact index not connected.");
    assert.equal(functions.surfaceStatusText("processes"), "1 process quality finding.");
    assert.equal(functions.surfaceStatusText("search"), "Unified operator search.");
  });

  test("renders accessible honest states, lanes, references, and quality actions", async () => {
    const document = new FakeDocument();
    const opened = [];
    const functions = productionFunctions(
      [
        "labelizeWorkValue",
        "renderSurfaceHeader",
        "renderHonestState",
        "renderOperationsRuntimeState",
        "renderOperationsLane",
        "renderOperationsLaneItem",
        "renderOperationsReference",
        "renderQualityFindingRow",
        "openQualityFinding",
      ],
      {
        document,
        openBundlePanel: (id) => opened.push(["card", id]),
        openDocument: (docPath) => opened.push(["doc", docPath]),
        openTaskPanel: (id) => opened.push(["task", id]),
        resolveDocReference: () => null,
        showWorkspaceSurface: (view) => opened.push(["surface", view]),
      },
    );
    const header = functions.renderSurfaceHeader("Cards", "Open work");
    assert.equal(header.className, "ops-surface-header");
    assert.equal(findByText(header, "Cards", "h3").textContent, "Cards");
    assert.equal(functions.renderHonestState("Unavailable", "Retry later").textContent, "UnavailableRetry later");

    assert.equal(functions.renderOperationsRuntimeState({ connected: true, errors: [] }), null);
    const partial = functions.renderOperationsRuntimeState({
      connected: true,
      errors: ["Cards unavailable", "", "Tasks unavailable"],
    });
    assert.equal(partial.getAttribute("aria-label"), "Runtime data state");
    assert.match(partial.textContent, /partially unavailable/);
    assert.equal(partial.querySelectorAll("li").length, 2);

    const lane = functions.renderOperationsLane({
      id: "today",
      title: "Due today",
      empty: "Nothing due",
      items: [
        { title: "Task", summary: "Ready", meta: "Todo", taskId: "task-1", risk: "high" },
      ],
    });
    assert.equal(lane.getAttribute("aria-label"), null);
    const laneButton = findAllByClass(lane, "ops-lane-item")[0];
    assert.equal(laneButton.classList.contains("ops-risk-high"), true);
    await laneButton.click();
    assert.deepEqual(opened.pop(), ["task", "task-1"]);

    const reference = functions.renderOperationsReference({
      title: "Process",
      summary: "Internal",
      path: "process.md",
    });
    await reference.click();
    assert.deepEqual(opened.pop(), ["doc", "process.md"]);

    const finding = functions.renderQualityFindingRow({
      title: "Missing proof guidance",
      severity: "blocking",
      category: "proof",
      taskId: "task-2",
      nextAction: "Add proof",
    });
    assert.equal(finding.classList.contains("ops-quality-blocking"), true);
    assert.match(finding.textContent, /Missing proof guidanceBlockingproof/);
    await finding.click();
    assert.deepEqual(opened.pop(), ["task", "task-2"]);
  });

  test("retains isolated browser coverage for assembled Home, Tasks, errors, and mobile safety", () => {
    assert.match(
      browserCharacterization,
      /shell, Home, and account scope retain their primary DOM and interactions/,
    );
    assert.match(
      browserCharacterization,
      /Cards, archive, card detail, and nested Task restore their canonical URLs/,
    );
    assert.match(
      browserCharacterization,
      /retained top-level surfaces keep canonical route, title, marker, and primary interaction/,
    );
    assert.match(browserCharacterization, /expect\(errors\)\.toEqual\(\[\]\)/);
    assert.match(
      browserCharacterization,
      /all retained routes avoid page overflow and runtime errors at mobile width/,
    );
  });
});
