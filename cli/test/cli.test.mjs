import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const configDir = mkdtempSync(path.join(tmpdir(), "dataops-cli-"));
process.env.DATAOPS_CONFIG_DIR = configDir;

const { parseArgs, run } = await import("../src/cli.mjs");
const { createClient, ApiError } = await import("../src/api.mjs");
const { describeSchedule } = await import("../src/commands/recurring.mjs");
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
    assert.equal(mode, 0o600);
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
          verificationUri: "https://portal.test/#/device",
          verificationUriComplete:
            "https://portal.test/#/device?userCode=BCDF-GHJK",
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
    assert.match(io.text(), /#\/device\?userCode=BCDF-GHJK/);
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
          verificationUri: "https://portal.test/#/device",
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
});

describe("recurring commands", () => {
  test("renders cron in the same words the Recurring tab uses", () => {
    assert.equal(describeSchedule("0 9 * * 1"), "every Monday at 09:00");
    assert.equal(describeSchedule("30 6 * * *"), "every day at 06:30");
    assert.equal(describeSchedule("0 9 15 * *"), "monthly on day 15 at 09:00");
    assert.equal(describeSchedule("*/5 * * * *"), "*/5 * * * *");
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
});

describe("command dispatch", () => {
  test("prints usage and exits zero with no arguments", async () => {
    const io = captureIo();
    assert.equal(await run([], io), 0);
    assert.match(io.text(), /dataops <command>/);
  });

  test("reports unknown commands on stderr with a non-zero exit", async () => {
    const io = captureIo();
    assert.equal(await run(["nope"], io), 1);
    assert.match(io.errors.join("\n"), /Unknown command: nope/);
  });

  test("reports a missing subcommand", async () => {
    const io = captureIo();
    assert.equal(await run(["recurring"], io), 1);
    assert.match(io.errors.join("\n"), /list\|create\|edit/);
  });
});
