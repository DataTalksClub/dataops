import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createSession } from "../src/db/sessions";
import { createNewsletterSlot } from "../src/db/newsletterSlots";
import { createCrmRecord } from "../src/db/sponsorCrm";
import { createCard, getCard, updateCard } from "../src/db/cards";
import { templateLink } from "./helpers/cardTemplate";
import { createTemplate } from "../src/db/templates";
import type { Template } from "../src/types";
import { listTasksByCard } from "../src/db/tasks";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_CARDS, TABLE_NEWSLETTER_SLOTS } from "../src/db/tableNames";
import { handleNewsletterSlotRoutes } from "../src/routes/newsletterSlots";
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
    ),
  data = (r: any) => JSON.parse(r.body),
  valid = {
    publicationDate: "2026-08-20",
    campaignLabel: "Synthetic Newsletter 42",
    campaignNumber: 42,
    status: "open",
    sourceKey: "synthetic-slot",
  };
describe("newsletter slots", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(stopLocal);
  afterEach(() => {
    process.env.SKIP_AUTH = "true";
  });
  it("enforces auth and CRUD/version/idempotency/ranges", async () => {
    process.env.SKIP_AUTH = "false";
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/newsletter-slots",
          undefined,
          {},
          { from: "2026-01-01", to: "2026-12-31" },
        )
      ).statusCode,
      401,
    );
    const session = await createSession(client, "newsletter-operator"),
      auth = { authorization: `Bearer ${session.token}` };
    let response = await invoke("POST", "/api/newsletter-slots", valid, auth);
    assert.equal(response.statusCode, 201, response.body);
    const slot = data(response);
    assert.equal(slot.timeZone, "Europe/Berlin");
    assert.equal(
      (await invoke("POST", "/api/newsletter-slots", valid, auth)).statusCode,
      200,
    );
    response = await invoke(
      "PUT",
      `/api/newsletter-slots/${slot.id}`,
      {
        version: slot.version,
        status: "reserved",
        bookedByDisplayName: "Synthetic Sponsor",
      },
      auth,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(
      (
        await invoke(
          "PUT",
          `/api/newsletter-slots/${slot.id}`,
          { version: 1, status: "sent" },
          auth,
        )
      ).statusCode,
      409,
    );
    const reviewRes = await invoke(
      "PUT",
      `/api/newsletter-slots/${slot.id}`,
      { version: 2, status: "review" },
      auth,
    );
    assert.equal(reviewRes.statusCode, 200);
    assert.equal(data(reviewRes).status, "review");
    const draftRes = await invoke(
      "PUT",
      `/api/newsletter-slots/${slot.id}`,
      { version: 3, status: "draft" },
      auth,
    );
    assert.equal(draftRes.statusCode, 200);
    assert.equal(data(draftRes).status, "draft");
    const listed = data(
      await invoke("GET", "/api/newsletter-slots", undefined, auth, {
        from: "2026-08-01",
        to: "2026-08-31",
        booked: "true",
      }),
    );
    assert.equal(listed.items.length, 1);
    const projection = data(
      await invoke("GET", "/api/newsletter-slots/projection", undefined, auth, {
        from: "2026-08-01",
        to: "2026-08-31",
      }),
    );
    assert.deepEqual(Object.keys(projection.items[0]).sort(), [
      "campaignLabel",
      "href",
      "id",
      "publicationDate",
      "status",
      "timeZone",
    ]);
    process.env.SKIP_AUTH = "true";
  });
  it("validates fields and calculates stable alert rules", async () => {
    assert.equal(
      (
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey: "missing-sponsor",
          sponsorBookingId: "orphan-booking",
        })
      ).statusCode,
      422,
    );
    const orphan = (
      await createNewsletterSlot(client, {
        ...valid,
        sourceKey: "orphan-existing",
        sponsorBookingId: "removed-booking",
      })
    ).item;
    const orphanRead = await invoke(
      "GET",
      `/api/newsletter-slots/${orphan.id}`,
    );
    assert.equal(orphanRead.statusCode, 200);
    assert.equal(data(orphanRead).sponsor, null);
    assert.equal(
      (
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey: "bad",
          status: "invalid",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey: "dst-gap",
          publicationDate: "2026-03-29",
          publicationTime: "02:30",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey: "dst-overlap",
          publicationDate: "2026-10-25",
          publicationTime: "02:30",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey: "dst-overlap-explicit",
          publicationDate: "2026-10-25",
          publicationTime: "02:30",
          utcOffset: "+01:00",
        })
      ).statusCode,
      201,
    );
    await invoke("POST", "/api/newsletter-slots", {
      ...valid,
      sourceKey: "alert-open",
      publicationDate: "2026-07-10",
      campaignNumber: 100,
    });
    await invoke("POST", "/api/newsletter-slots", {
      ...valid,
      sourceKey: "alert-duplicate",
      publicationDate: "2026-07-10",
      campaignNumber: 100,
      status: "reserved",
    });
    const result = data(
      await invoke(
        "GET",
        "/api/newsletter-slots",
        undefined,
        {},
        { from: "2026-07-01", to: "2026-07-31", today: "2026-07-01" },
      ),
    );
    const codes = new Set(result.alerts.map((item: any) => item.reasonCode));
    for (const code of [
      "near-term-open-unbooked",
      "reserved-missing-booker",
      "publication-missing-workflow",
      "duplicate-active-slot",
    ])
      assert.ok(codes.has(code), code);
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/newsletter-slots",
          undefined,
          {},
          { from: "bad", to: "2026-01-01" },
        )
      ).statusCode,
      400,
    );
  });
  it("covers alert lifecycle, authority lookups, method guards and write conflicts", async () => {
    process.env.NEWSLETTER_OPEN_ALERT_LEAD_DAYS = "1";
    const reserved = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "lifecycle-reserved",
        publicationDate: "2026-11-10",
        status: "reserved",
      }),
    );
    const range = {
        from: "2026-11-01",
        to: "2026-11-30",
        today: "2026-11-01",
      },
      first = data(
        await invoke("GET", "/api/newsletter-slots", undefined, {}, range),
      ),
      alert = first.alerts.find(
        (item: any) =>
          item.slotId === reserved.id &&
          item.reasonCode === "reserved-missing-booker",
      );
    assert.ok(alert);
    assert.equal(alert.occurrence, 1);
    assert.equal(
      (await invoke("POST", `/api/newsletter-slots/alerts/${alert.id}/dismiss`))
        .statusCode,
      200,
    );
    assert.ok(
      !data(
        await invoke("GET", "/api/newsletter-slots", undefined, {}, range),
      ).alerts.some((item: any) => item.id === alert.id),
    );
    let updated = data(
      await invoke("PUT", `/api/newsletter-slots/${reserved.id}`, {
        version: reserved.version,
        bookedByDisplayName: "Synthetic Booker",
      }),
    );
    await invoke("GET", "/api/newsletter-slots", undefined, {}, range);
    updated = data(
      await invoke("PUT", `/api/newsletter-slots/${reserved.id}`, {
        version: updated.version,
        bookedByDisplayName: null,
      }),
    );
    const recurred = data(
      await invoke("GET", "/api/newsletter-slots", undefined, {}, range),
    ).alerts.find(
      (item: any) =>
        item.slotId === reserved.id &&
        item.reasonCode === "reserved-missing-booker",
    );
    assert.equal(recurred.occurrence, 2);
    assert.notEqual(recurred.id, alert.id);

    const card = await createCard(client, {
      ...templateLink(),
      title: "[Newsletter] Synthetic incomplete newsletter (20NOV 2026)",
      anchorDate: "2026-11-20",
      stage: "planning",
      cardLinks: [{ name: "Mailchimp campaign", url: "" }],
    });
    const bundled = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "card-truth",
        publicationDate: "2026-11-20",
        cardId: card.id,
      }),
    );
    const cardResult = data(
      await invoke("GET", "/api/newsletter-slots", undefined, {}, range),
    );
    assert.ok(
      cardResult.alerts.some(
        (item: any) =>
          item.slotId === bundled.id &&
          item.reasonCode === "linked-workflow-incomplete",
      ),
    );

    const deal = (
      await createCrmRecord(client, "deal", {
        sourceKey: "authorized-newsletter-deal",
        organizationId: "synthetic-org",
        status: "agreed",
      })
    ).item;
    const deliverable = (
      await createCrmRecord(client, "deliverable", {
        sourceKey: "authorized-newsletter-booking",
        organizationId: "synthetic-org",
        dealId: deal.id,
        channel: "main",
      })
    ).item;
    const linked = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "authorized-linked-slot",
        sponsorBookingId: deliverable.id,
      }),
    );
    const linkedRead = data(
      await invoke("GET", `/api/newsletter-slots/${linked.id}`),
    );
    assert.deepEqual(linkedRead.sponsor, {
      id: deliverable.id,
      organizationId: "synthetic-org",
      dealId: deal.id,
    });
    assert.equal(
      (await invoke("POST", "/api/newsletter-slots/projection", {})).statusCode,
      405,
    );

    const dst = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "partial-dst",
        publicationDate: "2026-03-22",
        publicationTime: "02:30",
      }),
    );
    assert.equal(
      (
        await invoke("PUT", `/api/newsletter-slots/${dst.id}`, {
          version: dst.version,
          publicationDate: "2026-03-29",
        })
      ).statusCode,
      400,
    );

    const deletable = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "delete-conflict",
      }),
    );
    const originalSend = client.send.bind(client);
    (client as any).send = (command: any) => {
      if (command instanceof DeleteCommand)
        return Promise.reject(
          Object.assign(new Error("synthetic conflict"), {
            name: "ConditionalCheckFailedException",
          }),
        );
      return originalSend(command);
    };
    try {
      assert.equal(
        (
          await handleNewsletterSlotRoutes(
            `/api/newsletter-slots/${deletable.id}`,
            "DELETE",
            {
              httpMethod: "DELETE",
              path: `/api/newsletter-slots/${deletable.id}`,
              headers: {},
              queryStringParameters: {},
              body: JSON.stringify({ version: deletable.version }),
            },
            client,
          )
        ).statusCode,
        409,
      );
    } finally {
      (client as any).send = originalSend;
      delete process.env.NEWSLETTER_OPEN_ALERT_LEAD_DAYS;
    }
  });
  describe("card links", () => {
    const slot = async (sourceKey: string, extra: Record<string, unknown> = {}) =>
      data(
        await invoke("POST", "/api/newsletter-slots", {
          ...valid,
          sourceKey,
          ...extra,
        }),
      );
    let newsletterTemplate: Template;
    before(async () => {
      newsletterTemplate = (await createTemplate(client, {
        name: "Newsletter",
        type: "newsletter",
        cardTitle: "{date} · #{issue} · {sponsor} · {variant}",
        taskDefinitions: [
          { refId: "draft", description: "Draft issue", offsetDays: -3 },
          { refId: "send", description: "Send issue", offsetDays: 0 },
        ],
      }));
    });
    const newsletterCard = (title: string) =>
      createCard(client, { ...templateLink(newsletterTemplate), title, anchorDate: "2026-01-01", stage: "preparation" });
    it("validates the linked Card, keeps links unique, and unlinks with null", async () => {
      const first = await slot("link-a", { publicationDate: "2026-12-07", campaignNumber: 310 });
      const second = await slot("link-b", { publicationDate: "2026-12-14", campaignNumber: 311 });
      const missing = await invoke("PUT", `/api/newsletter-slots/${first.id}`, { version: first.version, cardId: "no-such-card" });
      assert.equal(missing.statusCode, 422, missing.body);
      const podcast = await createCard(client, { ...templateLink(), title: "[Podcast] 2026-DEC-07 - Topic - Ada Example", anchorDate: "2026-12-07", stage: "preparation" });
      const wrongType = await invoke("PUT", `/api/newsletter-slots/${first.id}`, { version: first.version, cardId: podcast.id });
      assert.equal(wrongType.statusCode, 422, wrongType.body);

      const card = await newsletterCard("Weekly email");
      const linked = await invoke("PUT", `/api/newsletter-slots/${first.id}`, { version: first.version, cardId: card.id });
      assert.equal(linked.statusCode, 200, linked.body);
      assert.equal(data(linked).cardSync, "synced");
      const pushed = (await getCard(client, card.id))!;
      assert.equal(pushed.anchorDate, "2026-12-07");
      assert.equal(pushed.issueNumber, "310");
      assert.equal(pushed.title, "7 Dec · #310");

      const taken = await invoke("PUT", `/api/newsletter-slots/${second.id}`, { version: second.version, cardId: card.id });
      assert.equal(taken.statusCode, 409, taken.body);
      const takenOnCreate = await invoke("POST", "/api/newsletter-slots", { ...valid, sourceKey: "link-c", cardId: card.id });
      assert.equal(takenOnCreate.statusCode, 409, takenOnCreate.body);

      const reverse = data(await invoke("GET", "/api/newsletter-slots", undefined, {}, { cardId: card.id }));
      assert.deepEqual(reverse.items.map((item: any) => item.id), [first.id]);
      assert.equal(reverse.items[0].card.id, card.id);
      assert.equal(reverse.items[0].card.anchorDate, "2026-12-07");

      const unlinked = await invoke("PUT", `/api/newsletter-slots/${first.id}`, { version: data(linked).version, cardId: null });
      assert.equal(unlinked.statusCode, 200, unlinked.body);
      assert.equal(data(await invoke("GET", "/api/newsletter-slots", undefined, {}, { cardId: card.id })).items.length, 0);
      const relinked = await invoke("PUT", `/api/newsletter-slots/${second.id}`, { version: second.version, cardId: card.id });
      assert.equal(relinked.statusCode, 200, relinked.body);
    });
    it("pushes slot date and issue changes to the Card and flags drift", async () => {
      const card = await newsletterCard("Weekly email");
      const created = await slot("push-a", { publicationDate: "2027-01-04", campaignNumber: 320, bookedByDisplayName: "Example Sponsor", cardId: card.id });
      assert.equal(created.cardSync, "synced");
      assert.equal((await getCard(client, card.id))!.title, "4 Jan · #320 · Example Sponsor");
      const moved = await invoke("PUT", `/api/newsletter-slots/${created.id}`, { version: created.version, publicationDate: "2027-01-11", campaignNumber: 321 });
      assert.equal(moved.statusCode, 200, moved.body);
      let current = (await getCard(client, card.id))!;
      assert.equal(current.anchorDate, "2027-01-11");
      assert.equal(current.issueNumber, "321");
      assert.equal(current.title, "11 Jan · #321 · Example Sponsor");
      const rebooked = await invoke("PUT", `/api/newsletter-slots/${created.id}`, { version: data(moved).version, bookedByDisplayName: "Other Sponsor", campaignLabel: "Weekly #321 secondary slot" });
      assert.equal(data(rebooked).cardSync, "synced");
      current = (await getCard(client, card.id))!;
      assert.equal(current.title, "11 Jan · #321 · Other Sponsor · secondary");

      const range = { from: "2027-01-01", to: "2027-01-31", today: "2027-01-01" };
      let listed = data(await invoke("GET", "/api/newsletter-slots", undefined, {}, range));
      const item = listed.items.find((value: any) => value.id === created.id);
      assert.deepEqual(Object.keys(item.card).sort(), ["anchorDate", "id", "openTaskCount", "stage", "status", "taskCount", "title"]);
      assert.ok(!listed.alerts.some((alert: any) => alert.reasonCode === "card-date-mismatch"));

      current = await updateCard(client, card.id, {
        expectedVersion: current.version,
        patch: { anchorDate: "2027-01-12" },
      });
      listed = data(await invoke("GET", "/api/newsletter-slots", undefined, {}, range));
      assert.ok(listed.alerts.some((alert: any) => alert.slotId === created.id && alert.reasonCode === "card-date-mismatch"));
    });
    it("creates a Card from the newsletter Template and rolls it back when linking fails", async () => {
      const target = await slot("create-a", { publicationDate: "2027-02-08", campaignNumber: 330, bookedByDisplayName: "Example Sponsor" });
      const created = await invoke("POST", `/api/newsletter-slots/${target.id}/card`, { version: target.version });
      assert.equal(created.statusCode, 201, created.body);
      const result = data(created);
      assert.equal(result.slot.cardId, result.card.id);
      const card = (await getCard(client, result.card.id))!;
      assert.equal(card.title, "8 Feb · #330 · Example Sponsor");
      assert.equal(card.anchorDate, "2027-02-08");
      assert.equal(card.issueNumber, "330");
      assert.equal((await listTasksByCard(client, card.id)).length, 2);
      assert.equal((await invoke("POST", `/api/newsletter-slots/${target.id}/card`, {})).statusCode, 409);
      assert.equal((await invoke("GET", `/api/newsletter-slots/${target.id}/card`)).statusCode, 405);

      const doomed = await slot("create-b", { publicationDate: "2027-02-15", campaignNumber: 331 });
      const originalSend = client.send.bind(client);
      (client as any).send = (command: any) => {
        if (command instanceof PutCommand && command.input.TableName === TABLE_NEWSLETTER_SLOTS && command.input.Item?.cardId)
          return Promise.reject(Object.assign(new Error("synthetic race"), { name: "ConditionalCheckFailedException" }));
        return originalSend(command);
      };
      let failed;
      try {
        failed = await handleNewsletterSlotRoutes(
          `/api/newsletter-slots/${doomed.id}/card`,
          "POST",
          { httpMethod: "POST", path: `/api/newsletter-slots/${doomed.id}/card`, headers: {}, queryStringParameters: {}, body: "{}" },
          client,
        );
      } finally {
        (client as any).send = originalSend;
      }
      assert.equal(failed.statusCode, 409, failed.body);
      const leftovers = await client.send(new ScanCommand({ TableName: TABLE_CARDS, FilterExpression: "title = :title", ExpressionAttributeValues: { ":title": "15 Feb · #331" } }));
      assert.equal(leftovers.Items?.length, 0);
      const reread = data(await invoke("GET", `/api/newsletter-slots/${doomed.id}`));
      assert.equal(reread.cardId, undefined);
      assert.equal(reread.card, null);
    });
  });
  it("accepts an existing bearer session while rejecting unauthenticated and Basic writes", async () => {
    Object.assign(process.env, {
      DATAOPS_DOCS_DOMAIN: "1",
      WORK_ENGINE_AUTH_MODE: "portal",
      AUTH_BASE_URL: "https://auth.example.test",
      AUTH_ISSUER: "https://issuer.example.test/pool",
      AUTH_CLIENT_ID: "dataops-client",
      AUTH_CALLBACK_URL: "https://ops.example.test/auth/callback",
      AUTH_LOGOUT_URL: "https://ops.example.test/",
      SKIP_AUTH: "false",
    });
    const body = {
        ...valid,
        sourceKey: "portal-basic-import",
        publicationDate: "2027-02-05",
      },
      basic = `Basic ${Buffer.from("newsletter-importer:synthetic-portal-password").toString("base64")}`,
      session = await createSession(client, "newsletter-importer"),
      bearer = `Bearer ${session.token}`;
    try {
      assert.equal(
        (await invoke("POST", "/api/newsletter-slots", body)).statusCode,
        401,
      );
      assert.equal((await invoke("POST", "/api/newsletter-slots", body, { authorization: basic })).statusCode, 401);
      const accepted = await invoke("POST", "/api/newsletter-slots", body, {
        authorization: bearer,
      });
      assert.equal(accepted.statusCode, 201, accepted.body);
      assert.ok(!accepted.body.includes("synthetic-portal-password"));
    } finally {
      delete process.env.DATAOPS_DOCS_DOMAIN;
      for (const key of ["WORK_ENGINE_AUTH_MODE", "AUTH_BASE_URL", "AUTH_ISSUER", "AUTH_CLIENT_ID", "AUTH_CALLBACK_URL", "AUTH_LOGOUT_URL"]) delete process.env[key];
      process.env.SKIP_AUTH = "true";
    }
  });
});
