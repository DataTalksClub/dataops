import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("calendar holds web parity", () => {
  test("portal slot search offers duration 60|90 (default 60) and window evening|midday|any (default any)", async () => {
    const planning = read("frontend/src/surfaces/planning.js");
    assert.match(planning, /data-slot-duration/);
    assert.match(planning, /data-slot-window/);
    assert.match(planning, /<option value="60" selected>60 min<\/option>/);
    assert.match(planning, /<option value="90">90 min<\/option>/);
    assert.match(planning, /<option value="any" selected>Any window<\/option>/);
    assert.match(planning, /\/overlays\?from=.*&duration=.*&window=/);
  });

  test("portal grid renders calendar holds as their own layer entry", async () => {
    const planning = read("frontend/src/surfaces/planning.js");
    assert.match(planning, /calendar-holds/);
    assert.match(planning, /Calendar hold/);
    assert.match(planning, /is-hold/);
  });

  test("portal day dialog proposes, confirms, and releases holds for the Orin workflow", async () => {
    const dialogs = read("frontend/src/surfaces/planning-calendar-dialogs.js");
    assert.match(dialogs, /holdsApi/);
    assert.match(dialogs, /data-hold-propose/);
    assert.match(dialogs, /data-hold-confirm/);
    assert.match(dialogs, /data-hold-release/);
    assert.match(dialogs, /\/confirm/);
    assert.match(dialogs, /\/release/);
    assert.match(dialogs, /onHoldsChanged/);
  });

  test("portal day dialog records the intended episode topic at propose time", async () => {
    const dialogs = read("frontend/src/surfaces/planning-calendar-dialogs.js");
    assert.match(dialogs, /name="topic"/);
    assert.match(dialogs, /Intended episode topic/);
    assert.match(dialogs, /topic: String\(data\.get\("topic"\)/);
    assert.match(dialogs, /Topic: /);
  });

  test("backend exposes /api/calendar-holds and projects holds into overlays", async () => {
    const router = read("backend/src/router.ts");
    assert.match(router, /api\/calendar-holds/);
    const routes = read("backend/src/routes/calendarHolds.ts");
    assert.match(routes, /\/api\/calendar-holds\/expire/);
    assert.match(routes, /confirm/);
    assert.match(routes, /release/);
    const calendar = read("backend/src/routes/calendar.ts");
    assert.match(calendar, /calendarHold/);
  });

  test("CLI documents propose/confirm-hold/release-hold/holds", async () => {
    const help = read("cli/src/commands/calendar.mjs");
    assert.match(help, /calendar propose --date D --window evening\|midday --duration N --title T --topic TOPIC/);
    assert.match(help, /calendar confirm-hold <id>/);
    assert.match(help, /calendar release-hold <id> \[--reason manual\]/);
    assert.match(help, /calendar holds \[/);
    const cli = read("cli/src/cli.mjs");
    assert.match(cli, /confirm-hold/);
    assert.match(cli, /release-hold/);
  });
});
