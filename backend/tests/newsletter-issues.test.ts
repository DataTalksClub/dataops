import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { createSession } from "../src/db/sessions";
import { getCard, updateCard } from "../src/db/cards";
import { createTemplate } from "../src/db/templates";
import { listTasksByCard, updateTask } from "../src/db/tasks";
import { TABLE_CARDS, TABLE_NEWSLETTER_SLOTS, TABLE_TASKS } from "../src/db/tableNames";
import { createCrmRecord } from "../src/db/sponsorCrm";
import { newsletterOverlayItem } from "../src/calendar/newsletterOverlay";
import { handleNewsletterIssueRoutes } from "../src/routes/newsletterIssues";

const invoke = (
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
) =>
  handler(
    {
      httpMethod: method,
      path: pathName,
      headers,
      queryStringParameters: query,
      body: body === undefined ? null : JSON.stringify(body),
    },
    {},
  );
const data = (response: any) => JSON.parse(response.body);
const weekly = (overrides: Record<string, unknown> = {}) => ({
  kind: "weekly",
  publicationDate: "2027-03-01",
  issueNumber: 340,
  slots: { primary: { ticked: true, sponsor: "Sponsor A" }, secondary: { ticked: false } },
  ...overrides,
});

describe("newsletter issues", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    const sponsorTask = (refId: string, group: string) => ({
      refId: `${group === "secondary-slot" ? "secondary-" : ""}${refId}`,
      description: `${group} ${refId}`,
      offsetDays: -7,
      optionalGroup: group,
    });
    await createTemplate(client, {
      name: "Newsletter",
      type: "newsletter",
      cardTitle: "{date} · #{issue} · {sponsors}",
      taskDefinitions: [
        { refId: "write-issue", description: "Write the issue", offsetDays: -3 },
        { refId: "schedule", description: "Schedule the issue", offsetDays: 0 },
        sponsorTask("sponsor-document", "primary-slot"),
        sponsorTask("invoice", "primary-slot"),
        sponsorTask("sponsor-document", "secondary-slot"),
        sponsorTask("invoice", "secondary-slot"),
      ],
    });
    await createTemplate(client, {
      name: "Newsletter Standalone",
      type: "newsletter-standalone",
      cardTitle: "{date} · {sponsor} · {variant}",
      taskDefinitions: [
        { refId: "sponsor-document", description: "Sponsor document", offsetDays: -7 },
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
  const tasksOf = async (cardId: string) =>
    (await listTasksByCard(client, cardId)).map((task) => `${task.templateTaskRef}:${task.status}`).sort();

  it("creates a weekly issue with its Card from the Template of its kind", async () => {
    const issue = await create(weekly({ sourceKey: "issue-340" }));
    assert.equal(issue.label, "Weekly #340");
    assert.ok(issue.cardId);
    assert.equal(issue.card.id, issue.cardId);
    const card = (await getCard(client, issue.cardId))!;
    assert.equal(card.title, "1 Mar · #340 · Sponsor A");
    assert.equal(card.anchorDate, "2027-03-01");
    assert.equal(card.issueNumber, "340");
    assert.equal(card.sponsor, "Sponsor A");
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot"]);
    assert.deepEqual(await tasksOf(card.id), [
      "invoice:todo", "schedule:todo", "sponsor-document:todo", "write-issue:todo",
    ]);
    const again = await invoke("POST", "/api/newsletter-issues", weekly({ sourceKey: "issue-340" }));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(data(again).cardId, issue.cardId);
    const conflicting = await invoke("POST", "/api/newsletter-issues", weekly({ sourceKey: "issue-340", issueNumber: 341 }));
    assert.equal(conflicting.statusCode, 409);
    const reverse = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { cardId: issue.cardId }));
    assert.deepEqual(reverse.items.map((item: any) => item.id), [issue.id]);
  });

  it("creates a stand-alone issue from the stand-alone Template and a cancelled week without a Card", async () => {
    const standalone = await create({
      kind: "standalone",
      publicationDate: "2027-03-03",
      slots: { primary: { ticked: true, sponsor: "Sponsor S" } },
    });
    const card = (await getCard(client, standalone.cardId))!;
    assert.equal(card.title, "3 Mar · Sponsor S · stand-alone");
    assert.deepEqual(await tasksOf(card.id), ["send:todo", "sponsor-document:todo"]);
    const vacation = await create(weekly({
      publicationDate: "2027-03-08",
      issueNumber: undefined,
      status: "cancelled",
      slots: { primary: { ticked: false }, secondary: { ticked: false } },
      planningNote: "Vacation",
    }));
    assert.equal(vacation.cardId, undefined);
  });

  it("validates kinds, slots and fields", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [weekly({ kind: "monthly" }), /Invalid kind/],
      [weekly({ status: "open" }), /Invalid status/],
      [weekly({ publicationDate: "2027-02-30" }), /Invalid publicationDate/],
      [weekly({ slots: { primary: { ticked: false, sponsor: "Early" } } }), /Tick the primary slot/],
      [weekly({ slots: { tertiary: { ticked: true } } }), /no tertiary slot/],
      [weekly({ slots: { primary: { ticked: "yes" } } }), /ticked true or false/],
      [weekly({ slots: { primary: { ticked: true, documentUrl: "http://x" } } }), /documentUrl/],
      [{ kind: "standalone", publicationDate: "2027-03-03", issueNumber: 3, slots: { primary: { ticked: true } } }, /no issueNumber/],
      [{ kind: "standalone", publicationDate: "2027-03-03", slots: { primary: { ticked: false } } }, /always has its slot/],
      [{ kind: "standalone", publicationDate: "2027-03-03", slots: { secondary: { ticked: true } } }, /no secondary slot/],
      [weekly({ cardId: "linked-elsewhere" }), /Unknown field: cardId/],
    ];
    for (const [body, error] of cases) {
      const response = await invoke("POST", "/api/newsletter-issues", body);
      assert.equal(response.statusCode, 400, `${JSON.stringify(body)} -> ${response.body}`);
      assert.match(data(response).error, error);
    }
    const missingBooking = await invoke("POST", "/api/newsletter-issues", weekly({
      slots: { primary: { ticked: true, sponsorBookingId: "no-such-deliverable" } },
    }));
    assert.equal(missingBooking.statusCode, 422);
    const deliverable = await createCrmRecord(client, "deliverable", { title: "Synthetic placement", status: "booked" } as any);
    const booked = await invoke("POST", "/api/newsletter-issues", weekly({
      publicationDate: "2027-03-15",
      issueNumber: 342,
      slots: { primary: { ticked: true, sponsorBookingId: deliverable.item.id } },
    }));
    assert.equal(booked.statusCode, 201, booked.body);
  });

  it("creates the issue and its Card atomically", async () => {
    const before = (await client.send(new ScanCommand({ TableName: TABLE_CARDS }))).Items!.length;
    const tasksBefore = (await client.send(new ScanCommand({ TableName: TABLE_TASKS }))).Items!.length;
    const originalSend = client.send.bind(client);
    (client as any).send = (command: any) => {
      if (command instanceof PutCommand && command.input.TableName === TABLE_NEWSLETTER_SLOTS && command.input.Item?.cardId) {
        return Promise.reject(Object.assign(new Error("synthetic issue write failure"), { name: "InternalServerError" }));
      }
      return originalSend(command);
    };
    await assert.rejects(
      handleNewsletterIssueRoutes("/api/newsletter-issues", "POST", {
        httpMethod: "POST",
        path: "/api/newsletter-issues",
        headers: {},
        queryStringParameters: {},
        body: JSON.stringify(weekly({ publicationDate: "2027-04-05", issueNumber: 345 })),
      }, client).finally(() => {
        (client as any).send = originalSend;
      }),
      /synthetic issue write failure/,
    );
    assert.equal((await client.send(new ScanCommand({ TableName: TABLE_CARDS }))).Items!.length, before);
    assert.equal((await client.send(new ScanCommand({ TableName: TABLE_TASKS }))).Items!.length, tasksBefore);
    const listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { from: "2027-04-05", to: "2027-04-05" }));
    assert.equal(listed.items.length, 0);
  });

  it("ticking a slot adds its Tasks; unticking skips the open ones after confirming done work", async () => {
    let issue = await create(weekly({ publicationDate: "2027-05-03", issueNumber: 350 }));
    let response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      slots: { secondary: { ticked: true } },
    });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    assert.equal(issue.cardSync, "synced");
    let card = (await getCard(client, issue.cardId))!;
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot", "secondary-slot"]);
    assert.ok((await tasksOf(card.id)).includes("secondary-invoice:todo"));
    assert.equal(card.title, "3 May · #350 · Sponsor A");

    response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      slots: { secondary: { ticked: true, sponsor: "Sponsor B" } },
    });
    issue = data(response);
    card = (await getCard(client, issue.cardId))!;
    assert.equal(card.title, "3 May · #350 · Sponsor A + Sponsor B");
    assert.deepEqual(card.secondarySponsors, ["Sponsor B"]);

    const document = (await listTasksByCard(client, card.id)).find((task) => task.templateTaskRef === "secondary-sponsor-document")!;
    await updateTask(client, document.id, { expectedVersion: document.version, patch: { status: "done" } });
    const untick = { version: issue.version, slots: { secondary: { ticked: false } } };
    response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, untick);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(data(response).code, "slot-has-completed-tasks");
    response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { ...untick, confirmSlotRemoval: true });
    assert.equal(response.statusCode, 200, response.body);
    const tasks = await tasksOf(issue.cardId);
    assert.ok(tasks.includes("secondary-sponsor-document:done"));
    assert.ok(tasks.includes("secondary-invoice:skipped"));
    assert.deepEqual((await getCard(client, issue.cardId))!.selectedOptionalGroups, ["primary-slot"]);
  });

  it("pushes date and issue number to the Card and refuses kind changes and Card links", async () => {
    let issue = await create(weekly({ publicationDate: "2027-06-07", issueNumber: 355 }));
    const moved = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      publicationDate: "2027-06-14",
      issueNumber: 356,
    });
    assert.equal(moved.statusCode, 200, moved.body);
    issue = data(moved);
    const card = (await getCard(client, issue.cardId))!;
    assert.equal(card.anchorDate, "2027-06-14");
    assert.equal(card.issueNumber, "356");
    assert.equal(card.title, "14 Jun · #356 · Sponsor A");
    for (const change of [{ kind: "standalone" }, { cardId: null }, { cardId: "other" }]) {
      const response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, ...change });
      assert.equal(response.statusCode, 400, response.body);
    }
    const stale = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: 1, planningNote: "x" });
    assert.equal(stale.statusCode, 409);
  });

  it("refuses to delete an issue's Card on its own", async () => {
    const issue = await create(weekly({ publicationDate: "2027-06-21", issueNumber: 357 }));
    const card = (await getCard(client, issue.cardId))!;
    const response = await invoke("DELETE", `/api/cards/${card.id}`, { expectedVersion: card.version });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(data(response).references.newsletterIssues, [issue.id]);
    assert.ok(await getCard(client, card.id));
  });

  it("cancelling deletes the Card (confirming done work), reinstating creates a new one, deleting removes both", async () => {
    let issue = await create(weekly({ publicationDate: "2027-07-05", issueNumber: 360 }));
    const first = issue.cardId;
    const task = (await listTasksByCard(client, first))[0];
    await updateTask(client, task.id, { expectedVersion: task.version, patch: { status: "done" } });
    let response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, status: "cancelled" });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(data(response).code, "card-has-completed-tasks");
    response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      status: "cancelled",
      confirmCardDeletion: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(await invoke("GET", `/api/newsletter-issues/${issue.id}`));
    assert.equal(issue.status, "cancelled");
    assert.equal(issue.cardId, undefined);
    assert.equal(await getCard(client, first), null);
    assert.equal((await listTasksByCard(client, first)).length, 0);

    response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, status: "planned" });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    assert.ok(issue.cardId && issue.cardId !== first);
    assert.ok(await getCard(client, issue.cardId));

    response = await invoke("DELETE", `/api/newsletter-issues/${issue.id}`, { version: issue.version });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await getCard(client, issue.cardId), null);
    assert.equal((await invoke("GET", `/api/newsletter-issues/${issue.id}`)).statusCode, 404);

    const cancelled = await create(weekly({ publicationDate: "2027-07-12", issueNumber: undefined, status: "cancelled", slots: {} }));
    assert.equal((await invoke("DELETE", `/api/newsletter-issues/${cancelled.id}`, { version: cancelled.version })).statusCode, 204);
  });

  it("lists with booking filters and alerts on open slots, duplicates and Card drift", async () => {
    const range = { from: "2027-09-01", to: "2027-09-30", today: "2027-09-01" };
    const open = await create(weekly({ publicationDate: "2027-09-06", issueNumber: 370, slots: { primary: { ticked: true } } }));
    const booked = await create(weekly({ publicationDate: "2027-09-13", issueNumber: 371 }));
    const duplicate = await create(weekly({ publicationDate: "2027-09-13", issueNumber: 371, slots: { primary: { ticked: false } } }));
    let listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, range));
    const reasons = (id: string) => listed.alerts.filter((alert: any) => alert.issueId === id).map((alert: any) => alert.reasonCode).sort();
    assert.deepEqual(reasons(open.id), ["near-term-open-slot"]);
    assert.deepEqual(reasons(booked.id), ["duplicate-active-issue"]);
    assert.deepEqual(reasons(duplicate.id), ["duplicate-active-issue"]);
    const ids = async (query: Record<string, string>) =>
      data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { ...range, ...query })).items.map((item: any) => item.id).sort();
    assert.deepEqual(await ids({ booked: "false" }), [open.id]);
    assert.deepEqual(await ids({ booked: "true" }), [booked.id]);
    assert.equal((await invoke("GET", "/api/newsletter-issues", undefined, {}, { booked: "maybe" })).statusCode, 400);

    const card = (await getCard(client, booked.cardId))!;
    await updateCard(client, card.id, { expectedVersion: card.version, patch: { anchorDate: "2027-09-14", selectedOptionalGroups: [] } as any });
    listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, range));
    assert.deepEqual(reasons(booked.id), ["card-date-mismatch", "card-slot-tasks-mismatch", "duplicate-active-issue"]);
  });

  it("projects one calendar item per issue with its slot state", () => {
    const base = {
      id: "i1", kind: "weekly" as const, publicationDate: "2026-10-05", issueNumber: 297, status: "sent",
      timeZone: "Europe/Berlin", version: 1, createdAt: "", updatedAt: "",
    };
    const sent = newsletterOverlayItem({
      ...base,
      slots: { primary: { ticked: true, sponsor: "VectorAI DB" }, secondary: { ticked: true, sponsor: "Astronomer" } },
    });
    assert.equal(sent.label, "Weekly #297 · VectorAI DB + Astronomer");
    assert.equal(sent.isAvailableSlot, false);
    assert.deepEqual(sent.newsletter, {
      kind: "weekly", issueNumber: 297, ticked: 2, booked: 2,
      slots: [
        { position: "primary", ticked: true, sponsor: "VectorAI DB" },
        { position: "secondary", ticked: true, sponsor: "Astronomer" },
      ],
    });
    const open = newsletterOverlayItem({ ...base, status: "planned", slots: { primary: { ticked: true }, secondary: { ticked: false } } });
    assert.equal(open.label, "Weekly #297 · open");
    assert.equal(open.isAvailableSlot, true);
  });

  it("requires an authenticated writer", async () => {
    process.env.SKIP_AUTH = "false";
    const range = { from: "2027-01-01", to: "2027-12-31" };
    assert.equal((await invoke("GET", "/api/newsletter-issues", undefined, {}, range)).statusCode, 401);
    assert.equal((await invoke("POST", "/api/newsletter-issues", weekly({ publicationDate: "2027-11-01" }))).statusCode, 401);
    const session = await createSession(client, "newsletter-operator");
    const listed = await invoke("GET", "/api/newsletter-issues", undefined, { authorization: `Bearer ${session.token}` }, range);
    assert.equal(listed.statusCode, 200, listed.body);
  });
});
