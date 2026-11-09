/**
 * A newsletter slot booking carries the sponsor email route (To, Cc, sender,
 * Gmail thread). Sending `email-sponsor` records it and copies it onto the
 * slot's send Tasks; `report/send` replies in that thread and closes the Task;
 * a missing route is an error. All sponsors and addresses are synthetic.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { createTemplate } from "../src/db/templates";
import { getTask, listTasksByCard } from "../src/db/tasks";
import { getNewsletterIssue, updateNewsletterIssue } from "../src/db/newsletterIssues";
import { recordSponsorRouteAfterSend, SponsorRouteError } from "../src/newsletter/sponsorRoute";
import { setSponsorDocEmailDepsForTests, type SponsorDocEmailDelivery } from "../src/sponsorDocs/emailDelivery";

const invoke = (method: string, pathName: string, body?: unknown) =>
  handler({ httpMethod: method, path: pathName, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) }, {});
const data = (response: any) => JSON.parse(response.body);
const addDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const sent = (overrides: Partial<SponsorDocEmailDelivery> = {}): SponsorDocEmailDelivery => ({
  state: "sent", from: "orin@datatalks.club", to: "contact@sponsor.example", cc: ["valeriia@datatalks.club"],
  subject: "Sponsorship document", messageId: "msg-initial", threadId: "thread-initial", ...overrides,
});

describe("sponsor email route", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    const slotTask = (refId: string) => ({ refId, description: refId, offsetDays: 1, optionalGroup: "primary-slot" });
    await createTemplate(client, {
      name: "Newsletter", type: "newsletter", cardTitle: "{date} · #{issue} · {sponsors}",
      taskDefinitions: [
        { refId: "write-issue", description: "Write the issue", offsetDays: -3 },
        slotTask("email-sponsor"), slotTask("send-performance-to-sponsor"), slotTask("send-email-sponsor-publication-live"),
      ],
    });
  });
  after(() => {
    setSponsorDocEmailDepsForTests({});
    return stopLocal();
  });

  const bookedIssue = async (sponsor = "Synthetic Sponsor") => {
    const created = await invoke("POST", "/api/newsletter-issues", {
      kind: "weekly", publicationDate: addDays(5), issueNumber: 900 + Math.floor(Math.random() * 1000),
      slots: { primary: { sponsor }, secondary: {} },
    });
    assert.equal(created.statusCode, 201, created.body);
    const issue = data(created);
    assert.ok(issue.cardId);
    const tasks = await listTasksByCard(client, issue.cardId);
    const byRef = (ref: string) => tasks.find((task) => task.templateTaskRef === ref)!;
    return { issue, byRef };
  };

  it("sending email-sponsor records the route on the slot and copies it onto the send Tasks", async () => {
    const { issue, byRef } = await bookedIssue();
    await recordSponsorRouteAfterSend(client, byRef("email-sponsor").id, sent());
    const route = { to: "contact@sponsor.example", cc: ["valeriia@datatalks.club"], sender: "orin@datatalks.club", threadRef: "thread-initial" };
    assert.deepEqual((await getNewsletterIssue(client, issue.id))!.slots.primary!.route, route);
    for (const ref of ["send-performance-to-sponsor", "send-email-sponsor-publication-live"]) {
      assert.deepEqual((await getTask(client, byRef(ref).id))!.sponsorRoute, route, ref);
    }
    assert.equal((await getTask(client, byRef("email-sponsor").id))!.sponsorRoute, undefined);
    const report = data(await invoke("GET", `/api/newsletter-issues/${issue.id}/report`));
    assert.deepEqual(report.report.route, route);
  });

  it("ignores other Tasks and fails loudly when the send has no thread", async () => {
    const { issue, byRef } = await bookedIssue();
    await recordSponsorRouteAfterSend(client, byRef("send-performance-to-sponsor").id, sent());
    assert.equal((await getNewsletterIssue(client, issue.id))!.slots.primary!.route, undefined);
    await assert.rejects(
      recordSponsorRouteAfterSend(client, byRef("email-sponsor").id, sent({ threadId: undefined })),
      (error: Error) => error instanceof SponsorRouteError && /sent \(Gmail message msg-initial\) but its route was not recorded/.test(error.message),
    );
    assert.equal((await getNewsletterIssue(client, issue.id))!.slots.primary!.route, undefined);
  });

  it("report --send replies in the recorded thread, closes the Task with the Gmail message id, and refuses without a route", async () => {
    const { issue, byRef } = await bookedIssue();
    const withStats = async () => {
      const current = (await getNewsletterIssue(client, issue.id))!;
      return updateNewsletterIssue(client, current, {
        slots: { ...current.slots, primary: { ...current.slots.primary, stats: { clicks: 10, recordedAt: new Date().toISOString() } } },
      });
    };
    await withStats();

    const missing = await invoke("POST", `/api/newsletter-issues/${issue.id}/report/send`, { slot: "primary", contactName: "Sam" });
    assert.equal(missing.statusCode, 422, missing.body);
    assert.equal(data(missing).code, "sponsor_route_missing");

    await recordSponsorRouteAfterSend(client, byRef("email-sponsor").id, sent());
    const noContact = await invoke("POST", `/api/newsletter-issues/${issue.id}/report/send`, { slot: "primary" });
    assert.equal(noContact.statusCode, 400, noContact.body);

    const sends: Array<Record<string, unknown>> = [];
    setSponsorDocEmailDepsForTests({
      brokerUrl: "https://dapier.example.test",
      credential: "dp_test",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        if (url === "https://dapier.example.test/api/agent/token") return json({ access_token: "ya29.test", provider_account_id: "orin@datatalks.club" });
        if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/threads/thread-initial")) {
          return json({ messages: [{ payload: { headers: [{ name: "Subject", value: "Sponsorship document" }, { name: "Message-ID", value: "<first@mail.example>" }] } }, { payload: { headers: [{ name: "Message-ID", value: "<last@mail.example>" }] } }] });
        }
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
          sends.push(JSON.parse(String(init?.body)));
          return json({ id: "msg-report", threadId: "thread-initial" });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch,
    });

    const ok = await invoke("POST", `/api/newsletter-issues/${issue.id}/report/send`, { slot: "primary", contactName: "Sam" });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].threadId, "thread-initial");
    const raw = Buffer.from(String(sends[0].raw), "base64url").toString("utf8");
    assert.match(raw, /^To: contact@sponsor\.example$/m);
    assert.match(raw, /^Cc: valeriia@datatalks\.club$/m);
    assert.match(raw, /^Subject: Re: Sponsorship document$/m);
    assert.match(raw, /^In-Reply-To: <last@mail\.example>$/m);
    assert.match(raw, /Hi Sam/);
    const task = (await getTask(client, byRef("send-performance-to-sponsor").id))!;
    assert.equal(task.status, "done");
    assert.match(task.comment || "", /Gmail message ID: msg-report/);

    const again = await invoke("POST", `/api/newsletter-issues/${issue.id}/report/send`, { slot: "primary", contactName: "Sam" });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(sends.length, 1);
  });
});
