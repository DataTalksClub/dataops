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
const normalized = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " "),
  iso = (value: unknown) =>
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : /^\d{4}-\d{2}-\d{2}$/.test(String(value))
        ? String(value)
        : "";
export async function readNewsletterSlots(file: string) {
  return (await inspectNewsletterSlots(file)).rows;
}
export async function inspectNewsletterSlots(file: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.getWorksheet("Newsletter");
  if (!sheet) throw new Error("Newsletter worksheet is required");
  const patterns = {
    date: /\b(date|publication|publish|send|scheduled)\b/,
    label: /\b(newsletter|campaign|subject|title|label)\b/,
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
    bookerCol = pick(patterns.booker);
  if (!dateCol || !labelCol)
    throw new Error("Required schedule columns were not found");
  const rows: ImportSlot[] = [],
    reasons: Record<string, number> = {},
    coordinates: string[] = [];
  let skipped = 0;
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
      label = String(row.getCell(labelCol).value ?? "").trim();
    if (!date) {
      reject("missing-or-invalid-date");
      return;
    }
    if (!label || label.length > 200) {
      reject("missing-or-invalid-campaign-label");
      return;
    }
    const numberValue = numberCol ? Number(row.getCell(numberCol).value) : NaN,
      statusRaw = statusCol ? normalized(row.getCell(statusCol).value) : "",
      status = [
        "open",
        "reserved",
        "drafting",
        "scheduled",
        "sent",
        "cancelled",
      ].includes(statusRaw)
        ? statusRaw
        : "open",
      booker = bookerCol
        ? String(row.getCell(bookerCol).value ?? "")
            .trim()
            .slice(0, 200)
        : "";
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
        .update(`Newsletter:${rowNumber}:${date}:${label}`)
        .digest("hex"),
    });
    coordinates.push(`Newsletter!${rowNumber}`);
  });
  return {
    rows,
    report: {
      sheet: "Newsletter",
      headerRow,
      accepted: rows.length,
      skipped,
      reasons,
      coordinates,
    },
  };
}
export async function writeNewsletterSlots(
  rows: ImportSlot[],
  options: { api: string; token: string; confirm: string },
) {
  if (options.confirm !== options.api)
    throw new Error("Explicit target confirmation must equal API URL");
  let created = 0,
    duplicates = 0;
  for (const row of rows) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(`${options.api}/api/newsletter-slots`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
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
  const verification = await fetch(
    `${options.api}/api/newsletter-slots?from=1900-01-01&to=9999-12-31`,
    { headers: { authorization: `Bearer ${options.token}` } },
  );
  if (!verification.ok) throw new Error("Import verification failed");
  const verified = (await verification.json()) as any;
  for (const row of rows)
    if (
      !(verified.items || []).some(
        (item: any) => item.sourceKey === row.sourceKey,
      )
    )
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
          ...(await writeNewsletterSlots(rows, { api, token, confirm })),
        }),
      );
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    });
}
