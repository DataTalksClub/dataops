import ExcelJS from "exceljs";
import { createHash } from "crypto";
type ImportItem = {
  activityType: string;
  title: string;
  status: string;
  allDay: true;
  startDate: string;
  endDate: string;
  timeZone: "Europe/Berlin";
  sourceType: "schedule-xlsx";
  sourceKey: string;
};
const ALLOWED_SHEETS = ["Time table", "Extra podcast slots"] as const;
const TRUSTED_DATE_ADAPTER =
  "schedule-v2:1900-dates:Time table:K,N,Q,U,V:weekly-shared-formulas";
const iso = (value: any) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 1)
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000)
      .toISOString()
      .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : "";
};
const text = (v: any) => {
  if (v == null) return "";
  if (typeof v !== "object") return String(v).trim();
  return String(
    v.text ?? (v.richText || []).map((x: any) => x.text).join("") ?? "",
  ).trim();
};
const status = (v: any) => {
  const s = text(v).toLowerCase();
  return s.includes("cancel")
    ? "cancelled"
    : s.includes("confirm")
      ? "confirmed"
      : s.includes("announce")
        ? "announced"
        : s.includes("publish")
          ? "published"
          : "tentative";
};
function validateTrustedDateFormulas(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
) {
  if (workbook.properties.date1904 !== false)
    throw new Error("Unsupported workbook date system");
  const headers: Record<number, string> = {
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
  for (const [column, expected] of Object.entries(headers))
    if (text(sheet.getCell(1, Number(column)).value).toLowerCase() !== expected)
      throw new Error("Schedule layout signature mismatch");
  const anchors = new Map([
      ["K2", { formula: "J2+1", source: "J2", offset: 1 }],
      ["N2", { formula: "J2+4", source: "J2", offset: 4 }],
      ["N114", { formula: "J114+0", source: "J114", offset: 0 }],
      ["Q10", { formula: "J10", source: "J10", offset: 0 }],
      ["Q35", { formula: "N35", source: "N35", offset: 0 }],
      ["Q109", { formula: "G109", source: "G109", offset: 0 }],
      ["U2", { formula: "C2", source: "C2", offset: 0 }],
      ["V2", { formula: "F2", source: "F2", offset: 0 }],
    ]),
    allowedColumns = new Set([11, 14, 17, 21, 22]),
    trusted = new Set<string>(),
    groups = new Map<string, { row: number; date: Date }[]>();
  let formulaCount = 0;
  for (const column of allowedColumns)
    for (let row = 2; row <= sheet.rowCount; row++) {
      const cell = sheet.getCell(row, column),
        value: any = cell.value;
      if (!value || typeof value !== "object") continue;
      const formula = value.formula,
        shared = value.sharedFormula;
      if (!formula && !shared) continue;
      formulaCount++;
      const root = formula ? cell.address : String(shared),
        expectedAnchor = anchors.get(cell.address);
      if (
        (formula && formula !== expectedAnchor?.formula) ||
        (shared && !anchors.has(root)) ||
        formula?.match(/[\[\]!]|NOW|TODAY|RAND|OFFSET|INDIRECT/i)
      )
        throw new Error("Unrecognized or unsafe schedule date formula");
      if (!(value.result instanceof Date) || Number.isNaN(value.result.getTime()))
        throw new Error("Schedule date formula cache is missing or invalid");
      trusted.add(cell.address);
      groups.set(root, [
        ...(groups.get(root) || []),
        { row, date: value.result },
      ]);
    }
  if (formulaCount === 0) return trusted;
  const cachedDate = (address: string, seen = new Set<string>()): Date => {
    if (seen.has(address)) throw new Error("Schedule date formula lineage cycles");
    seen.add(address);
    const cell = sheet.getCell(address),
      value: any = cell.value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (!value || typeof value !== "object" || !(value.result instanceof Date))
      throw new Error("Schedule date formula source cache is invalid");
    const match = String(cell.formula || "").match(
      /^([A-Z]+)(\d+)(?:([+-])(\d+))?$/,
    );
    if (!match)
      throw new Error(
        `Schedule date formula source lineage is not allowlisted at ${address}`,
      );
    const [, sourceColumn, sourceRowText, sign, magnitudeText] = match,
      sourceRow = Number(sourceRowText),
      offset = Number(magnitudeText || 0) * (sign === "-" ? -1 : 1),
      currentColumn = cell.col,
      sourceColumnNumber = sheet.getColumn(sourceColumn).number,
      weeklySourceRows = new Map([
        [64, 66],
        [65, 63],
        [67, 64],
      ]),
      horizontalDaily =
        cell.row === sourceRow &&
        currentColumn >= 4 &&
        currentColumn <= 10 &&
        sourceColumnNumber === currentColumn - 1 &&
        offset === 1,
      verticalWeekly =
        currentColumn >= 3 &&
        currentColumn <= 10 &&
        sourceColumnNumber === currentColumn &&
        sourceRow === (weeklySourceRows.get(cell.row) ?? cell.row - 1) &&
        offset === 7,
      fridayProjection =
        currentColumn === 14 &&
        sourceColumnNumber === 10 &&
        sourceRow === cell.row &&
        offset === 4;
    if (!horizontalDaily && !verticalWeekly && !fridayProjection)
      throw new Error(
        `Schedule date formula source lineage is not allowlisted at ${address}`,
      );
    const source = cachedDate(`${sourceColumn}${sourceRow}`, seen);
    if (value.result.getTime() !== source.getTime() + offset * 86400000)
      throw new Error("Schedule date formula source cache is inconsistent");
    return value.result;
  };
  for (const [address, anchor] of anchors) {
    const value: any = sheet.getCell(address).value,
      source = cachedDate(anchor.source);
    if (
      !(value?.result instanceof Date) ||
      value.result.getTime() !== source.getTime() + anchor.offset * 86400000
    )
      throw new Error("Schedule date formula anchor cache is inconsistent");
  }
  for (const [root, values] of groups) {
    if (!anchors.has(root)) throw new Error("Unrecognized shared-formula root");
    values.sort((a, b) => a.row - b.row);
    const versionedDiscontinuities = new Map([
      ["63:64", 21],
      ["64:65", -14],
      ["66:67", 14],
    ]);
    for (let index = 1; index < values.length; index++) {
      const transition = `${values[index - 1].row}:${values[index].row}`,
        expectedDays =
          versionedDiscontinuities.get(transition) ??
          (values[index].row - values[index - 1].row) * 7;
      if (
        values[index].date.getTime() - values[index - 1].date.getTime() !==
        expectedDays * 86400000
      )
        throw new Error("Schedule date formula sequence is inconsistent");
    }
  }
  for (const address of anchors.keys())
    if (!trusted.has(address)) throw new Error("Schedule formula anchor is missing");
  return trusted;
}
export async function inspectCalendarImport(
  file: string,
  today = new Date().toISOString().slice(0, 10),
) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const rows: ImportItem[] = [],
    reasons: Record<string, number> = {},
    coordinates: string[] = [],
    rejectedCoordinates: { coordinate: string; reason: string }[] = [];
  const reject = (reason: string, coordinate?: string) => {
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (coordinate) rejectedCoordinates.push({ coordinate, reason });
  };
  const add = (
    sheet: string,
    row: number,
    type: string,
    cells: ExcelJS.Cell[],
  ) => {
    const coordinate = `${sheet}!${row}:${type}`;
    const [dateCell, titleCell, stateCell, endCell] = cells,
      isFormula = (cell: ExcelJS.Cell) =>
        !!cell.value &&
        typeof cell.value === "object" &&
        ("formula" in cell.value || "sharedFormula" in cell.value),
      dateValue = (cell?: ExcelJS.Cell) =>
        cell && isFormula(cell) && trustedDateCells.has(cell.address)
          ? (cell.value as any).result
          : cell?.value;
    if (
      [titleCell, stateCell].some(isFormula) ||
      [dateCell, endCell].filter(Boolean).some(
        (cell) => isFormula(cell!) && !trustedDateCells.has(cell!.address),
      )
    )
      return reject("formula-cell", coordinate);
    if (cells.some((cell) => (cell as any)._column?.hidden))
      return reject("hidden-column", coordinate);
    const title = text(titleCell.value),
      start = iso(dateValue(dateCell));
    let end = iso(dateValue(endCell));
    if (!start || start < today)
      return reject("not-current-or-future", coordinate);
    if (!title || title.length > 200)
      return reject("missing-or-invalid-title", coordinate);
    if (!end) end = start;
    if (end < start) return reject("invalid-range", coordinate);
    const sourceKey = createHash("sha256")
      .update(`schedule-v1:${sheet}:${row}:${type}`)
      .digest("hex");
    rows.push({
      activityType: type,
      title,
      status: status(stateCell?.value),
      allDay: true,
      startDate: start,
      endDate: end,
      timeZone: "Europe/Berlin",
      sourceType: "schedule-xlsx",
      sourceKey,
    });
    coordinates.push(`${sheet}!${row}`);
  };
  const timetable = workbook.getWorksheet(ALLOWED_SHEETS[0]);
  if (!timetable) throw new Error("Time table worksheet is required");
  const trustedDateCells = validateTrustedDateFormulas(workbook, timetable);
  if (timetable.state !== "visible")
    reject("hidden-worksheet", "Time table!worksheet");
  else
    timetable.eachRow((row, n) => {
      if (n === 1) return;
      if (row.hidden) return reject("hidden-row", `Time table!${n}`);
      add("Time table", n, "webinar", [
        row.getCell(11),
        row.getCell(12),
        row.getCell(13),
      ]);
      add("Time table", n, "podcast-live", [
        row.getCell(14),
        row.getCell(15),
        row.getCell(16),
      ]);
      add("Time table", n, "podcast-release", [
        row.getCell(17),
        row.getCell(18),
        row.getCell(16),
      ]);
      add("Time table", n, "book-of-the-week", [
        row.getCell(21),
        row.getCell(23),
        row.getCell(24),
        row.getCell(22),
      ]);
    });
  const extra = workbook.getWorksheet(ALLOWED_SHEETS[1]);
  if (!extra) throw new Error("Extra podcast slots worksheet is required");
  if (extra.state !== "visible")
    reject("hidden-worksheet", "Extra podcast slots!worksheet");
  else
    extra.eachRow((row, n) => {
      if (n === 1) return;
      if (row.hidden)
        return reject("hidden-row", `Extra podcast slots!${n}`);
      const titleCell = text(row.getCell(7).value)
        ? row.getCell(7)
        : row.getCell(4);
      add("Extra podcast slots", n, "podcast-live", [
        row.getCell(1),
        titleCell,
        row.getCell(5),
      ]);
    });
  return {
    rows,
    report: {
      adapterSignature:
        TRUSTED_DATE_ADAPTER,
      allowedSheets: [...ALLOWED_SHEETS],
      accepted: rows.length,
      skipped: Object.values(reasons).reduce((a, b) => a + b, 0),
      reasons,
      coordinates,
      rejectedCoordinates,
    },
  };
}
export async function writeCalendarImport(
  rows: ImportItem[],
  options: {
    api: string;
    token?: string;
    confirm: string;
    portalUsername?: string;
    portalPassword?: string;
    fetcher?: typeof fetch;
  },
) {
  if (!options.api || options.confirm !== options.api)
    throw new Error("Explicit target confirmation must equal API URL");
  if (Boolean(options.portalUsername) !== Boolean(options.portalPassword))
    throw new Error("Portal username and password must be provided together");
  if (!options.portalUsername && !options.token)
    throw new Error("Import requires portal credentials or a session token");
  const authorization = options.portalUsername
      ? `Basic ${Buffer.from(`${options.portalUsername}:${options.portalPassword}`).toString("base64")}`
      : `Bearer ${options.token}`,
    fetcher = options.fetcher || fetch,
    api = options.api.replace(/\/$/, ""),
    route = options.portalUsername
      ? "/work/api/calendar-items"
      : "/api/calendar-items";
  let created = 0,
    duplicates = 0;
  const backoff = (attempt: number) =>
    new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
  for (const row of rows) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetcher(`${api}${route}`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "idempotency-key": row.sourceKey,
          },
          body: JSON.stringify(row),
        });
      } catch {
        if (attempt === 2) throw new Error("Import network failure");
        await backoff(attempt);
        continue;
      }
      if (response.status !== 429 && response.status < 500) break;
      if (attempt < 2) await backoff(attempt);
    }
    if (!response?.ok)
      throw new Error(
        `Import rejected for row key (${response?.status || "network"})`,
      );
    response.status === 201 ? created++ : duplicates++;
  }
  const byYear = new Map<string, ImportItem[]>();
  for (const row of rows)
    byYear.set(row.startDate.slice(0, 4), [
      ...(byYear.get(row.startDate.slice(0, 4)) || []),
      row,
    ]);
  for (const [year, expected] of byYear) {
    const verify = await fetcher(
      `${api}${route}?from=${year}-01-01&to=${year}-12-31`,
      { headers: { authorization } },
    );
    if (!verify.ok) throw new Error("Import verification failed");
    const body: any = await verify.json();
    for (const row of expected)
      if (!(body.items || []).some((i: any) => i.sourceKey === row.sourceKey))
        throw new Error("Import verification missing row key");
  }
  return { accepted: rows.length, created, duplicates, verified: rows.length };
}
if (require.main === module) {
  const file = process.argv[2],
    write = process.argv.includes("--write");
  inspectCalendarImport(file)
    .then(async ({ rows, report }) => {
      if (!write)
        return console.log(JSON.stringify({ mode: "dry-run", ...report }));
      console.log(
        JSON.stringify({
          mode: "write",
          ...(await writeCalendarImport(rows, {
            api: process.env.CALENDAR_IMPORT_API || "",
            token: process.env.CALENDAR_IMPORT_TOKEN || "",
            portalUsername: process.env.CALENDAR_IMPORT_PORTAL_USERNAME,
            portalPassword: process.env.CALENDAR_IMPORT_PORTAL_PASSWORD,
            confirm: process.env.CALENDAR_IMPORT_CONFIRM || "",
          })),
        }),
      );
    })
    .catch((e) => {
      console.error(JSON.stringify({ error: e.message }));
      process.exitCode = 1;
    });
}
