import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const MARKER_IBAN = "IBAN-MARKER-9f8e7d6c5b4a";

const PROFILE = {
  company: {
    legalName: "DataTalks Club OÜ",
    tradeName: "DataTalks.Club",
    registeredAddress: { line1: "Marker Street 1", city: "Marker City", postalCode: "00001", country: "Markerland" },
    tax: { vatId: "MARKER-VAT-1" },
    contact: { email: "ops@datatalks.club" },
    bankAccounts: [{ id: "eur", label: "Euro account", currency: "EUR", updatedAt: "2026-10-17T10:00:00Z", updatedBy: "u1" }],
    version: 2,
  },
};

describe("CLI company", () => {
  beforeEach(() => {
    isolateConfig();
  });

  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("show prints the profile and bank summaries without values", async () => {
    const io = captureIo();
    const fake_ = fake({ "GET /api/company": { status: 200, body: PROFILE } });
    try {
      const code = await run(["company", "show"], io);
      assert.equal(code, 0);
      assert.match(io.text(), /DataTalks Club OÜ/);
      assert.match(io.text(), /eur/);
      assert.equal(io.text().includes(MARKER_IBAN), false);
    } finally { fake_.restore(); }
  });

  test("show --section rejects unknown sections before any call", async () => {
    const io = captureIo();
    const portal = fake({});
    try {
      const code = await run(["company", "show", "--section", "vat"], io);
      assert.equal(code, 2);
      assert.equal(portal.calls.length, 0);
    } finally { portal.restore(); }
  });

  test("set reads the version first, then writes", async () => {
    const io = captureIo();
    const portal = fake({
      "GET /api/company": { status: 200, body: PROFILE },
      "PUT /api/company": (call) => ({ status: 200, body: { company: { ...PROFILE.company, version: 3 } } }),
    });
    try {
      const code = await run(["company", "set", "--data", '{"legalName":"DataTalks Club OÜ"}'], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 2);
      assert.equal(portal.calls[1].body.expectedVersion, 2);
      assert.equal(portal.calls[1].body.legalName, "DataTalks Club OÜ");
    } finally { portal.restore(); }
  });

  test("set-bank puts label, currency and details", async () => {
    const io = captureIo();
    const portal = fake({
      "PUT /api/company/bank/eur": { status: 200, body: { account: { id: "eur", label: "Euro account", currency: "EUR" } } },
    });
    try {
      const code = await run(["company", "set-bank", "eur", "--label", "Euro account", "--currency", "EUR", "--field", "BIC=X"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls[0].route, "/api/company/bank/eur");
      assert.deepEqual(portal.calls[0].body, { label: "Euro account", currency: "EUR", details: { BIC: "X" } });
    } finally { portal.restore(); }
  });

  test("delete-bank deletes the account", async () => {
    const io = captureIo();
    const portal = fake({ "DELETE /api/company/bank/eur": { status: 200, body: { deleted: true, id: "eur" } } });
    try {
      const code = await run(["company", "delete-bank", "eur"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls[0].route, "/api/company/bank/eur");
    } finally { portal.restore(); }
  });

  test("import dry-run prints the plan with field names only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "company-import-"));
    const file = path.join(dir, "company.json");
    writeFileSync(file, JSON.stringify({
      profile: { legalName: "DataTalks Club OÜ", tax: { vatId: "MARKER-VAT-1" } },
      bankAccounts: [{ id: "eur", label: "Euro account", currency: "EUR", details: { IBAN: MARKER_IBAN } }],
    }));
    const io = captureIo();
    const portal = fake({});
    try {
      const code = await run(["company", "import", "--from-file", file], io);
      assert.equal(code, 0);
      assert.match(io.text(), /dry-run/);
      assert.match(io.text(), /eur/);
      assert.match(io.text(), /IBAN/);
      assert.equal(io.text().includes(MARKER_IBAN), false);
      assert.equal(portal.calls.length, 0);
    } finally {
      portal.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("import --apply writes the profile then each bank account", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "company-import-"));
    const file = path.join(dir, "company.json");
    writeFileSync(file, JSON.stringify({
      profile: { legalName: "DataTalks Club OÜ" },
      bankAccounts: [{ id: "eur", label: "Euro account", currency: "EUR", details: { IBAN: MARKER_IBAN } }],
    }));
    const io = captureIo();
    const portal = fake({
      "GET /api/company": { status: 200, body: { company: { ...PROFILE.company, version: 0 } } },
      "PUT /api/company": { status: 200, body: { company: { ...PROFILE.company, version: 1 } } },
      "PUT /api/company/bank/eur": { status: 200, body: { account: { id: "eur" } } },
    });
    try {
      const code = await run(["company", "import", "--from-file", file, "--apply"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.map((call) => `${call.method} ${call.route}`).join("\n"),
        "GET /api/company\nPUT /api/company\nPUT /api/company/bank/eur");
      assert.equal(io.text().includes(MARKER_IBAN), false);
    } finally {
      portal.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 403 surfaces as exit code 3", async () => {
    const io = captureIo();
    fake({ "GET /api/company": { status: 403, body: { error: "Admin access required" } } });
    try {
      const code = await run(["company", "show"], io);
      assert.equal(code, 3);
    } finally { delete globalThis.fetch; }
  });
});
