import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const template = {
  id: "tpl-1",
  type: "course-launch",
  name: "Course launch",
  origin: "custom",
  pinned: false,
  revision: "rev-1",
  version: 3,
  triggerType: "manual",
  taskDefinitions: [
    { refId: "a", description: "Task A", offsetDays: 0 },
    { refId: "b", description: "Task B", offsetDays: 7, dependsOn: ["a"] },
  ],
};

const findRoutes = {
  "GET /api/templates/tpl-1": { template },
  "GET /api/templates": { templates: [template] },
};

describe("templates read commands", () => {
  test("list shows origin and pin state", async () => {
    fakePortal({ "GET /api/templates": { templates: [{ ...template, pinned: true }] } });
    const io = captureIo();
    assert.equal(await run(["templates", "list"], io), 0);
    assert.match(io.text(), /tpl-1\s+course-launch\s+custom\s+yes/);
  });

  test("show resolves by type and prints revision metadata", async () => {
    fakePortal({
      "GET /api/templates/course-launch": { status: 404, body: { error: "Template not found" } },
      ...findRoutes,
    });
    const io = captureIo();
    assert.equal(await run(["templates", "show", "course-launch"], io), 0);
    assert.match(io.text(), /rev-1/);
  });

  test("show resolves a unique id prefix (AC7)", async () => {
    const full = {
      ...template,
      id: "f25c4abf-1234-5678-9abc-def012345678",
      type: "prefixed-type",
      name: "Prefixed",
      sourceRevision: "dad2d88302bc0b4ab0cada1e3dcf622ababd1c00a10580401e4eb5f9b3ecf1b2",
      sourceBlobSha: "ad64be810dbff91a733474d5dfbbc48202901a9f",
    };
    fakePortal({
      "GET /api/templates/f25c4abf": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [full] },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "show", "f25c4abf"], io), 0);
    assert.match(io.text(), /f25c4abf-1234/);
  });

  test("an ambiguous id prefix is a usage error", async () => {
    const first = { ...template, id: "f25c4abf-1111-1111-1111-111111111111", type: "alpha" };
    const second = { ...template, id: "f25c4abf-2222-2222-2222-222222222222", type: "beta" };
    fakePortal({
      "GET /api/templates/f25c4abf": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [first, second] },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "show", "f25c4abf"], io), 2);
    assert.match(io.errors.join("\n"), /More than one Template id starts with/);
  });

  test("an ambiguous type match is a usage error before any write", async () => {
    fakePortal({
      "GET /api/templates/dup": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [template, { ...template, id: "tpl-2", name: "Course Launch" }] },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "course launch", "--task", "a", "--offset-days", "1"], io), 2);
  });
});

describe("templates write commands", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dataops-templates-"));
  });

  test("create posts a YAML file and prints the new id", async () => {
    const file = path.join(dir, "def.yaml");
    writeFileSync(file, "name: Fresh\ntype: fresh-type\ntrigger:\n  mode: manual\ntasks:\n  - id: a\n    name: A\n    schedule:\n      offset_days: 0\n");
    const calls = fakePortal({ "POST /api/templates": { template: { ...template, id: "tpl-9", type: "fresh-type" } } });
    const io = captureIo();
    assert.equal(await run(["templates", "create", "--file", file], io), 0);
    assert.equal(calls.at(-1).method, "POST");
    assert.equal(calls.at(-1).body.type, "fresh-type");
    assert.match(io.text(), /Created tpl-9/);
  });

  test("create with --dry-run sends nothing persistent and reports validity", async () => {
    const file = path.join(dir, "def.json");
    writeFileSync(file, JSON.stringify({ name: "Dry", type: "dry-type", tasks: [{ id: "a", name: "A", schedule: { offset_days: 0 } }] }));
    const calls = fakePortal({ "POST /api/templates": { dryRun: true, effective: { type: "dry-type" } } });
    const io = captureIo();
    assert.equal(await run(["templates", "create", "--file", file, "--dry-run"], io), 0);
    assert.equal(calls.at(-1).query.dryRun, "true");
    assert.match(io.text(), /Dry run/);
  });

  test("create rejects an unreadable file before sending", async () => {
    fakePortal({});
    const io = captureIo();
    assert.equal(await run(["templates", "create", "--file", path.join(dir, "missing.json")], io), 2);
  });

  test("update --task patches the offset client-side and pins with fetched pair", async () => {
    const calls = fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { template: { ...template, version: 4 } },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--task", "b", "--offset-days", "-3"], io), 0);
    const put = calls.at(-1);
    assert.deepEqual({ expectedVersion: put.body.expectedVersion, revision: put.body.revision }, { expectedVersion: 3, revision: "rev-1" });
    const patched = put.body.definition.taskDefinitions.find((task) => task.refId === "b");
    assert.equal(patched.offsetDays, -3);
    assert.match(io.text(), /version 4/);
  });

  test("explicit --expected-version/--revision win over a fresh fetch", async () => {
    const calls = fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { template: { ...template, version: 9 } },
    });
    assert.equal(
      await run(["templates", "update", "tpl-1", "--task", "a", "--offset-days", "1", "--expected-version", "7", "--revision", "rev-exported"], captureIo()),
      0,
    );
    assert.deepEqual(
      { expectedVersion: calls.at(-1).body.expectedVersion, revision: calls.at(-1).body.revision },
      { expectedVersion: 7, revision: "rev-exported" },
    );
  });

  test("update --task-name alone renames and --task-name combines with --offset-days", async () => {
    const calls = fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { template: { ...template, version: 4 } },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--task", "a", "--task-name", "Renamed A"], io), 0);
    const renamed = calls.at(-1).body.definition.taskDefinitions.find((task) => task.refId === "a");
    assert.equal(renamed.description, "Renamed A");
    assert.equal(renamed.offsetDays, 0);
    const both = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--task", "b", "--offset-days", "3", "--task-name", "Renamed B"], both), 0);
    const patched = calls.at(-1).body.definition.taskDefinitions.find((task) => task.refId === "b");
    assert.deepEqual([patched.offsetDays, patched.description], [3, "Renamed B"]);
  });

  test("update without any usable revision fails before sending", async () => {
    const calls = fakePortal({
      "GET /api/templates/norev-type": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [{ ...template, id: "tpl-norev", type: "norev-type", revision: undefined }] },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "norev-type", "--task", "a", "--offset-days", "1"], io), 2);
    assert.match(io.errors.join("\n"), /--revision/);
    assert.equal(calls.some(({ method }) => method === "PUT"), false);
  });
  test("update --from-file pins the file and prefers its embedded pair over a fresh fetch", async () => {
    const file = path.join(dir, "saved.json");
    const saved = {
      ...template,
      version: 2,
      revision: "rev-saved",
      taskDefinitions: [{ refId: "a", description: "Saved A", offsetDays: 4 }],
    };
    writeFileSync(file, JSON.stringify(saved));
    const calls = fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { template: { ...template, version: 3 } },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--from-file", file], io), 0);
    const put = calls.at(-1);
    assert.deepEqual({ expectedVersion: put.body.expectedVersion, revision: put.body.revision }, { expectedVersion: 2, revision: "rev-saved" });
    assert.equal(put.body.definition.id, undefined);
    assert.equal(put.body.definition.version, undefined);
    assert.equal(put.body.definition.revision, undefined);
    assert.deepEqual(put.body.definition.taskDefinitions, [{ refId: "a", description: "Saved A", offsetDays: 4 }]);
  });

  test("update rejects --file together with --from-file", async () => {
    fakePortal({});
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--file", "a.json", "--from-file", "b.json"], io), 2);
  });

  test("a 409 surfaces the current pair as a conflict", async () => {
    fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { status: 409, body: { error: "Template changed", code: "template_version_conflict", currentVersion: 9, currentTemplate: { ...template, version: 9, revision: "rev-9" } } },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--task", "a", "--offset-days", "1"], io), 5);
    assert.match(io.errors.join("\n"), /Current version is 9 \(revision rev-9\)/);
  });

  test("a 422 reports issues as invalid input", async () => {
    fakePortal({
      ...findRoutes,
      "PUT /api/templates/tpl-1": { status: 422, body: { error: "bad", code: "invalid-template", issues: ["cycle"] } },
    });
    const io = captureIo();
    assert.equal(await run(["templates", "update", "tpl-1", "--task", "a", "--offset-days", "1"], io), 6);
  });

  test("reset and delete confirm, version, and refuse Git templates in words", async () => {
    const git = { ...template, id: "tpl-git", type: "git-type", origin: "git", pinned: true };
    const calls = fakePortal({
      "GET /api/templates/tpl-git": { template: git },
      "GET /api/templates": { templates: [git] },
      "POST /api/templates/tpl-git/reset": { template: { ...git, pinned: false }, applied: true },
      "DELETE /api/templates/tpl-git": { status: 409, body: { error: "Only custom Templates can be deleted", code: "cannot-delete-git-template" } },
    });
    const confirm = captureIo();
    assert.equal(await run(["templates", "delete", "tpl-git"], confirm), 2);
    assert.match(confirm.errors.join("\n"), /--yes/);
    assert.equal(calls.some(({ method }) => method === "DELETE"), false);
    const io = captureIo();
    assert.equal(await run(["templates", "reset", "tpl-git"], io), 0);
    assert.deepEqual(calls.at(-1).body, { expectedVersion: 3, revision: "rev-1" });
    const refused = captureIo();
    assert.equal(await run(["templates", "delete", "tpl-git", "--yes"], refused), 5);
    assert.match(refused.errors.join("\n"), /Only custom Templates can be deleted/);
  });
});
