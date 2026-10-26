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
import { createCrmRecord, getCrmRecord } from "../src/db/sponsorCrm";
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
  slots: { primary: { sponsor: "Sponsor A" }, secondary: {} },
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
        { refId: "add-newsletter-performance", description: "Add newsletter performance metrics in DataOps", offsetDays: 7 },
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
  /** An issue plus its Card, made with "Create card now". */
  const createWithCard = async (body: Record<string, unknown>) => {
    const issue = await create(body);
    assert.equal(issue.cardId, undefined, "a far-future issue starts without a Card");
    const response = await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version });
    assert.equal(response.statusCode, 201, response.body);
    return data(response);
  };
  const tasksOf = async (cardId: string) =>
    (await listTasksByCard(client, cardId)).map((task) => `${task.templateTaskRef}:${task.status}`).sort();

  it("creates a weekly issue, then its Card from the Template of its kind", async () => {
    const issue = await createWithCard(weekly({ sourceKey: "issue-340" }));
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
      "add-newsletter-performance:todo", "invoice:todo", "schedule:todo", "sponsor-document:todo", "write-issue:todo",
    ]);
    const again = await invoke("POST", "/api/newsletter-issues", weekly({ sourceKey: "issue-340" }));
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(data(again).cardId, issue.cardId);
    const conflicting = await invoke("POST", "/api/newsletter-issues", weekly({ sourceKey: "issue-340", issueNumber: 341 }));
    assert.equal(conflicting.statusCode, 409);
    const reverse = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { cardId: issue.cardId }));
    assert.deepEqual(reverse.items.map((item: any) => item.id), [issue.id]);
  });

  it("creates a stand-alone issue's Card from the stand-alone Template; a cancelled week has none", async () => {
    const standalone = await createWithCard({
      kind: "standalone",
      publicationDate: "2027-03-03",
      slots: { primary: { sponsor: "Sponsor S" } },
    });
    const card = (await getCard(client, standalone.cardId))!;
    assert.equal(card.title, "3 Mar · Sponsor S · stand-alone");
    assert.deepEqual(await tasksOf(card.id), ["send:todo", "sponsor-document:todo"]);
    const vacation = await create(weekly({
      publicationDate: "2027-03-08",
      issueNumber: undefined,
      status: "cancelled",
      slots: { primary: {}, secondary: {} },
      planningNote: "Vacation",
    }));
    assert.equal(vacation.cardId, undefined);
  });

  it("validates kinds, slots and fields", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [weekly({ kind: "monthly" }), /Invalid kind/],
      [weekly({ status: "open" }), /Invalid status/],
      [weekly({ publicationDate: "2027-02-30" }), /Invalid publicationDate/],
      [weekly({ slots: { primary: { bookedByUserId: "someone" } } }), /Name the primary slot's sponsor/],
      [weekly({ slots: { primary: { ticked: true } } }), /Unknown primary slot field: ticked/],
      [weekly({ slots: { tertiary: {} } }), /no tertiary slot/],
      [weekly({ slots: { primary: { documentUrl: "http://x" } } }), /documentUrl/],
      [{ kind: "standalone", publicationDate: "2027-03-03", issueNumber: 3, slots: { primary: {} } }, /no issueNumber/],
      [{ kind: "standalone", publicationDate: "2027-03-03", slots: { secondary: {} } }, /no secondary slot/],
      [weekly({ cardId: "linked-elsewhere" }), /Unknown field: cardId/],
    ];
    for (const [body, error] of cases) {
      const response = await invoke("POST", "/api/newsletter-issues", body);
      assert.equal(response.statusCode, 400, `${JSON.stringify(body)} -> ${response.body}`);
      assert.match(data(response).error, error);
    }
    const booking = await invoke("POST", "/api/newsletter-issues", weekly({
      slots: { primary: { sponsor: "Sponsor A", sponsorBookingId: "a-deliverable" } },
    }));
    assert.equal(booking.statusCode, 400, "the booking lives on the deliverable, not the slot");
  });

  it("creates the Card and the issue's next version atomically", async () => {
    const issue = await create(weekly({ publicationDate: "2027-04-05", issueNumber: 345 }));
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
      handleNewsletterIssueRoutes(`/api/newsletter-issues/${issue.id}/card`, "POST", {
        httpMethod: "POST",
        path: `/api/newsletter-issues/${issue.id}/card`,
        headers: {},
        queryStringParameters: {},
        body: JSON.stringify({ version: issue.version }),
      }, client).finally(() => {
        (client as any).send = originalSend;
      }),
      /synthetic issue write failure/,
    );
    assert.equal((await client.send(new ScanCommand({ TableName: TABLE_CARDS }))).Items!.length, before);
    assert.equal((await client.send(new ScanCommand({ TableName: TABLE_TASKS }))).Items!.length, tasksBefore);
    const stored = data(await invoke("GET", `/api/newsletter-issues/${issue.id}`));
    assert.equal(stored.cardId, undefined);
    assert.equal(stored.version, issue.version);
  });

  it("starts a Card with only the booked slots' Tasks", async () => {
    const open = await createWithCard(weekly({ publicationDate: "2027-05-10", issueNumber: 351, slots: { primary: {}, secondary: {} } }));
    assert.deepEqual((await getCard(client, open.cardId))!.selectedOptionalGroups, []);
    assert.deepEqual(await tasksOf(open.cardId), ["add-newsletter-performance:todo", "schedule:todo", "write-issue:todo"]);
  });

  it("books, changes and releases a slot through the sponsor's deal", async () => {
    const org = (await createCrmRecord(client, "organization", { displayName: "Synthetic Org One" } as any)).item;
    const otherOrg = (await createCrmRecord(client, "organization", { displayName: "Synthetic Org Two" } as any)).item;
    const deal = (await createCrmRecord(client, "deal", { organizationId: org.id, status: "agreed", title: "Synthetic package" } as any)).item;
    const options = data(await invoke("GET", "/api/newsletter-issues/sponsor-options"));
    assert.ok(options.items.some((item: any) => item.dealId === deal.id && item.name === "Synthetic Org One"));
    assert.ok(options.items.some((item: any) => !item.dealId && item.organizationId === otherOrg.id));

    let issue = await createWithCard(weekly({ publicationDate: "2027-05-03", issueNumber: 350 }));
    const slot = `/api/newsletter-issues/${issue.id}/slots/secondary`;
    let response = await invoke("PUT", slot, { version: issue.version, dealId: deal.id });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    assert.equal(issue.cardSync, "synced");
    assert.equal(issue.slots.secondary.sponsor, "Synthetic Org One");
    assert.equal(issue.slots.secondary.organizationId, org.id, "the slot links the sponsor's company");
    const firstBooking = await getCrmRecord(client, "deliverable", issue.deliverableId);
    assert.equal(firstBooking!.newsletterIssueId, issue.id);
    assert.equal(firstBooking!.channel, "secondary");
    assert.equal(firstBooking!.plannedPublicationDate, "2027-05-03");
    let card = (await getCard(client, issue.cardId))!;
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot", "secondary-slot"]);
    assert.ok((await tasksOf(card.id)).includes("secondary-invoice:todo"));
    assert.equal(card.title, "3 May · #350 · Sponsor A + Synthetic Org One");

    // Changing the sponsor is one step: the new booking replaces the old one.
    response = await invoke("PUT", slot, { version: issue.version, organizationId: otherOrg.id });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    assert.equal(issue.slots.secondary.sponsor, "Synthetic Org Two");
    assert.deepEqual(issue.withdrawnDeliverables, [firstBooking!.id]);
    assert.ok((await getCrmRecord(client, "deliverable", firstBooking!.id))!.withdrawnAt, "withdrawn, not deleted");
    const newDeal = await getCrmRecord(client, "deal", issue.dealId);
    assert.equal(newDeal!.organizationId, otherOrg.id);
    assert.equal(newDeal!.status, "open");
    card = (await getCard(client, issue.cardId))!;
    assert.deepEqual(card.secondarySponsors, ["Synthetic Org Two"]);
    assert.deepEqual(card.selectedOptionalGroups, ["primary-slot", "secondary-slot"]);

    const document = (await listTasksByCard(client, card.id)).find((task) => task.templateTaskRef === "secondary-sponsor-document")!;
    await updateTask(client, document.id, { expectedVersion: document.version, patch: { status: "done" } });
    response = await invoke("DELETE", slot, { version: issue.version });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(data(response).code, "slot-has-completed-tasks");
    response = await invoke("DELETE", slot, { version: issue.version, confirmSlotRemoval: true });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    assert.deepEqual(issue.slots.secondary, {});
    assert.equal(issue.withdrawnDeliverables.length, 1);
    const tasks = await tasksOf(issue.cardId);
    assert.ok(tasks.includes("secondary-sponsor-document:done"));
    assert.ok(tasks.includes("secondary-invoice:skipped"));
    assert.deepEqual((await getCard(client, issue.cardId))!.selectedOptionalGroups, ["primary-slot"]);

    assert.equal((await invoke("PUT", `/api/newsletter-issues/${issue.id}/slots/tertiary`, { version: issue.version, dealId: deal.id })).statusCode, 400);
    assert.equal((await invoke("PUT", slot, { version: issue.version })).statusCode, 400);
    assert.equal((await invoke("PUT", slot, { version: 1, dealId: deal.id })).statusCode, 409);
  });

  it("links a newsletter deliverable to its issue, never to a Card", async () => {
    const org = (await createCrmRecord(client, "organization", { displayName: "Synthetic Org Three" } as any)).item;
    const deal = (await createCrmRecord(client, "deal", { organizationId: org.id, status: "open" } as any)).item;
    const issue = await createWithCard(weekly({ publicationDate: "2027-05-24", issueNumber: 353 }));
    const post = (body: Record<string, unknown>) => invoke("POST", "/api/sponsor-crm/deliverables", { dealId: deal.id, ...body });
    assert.equal((await post({ channel: "main", cardId: issue.cardId })).statusCode, 400);
    assert.equal((await post({ channel: "workshop", newsletterIssueId: issue.id })).statusCode, 400);
    assert.equal((await post({ channel: "main", newsletterIssueId: "no-such-issue" })).statusCode, 422);
    const linked = await post({ channel: "main", newsletterIssueId: issue.id, plannedPublicationDate: "2027-05-24" });
    assert.equal(linked.statusCode, 201, linked.body);
    const cleared = await invoke("PUT", `/api/sponsor-crm/deliverables/${data(linked).id}`, { version: 1, newsletterIssueId: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(Object.hasOwn(data(cleared), "newsletterIssueId"), false);
  });

  it("keeps a sent issue's slots read-only", async () => {
    const sent = await create(weekly({ publicationDate: "2027-05-17", issueNumber: 352, status: "sent" }));
    const response = await invoke("DELETE", `/api/newsletter-issues/${sent.id}/slots/primary`, { version: sent.version });
    assert.equal(response.statusCode, 409, response.body);
  });

  it("moving the issue re-derives its open Tasks' due dates and leaves resolved ones alone", async () => {
    let issue = await createWithCard(weekly({ publicationDate: "2027-06-28", issueNumber: 358 }));
    const tasks = await listTasksByCard(client, issue.cardId);
    const done = tasks.find((task) => task.templateTaskRef === "write-issue")!;
    await updateTask(client, done.id, { expectedVersion: done.version, patch: { status: "done" } });
    const response = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, publicationDate: "2027-07-05" });
    assert.equal(response.statusCode, 200, response.body);
    issue = data(response);
    const dates = Object.fromEntries((await listTasksByCard(client, issue.cardId)).map((task) => [task.templateTaskRef, task.date]));
    assert.equal(dates["write-issue"], "2027-06-25", "a done Task keeps its date");
    assert.equal(dates.schedule, "2027-07-05");
    assert.equal(dates["sponsor-document"], "2027-06-28");
    const moved = (await listTasksByCard(client, issue.cardId)).find((task) => task.templateTaskRef === "schedule")!;
    assert.equal(moved.templateDefinitionSnapshot?.date, "2027-07-05", "the Template snapshot moves with the Task");
  });

  it("pushes date and issue number to the Card and refuses kind changes and Card links", async () => {
    let issue = await createWithCard(weekly({ publicationDate: "2027-06-07", issueNumber: 355 }));
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
    const issue = await createWithCard(weekly({ publicationDate: "2027-06-21", issueNumber: 357 }));
    const card = (await getCard(client, issue.cardId))!;
    const response = await invoke("DELETE", `/api/cards/${card.id}`, { expectedVersion: card.version });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(data(response).references.newsletterIssues, [issue.id]);
    assert.ok(await getCard(client, card.id));
  });

  it("cancelling deletes the Card (confirming done work), reinstating waits for the Card's due date, deleting removes both", async () => {
    let issue = await createWithCard(weekly({ publicationDate: "2027-07-05", issueNumber: 360 }));
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
    assert.equal(issue.cardId, undefined, "a far-future issue gets its Card when it is due");
    response = await invoke("POST", `/api/newsletter-issues/${issue.id}/card`, { version: issue.version });
    issue = data(response);
    assert.ok(issue.cardId && issue.cardId !== first);

    response = await invoke("DELETE", `/api/newsletter-issues/${issue.id}`, { version: issue.version });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await getCard(client, issue.cardId), null);
    assert.equal((await invoke("GET", `/api/newsletter-issues/${issue.id}`)).statusCode, 404);

    const cancelled = await create(weekly({ publicationDate: "2027-07-12", issueNumber: undefined, status: "cancelled", slots: {} }));
    assert.equal((await invoke("DELETE", `/api/newsletter-issues/${cancelled.id}`, { version: cancelled.version })).statusCode, 204);
  });

  it("lists with booking filters and alerts on open slots, duplicates and Card drift", async () => {
    const range = { from: "2027-09-01", to: "2027-09-30", today: "2027-09-01" };
    const open = await create(weekly({ publicationDate: "2027-09-06", issueNumber: 370, slots: { primary: {} } }));
    const booked = await createWithCard(weekly({ publicationDate: "2027-09-13", issueNumber: 371 }));
    const duplicate = await create(weekly({ publicationDate: "2027-09-13", issueNumber: 371, slots: { primary: {} } }));
    let listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, range));
    const reasons = (id: string) => listed.alerts.filter((alert: any) => alert.issueId === id).map((alert: any) => alert.reasonCode).sort();
    // On 1 Sep the daily run should already have made the Cards of mid-September issues.
    assert.deepEqual(reasons(open.id), ["card-not-created", "near-term-open-slot"]);
    assert.deepEqual(reasons(booked.id), ["duplicate-active-issue"]);
    assert.deepEqual(reasons(duplicate.id), ["card-not-created", "duplicate-active-issue", "near-term-open-slot"]);
    const ids = async (query: Record<string, string>) =>
      data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { ...range, ...query })).items.map((item: any) => item.id).sort();
    assert.deepEqual(await ids({ booked: "false" }), [open.id, duplicate.id].sort());
    assert.deepEqual(await ids({ booked: "true" }), [booked.id]);
    assert.equal((await invoke("GET", "/api/newsletter-issues", undefined, {}, { booked: "maybe" })).statusCode, 400);

    const card = (await getCard(client, booked.cardId))!;
    await updateCard(client, card.id, { expectedVersion: card.version, patch: { anchorDate: "2027-09-14", selectedOptionalGroups: [] } as any });
    listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, range));
    assert.deepEqual(reasons(booked.id), ["card-date-mismatch", "card-slot-tasks-mismatch", "duplicate-active-issue"]);
  });

  it("does not nag about a sent issue's unfinished Card", async () => {
    let issue = await createWithCard(weekly({ publicationDate: "2027-10-04", issueNumber: 380 }));
    issue = data(await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, status: "sent" }));
    const listed = data(await invoke("GET", "/api/newsletter-issues", undefined, {}, { from: "2027-10-04", to: "2027-10-04", today: "2027-10-05" }));
    assert.deepEqual(listed.alerts.filter((alert: any) => alert.issueId === issue.id), []);
  });

  it("projects one calendar item per issue with its slot state", () => {
    const base = {
      id: "i1", kind: "weekly" as const, publicationDate: "2026-10-05", issueNumber: 297, status: "sent",
      timeZone: "Europe/Berlin", version: 1, createdAt: "", updatedAt: "",
    };
    const sent = newsletterOverlayItem({
      ...base,
      slots: { primary: { sponsor: "VectorAI DB" }, secondary: { sponsor: "Astronomer" } },
    });
    assert.equal(sent.label, "Weekly #297 · VectorAI DB + Astronomer");
    assert.equal(sent.isAvailableSlot, false);
    assert.deepEqual(sent.newsletter, {
      kind: "weekly", issueNumber: 297, booked: 2, cardId: null, cardDueDate: null,
      slots: [
        { position: "primary", sponsor: "VectorAI DB" },
        { position: "secondary", sponsor: "Astronomer" },
      ],
    });
    const open = newsletterOverlayItem({ ...base, status: "planned", slots: { primary: {}, secondary: {} } });
    assert.equal(open.label, "Weekly #297 · open");
    assert.equal(open.isAvailableSlot, true);
  });

  it("records, updates, validates, and reports issue and slot performance stats", async () => {
    let issue = await create(weekly({
      publicationDate: "2026-10-05",
      issueNumber: 297,
      status: "sent",
      slots: {
        primary: {
          sponsor: "VectorAI DB",
          stats: {
            clicks: 831,
            uniqueClicks: 651,
            clickRate: 2.38,
            linkedinImpressions: 8080,
            linkedinClicks: 109,
            linkedinReactions: 42,
            linkedinCtr: 1.35,
            linkedinPostUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7446932215609192448/",
            xImpressions: 2916,
            xClicks: 0,
            xReactions: 3,
            xCtr: 0,
            xPostUrl: "https://x.com/DataTalksClub/status/2041170969592254836",
          },
        },
        secondary: {
          sponsor: "Astronomer",
          stats: {
            clicks: 273,
            uniqueClicks: 185,
            clickRate: 0.78,
            linkedinImpressions: 2639,
            linkedinClicks: 49,
            linkedinCtr: 1.86,
            linkedinPostUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7447329446212612098/",
            xImpressions: 1295,
            xClicks: 7,
            xCtr: 0.54,
            xPostUrl: "https://x.com/DataTalksClub/status/2041566603948195932",
          },
        },
      },
      stats: {
        sent: 99714,
        opens: 34886,
        clicks: 831,
        uniqueClicks: 651,
        openRate: 34.99,
        clickRate: 2.38,
      },
    }));
    assert.equal(issue.stats.sent, 99714);
    assert.equal(issue.stats.opens, 34886);
    assert.equal(issue.stats.openRate, 34.99);
    assert.ok(issue.stats.recordedAt, "recordedAt is stamped automatically");
    assert.equal(issue.slots.primary.stats.clicks, 831);
    assert.equal(issue.slots.primary.stats.linkedinImpressions, 8080);
    assert.equal(issue.slots.primary.stats.linkedinReactions, 42);
    assert.equal(issue.slots.primary.stats.xReactions, 3);
    assert.ok(issue.slots.primary.stats.recordedAt);
    assert.equal(issue.slots.secondary.stats.clicks, 273);
    assert.equal(issue.slots.secondary.stats.xClicks, 7);

    // Updating one slot's stats preserves the other slot and updates recordedAt when metrics change
    const updated = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      slots: {
        primary: {
          ...issue.slots.primary,
          stats: {
            ...issue.slots.primary.stats,
            xClicks: 12,
            xCtr: 0.41,
          },
        },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    issue = data(updated);
    assert.equal(issue.slots.primary.stats.xClicks, 12);
    assert.equal(issue.slots.secondary.stats.clicks, 273);

    // Report endpoint for a single slot omits "/ 0 clicks" when clicks are 0, and includes it when > 0
    const secondaryReport = data(
      await invoke("GET", `/api/newsletter-issues/${issue.id}/report`, undefined, {}, { slot: "secondary" }),
    );
    assert.equal(secondaryReport.report.sponsor, "Astronomer");
    assert.equal(secondaryReport.report.slot, "secondary");
    assert.equal(secondaryReport.report.newsletter.sent, 99714);
    assert.equal(secondaryReport.report.newsletter.views, 34886);
    assert.equal(secondaryReport.report.newsletter.clicks, 273);
    assert.match(secondaryReport.report.message, /- 34,886 views \/ 273 clicks in the newsletter/);
    assert.match(secondaryReport.report.message, /- 2,639 views \/ 49 clicks in LinkedIn/);
    assert.match(secondaryReport.report.message, /- 1,295 views \/ 7 clicks in Twitter/);
    assert.match(secondaryReport.report.message, /So 38,820 views and 329 clicks in total/);

    // Reset xClicks to 0 on primary to verify zero-click social formatting rule
    issue = data(
      await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
        version: issue.version,
        slots: {
          primary: {
            ...issue.slots.primary,
            stats: { ...issue.slots.primary.stats, xClicks: 0, xCtr: 0 },
          },
        },
      }),
    );
    const primaryReport = data(
      await invoke("GET", `/api/newsletter-issues/${issue.id}/report`, undefined, {}, { slot: "primary" }),
    );
    assert.match(primaryReport.report.message, /- 2,916 views in Twitter\n/);
    assert.doesNotMatch(primaryReport.report.message, /2,916 views \/ 0 clicks/);
    assert.equal(primaryReport.report.linkedin.reactions, 42);
    assert.equal(primaryReport.report.x.reactions, 3);

    // Sponsor-wide report aggregates placements for the requested sponsor
    const sponsorReport = data(
      await invoke("GET", "/api/newsletter-issues/report", undefined, {}, { sponsor: "Astronomer" }),
    );
    assert.equal(sponsorReport.items.length, 1);
    assert.equal(sponsorReport.items[0].slot, "secondary");
    assert.equal(sponsorReport.items[0].sponsor, "Astronomer");

    // Validation errors on malformed stats
    const badCases: [Record<string, unknown>, RegExp][] = [
      [{ stats: { sent: -1 } }, /Invalid stats sent/],
      [{ stats: { openRate: 120 } }, /Invalid stats openRate/],
      [{ stats: { bogus: 1 } }, /Unknown stats field: bogus/],
      [{ stats: { deliveries: 1 } }, /Unknown stats field: deliveries/],
      [{ slots: { primary: { sponsor: "VectorAI DB", stats: { clicks: -5 } } } }, /Invalid primary slot stats clicks/],
      [{ slots: { primary: { sponsor: "VectorAI DB", stats: { clickRate: 200 } } } }, /Invalid primary slot stats clickRate/],
      [{ slots: { primary: { sponsor: "VectorAI DB", stats: { linkedinPostUrl: "http://linkedin.com/x" } } } }, /Invalid primary slot stats linkedinPostUrl/],
      [{ slots: { primary: { sponsor: "VectorAI DB", stats: { linkedinReactions: -1 } } } }, /Invalid primary slot stats linkedinReactions/],
      [{ slots: { primary: { sponsor: "VectorAI DB", stats: { unknownMetric: 1 } } } }, /Unknown primary slot stats field: unknownMetric/],
    ];
    for (const [patch, pattern] of badCases) {
      const bad = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, { version: issue.version, ...patch });
      assert.equal(bad.statusCode, 400, `${JSON.stringify(patch)} -> ${bad.body}`);
      assert.match(data(bad).error, pattern);
    }

    // Clearing issue stats with null removes the stats object
    const cleared = await invoke("PUT", `/api/newsletter-issues/${issue.id}`, {
      version: issue.version,
      stats: null,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(data(cleared).stats, undefined);
  });

  it("auto-closes the metrics task when the issue metrics become complete", async () => {
    const created = await createWithCard(weekly({
      sourceKey: "issue-metrics-autoclose",
      publicationDate: "2027-11-02",
      issueNumber: 390,
      slots: { primary: { sponsor: "Sponsor A" }, secondary: {} },
    }));
    const metricsOf = async () =>
      (await listTasksByCard(client, created.cardId)).find((task) => task.templateTaskRef === "add-newsletter-performance")!;
    assert.equal((await metricsOf()).status, "todo");

    // Opens alone are not complete: the task stays open.
    let issue = data(await invoke("PUT", `/api/newsletter-issues/${created.id}`, {
      version: created.version,
      stats: { opens: 34886, openRate: 34.99 },
    }));
    assert.equal(issue.metricsTask, "open");
    assert.equal((await metricsOf()).status, "todo");

    // Sent counts plus the booked slot's link clicks complete the metrics.
    issue = data(await invoke("PUT", `/api/newsletter-issues/${created.id}`, {
      version: issue.version,
      stats: { sent: 99714, opens: 34886, openRate: 34.99 },
      slots: { primary: { sponsor: "Sponsor A", stats: { clicks: 831, uniqueClicks: 651 } } },
    }));
    assert.equal(issue.metricsTask, "closed");
    const closed = await metricsOf();
    assert.equal(closed.status, "done");
    assert.match(closed.externalStatus || "", /99714 sent, 34886 opens/);
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
