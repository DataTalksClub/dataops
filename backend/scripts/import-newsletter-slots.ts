import ExcelJS from "exceljs";
import { createHash } from "crypto";
export type ImportSlot = {
  publicationDate: string;
  campaignLabel: string;
  campaignNumber?: number;
  status: string;
  bookedByDisplayName?: string;
  sourceType: string;
  sourceKey: string;
};
/** A cell's plain value: formula results, hyperlink text and rich text unwrapped. */
const cellValue = (value: unknown): unknown => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const cell = value as Record<string, any>;
      if ("result" in cell) return cellValue(cell.result);
      if ("text" in cell) return cellValue(cell.text);
      if (Array.isArray(cell.richText))
        return cell.richText.map((part: any) => part.text).join("");
    }
    return value;
  },
  normalized = (v: unknown) =>
    String(cellValue(v) ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
  iso = (raw: unknown) => {
    const value = cellValue(raw);
    return value instanceof Date
      ? value.toISOString().slice(0, 10)
      : /^\d{4}-\d{2}-\d{2}$/.test(String(value))
        ? String(value)
        : "";
  },
  text = (value: unknown) => String(cellValue(value) ?? "").trim();
const SHEET_STATUSES = [
  "open",
  "reserved",
  "drafting",
  "scheduled",
  "sent",
  "cancelled",
];
/**
 * Slot identity. When the "Newsletter" sheet has an `ID` column, each row's
 * slot is keyed by that stable ID, so inserting or reordering rows never
 * changes which slot a row updates. Without the column a slot is keyed by its
 * row number, date and label, which breaks when rows move; the schedule sheet
 * has an ID column for that reason.
 */
const ID_HEADER = /^(id|slot id)$/;
/**
 * The DataTalks.Club schedule sheet has no label, issue or status column. A
 * row there has a Promo Type (Primary Slot, Secondary Slot, Stand-Alone
 * Newsletter, Vacation), a Mailchimp URL ending in `weekly-<issue>`, and
 * post-send metrics once sent. For that layout the label and issue number come
 * from the type and URL. A Secondary Slot shares its issue with the Primary
 * Slot, so it carries no campaignNumber: the issue's Card links to the Primary
 * Slot and the pair is not reported as a duplicate.
 */
const scheduleLabel = (type: string, issue: number | undefined) => {
  const kind = normalized(type).trim();
  if (issue !== undefined && kind === "primary slot")
    return { label: `Weekly #${issue}`, campaignNumber: issue };
  if (issue !== undefined && kind === "secondary slot")
    return { label: `Weekly #${issue} secondary slot` };
  return { label: type };
};
/**
 * Status for a sheet without a status column: a Vacation week is cancelled,
 * a row with send metrics or a past date has been sent, a row with a sponsor
 * is reserved, and anything else is open.
 */
const inferredStatus = (row: { type: string; sent: boolean; booked: boolean }) =>
  normalized(row.type).trim() === "vacation"
    ? "cancelled"
    : row.sent
      ? "sent"
      : row.booked
        ? "reserved"
        : "open";
export async function readNewsletterSlots(file: string) {
  return (await inspectNewsletterSlots(file)).rows;
}
export async function inspectNewsletterSlots(
  file: string,
  options: { today?: string } = {},
) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Newsletter");
  if (!sheet) throw new Error("Newsletter worksheet is required");
  const patterns = {
    date: /\b(date|publication|publish|send|scheduled)\b/,
    label: /^(newsletter|campaign|campaign label|subject|title|label)$/,
    type: /^promo type$/,
    number: /\b(number|issue|campaign no|newsletter no)\b/,
    status: /\b(status|state)\b/,
    booker: /\b(booked|sponsor|client|booking owner)\b/,
  };
  let headerRow = 0,
    headers = new Map<string, number>(),
    best = 0;
  for (
    let rowNumber = 1;
    rowNumber <= Math.min(sheet.rowCount, 40);
    rowNumber++
  ) {
    const candidate = new Map<string, number>();
    sheet
      .getRow(rowNumber)
      .eachCell((cell, column) =>
        candidate.set(normalized(cell.value), column),
      );
    const score = Object.values(patterns).filter((pattern) =>
      [...candidate.keys()].some((value) => pattern.test(value)),
    ).length;
    if (score > best) {
      best = score;
      headerRow = rowNumber;
      headers = candidate;
    }
  }
  const pick = (pattern: RegExp) =>
      [...headers].find(([value]) => pattern.test(value))?.[1],
    typedColumn = (test: (value: unknown) => boolean) => {
      let winner = 0,
        max = 0;
      for (let column = 1; column <= sheet.columnCount; column++) {
        let count = 0;
        for (
          let row = headerRow + 1;
          row <= Math.min(sheet.rowCount, headerRow + 200);
          row++
        )
          if (test(sheet.getRow(row).getCell(column).value)) count++;
        if (count > max) {
          max = count;
          winner = column;
        }
      }
      return winner || undefined;
    },
    dateCol =
      pick(patterns.date) || typedColumn((value) => value instanceof Date),
    labelCol = pick(patterns.label),
    numberCol = pick(patterns.number),
    statusCol = pick(patterns.status),
    bookerCol = pick(patterns.booker),
    idCol = pick(ID_HEADER),
    typeCol = pick(patterns.type),
    urlCol = pick(/^url$/),
    sentMetricCol = pick(/^newsletter deliveries$/);
  if (!dateCol || !(labelCol || typeCol))
    throw new Error("Required schedule columns were not found");
  const rows: ImportSlot[] = [],
    reasons: Record<string, number> = {},
    coordinates: string[] = [];
  let skipped = 0;
  const seenIds = new Set<string>();
  const reject = (reason: string) => {
    skipped++;
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    if (row.hidden) {
      reject("hidden-row");
      return;
    }
    const date = iso(row.getCell(dateCol).value),
      issueMatch = urlCol
        ? /weekly-(\d+)\b/.exec(text(row.getCell(urlCol).value))
        : null,
      issue = issueMatch ? Number(issueMatch[1]) : undefined,
      type = typeCol ? text(row.getCell(typeCol).value) : "",
      derived = labelCol ? undefined : scheduleLabel(type, issue),
      label = labelCol ? text(row.getCell(labelCol).value) : derived!.label;
    if (!date) {
      reject("missing-or-invalid-date");
      return;
    }
    if (!label || label.length > 200) {
      reject("missing-or-invalid-campaign-label");
      return;
    }
    const slotId = idCol
      ? text(row.getCell(idCol).value)
      : "";
    if (idCol && (!slotId || slotId.length > 100)) {
      reject("missing-or-invalid-id");
      return;
    }
    if (idCol && seenIds.has(slotId)) {
      reject("duplicate-id");
      return;
    }
    seenIds.add(slotId);
    const numberValue = numberCol
        ? Number(cellValue(row.getCell(numberCol).value))
        : (derived?.campaignNumber ?? NaN),
      statusRaw = statusCol ? normalized(row.getCell(statusCol).value) : "",
      sheetBooker = bookerCol
        ? text(row.getCell(bookerCol).value).slice(0, 200)
        : "",
      booker = /^n\/?a$/i.test(sheetBooker) ? "" : sheetBooker,
      status = statusCol
        ? SHEET_STATUSES.includes(statusRaw)
          ? statusRaw
          : "open"
        : inferredStatus({
            type,
            sent:
              (sentMetricCol !== undefined &&
                text(row.getCell(sentMetricCol).value) !== "") ||
              date < today,
            booked: Boolean(booker),
          });
    rows.push({
      publicationDate: date,
      campaignLabel: label,
      ...(Number.isSafeInteger(numberValue) && numberValue >= 0
        ? { campaignNumber: numberValue }
        : {}),
      status,
      ...(booker ? { bookedByDisplayName: booker } : {}),
      sourceType: "xlsx-import",
      sourceKey: createHash("sha256")
        .update(
          idCol
            ? `Newsletter:id:${slotId}`
            : `Newsletter:${rowNumber}:${date}:${label}`,
        )
        .digest("hex"),
    });
    coordinates.push(`Newsletter!${rowNumber}`);
  });
  return {
    rows,
    report: {
      sheet: "Newsletter",
      headerRow,
      keyedBy: idCol ? "id-column" : "row",
      accepted: rows.length,
      skipped,
      reasons,
      coordinates,
    },
  };
}
export async function writeNewsletterSlots(
  rows: ImportSlot[],
  options: {
    api: string;
    token?: string;
    confirm: string;
  },
) {
  if (options.confirm !== options.api)
    throw new Error("Explicit target confirmation must equal API URL");
  if (!options.token)
    throw new Error("Import requires a session token");
  const authorization = `Bearer ${options.token}`,
    api = options.api.replace(/\/$/, ""),
    headers = { authorization };
  let created = 0,
    duplicates = 0;
  for (const row of rows) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(`${api}/api/newsletter-slots`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": row.sourceKey,
          },
          body: JSON.stringify(row),
        });
      } catch {
        if (attempt === 2) throw new Error("Import network failure");
        continue;
      }
      if (response.status < 500) break;
    }
    if (!response?.ok)
      throw new Error(
        `Import rejected for row key (${response?.status || "network"})`,
      );
    response.status === 201 ? created++ : duplicates++;
  }
  const verifiedKeys = new Set<string>();
  for (const year of [
    ...new Set(rows.map((row) => row.publicationDate.slice(0, 4))),
  ].sort()) {
    const verification = await fetch(
      `${api}/api/newsletter-slots?from=${year}-01-01&to=${year}-12-31`,
      { headers },
    );
    if (!verification.ok) throw new Error("Import verification failed");
    const result = (await verification.json()) as any;
    for (const item of result.items || [])
      if (typeof item.sourceKey === "string") verifiedKeys.add(item.sourceKey);
  }
  for (const row of rows)
    if (!verifiedKeys.has(row.sourceKey))
      throw new Error("Import verification missing row key");
  return { accepted: rows.length, created, duplicates, verified: rows.length };
}
if (require.main === module) {
  const file = process.argv[2],
    write = process.argv.includes("--write");
  inspectNewsletterSlots(file)
    .then(async ({ rows, report }) => {
      if (!write) {
        console.log(JSON.stringify({ mode: "dry-run", ...report }));
        return;
      }
      const api = process.env.NEWSLETTER_IMPORT_API || "",
        token = process.env.NEWSLETTER_IMPORT_TOKEN || "",
        confirm = process.env.NEWSLETTER_IMPORT_CONFIRM || "";
      console.log(
        JSON.stringify({
          mode: "write",
          ...(await writeNewsletterSlots(rows, {
            api,
            token,
            confirm,
          })),
        }),
      );
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    });
}
