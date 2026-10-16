/**
 * A newsletter issue gets its Card N days before it goes out (a workspace
 * setting, earlier when the Template has an earlier Task), from the daily run
 * or "Create card now"; removing a Card that holds no work keeps the issue and
 * moves the Card's links onto it. All sponsors here are synthetic.
 */
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { getCard, updateCard } from "../src/db/cards";
import { createTemplate } from "../src/db/templates";
import { listTasksByCard, updateTask } from "../src/db/tasks";
import { createCrmRecord } from "../src/db/sponsorCrm";
import { updateWorkspaceSettings, getWorkspaceSettings } from "../src/db/workspaceSettings";
import { createDueIssueCards, issueCardLeadDays } from "../src/newsletter/cardSchedule";
import { newsletterOverlayItem } from "../src/calendar/newsletterOverlay";
import { runCron } from "../src/cron/runner";

const invoke = (method: string, pathName: string, body?: unknown, query: Record<string, string> = {}) =>
  handler({
    httpMethod: method,
    path: pathName,
    headers: {},
    queryStringParameters: query,
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
const data = (response: any) => JSON.parse(response.body);
const today = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
let nextNumber = 500;
const weekly = (publicationDate: string, slots: Record<string, unknown> = { primary: {}, secondary: {} }) => ({
  kind: "weekly", publicationDate, issueNumber: nextNumber++, slots,
});

describe("newsletter issue Cards", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    const sponsorTask = (refId: string, group: string, offsetDays: number) => ({
      refId: `${group}-${refId}`, description: `${group} ${refId}`, offsetDays, optionalGroup: group,
    });
    await createTemplate(client, {
      name: "Newsletter",
      type: "newsletter",
      cardTitle: "{date} · #{issue} · {sponsors}",
      cardLinkDefinitions: [{ name: "Sponsorship document" }, { name: "Secondary sponsorship document" }, { name: "Newsletter Markdown" }],
      taskDefinitions: [
        { refId: "write-issue", description: "Write the issue", offsetDays: -3 },
        { refId: "schedule", description: "Schedule the issue", offsetDays: 0 },
        sponsorTask("document", "primary-slot", -14),
        sponsorTask("document", "secondary-slot", -14),
      ],
    });
    await createTemplate(client, {
      name: "Newsletter Standalone",
      type: "newsletter-standalone",
      cardTitle: "{date} · {sponsor} · {variant}",
      taskDefinitions: [
        { refId: "sponsor-document", description: "Sponsor document", offsetDays: -30 },
        { refId: "send", description: "Send", offsetDays: 0 },
      ],
    });
  });
  after(stopLocal);
  afterEach(() => {
    process.env.SKIP_AUTH = "true";
  });

  const create = async (body: Record<string, unknown>) => {
    const response = await invoke("POST", "/api/newsletter-issues", body);
    assert.equal(response.statusCode, 201, response.body);
    return data(response);
  };
  const show = async (id: string) => data(await invoke("GET", `/api/newsletter-issues/${id}`));

  it("takes the lead time from the setting, or the Template's earliest Task when that is earlier", () => {
    assert.equal(issueCardLeadDays({ taskDefinitions: [{ refId: "a", description: "a", offsetDays: -14 }] }, 21), 21);
    assert.equal(issueCardLeadDays({ taskDefinitions: [{ refId: "a", description: "a", offsetDays: -30 }] }, 21), 30);
    assert.equal(issueCardLeadDays({ taskDefinitions: [{ refId: "a", description: "a", offsetDays: 7 }] }, 0), 0);
  });

  it("plans an issue without a Card and says when its Card is due", async () => {
    const far = await create(weekly(addDays(today, 60)));
    assert.equal(far.cardId, undefined);
    assert.equal(far.cardDueDate, addDays(today, 39));
    const listed = data(await invoke("GET", "/api/newsletter-issues", undefined, { from: far.publicationDate, to: far.publicationDate }));
    assert.equal(listed.items[0].cardDueDate, addDays(today, 39));
    assert.deepEqual(listed.alerts.filter((alert: any) => alert.issueId === far.id).map((alert: any) => alert.reasonCode), []);
    const standalone = await create({ kind: "standalone", publicationDate: addDays(today, 60), slots: { primary: {} } });
    assert.equal(standalone.cardDueDate, addDays(today, 30), "the stand-alone Template has a Task 30 days ahead");
    const overlay = newsletterOverlayItem(far, { cardDueDate: far.cardDueDate });
    assert.equal(overlay.newsletter?.cardDueDate, far.cardDueDate);
  });

  it("creates the Card at once for an issue whose Card is already due", async () => {
    const near = await create(weekly(addDays(today, 10)));
    assert.ok(near.cardId);
    assert.ok(await getCard(client, near.cardId));
  });

  it("the daily run creates due Cards once, with only the booked slots' Tasks, and leaves later ones", async () => {
    const setting = await getWorkspaceSettings(client);
    await updateWorkspaceSettings(client, { changes: { newsletterCardLeadDays: 5 }, expectedVersion: setting.version });
    const due = await create(weekly(addDays(today, 20), { primary: { sponsor: "Synthetic Booked" }, secondary: {} }));
    const later = await create(weekly(addDays(today, 40)));
    assert.equal(due.cardId, undefined, "with a 5-day setting the -14 Task still makes it due 14 days ahead");
    const restore = await getWorkspaceSettings(client);
    await updateWorkspaceSettings(client, { changes: { newsletterCardLeadDays: 21 }, expectedVersion: restore.version });

    const dry = await createDueIssueCards(client, today, { dryRun: true });
    assert.ok(dry.due.some((item) => item.issueId === due.id));
    assert.ok(!dry.due.some((item) => item.issueId === later.id));
    assert.equal(dry.created.length, 0);
    assert.equal((await show(due.id)).cardId, undefined, "a dry run writes nothing");

    const result = await runCron(client, new Date(`${today}T08:00:00Z`));
    assert.ok(result.newsletterCards.created.some((item) => item.issueId === due.id));
    const issue = await show(due.id);
    const card = (await getCard(client, issue.cardId))!;
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot"]);
    assert.equal(card.sponsor, "Synthetic Booked");
    assert.equal((await show(later.id)).cardId, undefined);

    const again = await createDueIssueCards(client, today);
    assert.ok(!again.created.some((item) => item.issueId === due.id), "one Card per issue");
    assert.equal((await show(due.id)).cardId, issue.cardId);
  });

  it("Create card now works for any future issue and never makes a second Card", async () => {
    const issue = await create(weekly(addDays(today, 90)));
    const response = await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version });
    assert.equal(response.statusCode, 201, response.body);
    const created = data(response);
    assert.ok(created.cardId);
    assert.equal(created.card.id, created.cardId);
    const repeat = await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: created.version });
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(data(repeat).cardId, created.cardId);
    const cancelled = await create({ ...weekly(addDays(today, 91)), status: "cancelled", issueNumber: undefined });
    assert.equal((await invoke("POST", `/api/newsletter-issues/${cancelled.id}/card`, { version: cancelled.version })).statusCode, 409);
  });

  it("fills a new Card from the Sponsors tab bookings and the issue's links", async () => {
    const issue = await create(weekly(addDays(today, 95), {
      primary: { sponsor: "Synthetic Primary", documentUrl: "https://docs.example.com/primary" },
      secondary: {},
    }));
    const org = (await createCrmRecord(client, "organization", { displayName: "Synthetic Secondary" } as any)).item;
    const deal = (await createCrmRecord(client, "deal", { organizationId: org.id, status: "agreed" } as any)).item;
    const booked = await invoke("POST", "/api/sponsor-crm/deliverables", {
      dealId: deal.id, channel: "secondary", plannedPublicationDate: issue.publicationDate, newsletterIssueId: issue.id,
    });
    assert.equal(booked.statusCode, 201, booked.body);
    const withLinks = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      links: [{ name: "Newsletter Markdown", url: "https://docs.example.com/markdown" }, { name: "Draft notes", url: "https://docs.example.com/notes" }],
    });
    assert.equal(withLinks.statusCode, 200, withLinks.body);
    const response = await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: data(withLinks).version });
    assert.equal(response.statusCode, 201, response.body);
    const created = data(response);
    assert.equal(created.slots.secondary.sponsor, "Synthetic Secondary");
    const card = (await getCard(client, created.cardId))!;
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot", "secondary-slot"]);
    assert.deepEqual(card.secondarySponsors, ["Synthetic Secondary"]);
    assert.match(String(card.title), /Synthetic Primary \+ Synthetic Secondary/);
    assert.deepEqual(card.cardLinks, [
      { name: "Sponsorship document", url: "https://docs.example.com/primary" },
      { name: "Secondary sponsorship document", url: "" },
      { name: "Newsletter Markdown", url: "https://docs.example.com/markdown" },
      { name: "Draft notes", url: "https://docs.example.com/notes" },
    ]);
  });

  it("removes a Card with no work and moves its links to the issue; keeps one with work", async () => {
    let issue = await create(weekly(addDays(today, 100)));
    issue = data(await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version }));
    let card = (await getCard(client, issue.cardId))!;
    card = await updateCard(client, card.id, {
      expectedVersion: card.version,
      patch: { cardLinks: [
        { name: "Sponsorship document", url: "https://docs.example.com/sponsor" },
        { name: "Newsletter Markdown", url: "https://docs.example.com/md" },
        { name: "Mailchimp newsletter", url: "" },
      ] },
    });
    const dry = await invoke("DELETE", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version, dryRun: true });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.deepEqual(data(dry).keep, []);
    assert.deepEqual(data(dry).moves.map((move: any) => move.to), ["primary slot sponsorship document", 'issue link "Newsletter Markdown"']);
    assert.ok(await getCard(client, card.id), "a dry run removes nothing");

    const removed = await invoke("DELETE", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await getCard(client, card.id), null);
    assert.equal((await listTasksByCard(client, card.id)).length, 0);
    issue = await show(issue.id);
    assert.equal(issue.cardId, undefined);
    assert.equal(issue.slots.primary.documentUrl, "https://docs.example.com/sponsor");
    assert.deepEqual(issue.links, [{ name: "Newsletter Markdown", url: "https://docs.example.com/md" }]);

    issue = data(await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version }));
    const recreated = (await getCard(client, issue.cardId))!;
    assert.deepEqual(recreated.cardLinks?.find((link) => link.name === "Newsletter Markdown"), { name: "Newsletter Markdown", url: "https://docs.example.com/md" });
    const task = (await listTasksByCard(client, recreated.id)).find((candidate) => candidate.templateTaskRef === "write-issue")!;
    await updateTask(client, task.id, { expectedVersion: task.version, patch: { status: "done" } });
    const refused = await invoke("DELETE", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(data(refused).code, "card-has-progress");
    assert.deepEqual(data(refused).keep, ["1 Task done"]);
    const confirmed = await invoke("DELETE", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version, confirmCardDeletion: true });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(await getCard(client, recreated.id), null);
  });
});
