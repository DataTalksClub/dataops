// ONE-OFF: delete with src/routes/newsletterSlotMigration.ts.
import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { getCard } from "../src/db/cards";
import { createTemplate } from "../src/db/templates";
import { listTasksByCard, updateTask } from "../src/db/tasks";
import { TABLE_NEWSLETTER_SLOTS } from "../src/db/tableNames";
import { getNewsletterIssue, newsletterIssueId } from "../src/db/newsletterIssues";
import { issueSourceKey } from "../scripts/import-newsletter-issues";

const invoke = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) =>
  handler({ httpMethod: method, path, headers: {}, queryStringParameters: query, body: body === undefined ? null : JSON.stringify(body) }, {});
const data = (response: any) => JSON.parse(response.body);

describe("newsletter slot to issue migration", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    const sponsorTask = (refId: string, group: string) => ({
      refId: `${group === "secondary-slot" ? "secondary-" : ""}${refId}`, description: `${group} ${refId}`, offsetDays: -7, optionalGroup: group,
    });
    await createTemplate(client, {
      name: "Newsletter", type: "newsletter", cardTitle: "{date} · #{issue} · {sponsors}",
      cardLinkDefinitions: [{ name: "Sponsorship document" }, { name: "Secondary sponsorship document" }],
      taskDefinitions: [
        { refId: "schedule", description: "Schedule", offsetDays: 0 },
        sponsorTask("create-sponsorship-document", "primary-slot"),
        sponsorTask("create-sponsorship-document", "secondary-slot"),
        sponsorTask("create-invoice", "primary-slot"),
        sponsorTask("create-invoice", "secondary-slot"),
      ],
    });
  });
  after(stopLocal);

  const slotRow = async (sheetId: string, extra: Record<string, unknown>) => {
    const id = newsletterIssueId(issueSourceKey(sheetId));
    await client.send(new PutCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Item: {
      PK: `SLOT#${id}`, SK: `SLOT#${id}`, rangeKey: "SLOTS", publicationKey: `${extra.publicationDate}#${id}`, id, version: 1, ...extra,
    } }));
    return id;
  };
  const slotGone = async (id: string) =>
    !(await client.send(new GetCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: { PK: `SLOT#${id}`, SK: `SLOT#${id}` } }))).Item;

  it("merges a slot pair into one issue, folds the secondary Card, and creates missing Cards", async () => {
    const created = async (date: string) => {
      const issue = data(await invoke("POST", "/api/newsletter-issues", {
        kind: "weekly", publicationDate: date, issueNumber: 1, slots: { primary: { ticked: true } }, sourceKey: `tmp-${date}`,
      }));
      // The cards existed before the issues; detach them from these scratch issues.
      await client.send(new PutCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Item: { PK: `ISSUE#${issue.id}`, SK: `ISSUE#${issue.id}`, gone: true } }));
      return issue.cardId as string;
    };
    const primaryCard = await created("2026-12-01");
    const secondaryCard = await created("2026-12-02");
    const secondaryDoc = (await listTasksByCard(client, secondaryCard)).find((task) => task.templateTaskRef === "create-sponsorship-document")!;
    await updateTask(client, secondaryDoc.id, { expectedVersion: secondaryDoc.version, patch: { status: "done", link: "https://docs.example/b" } as any });
    const secondaryCardNow = (await getCard(client, secondaryCard))!;
    const { updateCard } = await import("../src/db/cards");
    await updateCard(client, secondaryCard, { expectedVersion: secondaryCardNow.version, patch: { cardLinks: [{ name: "Sponsorship document", url: "https://docs.example/b" }] } });

    await slotRow("NL-306", { publicationDate: "2026-12-07", campaignNumber: 306, status: "reserved", cardId: primaryCard });
    await slotRow("NL-306-secondary", { publicationDate: "2026-12-07", status: "reserved", cardId: secondaryCard });
    await slotRow("NL-302", { publicationDate: "2026-11-09", campaignNumber: 302, status: "open" });
    const plan = [
      {
        slotIds: [newsletterIssueId(issueSourceKey("NL-306")), newsletterIssueId(issueSourceKey("NL-306-secondary"))],
        issue: { kind: "weekly", publicationDate: "2026-12-07", issueNumber: 306, status: "planned", sourceType: "xlsx-import", sourceKey: issueSourceKey("NL-306"),
          slots: { primary: { ticked: true, sponsor: "Sponsor A", sheetId: "NL-306" }, secondary: { ticked: true, sponsor: "Sponsor B", sheetId: "NL-306-secondary" } } },
        card: { action: "merge", cardId: primaryCard, mergeCardId: secondaryCard },
      },
      {
        slotIds: [newsletterIssueId(issueSourceKey("NL-302"))],
        issue: { kind: "weekly", publicationDate: "2026-11-09", issueNumber: 302, status: "planned", sourceType: "xlsx-import", sourceKey: issueSourceKey("NL-302"),
          slots: { primary: { ticked: true, sheetId: "NL-302" }, secondary: { ticked: false } } },
        card: { action: "create" },
      },
    ];
    const dry = data(await invoke("POST", "/api/newsletter-issues/migrations/from-slots", { dryRun: true, plan }));
    assert.deepEqual(dry.results.map((result: any) => result.outcome), ["planned", "planned"]);
    const run = data(await invoke("POST", "/api/newsletter-issues/migrations/from-slots", { dryRun: false, plan }));
    assert.deepEqual(run.results.map((result: any) => result.outcome), ["migrated", "migrated"], JSON.stringify(run));

    const issue306 = (await getNewsletterIssue(client, newsletterIssueId(issueSourceKey("NL-306"))))!;
    assert.equal(issue306.cardId, primaryCard);
    const kept = (await getCard(client, primaryCard))!;
    assert.deepEqual(kept.selectedOptionalGroups, ["primary-slot", "secondary-slot"]);
    assert.equal(kept.title, "7 Dec · #306 · Sponsor A + Sponsor B");
    assert.equal(kept.sponsor, "Sponsor A");
    assert.deepEqual(kept.secondarySponsors, ["Sponsor B"]);
    assert.equal(kept.cardLinks?.find((link) => link.name === "Secondary sponsorship document")?.url, "https://docs.example/b");
    const keptTasks = await listTasksByCard(client, primaryCard);
    const folded = keptTasks.find((task) => task.templateTaskRef === "secondary-create-sponsorship-document")!;
    assert.equal(folded.status, "done");
    assert.equal(folded.link, "https://docs.example/b");
    assert.ok(keptTasks.some((task) => task.templateTaskRef === "secondary-create-invoice"));
    assert.equal(await getCard(client, secondaryCard), null);

    const issue302 = (await getNewsletterIssue(client, newsletterIssueId(issueSourceKey("NL-302"))))!;
    const card302 = (await getCard(client, issue302.cardId!))!;
    assert.deepEqual(card302.selectedOptionalGroups, ["primary-slot"]);
    assert.equal(card302.anchorDate, "2026-11-09");
    for (const sheetId of ["NL-306", "NL-306-secondary", "NL-302"]) assert.ok(await slotGone(newsletterIssueId(issueSourceKey(sheetId))));

    const again = data(await invoke("POST", "/api/newsletter-issues/migrations/from-slots", { dryRun: false, plan }));
    assert.deepEqual(again.results.map((result: any) => result.outcome), ["exists", "exists"]);
  });
});
