import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const configDir = mkdtempSync(path.join(tmpdir(), "dataops-cli-"));
process.env.DATAOPS_CONFIG_DIR = configDir;

const globalFetch = globalThis.fetch;

const { parseArgs, run } = await import("../src/cli.mjs");
const { createClient, ApiError } = await import("../src/api.mjs");
const { list } = await import("../src/commands/recurring.mjs");
const { credentialsPath, resolveProfile, saveProfile } =
  await import("../src/config.mjs");

function captureIo() {
  const out = [];
  const errors = [];
  return {
    out,
    errors,
    log: (line) => out.push(String(line)),
    error: (line) => errors.push(String(line)),
    text: () => out.join("\n"),
  };
}

/** A fetch stand-in that answers a route table and records what was sent. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = Object.keys(routes).find((key) => url.endsWith(key));
    if (!route) return new Response("", { status: 404 });
    const handler = routes[route];
    const result =
      typeof handler === "function" ? handler(options, calls) : handler;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
    });
  };
  impl.calls = calls;
  return impl;
}

describe("CLI argument parsing", () => {
  test("reads flags, inline values, booleans, and positionals", () => {
    const args = parseArgs([
      "recurring-1",
      "--description",
      "Weekly newsletter",
      "--cron=0 9 * * 1",
      "--json",
    ]);
    assert.deepEqual(args._, ["recurring-1"]);
    assert.equal(args.description, "Weekly newsletter");
    assert.equal(args.cron, "0 9 * * 1");
    assert.equal(args.json, true);
  });

  test("converts dashed flags to camelCase", () => {
    assert.equal(parseArgs(["--user-code", "BCDF-GHJK"]).userCode, "BCDF-GHJK");
  });
});

describe("CLI API client", () => {
  test("prefers the portal /work seam and falls back to a bare backend", async () => {
    const fetchImpl = fakeFetch({
      "/api/recurring": { body: { recurringConfigs: [] } },
    });
    const client = createClient({
      url: "https://portal.test/",
      token: "dops_x",
      fetchImpl,
    });
    await client.get("/api/recurring");
    assert.equal(
      fetchImpl.calls[0].url,
      "https://portal.test/work/api/recurring",
    );
    assert.equal(
      fetchImpl.calls[0].options.headers.Authorization,
      "Bearer dops_x",
    );
  });

  test("raises the API error message rather than a bare status", async () => {
    const fetchImpl = fakeFetch({
      "/api/recurring": { status: 409, body: { error: "still referenced" } },
    });
    const client = createClient({
      url: "https://portal.test",
      token: "t",
      fetchImpl,
    });
    await assert.rejects(
      () => client.get("/api/recurring"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.message, "still referenced");
        return true;
      },
    );
  });

  test("refuses to run without a portal URL", () => {
    assert.throws(() => createClient({ url: "" }), /No portal URL/);
  });
});

describe("credential storage", () => {
  afterEach(() => {
    delete process.env.DATAOPS_TOKEN;
  });

  test("writes credentials owner-only and reads them back", () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const mode = statSync(credentialsPath()).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
    const stored = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    assert.equal(stored.profiles["https://portal.test"].token, "dops_abc");
    const profile = resolveProfile({ url: "https://portal.test" });
    assert.equal(profile.token, "dops_abc");
    assert.equal(profile.source, "file");
  });

  test("lets the environment override the stored profile for CI", () => {
    process.env.DATAOPS_TOKEN = "dops_from_env";
    const profile = resolveProfile({ url: "https://portal.test" });
    assert.equal(profile.token, "dops_from_env");
    assert.equal(profile.source, "environment");
  });
});

describe("device login", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    delete process.env.DATAOPS_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("polls until the browser confirms, then stores the token", async () => {
    let polls = 0;
    const fetchImpl = fakeFetch({
      "/api/auth/device": {
        body: {
          deviceCode: "device-code",
          userCode: "BCDF-GHJK",
          verificationUri: "https://portal.test/device",
          verificationUriComplete:
            "https://portal.test/device?code=BCDF-GHJK",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          // The client floors the interval at a second; keep the test near it.
          interval: 1,
        },
      },
      "/api/auth/device/token": () => {
        polls += 1;
        if (polls < 2)
          return { status: 400, body: { error: "authorization_pending" } };
        return {
          body: {
            token: "dops_issued",
            tokenId: "token-id",
            expiresAt: "2026-11-11T00:00:00.000Z",
            user: { id: "u1", name: "Grace", email: "grace@datatalks.club" },
          },
        };
      },
    });
    globalThis.fetch = fetchImpl;
    const { login } = await import("../src/commands/auth.mjs");
    const io = captureIo();
    const result = await login(
      { url: "https://portal.test", label: "grace@remote" },
      { print: io.log },
    );

    assert.equal(result.token, "dops_issued");
    assert.equal(polls, 2, "keeps polling while the grant is pending");
    assert.match(io.text(), /BCDF-GHJK/);
    assert.match(io.text(), /\/device\?code=BCDF-GHJK/);
    assert.match(io.text(), /Signed in as Grace/);
    assert.equal(
      resolveProfile({ url: "https://portal.test" }).token,
      "dops_issued",
    );
    // The device code is the CLI's secret and is never printed.
    assert.doesNotMatch(io.text(), /device-code/);
  });

  test("stops with a clear message when the browser denies the login", async () => {
    const fetchImpl = fakeFetch({
      "/api/auth/device": {
        body: {
          deviceCode: "device-code",
          userCode: "BCDF-GHJK",
          verificationUri: "https://portal.test/device",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          interval: 1,
        },
      },
      "/api/auth/device/token": {
        status: 400,
        body: { error: "access_denied" },
      },
    });
    globalThis.fetch = fetchImpl;
    const { login } = await import("../src/commands/auth.mjs");
    await assert.rejects(
      () => login({ url: "https://portal.test" }, { print: () => {} }),
      /denied in the browser/,
    );
  });

  test("rewrites verification link to the target portal origin when server returns a different host", async () => {
    const rawLambda =
      "https://el4jt4z2k4lnxwvoqawrdcsedm0axjzc.lambda-url.eu-west-1.on.aws/device?code=BCDF-GHJK";
    const fetchImpl = fakeFetch({
      "/api/auth/device": {
        body: {
          deviceCode: "device-code",
          userCode: "BCDF-GHJK",
          verificationUri:
            "https://el4jt4z2k4lnxwvoqawrdcsedm0axjzc.lambda-url.eu-west-1.on.aws/device",
          verificationUriComplete: rawLambda,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          interval: 1,
        },
      },
      "/api/auth/device/token": {
        body: {
          token: "dops_issued",
          tokenId: "token-id",
          expiresAt: "2026-11-11T00:00:00.000Z",
          user: { id: "u1", name: "Grace", email: "grace@datatalks.club" },
        },
      },
    });
    globalThis.fetch = fetchImpl;
    const { login, rewriteVerificationUri } = await import(
      "../src/commands/auth.mjs"
    );
    assert.equal(
      rewriteVerificationUri(rawLambda, "https://ops.dtcdev.click"),
      "https://ops.dtcdev.click/device?code=BCDF-GHJK",
    );
    assert.equal(
      rewriteVerificationUri(
        "https://ops.dtcdev.click/device?code=XYZ",
        "https://ops.dtcdev.click",
      ),
      "https://ops.dtcdev.click/device?code=XYZ",
    );
    const io = captureIo();
    await login(
      { url: "https://ops.dtcdev.click", label: "grace@remote" },
      { print: io.log },
    );
    assert.match(
      io.text(),
      /Open in a browser:\s+https:\/\/ops\.dtcdev\.click\/device\?code=BCDF-GHJK/,
    );
    assert.doesNotMatch(io.text(), /lambda-url/);
  });
});

describe("recurring commands", () => {
  test("renders the cadence and next run the API reports, verbatim", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    globalThis.fetch = fakeFetch({
      "/api/recurring": {
        body: {
          recurringConfigs: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              description: "Weekly newsletter",
              cronExpression: "0 9 * * 1",
              enabled: true,
              scheduleLabel: "Every Monday at 09:00",
              nextRunLabel: "Mon 17 Aug",
            },
            {
              id: "66666666-2222-3333-4444-555555555555",
              description: "Old export",
              cronExpression: "0 9 * * 2",
              enabled: false,
              scheduleLabel: "Every Tuesday at 09:00",
            },
            {
              id: "77777777-2222-3333-4444-555555555555",
              description: "Unlabelled range",
              cronExpression: "0 9 * * 1-5",
            },
          ],
        },
      },
    });
    const io = captureIo();
    await list({ url: "https://portal.test", _: [] }, { print: io.log });

    assert.deepEqual(io.out, [
      "11111111  active   Weekly newsletter  (Every Monday at 09:00 - next Mon 17 Aug)",
      "66666666  paused   Old export  (Every Tuesday at 09:00 - paused)",
      "77777777  active   Unlabelled range  (0 9 * * 1-5)",
    ]);
    globalThis.fetch = globalFetch;
  });

  test("--doc stores the canonical id of the process doc it names", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const { create, edit } = await import("../src/commands/recurring.mjs");
    const sent = [];
    globalThis.fetch = fakeFetch({
      "/docs/resolve?ref=bookkeeping-report": {
        body: { document: { id: "sop.finance.prepare-a-bookkeeping-report", path: "content/x.md" } },
      },
      "/api/recurring": (options) => {
        if (options.method === "POST") sent.push(JSON.parse(options.body));
        return {
          status: options.method === "POST" ? 201 : 200,
          body: options.method === "POST"
            ? { recurringConfig: { id: "abc", description: "Report", ...sent.at(-1) } }
            : { recurringConfigs: [{ id: "abc12345", description: "Report", cronExpression: "0 9 1 * *" }] },
        };
      },
      "/api/recurring/abc12345": (options) => {
        sent.push(JSON.parse(options.body));
        return { body: { recurringConfig: { id: "abc12345", description: "Report" } } };
      },
    });
    const io = captureIo();
    await create(
      { url: "https://portal.test", description: "Report", cron: "0 9 1 * *", doc: "bookkeeping-report", _: [] },
      { print: io.log },
    );
    await edit({ url: "https://portal.test", doc: "none", _: ["abc1"] }, { print: io.log });
    assert.equal(sent[0].instructionDocId, "sop.finance.prepare-a-bookkeeping-report");
    assert.deepEqual(sent[1], { instructionDocId: null });
    assert.match(io.out[0], /\[doc sop\.finance\.prepare-a-bookkeeping-report\]$/);
    await assert.rejects(
      () => edit({ url: "https://portal.test", doc: true, _: ["abc1"] }, { print: () => {} }),
      /--doc needs a process doc/,
    );
    globalThis.fetch = globalFetch;
  });

  test("rejects a cron expression that is not five fields", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const { create } = await import("../src/commands/recurring.mjs");
    await assert.rejects(
      () =>
        create(
          {
            url: "https://portal.test",
            description: "Weekly",
            cron: "0 9 * *",
            _: [],
          },
          { print: () => {} },
        ),
      /five fields/,
    );
  });

  test("sends the browser classification on create and edit, none clearing it", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const recurring = await import("../src/commands/recurring.mjs");
    const fetch = fakeFetch({
      "/api/recurring/config-1": {
        body: { recurringConfig: { id: "config-1", description: "Weekly", browserRequirement: "headless" } },
      },
      "/api/recurring": (options) =>
        options.method === "POST"
          ? { body: { recurringConfig: { id: "config-1", description: "New" } }, status: 201 }
          : { body: { recurringConfigs: [{ id: "config-1", description: "Weekly", cronExpression: "0 9 * * 1" }] } },
    });
    globalThis.fetch = fetch;

    const io = captureIo();
    await recurring.create(
      { url: "https://portal.test", description: "New", cron: "0 9 * * 1", browser: "headless", _: [] },
      { print: io.log },
    );
    const created = fetch.calls.find((call) => call.url.endsWith("/api/recurring") && call.options.method === "POST");
    assert.deepEqual(JSON.parse(created.options.body).browserRequirement, "headless");

    await recurring.edit(
      { url: "https://portal.test", _: ["config-1"], browser: "none" },
      { print: io.log },
    );
    const edited = fetch.calls.find((call) => call.url.endsWith("/api/recurring/config-1"));
    assert.equal(edited.options.method, "PUT");
    assert.equal(JSON.parse(edited.options.body).browserRequirement, null);

    await assert.rejects(
      () =>
        recurring.edit(
          { url: "https://portal.test", _: ["config-1"], browser: "sometimes" },
          { print: () => {} },
        ),
      /--browser must be required, headless, or none/,
    );
    globalThis.fetch = globalFetch;
  });
});

describe("tasks commands", () => {
  test("list sends the browser filter, marks each row, and rejects unknown modes", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const fetch = fakeFetch({
      "browser=headless": {
        body: {
          tasks: [
            {
              id: "task-headless",
              description: "Headless work",
              status: "todo",
              date: "2026-08-12",
              browserRequirement: "headless",
            },
            {
              id: "task-unclear",
              description: "Undecided work",
              status: "todo",
              date: "2026-08-12",
            },
          ],
        },
      },
    });
    globalThis.fetch = fetch;
    const tasks = await import("../src/commands/tasks.mjs");

    const io = captureIo();
    const result = await tasks.list(
      { url: "https://portal.test", _: [], status: "todo", browser: "headless" },
      { print: io.log },
    );
    const listCall = fetch.calls.find((call) => call.url.includes("/api/tasks?"));
    assert.ok(String(listCall.url).includes("browser=headless"), listCall.url);
    // The server narrows; the table carries the honest BROWSER column, empty
    // for work nobody classified.
    assert.match(io.text(), /BROWSER/);
    assert.match(io.text(), /headless/);
    assert.match(io.text(), /task-unclear/);

    await assert.rejects(
      () =>
        tasks.list(
          { url: "https://portal.test", _: [], status: "todo", browser: "sometimes" },
          { print: () => {} },
        ),
      /--browser must be required, headless, or unclassified/,
    );
    globalThis.fetch = globalFetch;
  });

  test("create and update send the classification, none clears it", async () => {
    const tasks = await import("../src/commands/tasks.mjs");
    const { browserQuery, browserMark, requiresQuery } = tasks;
    assert.deepEqual(browserQuery({ browser: "headless" }), { browser: "headless" });
    assert.deepEqual(browserQuery({}), {});
    assert.deepEqual(browserMark("required"), "browser");
    assert.equal(browserMark(undefined), "");
    assert.throws(() => browserQuery({ browser: "sometimes" }), /--browser must be/);
    // The resource pipeline is untouched by the browser filter.
    assert.deepEqual(requiresQuery({ canDo: "all" }), {});
  });

  test("batches groups same-day Card tasks in dependency order and distinguishes chained vs externally blocked steps", async () => {
    saveProfile("https://portal.test", { token: "dops_abc", tokenId: "id-1" });
    const fetch = fakeFetch({
      "cardId=card-webinar": {
        body: {
          tasks: [
            {
              id: "task-meetup",
              cardId: "card-webinar",
              description: "Create events on Meetup",
              status: "todo",
              date: "2026-10-18",
              blocked: true,
              dependsOn: ["task-luma"],
              prerequisites: [{ id: "task-luma", description: "Create events on Luma", status: "todo" }],
              requires: ["meetup"],
              browserRequirement: "required",
            },
            {
              id: "task-banner",
              cardId: "card-webinar",
              description: "Create a banner",
              status: "todo",
              date: "2026-10-18",
              blocked: false,
              dependsOn: [],
              prerequisites: [],
              requires: ["banner-generator"],
              browserRequirement: "headless",
            },
            {
              id: "task-luma",
              cardId: "card-webinar",
              description: "Create events on Luma",
              status: "todo",
              date: "2026-10-18",
              blocked: true,
              dependsOn: ["task-banner"],
              prerequisites: [{ id: "task-banner", description: "Create a banner", status: "todo" }],
              requires: ["luma", "youtube"],
              browserRequirement: "required",
            },
            {
              id: "task-post",
              cardId: "card-webinar",
              description: "Recheck the video edit",
              status: "todo",
              date: "2026-11-11",
              blocked: true,
              dependsOn: ["task-trim-missing"],
              prerequisites: [{ id: "task-trim-missing", description: "Remove beginning", status: "waiting" }],
              requires: ["youtube"],
              browserRequirement: "required",
            },
          ],
        },
      },
    });
    globalThis.fetch = fetch;
    const tasks = await import("../src/commands/tasks.mjs");

    const io = captureIo();
    const result = await tasks.batches(
      { url: "https://portal.test", _: [], card: "card-webinar", asOf: "2026-10-17" },
      { print: io.log },
    );

    assert.equal(result.batches.length, 2);
    const setupBatch = result.batches[0];
    assert.equal(setupBatch.date, "2026-10-18");
    assert.equal(setupBatch.scope, "card:card-webinar");
    assert.equal(setupBatch.total, 3);
    assert.equal(setupBatch.ready, 1);
    assert.equal(setupBatch.chained, 2);
    assert.equal(setupBatch.actionable, 3);
    assert.equal(setupBatch.blocked, 0);
    assert.deepEqual(
      setupBatch.tasks.map((t) => [t.id, t.batchStep, t.batchState]),
      [
        ["task-banner", 1, "ready"],
        ["task-luma", 2, "chained"],
        ["task-meetup", 3, "chained"],
      ],
    );
    assert.deepEqual(setupBatch.requires, ["banner-generator", "luma", "meetup", "youtube"]);
    assert.equal(setupBatch.browserRequirement, "required");

    const postBatch = result.batches[1];
    assert.equal(postBatch.date, "2026-11-11");
    assert.equal(postBatch.total, 1);
    assert.equal(postBatch.actionable, 0);
    assert.equal(postBatch.blocked, 1);
    assert.equal(postBatch.tasks[0].batchState, "blocked");

    assert.match(io.text(), /ACTIONABLE/);
    assert.match(io.text(), /3\/3/);
    assert.match(io.text(), /1\. \[ready\] task-banner/);
    assert.match(io.text(), /2\. \[chained\] task-luma/);
    assert.match(io.text(), /3\. \[chained\] task-meetup/);
    globalThis.fetch = globalFetch;
  });
});

describe("command dispatch", () => {
  test("prints usage and exits zero with no arguments", async () => {
    const io = captureIo();
    assert.equal(await run([], io), 0);
    assert.match(io.text(), /dataops <command>/);
  });

  test("reports unknown commands on stderr with a non-zero exit", async () => {
    const io = captureIo();
    assert.equal(await run(["nope"], io), 2);
    assert.match(io.errors.join("\n"), /Unknown command: nope/);
  });

  test("reports a missing subcommand", async () => {
    const io = captureIo();
    assert.equal(await run(["recurring"], io), 2);
    assert.match(io.text(), /dataops recurring list/);
  });
});

describe("newsletter doc and podcast doc commands", () => {
  test("creates a sponsor doc via newsletter doc and podcast doc, supports show/export/delete, and keeps sponsor-docs as a deprecated alias", async () => {
    saveProfile("https://ops.dtcdev.click", { token: "dops_abc", tokenId: "id-1" });
    const sent = [];
    const fetch = fakeFetch({
      "/api/sponsor-docs": (options) => {
        if (options.method === "POST") {
          const parsed = JSON.parse(options.body);
          sent.push(parsed);
          return {
            status: 201,
            body: {
              doc: {
                id: "doc-123",
                cardId: parsed.cardId,
                template: parsed.template || "newsletter-main",
                title: "2026-11-15 - Acme AI",
                sponsorName: "Acme AI",
                publicationDate: "2026-11-15",
                linkType: "Sponsorship document",
                status: "draft",
                docUrl: "https://internal.lambda-url.eu-west-1.on.aws/sponsor-docs/doc-123",
                shareUrl: "https://internal.lambda-url.eu-west-1.on.aws/sponsor-docs/doc-123?code=BCDF-GHJK-MNPR-STVW",
                accessCode: "BCDF-GHJK-MNPR-STVW",
                emailDraft: {
                  subject: "DataTalks.Club Newsletter Content Brief (2026-11-15) - Acme AI",
                  body: "Link: https://internal.lambda-url.eu-west-1.on.aws/sponsor-docs/doc-123?code=BCDF-GHJK-MNPR-STVW\nAccess code: BCDF-GHJK-MNPR-STVW",
                },
                version: 1,
              },
              card: {
                id: parsed.cardId,
                title: "2026-11-15 - Acme AI",
              },
            },
          };
        }
        return {
          body: {
            docs: [
              {
                id: "doc-123",
                cardId: "card-1",
                template: "newsletter-main",
                title: "2026-11-15 - Acme AI",
                sponsorName: "Acme AI",
                publicationDate: "2026-11-15",
                status: "submitted",
                lastEditedAt: "2026-11-01T12:00:00.000Z",
                lastEditedBy: "sponsor",
                docUrl: "https://ops.dtcdev.click/sponsor-docs/doc-123",
              },
            ],
          },
        };
      },
      "/api/sponsor-docs/doc-123/export": {
        body: {
          id: "doc-123",
          markdown: "# 2026-11-15 - Acme AI\n\n## Title\n\nAcme Launch\n",
        },
      },
      "/api/sponsor-docs/doc-123": (options) => {
        if (options.method === "DELETE") {
          sent.push({ deleted: "doc-123" });
          return {
            body: {
              deleted: { id: "doc-123", cardId: "card-1", title: "2026-11-15 - Acme AI" },
            },
          };
        }
        if (options.method === "PUT") {
          const parsed = JSON.parse(options.body);
          sent.push(parsed);
          return {
            body: {
              doc: {
                id: "doc-123",
                cardId: "card-1",
                template: "newsletter-main",
                status: parsed.status || "draft",
                version: 2,
                docUrl: "https://ops.dtcdev.click/sponsor-docs/doc-123",
              },
            },
          };
        }
        return {
          body: {
            doc: {
              id: "doc-123",
              cardId: "card-1",
              template: "newsletter-main",
              title: "2026-11-15 - Acme AI",
              status: "submitted",
              docUrl: "https://ops.dtcdev.click/sponsor-docs/doc-123",
              shareUrl: "https://ops.dtcdev.click/sponsor-docs/doc-123?code=BCDF-GHJK-MNPR-STVW",
              accessCode: "BCDF-GHJK-MNPR-STVW",
              emailDraft: {
                subject: "DataTalks.Club Newsletter Content Brief (2026-11-15) - Acme AI",
                body: "Open https://ops.dtcdev.click/sponsor-docs/doc-123?code=BCDF-GHJK-MNPR-STVW",
              },
              templateDefinition: {
                label: "Sponsored Newsletter — Main Slot",
                fields: [{ key: "headline", label: "Title" }],
              },
              content: { headline: "Acme Launch" },
              version: 2,
            },
          },
        };
      },
    });
    globalThis.fetch = fetch;

    const ioCreate = captureIo();
    assert.equal(
      await run(["newsletter", "doc", "create", "issue-1", "--slot", "secondary", "--email", "--url", "https://ops.dtcdev.click"], ioCreate),
      0,
    );
    assert.equal(sent[0].cardId, "issue-1");
    assert.equal(sent[0].slot, "secondary");
    assert.equal(sent[0].template, "newsletter-secondary");
    assert.match(
      ioCreate.text(),
      /Shareable link \(with code\): https:\/\/ops\.dtcdev\.click\/sponsor-docs\/doc-123\?code=BCDF-GHJK-MNPR-STVW/,
    );
    assert.match(
      ioCreate.text(),
      /Card link \(Sponsorship document\): https:\/\/ops\.dtcdev\.click\/sponsor-docs\/doc-123/,
    );
    assert.doesNotMatch(ioCreate.text(), /internal\.lambda-url/);

    const ioStandalone = captureIo();
    assert.equal(
      await run(["newsletter", "doc", "create", "issue-2", "--standalone", "--url", "https://ops.dtcdev.click"], ioStandalone),
      0,
    );
    assert.equal(sent[1].cardId, "issue-2");
    assert.equal(sent[1].standalone, true);
    assert.equal(sent[1].template, "newsletter-standalone");

    const ioPodcast = captureIo();
    assert.equal(
      await run(["podcast", "doc", "create", "card-pod-1", "--sponsor", "PodCorp", "--email", "--url", "https://ops.dtcdev.click"], ioPodcast),
      0,
    );
    assert.equal(sent[2].cardId, "card-pod-1");
    assert.equal(sent[2].template, "podcast");
    assert.equal(sent[2].sponsorName, "PodCorp");

    const ioPrep = captureIo();
    assert.equal(
      await run(["podcast", "doc", "create", "card-pod-1", "--template", "podcast-run-sheet", "--url", "https://ops.dtcdev.click"], ioPrep),
      0,
    );
    assert.equal(sent[3].template, "podcast-run-sheet");

    const ioBadTemplate = captureIo();
    assert.equal(
      await run(["podcast", "doc", "create", "card-pod-1", "--template", "newsletter-main", "--url", "https://ops.dtcdev.click"], ioBadTemplate),
      2,
    );

    const ioSubmit = captureIo();
    assert.equal(
      await run(["newsletter", "doc", "submit", "doc-123", "--url", "https://ops.dtcdev.click"], ioSubmit),
      0,
    );
    assert.equal(sent[4].status, "submitted");
    assert.match(ioSubmit.text(), /Updated sponsor doc doc-123 \[submitted\]/);

    const ioExport = captureIo();
    assert.equal(
      await run(["newsletter", "doc", "export", "doc-123", "--url", "https://ops.dtcdev.click"], ioExport),
      0,
    );
    assert.match(ioExport.text(), /Acme Launch/);

    const ioDelete = captureIo();
    assert.equal(
      await run(["podcast", "doc", "delete", "doc-123", "--yes", "--url", "https://ops.dtcdev.click"], ioDelete),
      0,
    );
    assert.deepEqual(sent[5], { deleted: "doc-123" });
    assert.match(ioDelete.text(), /Deleted sponsor doc doc-123/);

    const ioDeprecated = captureIo();
    assert.equal(
      await run(["sponsor-docs", "show", "doc-123", "--url", "https://ops.dtcdev.click"], ioDeprecated),
      0,
    );
    assert.match(ioDeprecated.text(), /Deprecated: 'dataops sponsor-docs' is deprecated; use 'dataops newsletter doc show'/);

    globalThis.fetch = globalFetch;
  });

  test("newsletter markdown set, show, preview, and rotate-code store and print shareable preview links", async () => {
    const { writeFileSync } = await import("node:fs");
    const issuePath = path.join(configDir, "issue.md");
    const sourcesPath = path.join(configDir, "sources.md");
    const briefPath = path.join(configDir, "brief.md");
    writeFileSync(issuePath, "Subject: PhoenixAI\n\n# Next Query 2026\n", "utf-8");
    writeFileSync(sourcesPath, "# Sources\n- Card 2fe23a82\n", "utf-8");
    writeFileSync(briefPath, "# Brief\n- Stand-alone\n", "utf-8");

    const sent = [];
    const fetch = fakeFetch({
      "/api/newsletter-issues/issue-phx/markdown": (options) => {
        if (options.method === "PUT") {
          sent.push(JSON.parse(options.body));
        }
        return {
          status: 200,
          body: {
            issueId: "issue-phx",
            cardId: "card-phx",
            label: "Stand-alone newsletter",
            publicationDate: "2026-10-21",
            status: "planned",
            viewerRole: "staff",
            previewUrl: "https://internal.lambda-url.eu-central-1.on.aws/newsletter-issues/issue-phx/preview",
            shareUrl:
              "https://internal.lambda-url.eu-central-1.on.aws/newsletter-issues/issue-phx/preview?code=2345-6789-ABCD-EFGH",
            accessCode: "2345-6789-ABCD-EFGH",
            markdown: {
              issue: "Subject: PhoenixAI\n\n# Next Query 2026\n",
              sources: "# Sources\n- Card 2fe23a82\n",
              brief: "# Brief\n- Stand-alone\n",
              updatedAt: "2026-10-18T16:00:00.000Z",
              updatedByName: "Alexey Staff",
            },
          },
        };
      },
      "/api/newsletter-issues/issue-phx/markdown/rotate-code": () => ({
        status: 200,
        body: {
          issueId: "issue-phx",
          label: "Stand-alone newsletter",
          publicationDate: "2026-10-21",
          previewUrl: "https://ops.dtcdev.click/newsletter-issues/issue-phx/preview",
          shareUrl: "https://ops.dtcdev.click/newsletter-issues/issue-phx/preview?code=WXYZ-2345-6789-ABCD",
          accessCode: "WXYZ-2345-6789-ABCD",
        },
      }),
    });
    globalThis.fetch = fetch;

    const ioSet = captureIo();
    assert.equal(
      await run(
        [
          "newsletter",
          "markdown",
          "set",
          "issue-phx",
          "--issue-file",
          issuePath,
          "--sources-file",
          sourcesPath,
          "--brief-file",
          briefPath,
          "--url",
          "https://ops.dtcdev.click",
        ],
        ioSet,
      ),
      0,
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0].issue, /Next Query 2026/);
    assert.match(sent[0].sources, /Card 2fe23a82/);
    assert.match(sent[0].brief, /Stand-alone/);
    assert.match(
      ioSet.text(),
      /Shareable preview link \(with code\): https:\/\/ops\.dtcdev\.click\/newsletter-issues\/issue-phx\/preview\?code=2345-6789-ABCD-EFGH/,
    );

    const ioShowKind = captureIo();
    assert.equal(
      await run(["newsletter", "markdown", "show", "issue-phx", "issue", "--url", "https://ops.dtcdev.click"], ioShowKind),
      0,
    );
    assert.match(ioShowKind.text(), /Subject: PhoenixAI/);

    const ioPreview = captureIo();
    assert.equal(
      await run(["newsletter", "markdown", "preview", "issue-phx", "--url", "https://ops.dtcdev.click"], ioPreview),
      0,
    );
    assert.match(ioPreview.text(), /Access code: 2345-6789-ABCD-EFGH/);

    const ioRotate = captureIo();
    assert.equal(
      await run(["newsletter", "markdown", "rotate-code", "issue-phx", "--url", "https://ops.dtcdev.click"], ioRotate),
      0,
    );
    assert.match(ioRotate.text(), /WXYZ-2345-6789-ABCD/);

    globalThis.fetch = globalFetch;
  });
});


