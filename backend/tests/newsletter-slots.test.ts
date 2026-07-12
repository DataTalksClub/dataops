import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import path from "path";
import fs from "fs/promises";
import ExcelJS from "exceljs";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables } from "../src/db/setup";
import { getClient, startLocal, stopLocal } from "../src/db/client";
import { createSession } from "../src/db/sessions";
import { createNewsletterSlot } from "../src/db/newsletterSlots";
import { createCrmRecord } from "../src/db/sponsorCrm";
import { createBundle } from "../src/db/bundles";
import { handleNewsletterSlotRoutes } from "../src/routes/newsletterSlots";
import {
  readNewsletterSlots,
  writeNewsletterSlots,
} from "../scripts/import-newsletter-slots";
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

    const bundle = await createBundle(client, {
      title: "Synthetic incomplete newsletter",
      anchorDate: "2026-11-20",
      stage: "planning",
      bundleLinks: [{ name: "Mailchimp campaign", url: "" }],
    });
    const bundled = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "bundle-truth",
        publicationDate: "2026-11-20",
        bundleId: bundle.id,
      }),
    );
    const bundleResult = data(
      await invoke("GET", "/api/newsletter-slots", undefined, {}, range),
    );
    assert.ok(
      bundleResult.alerts.some(
        (item: any) =>
          item.slotId === bundled.id &&
          item.reasonCode === "linked-workflow-incomplete",
      ),
    );

    const booking = (
      await createCrmRecord(client, "booking", {
        sourceKey: "authorized-newsletter-booking",
        organizationId: "synthetic-org",
        status: "confirmed",
      })
    ).item;
    const linked = data(
      await invoke("POST", "/api/newsletter-slots", {
        ...valid,
        sourceKey: "authorized-linked-slot",
        sponsorBookingId: booking.id,
      }),
    );
    const linkedRead = data(
      await invoke("GET", `/api/newsletter-slots/${linked.id}`),
    );
    assert.deepEqual(linkedRead.sponsor, {
      id: booking.id,
      organizationId: "synthetic-org",
      status: "confirmed",
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
  it("accepts deployed portal Basic auth while rejecting an unauthenticated write", async () => {
    process.env.DATAOPS_DOCS_DOMAIN = "1";
    process.env.BASIC_AUTH_USERNAME = "newsletter-importer";
    process.env.BASIC_AUTH_PASSWORD = "synthetic-portal-password";
    process.env.SKIP_AUTH = "false";
    const body = {
        ...valid,
        sourceKey: "portal-basic-import",
        publicationDate: "2027-02-05",
      },
      basic = `Basic ${Buffer.from("newsletter-importer:synthetic-portal-password").toString("base64")}`;
    try {
      assert.equal(
        (await invoke("POST", "/api/newsletter-slots", body)).statusCode,
        401,
      );
      const accepted = await invoke("POST", "/api/newsletter-slots", body, {
        authorization: basic,
      });
      assert.equal(accepted.statusCode, 201, accepted.body);
      assert.ok(!accepted.body.includes("synthetic-portal-password"));
    } finally {
      delete process.env.DATAOPS_DOCS_DOMAIN;
      delete process.env.BASIC_AUTH_USERNAME;
      delete process.env.BASIC_AUTH_PASSWORD;
      process.env.SKIP_AUTH = "true";
    }
  });
  it("dry-runs offline and writes only synthetic allowlisted Newsletter fields through HTTP", async () => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Newsletter");
    sheet.addRow([
      "Publication Date",
      "Campaign Label",
      "Campaign Number",
      "Status",
      "Booked By",
      "Email",
      "Opens",
      "Clicks",
      "Private Link",
      "Sensitive Notes",
    ]);
    sheet.addRow([
      new Date("2026-09-01T00:00:00Z"),
      "Synthetic Campaign",
      55,
      "reserved",
      "Synthetic Booker",
      "private@example.invalid",
      999,
      111,
      "https://private.invalid",
      "secret",
    ]);
    const hidden = sheet.addRow([
      new Date("2026-09-02T00:00:00Z"),
      "Hidden Campaign",
    ]);
    hidden.hidden = true;
    workbook.addWorksheet("Contacts").addRow(["private@example.invalid"]);
    const file = path.resolve(".tmp/newsletter-import-synthetic.xlsx");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await workbook.xlsx.writeFile(file);
    const rows = await readNewsletterSlots(file);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "bookedByDisplayName",
      "campaignLabel",
      "campaignNumber",
      "publicationDate",
      "sourceKey",
      "sourceType",
      "status",
    ]);
    let calls = 0,
      posts = 0;
    const requests: Array<{ url: string; authorization: string }> = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
      calls++;
      requests.push({
        url: String(url),
        authorization: new Headers(options?.headers).get("authorization") || "",
      });
      if (options?.method === "POST") {
        posts++;
        return new Response("{}", { status: posts === 1 ? 201 : 200 });
      }
      return new Response(JSON.stringify({ items: rows }), { status: 200 });
    };
    try {
      assert.deepEqual(
        await writeNewsletterSlots(rows, {
          api: "https://api.example.invalid",
          token: "synthetic",
          confirm: "https://api.example.invalid",
        }),
        { accepted: 1, created: 1, duplicates: 0, verified: 1 },
      );
      assert.equal(calls, 2);
      assert.equal(
        requests[1].url,
        "https://api.example.invalid/api/newsletter-slots?from=2026-01-01&to=2026-12-31",
      );
      assert.ok(!requests.some((request) => request.url.includes("9999")));
      assert.deepEqual(
        await writeNewsletterSlots(rows, {
          api: "https://api.example.invalid",
          token: "synthetic",
          confirm: "https://api.example.invalid",
        }),
        { accepted: 1, created: 0, duplicates: 1, verified: 1 },
      );
      const beforeBasic = requests.length;
      assert.deepEqual(
        await writeNewsletterSlots(rows, {
          api: "https://api.example.invalid",
          confirm: "https://api.example.invalid",
          portalUsername: "portal-user",
          portalPassword: "portal-password",
        }),
        { accepted: 1, created: 0, duplicates: 1, verified: 1 },
      );
      const basic = `Basic ${Buffer.from("portal-user:portal-password").toString("base64")}`;
      assert.ok(
        requests
          .slice(beforeBasic)
          .every((request) => request.authorization === basic),
      );
      assert.ok(
        !JSON.stringify(
          await writeNewsletterSlots([], {
            api: "https://api.example.invalid",
            confirm: "https://api.example.invalid",
            portalUsername: "portal-user",
            portalPassword: "portal-password",
          }),
        ).includes("portal-password"),
      );
      await assert.rejects(() =>
        writeNewsletterSlots(rows, {
          api: "https://api.example.invalid",
          token: "synthetic",
          confirm: "wrong",
        }),
      );
    } finally {
      global.fetch = original;
    }
  });
});
