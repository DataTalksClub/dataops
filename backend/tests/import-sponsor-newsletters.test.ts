import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ImportFailure,
  issueBody,
  leadIssues,
  matchExisting,
  missingFields,
  newsletterBody,
  parseArguments,
  plan,
  recordsFromScan,
} from "../scripts/import-sponsor-newsletters";

const weekly = {
  name: "Example Weekly",
  slug: "example-weekly",
  publisher: "Example Press",
  url: "https://www.weekly.example.invalid/archive",
  senders: ["weekly@news.example.invalid"],
  cadence: "Weekly",
  expectedIntervalDays: 7,
  subscriptionStatus: "subscribed",
  platform: "substack",
  issues: [
    {
      issueKey: "weekly.example.invalid/p/2",
      title: "Two",
      publishedAt: "2026-10-08",
      url: "https://weekly.example.invalid/p/2",
      source: "public-archive",
      sponsors: [
        { name: "Acme", url: "https://acme.example.invalid", category: "tool", blurb: "Bits\u0001" },
        { name: "acme", url: "https://acme.example.invalid/x" },
        { name: "Beta", url: "http://beta.example.invalid" },
      ],
    },
    { issueKey: "weekly.example.invalid/p/1", title: "One", publishedAt: "2026-10-01", url: null, source: "public-archive", sponsors: [] },
  ],
};

describe("sponsor newsletter import", () => {
  it("is a dry run unless --write is passed", () => {
    assert.equal(parseArguments(["--source", "catalog.json"]).write, false);
    assert.equal(parseArguments(["--source", "catalog.json", "--write"]).write, true);
    assert.throws(() => parseArguments([]), ImportFailure);
    assert.throws(() => parseArguments(["--source", "x", "--bogus"]), ImportFailure);
  });

  it("sends only API fields, folding the publisher into notes", () => {
    const body = newsletterBody(weekly);
    assert.equal(body.platform, undefined);
    assert.equal(body.issues, undefined);
    assert.equal(body.notes, "Publisher: Example Press.");
  });

  it("keeps https links only and one sponsor per name and site", () => {
    const body = issueBody(weekly.issues[0]);
    assert.deepEqual(body.sponsors, [
      { name: "Acme", url: "https://acme.example.invalid/", category: "tool", blurb: "Bits" },
      { name: "Beta" },
    ]);
    assert.equal(issueBody(weekly.issues[1]).url, undefined);
  });

  it("matches existing records by slug, name, or domain and only fills gaps", () => {
    const existing = [
      { id: "1", name: "Other", slug: "other", url: "https://other.example.invalid", version: 1 },
      { id: "2", name: "Weekly (old)", slug: "weekly-old", url: "https://weekly.example.invalid", senders: [], notes: "", version: 3 },
    ];
    const match = matchExisting(weekly, existing);
    assert.equal(match?.id, "2");
    const patch = missingFields(newsletterBody(weekly), match!);
    assert.deepEqual(Object.keys(patch).sort(), ["cadence", "expectedIntervalDays", "notes", "senders"]);
    assert.equal(matchExisting({ ...weekly, url: "https://new.example.invalid", senders: [] }, existing), null);
  });

  it("gives delivered leads their inbox issue and plans counts", () => {
    const leads = [
      { sourceType: "leads-intake", messageId: "<m1>", newsletter: { name: "Weekly!", sender: "weekly@news.example.invalid", subject: "Three", receivedAt: "2026-10-13T08:00:00Z" } },
      { sourceType: "leads-intake", messageId: "<m1>", newsletter: { name: "Weekly!", sender: "weekly@news.example.invalid", subject: "Three", receivedAt: "2026-10-13T08:00:00Z" } },
      { sourceType: "leads-intake", messageId: "<probe>", newsletter: { name: "Probe", sender: "probe@example.invalid" } },
    ];
    const delivered = leadIssues(leads, [weekly]);
    assert.equal(delivered.issues.length, 1);
    assert.deepEqual(delivered.unmatched, ["Probe"]);
    const { summary } = plan([weekly], [], leads);
    assert.equal(summary.create, 1);
    assert.equal(summary.issues, 3);
    assert.equal(summary.issuesWithSponsors, 1);
    assert.equal(summary.sponsorSightings, 2);
  });

  it("reads newsletter and lead records from a DynamoDB scan export", () => {
    const scan = {
      Items: [
        { PK: { S: "NEWSLETTER#1" }, name: { S: "Example Weekly" }, senders: { L: [{ S: "weekly@news.example.invalid" }] }, version: { N: "2" } },
        { PK: { S: "LEAD#1" }, messageId: { S: "<m1>" }, newsletter: { M: { name: { S: "Weekly" } } } },
      ],
    };
    assert.deepEqual(recordsFromScan(scan, "NEWSLETTER#"), [
      { PK: "NEWSLETTER#1", name: "Example Weekly", senders: ["weekly@news.example.invalid"], version: 2 },
    ]);
    assert.equal(recordsFromScan(scan, "LEAD#")[0].newsletter.name, "Weekly");
  });
});
