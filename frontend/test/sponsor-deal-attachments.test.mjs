import assert from "node:assert/strict";
import { test } from "node:test";

import { createSponsorRecord } from "../src/surfaces/finance/sponsor-record.js";
import { dealAttachmentsMarkup, dealsListMarkup } from "../src/surfaces/finance/sponsor-record-markup.js";
import { createApiStub, escapeHtml, FakeNode } from "./support/fake-record-dom.mjs";

const company = {
  id: "c1",
  displayName: "Vivix",
  domain: "vivix.ai",
  relationship: "customer",
  active: true,
  primaryPerson: null,
  version: 1,
};

const preview = {
  targetType: "organization",
  targetId: "c1",
  items: [],
  total: 0,
  nextCursor: null,
  sources: {},
  relatedWork: [],
  tasksScope: "open",
  reads: {},
};

test("dealAttachmentsMarkup renders attachment list, download/remove actions, and upload input", () => {
  const markup = dealAttachmentsMarkup({
    id: "d1",
    attachments: [
      {
        id: "att1",
        filename: "Signed <Contract>.pdf",
        sizeBytes: 109756,
        createdAt: "2026-11-25T10:00:00.000Z",
        note: "DocuSign",
      },
    ],
  });
  assert.match(markup, /Attachments \(1\)/);
  assert.match(markup, /Signed &lt;Contract&gt;\.pdf/);
  assert.match(markup, /107\.2 KB/);
  assert.match(markup, /DocuSign/);
  assert.match(markup, /data-download-attachment="att1"/);
  assert.match(markup, /data-delete-attachment="att1"/);
  assert.match(markup, /data-attach-file-input="d1"/);
});

test("Deals tab lists attachments and downloads via authorized signed URL", async () => {
  const calls = [];
  const openedUrls = [];
  const api = createApiStub({
    "GET /directory/companies/c1": company,
    "GET /activity/organization/c1?limit=3": preview,
    "GET /deals?organizationId=c1&limit=50": {
      items: [
        {
          id: "d1",
          organizationId: "c1",
          status: "agreed",
          productKind: "one-off",
          attachments: [
            {
              id: "att1",
              dealId: "d1",
              filename: "VVX-Signed.pdf",
              sizeBytes: 109756,
              createdAt: "2026-11-25T10:16:00.000Z",
            },
          ],
        },
      ],
      nextCursor: null,
    },
    // An exact deal link reads the deal by ID beside the company projection.
    "GET /deals/d1": {
      id: "d1",
      organizationId: "c1",
      status: "agreed",
      productKind: "one-off",
      attachments: [
        {
          id: "att1",
          dealId: "d1",
          filename: "VVX-Signed.pdf",
          sizeBytes: 109756,
          createdAt: "2026-11-25T10:16:00.000Z",
        },
      ],
    },
    "GET /deals/d1/attachments/att1/download": {
      downloadUrl: "https://private-bucket.s3.amazonaws.com/crm-deals/d1/signed?X-Amz-Signature=abc&X-Amz-Expires=300",
      expiresIn: 300,
      filename: "VVX-Signed.pdf",
    },
    "DELETE /deals/d1/attachments/att1": {},
  }, calls);

  const surface = new FakeNode("section");
  const host = surface.setQuery("[data-crm-record]", new FakeNode("article"));
  const panels = {};
  for (const name of ["overview", "people", "activity", "deals", "finance"]) {
    panels[name] = host.setQuery(`[data-record-panel="${name}"]`, new FakeNode("section"));
  }
  host.setQuery("[data-record-header]", new FakeNode("header"));
  host.setQuery("[data-record-title]", new FakeNode("h2"));

  const record = createSponsorRecord({
    api,
    surface,
    escapeHtml,
    closeRecord: () => {},
    loadFinance: async () => {},
    openDownloadUrl: (url) => openedUrls.push(url),
  });
  record.wire(host);

  await record.openCompany("c1", { dealId: "d1" });
  await record.switchTab("deals");
  assert.match(panels.deals.innerHTML, /VVX-Signed\.pdf/);
  assert.match(panels.deals.innerHTML, /data-download-attachment="att1"/);

  await host.dispatch("click", {
    closestPatch: {
      "[data-download-attachment]": {
        dataset: { downloadAttachment: "att1", attachmentDeal: "d1" },
      },
    },
  });
  assert.equal(openedUrls.length, 1);
  assert.match(openedUrls[0], /X-Amz-Signature=abc/);

  await host.dispatch("click", {
    closestPatch: {
      "[data-delete-attachment]": {
        dataset: { deleteAttachment: "att1", attachmentDeal: "d1" },
      },
    },
  });
  assert.match(panels.deals.innerHTML, /No attachments yet\./);
});
