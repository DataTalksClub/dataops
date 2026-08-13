import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import * as workspace from "../src/core/workspace.js";
import {
  assistantJobsFromPayload,
  cardsFromWorkPayload,
  createOperationsModel,
  currentOperatorIdFromPayload,
  emptyOperationsArtifactSnapshot,
  emptyOperationsAssistantSnapshot,
  emptyOperationsQualitySnapshot,
  emptyOperationsRecurringSnapshot,
  emptyOperationsWorkSnapshot,
  labelizeWorkValue,
  normalizeTemplateMatchValue,
  recurringConfigsFromPayload,
  settledPayload,
  usersFromWorkPayload,
} from "../src/core/operations-model.js";
import { createOperationsOverview } from "../src/surfaces/operations-overview.js";
import {
  FakeDocument,
  findAllByClass,
  findByText,
} from "./support/fake-dom.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const applicationSource = readFileSync(
  path.join(repoRoot, "frontend/src/runtime/application.js"),
  "utf8",
);
const operationsModelSource = readFileSync(
  path.join(repoRoot, "frontend/src/core/operations-model.js"),
  "utf8",
);
const operationsOverviewSource = readFileSync(
  path.join(repoRoot, "frontend/src/surfaces/operations-overview.js"),
  "utf8",
);
const canonicalTask = (task) => ({ version: 1, taskHistory: [], status: "todo", ...task });
const browserCharacterization = readFileSync(
  path.join(
    repoRoot,
    "backend/e2e/frontend-module-characterization.spec.js",
  ),
  "utf8",
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const adapterNames = [
  "settledPayload",
  "cardsFromWorkPayload",
  "usersFromWorkPayload",
  "recurringConfigsFromPayload",
  "assistantJobsFromPayload",
  "currentOperatorIdFromPayload",
];

const workModelNames = [
  "cardsFromWorkPayload",
  "usersFromWorkPayload",
  "normalizeOperationsWorkSnapshot",
  "normalizeCardTaskMap",
  "sortWorkTasks",
  "taskSortDate",
  "sortActiveWorkCards",
];

function operationsModel(overrides = {}) {
  return {
    normalizeTemplateMatchValue,
    ...createOperationsModel({
      basename: (value) => String(value).split("/").pop(),
      cleanPath: (value) => String(value).replace(/^\/+/, ""),
      getRecurringConfigTitle: (config) => config.title,
      resolveAssigneeLabel: (id) => ({ grace: "Grace" })[id] || id,
      ...overrides,
    }),
  };
}

describe("app shared operations domain characterization", () => {
  test("pins the remaining app-owned model, quality, reference, and surface boundaries", () => {
    const appOwned = [
      "normalizeOperationsRecurringSnapshot",
      "operationItemFromTask",
      "operationItemFromCard",
      "summarizeWorkflowTemplate",
      "buildOperationsReferenceLinks",
      "renderProcessQualityHomeSection",
      "renderOperationsRuntimeState",
      "renderOperationsLane",
      "renderOperationsReference",
    ];
    for (const name of appOwned.slice(5)) {
      assert.match(
        operationsOverviewSource,
        new RegExp(`function\\s+${name}\\b|\\b${name},`),
      );
    }

    for (const name of [...adapterNames, ...workModelNames.slice(2)]) {
      assert.match(
        operationsModelSource,
        new RegExp(`(?:export\\s+)?function\\s+${name}\\b|\\b${name},`),
      );
    }

    assert.match(
      applicationSource,
      /from "\.\.\/core\/operations-model\.js"/,
    );
    assert.match(
      applicationSource,
      /createTasksSurface\([\s\S]*operationItemFromCard,[\s\S]*sortWorkTasks,/,
    );
    assert.match(
      applicationSource,
      /createKnowledgeSurface\([\s\S]*buildOperationsReferenceLinks,[\s\S]*renderQualityFindingRow,/,
    );
  });

  test("normalizes work API collection envelopes and authenticated operator ids", () => {
    const card = { id: "card-1" };
    const user = { id: "grace" };
    const recurring = { id: "weekly" };
    const job = { id: "job-1" };

    assert.equal(settledPayload({ status: "fulfilled", value: card }), card);
    assert.deepEqual(plain(settledPayload({ status: "rejected" })), {});
    assert.equal(cardsFromWorkPayload({ cards: [card] })[0], card);
    assert.equal(cardsFromWorkPayload({ items: [card] })[0], card);
    assert.equal(usersFromWorkPayload({ users: [user] })[0], user);
    assert.equal(
      recurringConfigsFromPayload({ configs: [recurring] })[0],
      recurring,
    );
    assert.equal(assistantJobsFromPayload({ jobs: [job] })[0], job);
    assert.deepEqual(assistantJobsFromPayload(null), []);
    assert.equal(currentOperatorIdFromPayload({ user }), "grace");
    assert.equal(currentOperatorIdFromPayload({ actor: { id: 42 } }), "42");
    assert.equal(currentOperatorIdFromPayload({ id: "alexey" }), "alexey");
    assert.equal(currentOperatorIdFromPayload({}), "");
  });

  test("creates honest empty snapshots for each independently loaded source", () => {
    assert.deepEqual(emptyOperationsWorkSnapshot(), {
      loaded: false,
      currentOperatorId: "",
      todayTasks: [],
      overdueTasks: [],
      waitingTasks: [],
      cards: [],
      users: [],
      cardTasks: {},
      errors: [],
      todayLoaded: false,
      overdueLoaded: false,
      waitingLoaded: false,
      cardsLoaded: false,
      usersLoaded: false,
    });
    assert.deepEqual(emptyOperationsRecurringSnapshot(), {
      loaded: false,
      recurringConfigs: [],
      errors: [],
    });
    assert.deepEqual(emptyOperationsArtifactSnapshot(), {
      loaded: false,
      artifacts: [],
      errors: [],
    });
    assert.deepEqual(emptyOperationsAssistantSnapshot(), {
      loaded: false,
      jobs: [],
      errors: [],
    });
    assert.equal(emptyOperationsQualitySnapshot().summary.total, 0);
    assert.deepEqual(emptyOperationsQualitySnapshot().validationErrors, []);
  });

  test("sorts recurring configs into enabled and disabled operational states", () => {
    const model = operationsModel().normalizeOperationsRecurringSnapshot({
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
    const functions = operationsModel();
    const snapshot = functions.normalizeOperationsWorkSnapshot(
      {
        loaded: true,
        todayLoaded: true,
        overdueLoaded: false,
        waitingLoaded: true,
        cardsLoaded: true,
        usersLoaded: false,
        currentOperatorId: "alexey",
        tasks: [
          canonicalTask({ id: "today", title: "Today", date: "2026-08-13", cardId: "card-1" }),
          canonicalTask({ id: "late", title: "Late", date: "2026-08-11", cardId: "card-1" }),
          canonicalTask({ id: "wait", title: "Waiting", status: "waiting", followUpAt: "2026-08-13" }),
          canonicalTask({ id: "done", title: "Done", date: "2026-08-13", status: "done" }),
        ],
        todayTasks: [canonicalTask({ id: "today", title: "Today", date: "2026-08-13" })],
        cardTasks: {
          "card-1": [canonicalTask({ id: "today", title: "Today", date: "2026-08-13" })],
        },
        cards: [
          { id: "card-1", version: 1, title: "Risk card", status: "active", stage: "preparation", taskCount: 2, openTaskCount: 2, anchorDate: "2026-08-14" },
          { id: "archived", version: 2, title: "Old", status: "archived", stage: "done", taskCount: 1, openTaskCount: 0, completedAt: "2026-08-01T12:00:00.000Z", completedBy: "alexey", activeStageBeforeCompletion: "preparation" },
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
    assert.deepEqual(snapshot.activeCards.map((card) => card.id), ["card-1"]);
    assert.equal(snapshot.cardsById.get("card-1").title, "Risk card");
    assert.equal(snapshot.usersById.get("alexey").name, "Alexey");
    assert.deepEqual(snapshot.cardTasks["card-1"].map((task) => task.id), [
      "today",
      "late",
    ]);
    assert.deepEqual(plain(snapshot.errors), ["overdue unavailable"]);
  });

  test("maps Tasks and Cards to operator-facing source, proof, risk, and next actions", () => {
    const functions = operationsModel();
    const waiting = {
      version: 1,
      taskHistory: [],
      id: "task-1",
      title: "Confirm guest",
      status: "waiting",
      waitingFor: "speaker reply",
      followUpAt: "2026-08-13",
      date: "2026-08-12",
      source: "email_intake",
      assigneeId: "grace",
      cardId: "card-1",
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
        canonicalTask({ id: "proof", requiresFile: true }),
        "2026-08-13",
      ),
      "Attach file",
    );
    assert.equal(functions.taskSourceLabel({ recurringConfigId: "weekly" }), "Recurring");
    assert.equal(functions.taskSourceLabel({ templateId: "podcast" }), "Card");
    assert.equal(functions.taskSourceLabel({}), "Ad hoc");

    const card = functions.operationItemFromCard(
      { id: "card-1", title: "Podcast", stage: "preparation", anchorDate: "2026-08-14" },
      [waiting],
      { today: "2026-08-13" },
    );
    assert.equal(card.title, "Podcast");
    assert.equal(card.stage, "preparation");
    assert.match(card.summary, /Preparation - Anchor Tomorrow/);
    assert.equal(card.anchorDate, "2026-08-14");
    assert.equal(card.anchorLabel, "Tomorrow");

    const undated = functions.operationItemFromCard(
      { id: "card-2", title: "Webinar", stage: "preparation" },
      [],
      { today: "2026-08-13" },
    );
    assert.equal(undated.anchorDate, "");
    assert.equal(undated.anchorLabel, "");
  });

  test("projects Template and Process Doc vocabulary without duplicate operation rows", () => {
    const functions = operationsModel();
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
    const { buildOperationsReferenceLinks } = operationsModel();
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
    const functions = createOperationsOverview({
      document: new FakeDocument(),
      labelizeWorkValue,
      openCardPanel() {},
      openDocument() {},
      openTaskPanel() {},
      resolveDocReference() {},
      showWorkspaceSurface() {},
      state: {
        assistantSnapshot: { loaded: true, jobs: [{}, {}] },
        artifactSnapshot: { loaded: false, artifacts: [] },
        qualitySnapshot: { loaded: true, findings: [{}] },
      },
      tasksSectionTitle: workspace.tasksSectionTitle,
    });
    assert.equal(functions.operationsViewTitle("home"), "Today");
    assert.equal(functions.operationsViewTitle("tasks", "templates"), "Tasks - Templates");
    assert.equal(functions.operationsViewPath("docs"), "Docs");
    assert.equal(functions.operationsViewPath("calendar"), "Workspace");
    assert.match(functions.surfaceDescription("queue"), /overdue, follow-up, waiting/);
    assert.equal(functions.referenceCountLabel("calendar", 1), "1 calendar item");
    assert.equal(functions.referenceCountLabel("cards", 2), "2 cards");
    assert.equal(functions.surfaceStatusText("assistants"), "2 assistant jobs.");
    assert.equal(functions.surfaceStatusText("artifacts"), "Artifact index not connected.");
    assert.equal(functions.surfaceStatusText("processes"), "1 process quality finding.");
    assert.equal(functions.surfaceStatusText("search"), "Unified operator search.");
  });

  test("renders accessible honest states, lanes, references, and quality actions", async () => {
    const document = new FakeDocument();
    const opened = [];
    const functions = createOperationsOverview({
      document,
      labelizeWorkValue,
      openCardPanel: (id) => opened.push(["card", id]),
      openDocument: (docPath) => opened.push(["doc", docPath]),
      openTaskPanel: (id) => opened.push(["task", id]),
      resolveDocReference: () => null,
      showWorkspaceSurface: (view) => opened.push(["surface", view]),
      state: {
        assistantSnapshot: { loaded: false, jobs: [] },
        artifactSnapshot: { loaded: false, artifacts: [] },
        qualitySnapshot: { loaded: false, findings: [] },
      },
      tasksSectionTitle: workspace.tasksSectionTitle,
    });
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
