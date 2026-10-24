import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPONSORS_TABS, sponsorsPath } from "../src/core/sponsor-routes.js";
import { CRM_PRIMARY_TABS, crmNavModel } from "../src/surfaces/finance/sponsor-navigation.js";
import { DIRECTORY_FILTER_KEYS, validateDirectoryState } from "../src/surfaces/finance/sponsor-directory.js";
import { validateViewFilters } from "../src/surfaces/finance/sponsor-saved-views.js";
import { personHeaderMarkup } from "../src/surfaces/finance/sponsor-person-detail.js";
import { recordHeaderMarkup } from "../src/surfaces/finance/sponsor-record-markup.js";

describe("CRM follow-ups and DNC frontend surface components", () => {
  it("registers followups tab in sponsor routes and navigation", () => {
    assert.equal(sponsorsPath("followups"), "/sponsors/followups");
    assert.ok(SPONSORS_TABS.some(([id, label]) => id === "followups" && label === "Follow-ups"));
    assert.ok(CRM_PRIMARY_TABS.some((tab) => tab.id === "followups" && tab.label === "Follow-ups"));
    const nav = crmNavModel("followups");
    const current = nav.primary.find((t) => t.id === "followups");
    assert.ok(current?.current);
  });

  it("directory filter keys and validation support tag, contact dates, dnc, and noDeal", () => {
    for (const key of ["tag", "firstContactAfter", "firstContactBefore", "lastContactAfter", "lastContactBefore", "dnc"]) {
      assert.ok(DIRECTORY_FILTER_KEYS.companies.includes(key), `companies missing ${key}`);
      assert.ok(DIRECTORY_FILTER_KEYS.people.includes(key), `people missing ${key}`);
    }
    assert.ok(DIRECTORY_FILTER_KEYS.people.includes("noDeal"));

    assert.equal(
      validateDirectoryState("companies", {
        tag: "inbound",
        firstContactAfter: "2026-09-01",
        lastContactBefore: "2026-10-01",
        dnc: "false",
      }),
      "",
    );

    assert.equal(
      validateDirectoryState("people", {
        tag: "inbound",
        firstContactAfter: "2026-09-01",
        lastContactBefore: "2026-10-01",
        dnc: "false",
        noDeal: "true",
      }),
      "",
    );

    assert.equal(
      validateViewFilters("people", {
        tag: "inbound",
        lastContactBefore: { daysAgo: 21 },
        dnc: "false",
        noDeal: "true",
      }),
      "",
    );
  });

  it("person header renders DNC badge and toggle button when person is marked DNC", () => {
    const dncPerson = { id: "p1", name: "Allie Beazell", doNotContact: true };
    const html = personHeaderMarkup(dncPerson, { canEdit: true }, { escapeHtml: (s) => s });
    assert.ok(html.includes("Do Not Contact"));
    assert.ok(html.includes("data-toggle-person-dnc"));
    assert.ok(html.includes("Remove DNC"));

    const normalPerson = { id: "p2", name: "Normal Person", doNotContact: false };
    const normalHtml = personHeaderMarkup(normalPerson, { canEdit: true }, { escapeHtml: (s) => s });
    assert.ok(!normalHtml.includes("data-status=\"dnc\""));
    assert.ok(normalHtml.includes("Mark Do-Not-Contact"));
  });

  it("company header renders DNC badge and toggle button when company is marked DNC", () => {
    const dncCompany = { id: "c1", displayName: "Fabi.ai", doNotContact: true };
    const html = recordHeaderMarkup(dncCompany, { canEdit: true }, { escapeHtml: (s) => s });
    assert.ok(html.includes("Do Not Contact"));
    assert.ok(html.includes("data-toggle-company-dnc"));
    assert.ok(html.includes("Remove DNC"));

    const normalCompany = { id: "c2", displayName: "Normal Corp", doNotContact: false };
    const normalHtml = recordHeaderMarkup(normalCompany, { canEdit: true }, { escapeHtml: (s) => s });
    assert.ok(!normalHtml.includes("data-status=\"dnc\""));
    assert.ok(normalHtml.includes("Mark Do-Not-Contact"));
  });
});
