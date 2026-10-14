// End-to-end smoke: the real CLI binary against the real backend router
// (scripts/test-server.ts: in-process Dynalite, synthetic knowledge in a
// memory-backed S3 store, test auth bypass). Fake data only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "../../backend");
const bin = path.resolve(here, "../bin/dataops.mjs");

const KNOWLEDGE = {
  "content/newsletter/sops/schedule-newsletter.md": [
    "---",
    "id: newsletter.schedule",
    "title: Schedule the weekly newsletter",
    "summary: How to schedule a synthetic weekly newsletter issue",
    "doc_type: sop",
    "---",
    "",
    "# Schedule the weekly newsletter",
    "",
    "Open the synthetic mail tool and schedule the issue for Monday.",
  ].join("\n"),
  "content/finance/reference/invoices.md": [
    "---",
    "id: finance.invoices",
    "title: Invoice reference",
    "summary: Synthetic notes about sponsor invoices",
    "doc_type: reference",
    "---",
    "",
    "A sponsor invoice is sent after the newsletter placement is published.",
  ].join("\n"),
};

let server;
let baseUrl;
let workDir;

function startServer(knowledgeRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/test-server.ts"], {
      cwd: backendDir,
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SKIP_AUTH: "true",
        PORT: "0",
        DATAOPS_DOCS_DOMAIN: "true",
        DTC_OFFLINE: "1",
        DTC_CACHE_ROOT: knowledgeRoot,
        FRONTEND_ROOT: "../frontend",
        E2E_TEMPLATE_ACTOR_ID: "00000000-0000-0000-0000-000000000001",
        CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: "false",
        CONVERSATIONAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_ENABLED_PLUGINS: "none",
        CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: "false",
        CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => reject(new Error(`test server did not start:\n${log}`)), 90_000);
    const onData = (chunk) => {
      log += chunk;
      const match = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`test server exited with ${code}:\n${log}`));
    });
  });
}

/** Run the CLI binary; returns { code, stdout, stderr, json }. */
function cli(...args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: {
      ...process.env,
      DATAOPS_URL: baseUrl,
      DATAOPS_TOKEN: "e2e-test-bypass",
      DATAOPS_CONFIG_DIR: path.join(workDir, "config"),
    },
    encoding: "utf8",
  });
  let json;
  if (args.includes("--json") && result.status === 0) json = JSON.parse(result.stdout);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "dataops-cli-e2e-"));
  const knowledgeRoot = path.join(workDir, "knowledge");
  for (const [file, text] of Object.entries(KNOWLEDGE)) {
    mkdirSync(path.dirname(path.join(knowledgeRoot, file)), { recursive: true });
    writeFileSync(path.join(knowledgeRoot, file), text);
  }
  ({ child: server, url: baseUrl } = await startServer(knowledgeRoot));
});

after(() => {
  if (server) {
    server.removeAllListeners("exit");
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("dataops CLI against a local backend", () => {
  let cardId;
  let taskId;

  test("whoami identifies the actor", () => {
    const result = cli("whoami", "--json");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.user.email, "grace@datatalks.club");
  });

  test("a Card created from a Template carries its Tasks", () => {
    const templates = cli("templates", "list", "--json");
    assert.equal(templates.code, 0, templates.stderr);
    const type = templates.json.templates[0].type;
    const created = cli("cards", "create", "--title", "Synthetic newsletter", "--date", "2026-11-02", "--template", type, "--json");
    assert.equal(created.code, 0, created.stderr);
    cardId = created.json.card.id;
    taskId = created.json.tasks[0].id;
    const shown = cli("cards", "show", cardId, "--json");
    assert.deepEqual(shown.json.tasks.map((task) => task.id), [taskId]);
  });

  test("the card's tasks are listed, and done enforces then accepts the proof", () => {
    const listed = cli("tasks", "list", "--card", cardId, "--json");
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(listed.json.tasks.map((task) => task.id), [taskId]);

    const refused = cli("tasks", "done", taskId, "--json");
    assert.equal(refused.code, 6);
    assert.match(JSON.parse(refused.stderr).error.message, /required link/);

    const done = cli("tasks", "done", taskId, "--link", "https://example.test/synthetic-output", "--json");
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.json.status, "done");
    assert.equal(done.json.link, "https://example.test/synthetic-output");

    const reopened = cli("tasks", "reopen", taskId, "--json");
    assert.equal(reopened.json.status, "todo");
  });

  test("waiting and unblocking go through the follow-up actions", () => {
    const waiting = cli("tasks", "wait", taskId, "--for", "Synthetic sponsor", "--follow-up", "2026-10-30", "--channel", "email", "--note", "Asked for a logo", "--json");
    assert.equal(waiting.code, 0, waiting.stderr);
    assert.equal(waiting.json.status, "waiting");
    const queue = cli("tasks", "list", "--waiting", "--json");
    assert.ok(queue.json.tasks.some((task) => task.id === taskId));
    const unblocked = cli("tasks", "unblock", taskId, "--note", "Logo received", "--json");
    assert.equal(unblocked.json.status, "todo");
  });

  test("knowledge base: tree, search with snippets, show, and related", () => {
    const tree = cli("kb", "tree", "--json");
    assert.equal(tree.code, 0, tree.stderr);
    assert.deepEqual(tree.json.folders.map((folder) => folder.name), ["finance", "newsletter"]);

    const search = cli("kb", "search", "sponsor invoice", "--json");
    assert.equal(search.code, 0, search.stderr);
    assert.equal(search.json.results[0].id, "finance.invoices");
    assert.match(search.json.results[0].snippet, /sponsor invoice/);
    assert.equal(typeof search.json.results[0].score, "number");

    const filtered = cli("kb", "search", "newsletter", "--type", "sop", "--json");
    assert.deepEqual(filtered.json.results.map((item) => item.id), ["newsletter.schedule"]);

    const shown = cli("kb", "show", "newsletter.schedule");
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /# Schedule the weekly newsletter/);

    const related = cli("kb", "related", taskId, "--json");
    assert.equal(related.code, 0, related.stderr);
    assert.equal(related.json.subject.kind, "task");
    assert.ok(Array.isArray(related.json.matches));

    assert.equal(cli("kb", "show", "no.such.doc").code, 4);
  });

  test("a newsletter slot gets a linked Card", () => {
    const slot = cli("newsletter", "create", "--date", "2026-11-09", "--label", "Synthetic issue", "--json");
    assert.equal(slot.code, 0, slot.stderr);
    const linked = cli("newsletter", "create-card", slot.json.id, "--json");
    assert.equal(linked.code, 0, linked.stderr);
    assert.equal(linked.json.slot.cardId, linked.json.card.id);
    assert.equal(linked.json.card.anchorDate, "2026-11-09");
  });

  test("unknown records and bad input use their exit codes", () => {
    assert.equal(cli("tasks", "show", "00000000-0000-0000-0000-00000000dead").code, 4);
    assert.equal(cli("cards", "stage", cardId, "nowhere").code, 2);
  });
});
