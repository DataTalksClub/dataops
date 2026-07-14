import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables } from "../src/db/setup";
import { getClient, startLocal, stopLocal } from "../src/db/client";
import { createSession } from "../src/db/sessions";
import {
  builtInHolidayGeneration,
  holidaySnapshot,
} from "../src/calendar/holidays";
import {
  persistHolidayGeneration,
  readHolidayGeneration,
  setHolidaySyncFailureForTests,
} from "../src/db/calendarHolidays";
import { createNewsletterSlot } from "../src/db/newsletterSlots";
import {
  inspectCalendarImport,
  writeCalendarImport,
} from "../scripts/import-calendar";
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
      body: body === undefined ? null : JSON.stringify(body),
      headers,
      queryStringParameters: query,
    },
    {},
  );
const parse = (r: any) => JSON.parse(r.body);
function addTrustedFormulaTopology(workbook: ExcelJS.Workbook) {
  workbook.properties.date1904 = false;
  const sheet =
      workbook.getWorksheet("Time table") ||
      workbook.addWorksheet("Time table"),
    headers: { [key: number]: string } = {
      11: "webinar or workshop",
      12: "webinar or workshop",
      13: "status",
      14: "podcast live",
      15: "podcast live",
      16: "status",
      17: "release",
      18: "podcast title",
      21: "start",
      22: "end",
      23: "book of the week",
      24: "status",
    };
  for (const [column, value] of Object.entries(headers))
    sheet.getCell(1, +column).value = value;
  const date = (row: number, offset = 0) => {
      let days = (row - 2) * 7;
      if (row >= 64) days += 14;
      if (row >= 65) days -= 21;
      if (row >= 67) days += 7;
      return new Date(Date.UTC(2021, 1, 22 + days + offset));
    },
    fill = (
      column: number,
      anchorRow: number,
      endRow: number,
      formula: string,
      offset: number,
    ) => {
      const anchor = sheet.getCell(anchorRow, column);
      anchor.value = { formula, result: date(anchorRow, offset) } as any;
      for (let row = anchorRow + 1; row <= endRow; row++)
        sheet.getCell(row, column).value = {
          sharedFormula: anchor.address,
          result: date(row, offset),
        } as any;
    };
  fill(11, 2, 309, "J2+1", 1);
  fill(14, 2, 113, "J2+4", 4);
  fill(14, 114, 309, "J114+0", 4);
  fill(17, 10, 17, "J10", 0);
  fill(17, 35, 108, "N35", 4);
  fill(17, 109, 309, "G109", 0);
  fill(21, 2, 309, "C2", 0);
  fill(22, 2, 309, "F2", 3);
  sheet.getCell("J2").value = date(2, 0);
  sheet.getCell("J114").value = date(114, 4);
  sheet.getCell("J10").value = date(10, 0);
  sheet.getCell("J35").value = date(35, 0);
  sheet.getCell("G109").value = date(109, 0);
  sheet.getCell("C2").value = date(2, 0);
  sheet.getCell("F2").value = date(2, 3);
  return sheet;
}
describe("operations calendar", () => {
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
  it("does not leak before auth and supports indexed CRUD, versions and idempotency", async () => {
    process.env.SKIP_AUTH = "false";
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/calendar-items",
          undefined,
          {},
          { from: "2026-07-01", to: "2026-07-31" },
        )
      ).statusCode,
      401,
    );
    const session = await createSession(client, "calendar-operator"),
      auth = { authorization: `Bearer ${session.token}` },
      valid = {
        activityType: "webinar",
        title: "Synthetic planning event",
        status: "confirmed",
        allDay: true,
        startDate: "2026-07-20",
        endDate: "2026-08-02",
        sourceType: "synthetic",
        sourceKey: "calendar-test-one",
      };
    let r = await invoke("POST", "/api/calendar-items", valid, auth);
    assert.equal(r.statusCode, 201, r.body);
    const created = parse(r).item;
    assert.equal(
      (await invoke("POST", "/api/calendar-items", valid, auth)).statusCode,
      200,
    );
    r = await invoke("GET", "/api/calendar-items", undefined, auth, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
    assert.equal(parse(r).items.length, 1);
    assert.ok(
      parse(r).alerts.some(
        (a: any) => a.reasonCode === "school-holiday-overlap",
      ),
    );
    r = await invoke(
      "PUT",
      `/api/calendar-items/${created.id}`,
      { version: created.version, title: "Updated synthetic event" },
      auth,
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (
        await invoke(
          "PUT",
          `/api/calendar-items/${created.id}`,
          { version: 1, title: "stale" },
          auth,
        )
      ).statusCode,
      409,
    );
    const updated = parse(r);
    assert.equal(
      (
        await invoke(
          "DELETE",
          `/api/calendar-items/${created.id}`,
          { version: updated.version },
          auth,
        )
      ).statusCode,
      204,
    );
    process.env.SKIP_AUTH = "true";
  });
  it("validates range, UTC offsets, filters, and holiday year edges", async () => {
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/calendar-items",
          undefined,
          {},
          { from: "2020-01-01", to: "2026-01-01" },
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await invoke("POST", "/api/calendar-items", {
          activityType: "webinar",
          title: "DST gap",
          status: "tentative",
          allDay: false,
          startsAt: "2026-03-29T02:30:00",
          endsAt: "2026-03-29T03:30:00",
          timeZone: "Europe/Berlin",
        })
      ).statusCode,
      400,
    );
    assert.ok(
      holidaySnapshot("2028-06-17", "2028-06-17").some(
        (h) => h.startDate === "2028-06-17",
      ),
    );
    assert.ok(
      holidaySnapshot("2026-12-30", "2027-01-03").some(
        (h) => h.startDate === "2026-12-23" && h.endDate === "2027-01-02",
      ),
    );
  });
  it("publishes a persistent holiday generation atomically and retains LKG on refresh failure", async () => {
    let response = await invoke("POST", "/api/calendar-items/holidays/sync");
    assert.equal(response.statusCode, 200, response.body);
    const first = parse(response);
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2028-06-01", to: "2028-06-30" },
    );
    const before = parse(response);
    assert.equal(before.holidayMetadata.generationId, first.generationId);
    assert.equal(before.holidayMetadata.persistent, true);
    assert.ok(
      before.holidays.some(
        (h: any) =>
          h.startDate === "2028-06-17" &&
          h.officialSourceUrl.startsWith("https://gesetze.berlin.de/"),
      ),
    );
    setHolidaySyncFailureForTests(2);
    response = await invoke("POST", "/api/calendar-items/holidays/sync");
    assert.equal(response.statusCode, 503);
    setHolidaySyncFailureForTests(null);
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2028-06-01", to: "2028-06-30" },
    );
    assert.equal(
      parse(response).holidayMetadata.generationId,
      first.generationId,
    );
  });
  it("rejects incomplete statutory and school generations without moving the LKG pointer", async () => {
    const before = await readHolidayGeneration(client),
      complete = builtInHolidayGeneration(),
      withoutPublic = {
        ...complete,
        occurrences: complete.occurrences.filter(
          (h) => h.startDate !== "2028-06-17",
        ),
      };
    await assert.rejects(
      () => persistHolidayGeneration(client, withoutPublic),
      /incomplete|17 June/,
    );
    assert.equal(
      (await readHolidayGeneration(client))?.generationId,
      before?.generationId,
    );
    const school = complete.occurrences.find(
      (h) => h.kind === "berlin-school-holiday",
    )!;
    await assert.rejects(
      () =>
        persistHolidayGeneration(client, {
          ...complete,
          occurrences: complete.occurrences.filter((h) => h !== school),
        }),
      /incomplete/,
    );
    assert.equal(
      (await readHolidayGeneration(client))?.generationId,
      before?.generationId,
    );
  });
  it("projects newsletter records read-only and reopens changed dismissed alerts", async () => {
    await createNewsletterSlot(client, {
      publicationDate: "2027-04-05",
      campaignLabel: "Synthetic overlay",
      status: "open",
      sourceKey: "calendar-overlay-test",
    });
    let response = await invoke(
      "GET",
      "/api/calendar-items/overlays",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      parse(response).items.some(
        (i: any) =>
          i.label === "Synthetic overlay" &&
          i.provider === "newsletter-slots-readonly",
      ),
    );
    response = await invoke("POST", "/api/calendar-items", {
      activityType: "webinar",
      title: "Dismissible synthetic",
      status: "tentative",
      allDay: true,
      startDate: "2027-04-05",
      endDate: "2027-04-05",
      timeZone: "Europe/Berlin",
      sourceKey: "dismiss-test",
    });
    const item = parse(response).item;
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    const alert = parse(response).alerts.find(
      (a: any) =>
        a.reasonCode === "missing-workflow-context" &&
        a.affectedIds.includes(item.id),
    );
    assert.ok(alert);
    await invoke(
      "POST",
      `/api/calendar-items/alerts/${encodeURIComponent(alert.fingerprint)}/dismiss`,
    );
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      !parse(response).alerts.some(
        (a: any) => a.fingerprint === alert.fingerprint,
      ),
    );
    await invoke("PUT", `/api/calendar-items/${item.id}`, {
      version: item.version,
      title: "Dismissible synthetic changed",
    });
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      parse(response).alerts.some(
        (a: any) =>
          a.reasonCode === "missing-workflow-context" &&
          a.affectedIds.includes(item.id),
      ),
    );
  });
  it("ships week/month UI, independent layers, accessible status, and API seam", async () => {
    const src = path.resolve(__dirname, "../src"),
      html = await fs.readFile(path.join(src, "pages/index.html"), "utf8"),
      app = await fs.readFile(path.join(src, "public/app.js"), "utf8"),
      client = await fs.readFile(path.join(src, "public/api.js"), "utf8");
    assert.match(html, /#\/calendar/);
    assert.match(app, /Europe\/Berlin · Monday–Sunday · ISO weeks/);
    for (const id of [
      "calendar-view",
      "calendar-activities",
      "calendar-public",
      "calendar-school",
      "calendar-alerts",
    ])
      assert.ok(app.includes(id));
    assert.match(client, /calendar:\{list:function/);
  });
  it("imports only the two allowlisted sheets, dry-run first, then through API", async () => {
    const file = path.join(process.cwd(), ".tmp", "calendar-synthetic.xlsx");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const wb = new ExcelJS.Workbook(),
      tt = addTrustedFormulaTopology(wb),
      extra = wb.addWorksheet("Extra podcast slots"),
      newsletter = wb.addWorksheet("Newsletter");
    tt.getRow(309).getCell(12).value = "Synthetic trusted workshop";
    tt.getRow(309).getCell(13).value = "Confirmed";
    extra.addRow(["Date", "Day", "Time", "Guest", "status"]);
    extra.addRow([
      new Date("2027-02-02T00:00:00Z"),
      "Tuesday",
      "12:00",
      "Synthetic guest",
      "announced",
    ]);
    newsletter.addRow(["2027-02-03", "PRIVATE SPONSOR"]);
    await wb.xlsx.writeFile(file);
    let calls = 0;
    const prior = global.fetch;
    global.fetch = (async () => {
      calls++;
      throw new Error("network forbidden");
    }) as any;
    const inspected = await inspectCalendarImport(file, "2026-01-01");
    assert.equal(calls, 0);
    assert.equal(inspected.rows.length, 2);
    assert.match(inspected.report.adapterSignature, /schedule-v2/);
    assert.equal(JSON.stringify(inspected).includes("PRIVATE SPONSOR"), false);
    global.fetch = prior;
    process.env.SKIP_AUTH = "false";
    const session = await createSession(client, "importer");
    const { createServer } = await import("http");
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const url = new URL(req.url || "/", `http://${req.headers.host}`),
        result = await handler(
          {
            httpMethod: req.method || "GET",
            path: url.pathname,
            queryStringParameters: Object.fromEntries(url.searchParams),
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
            ),
            body: chunks.length ? Buffer.concat(chunks).toString() : null,
          },
          {},
        );
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as any,
        api = `http://127.0.0.1:${address.port}`;
      assert.deepEqual(
        await writeCalendarImport(inspected.rows, {
          api,
          confirm: api,
          token: session.token,
        }),
        { accepted: 2, created: 2, duplicates: 0, verified: 2 },
      );
      assert.equal(
        (
          await writeCalendarImport(inspected.rows, {
            api,
            confirm: api,
            token: session.token,
          })
        ).duplicates,
        2,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.env.SKIP_AUTH = "true";
      await fs.rm(file, { force: true });
    }
  });
  it("rejects cached formulas, hidden columns, and entire hidden allowlisted worksheets", async () => {
    const file = path.join(process.cwd(), ".tmp", "calendar-adversarial.xlsx"),
      wb = new ExcelJS.Workbook(),
      tt = addTrustedFormulaTopology(wb),
      extra = wb.addWorksheet("Extra podcast slots");
    tt.getCell("L309").value = {
      formula: '"PRIVATE FORMULA TITLE"',
      result: "PRIVATE FORMULA TITLE",
    };
    tt.getCell("L308").value = "Hidden column title";
    tt.getColumn(12).hidden = true;
    extra.state = "hidden";
    extra.addRow(["Date", "Day", "Time", "Guest", "status"]);
    extra.addRow([
      new Date("2027-03-03T00:00:00Z"),
      "x",
      "x",
      "PRIVATE HIDDEN SHEET",
      "confirmed",
    ]);
    await wb.xlsx.writeFile(file);
    const result = await inspectCalendarImport(file, "2026-01-01");
    assert.equal(result.rows.length, 0);
    assert.ok(result.report.reasons["formula-cell"] > 0);
    assert.ok(result.report.reasons["hidden-column"] > 0);
    assert.equal(result.report.reasons["hidden-worksheet"], 1);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    await fs.rm(file, { force: true });
  });
  it("rejects unrecognized, external, volatile, cacheless, and inconsistent date formulas", async () => {
    const variants = [
      (sheet: ExcelJS.Worksheet) =>
        (sheet.getCell("K2").value = {
          formula: "[external.xlsx]Sheet1!A1",
          result: new Date("2027-01-01T00:00:00Z"),
        }),
      (sheet: ExcelJS.Worksheet) =>
        (sheet.getCell("K2").value = {
          formula: "TODAY()",
          result: new Date("2027-01-01T00:00:00Z"),
        }),
      (sheet: ExcelJS.Worksheet) =>
        (sheet.getCell("K3").value = { sharedFormula: "K2" } as any),
      (sheet: ExcelJS.Worksheet) =>
        (sheet.getCell("K3").value = {
          sharedFormula: "K2",
          result: new Date("2040-01-01T00:00:00Z"),
        } as any),
    ];
    for (let index = 0; index < variants.length; index++) {
      const workbook = new ExcelJS.Workbook(),
        sheet = addTrustedFormulaTopology(workbook),
        file = path.join(
          process.cwd(),
          ".tmp",
          `calendar-formula-drift-${index}.xlsx`,
        );
      workbook.addWorksheet("Extra podcast slots");
      variants[index](sheet);
      await workbook.xlsx.writeFile(file);
      await assert.rejects(
        () => inspectCalendarImport(file, "2026-01-01"),
        /formula|cache|sequence|unsafe/i,
      );
      await fs.rm(file, { force: true });
    }
  });
  it("rejects a coherent shift of every trusted formula cache", async () => {
    const workbook = new ExcelJS.Workbook(),
      sheet = addTrustedFormulaTopology(workbook),
      file = path.join(process.cwd(), ".tmp", "calendar-coherent-shift.xlsx");
    workbook.addWorksheet("Extra podcast slots");
    for (const column of [11, 14, 17, 21, 22])
      for (let row = 2; row <= sheet.rowCount; row++) {
        const cell = sheet.getCell(row, column),
          value: any = cell.value;
        if (value?.result instanceof Date)
          cell.value = {
            ...value,
            result: new Date(value.result.getTime() + 7 * 86400000),
          } as any;
      }
    await workbook.xlsx.writeFile(file);
    await assert.rejects(
      () => inspectCalendarImport(file, "2026-01-01"),
      /anchor cache|source cache|inconsistent/i,
    );
    await fs.rm(file, { force: true });
  });
  it("uses an existing bearer session for writes and bounded reads", async () => {
    const requests: { url: string; authorization: string | null }[] = [],
      row = {
        activityType: "webinar",
        title: "Synthetic portal import",
        status: "confirmed",
        allDay: true as const,
        startDate: "2027-03-01",
        endDate: "2027-03-01",
        timeZone: "Europe/Berlin" as const,
        sourceType: "schedule-xlsx" as const,
        sourceKey: "synthetic-basic-auth-key",
      },
      bearer = "Bearer opaque-calendar-session";
    const result = await writeCalendarImport([row], {
      api: "https://calendar.invalid",
      confirm: "https://calendar.invalid",
      token: "opaque-calendar-session",
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return String(input).includes("?")
          ? new Response(JSON.stringify({ items: [row] }), { status: 200 })
          : new Response(JSON.stringify(row), { status: 201 });
      },
    });
    assert.deepEqual(result, {
      accepted: 1,
      created: 1,
      duplicates: 0,
      verified: 1,
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.url), [
      "https://calendar.invalid/api/calendar-items",
      "https://calendar.invalid/api/calendar-items?from=2027-01-01&to=2027-12-31",
    ]);
    assert.deepEqual(requests.map((request) => request.authorization), [
      bearer,
      bearer,
    ]);
    assert.equal(JSON.stringify(requests).includes("opaque-calendar-session"), true);
  });
  it("rejects missing or partial importer credentials before network", async () => {
    let calls = 0;
    const common = {
        api: "https://calendar.invalid",
        confirm: "https://calendar.invalid",
        fetcher: async () => {
          calls++;
          return new Response("{}", { status: 500 });
        },
      },
      attempts = [common];
    for (const options of attempts)
      await assert.rejects(
        () => writeCalendarImport([], options),
        /session token/i,
      );
    assert.equal(calls, 0);
  });
});
