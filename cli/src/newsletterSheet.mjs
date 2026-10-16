// Read the schedule sheet's Newsletter tab and plan how DataOps newsletter
// issues catch up with it. The sheet keeps one row per sponsor placement: a
// Primary Slot and an optional Secondary Slot per weekly issue, a Stand-Alone
// Newsletter row per stand-alone send, and a Vacation row for a cancelled
// week. Every row has a stable ID (`NL-306`, `NL-306-secondary`,
// `NL-<date>-standalone`, `NL-<date>-vacation`); `NL-306` and
// `NL-306-secondary` are one issue.
//
// Past issues follow the sheet. An issue still to come is planned in DataOps
// (slots are booked there), so the sync only fills what it lacks and reports
// where it differs. A sponsor is linked to its company in the Sponsors tab
// only when exactly one company has the same name; otherwise the sheet's name
// stays plain text. The sync never creates deals or Cards and never deletes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseCsv } from "./bookkeepingSheet.mjs";

export const SOURCE_TYPE = "schedule-sheet";

const ROW_TYPES = {
  "primary slot": "primary",
  "secondary slot": "secondary",
  "stand alone newsletter": "standalone",
  vacation: "vacation",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const squash = (value) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "14 Feb 22", "14 Feb 2022" or "2022-02-14" as an ISO date; "" otherwise. */
export function sheetIssueDate(raw) {
  const text = String(raw ?? "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let year, month, day;
  if (match) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{2}|\d{4})$/);
    if (!match || !MONTHS.includes(match[2].toLowerCase())) return "";
    [day, month, year] = [Number(match[1]), MONTHS.indexOf(match[2].toLowerCase()) + 1, Number(match[3])];
    if (year < 100) year += 2000;
  }
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso ? iso : "";
}

/** The issue a row belongs to: its ID without the `-secondary` suffix. */
export const issueSheetId = (rowId) => rowId.replace(/-secondary$/i, "");

/** The issue's source key; an issue created from the sheet keeps it. */
export const issueSourceKey = (issueId) =>
  createHash("sha256").update(`Newsletter:id:${issueId}`).digest("hex");

const httpsLink = (link, text) => [link, text].find((value) => /^https:\/\//.test(String(value || "").trim()))?.trim() || "";

/**
 * Sheet rows as `{ row, values, links }` keyed by header: `values` are the
 * displayed texts, `links` the cells' hyperlinks.
 */
function keyedRows(grid) {
  const [header = [], ...rows] = grid;
  const names = header.map((cell) => squash(cell.value));
  return rows.map((cells, index) => {
    const values = {};
    const links = {};
    names.forEach((name, column) => {
      if (!name || values[name] !== undefined) return;
      values[name] = String(cells[column]?.value ?? "").trim();
      links[name] = cells[column]?.link || "";
    });
    return { row: index + 2, values, links };
  });
}

/** The Newsletter tab through the Sheets API, hidden rows included, with each cell's link. */
export async function fetchNewsletterTab(spreadsheetId, accessToken, fetchImpl = fetch) {
  const range = encodeURIComponent("'Newsletter'");
  const fields = encodeURIComponent("sheets.data.rowData.values(formattedValue,hyperlink)");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?ranges=${range}&fields=${fields}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google Sheets answered HTTP ${response.status}; check the sheet id and the token's account.`);
  const body = await response.json();
  const rowData = body.sheets?.[0]?.data?.[0]?.rowData || [];
  if (!rowData.length) throw new Error("The spreadsheet has no Newsletter tab, or it is empty.");
  return keyedRows(rowData.map((row) => (row.values || []).map((cell) => ({ value: cell.formattedValue ?? "", link: cell.hyperlink || "" }))));
}

/** A CSV export of the Newsletter tab (links only where the cell shows the URL). */
export function readNewsletterCsv(file) {
  return keyedRows(parseCsv(readFileSync(file, "utf8")).map((row) => row.map((value) => ({ value, link: "" }))));
}

/** One issue per email from the sheet rows, plus the rows it could not use. */
export function sheetIssues(rows, today) {
  const skipped = [];
  const placements = [];
  const seen = new Set();
  for (const { row, values, links } of rows) {
    if (!Object.values(values).some(Boolean)) continue;
    const id = values.id;
    const type = ROW_TYPES[squash(values["promo type"])];
    const date = sheetIssueDate(values.date);
    if (!id || id.length > 100) { skipped.push({ row, reason: "no ID" }); continue; }
    if (seen.has(id)) { skipped.push({ row, reason: `duplicate ID ${id}` }); continue; }
    if (!date) { skipped.push({ row, reason: `no date (${id})` }); continue; }
    if (!type) { skipped.push({ row, reason: `unknown promo type (${id})` }); continue; }
    seen.add(id);
    const sponsor = values.sponsor.slice(0, 200);
    const number = /^NL-(\d+)(?:-secondary)?$/i.exec(id)?.[1] || /weekly-(\d+)\b/.exec(`${links.url} ${values.url}`)?.[1];
    placements.push({
      row, id, date, type,
      issueNumber: number ? Number(number) : undefined,
      sponsor: /^n\/?a$|^-$/i.test(sponsor) ? "" : sponsor,
      documentUrl: httpsLink(links.doc, values.doc),
      note: values.note.slice(0, 1000),
    });
  }
  const groups = new Map();
  for (const placement of placements) {
    const key = issueSheetId(placement.id);
    groups.set(key, [...(groups.get(key) || []), placement]);
  }
  const issues = [];
  for (const [sheetId, group] of groups) {
    const primary = group.find((placement) => placement.type !== "secondary");
    const secondary = group.find((placement) => placement.type === "secondary");
    const head = primary || secondary;
    if (secondary && (!primary || primary.date !== secondary.date || primary.type !== "primary")) {
      skipped.push({ row: secondary.row, reason: `secondary slot without a matching primary (${secondary.id})` });
      if (!primary) continue;
    }
    const slot = (placement) => {
      if (!placement) return {};
      return {
        sheetId: placement.id,
        ...(placement.sponsor ? { sponsor: placement.sponsor } : {}),
        ...(placement.documentUrl ? { documentUrl: placement.documentUrl } : {}),
      };
    };
    const kind = head.type === "standalone" ? "standalone" : "weekly";
    const note = group.map((placement) => placement.note).find(Boolean);
    issues.push({
      sheetId,
      kind,
      publicationDate: head.date,
      ...(kind === "weekly" && head.issueNumber !== undefined && head.type !== "vacation" ? { issueNumber: head.issueNumber } : {}),
      status: head.type === "vacation" ? "cancelled" : head.date < today ? "sent" : "planned",
      slots: kind === "standalone"
        ? { primary: slot(primary) }
        : head.type === "vacation"
          ? { primary: { sheetId: head.id }, secondary: {} }
          : { primary: slot(primary), secondary: slot(secondary && primary?.date === secondary.date ? secondary : undefined) },
      ...(note ? { planningNote: note } : {}),
      sourceKey: issueSourceKey(sheetId),
    });
  }
  issues.sort((left, right) => left.publicationDate.localeCompare(right.publicationDate));
  return { issues, skipped };
}

/** The one live company named exactly `name`, ignoring case and punctuation. */
function companyMatcher(organizations) {
  const byName = new Map();
  for (const org of organizations) {
    if (org.archivedAt) continue;
    const key = squash(org.displayName);
    if (key) byName.set(key, [...(byName.get(key) || []), org.id]);
  }
  return (name) => {
    const ids = byName.get(squash(name)) || [];
    return ids.length === 1 ? ids[0] : null;
  };
}

const SLOT_FIELDS = ["sponsor", "sheetId", "documentUrl", "organizationId"];
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * What to write: issues the sheet has and DataOps lacks, and changes to
 * matched issues. A past issue takes the sheet's date, number, sponsors and
 * links; one still to come only gets what it lacks.
 */
export function planNewsletterSync(sheet, issues, organizations, today) {
  const companyOf = companyMatcher(organizations);
  const bySourceKey = new Map(issues.filter((issue) => issue.sourceKey).map((issue) => [issue.sourceKey, issue]));
  const byDate = new Map();
  for (const issue of issues) {
    if (issue.status === "cancelled") continue;
    const key = `${issue.publicationDate}|${issue.kind}`;
    byDate.set(key, [...(byDate.get(key) || []), issue]);
  }
  const plan = { creates: [], updates: [], conflicts: [], unchanged: 0, linked: 0 };
  for (const wanted of sheet) {
    for (const slot of Object.values(wanted.slots)) {
      const organizationId = slot.sponsor ? companyOf(slot.sponsor) : null;
      if (organizationId) {
        slot.organizationId = organizationId;
        plan.linked += 1;
      }
    }
    const candidates = byDate.get(`${wanted.publicationDate}|${wanted.kind}`) || [];
    const existing = bySourceKey.get(wanted.sourceKey) || (candidates.length === 1 ? candidates[0] : null);
    const { sheetId, ...body } = wanted;
    if (!existing) {
      plan.creates.push({ sheetId, body: { ...body, sourceType: SOURCE_TYPE } });
      continue;
    }
    const past = existing.publicationDate < today && wanted.publicationDate < today;
    const changes = {};
    const differences = [];
    if (past) {
      if (existing.publicationDate !== wanted.publicationDate) changes.publicationDate = wanted.publicationDate;
      if (wanted.issueNumber !== undefined && existing.issueNumber !== wanted.issueNumber) changes.issueNumber = wanted.issueNumber;
      if (existing.status !== "sent" && existing.status !== "cancelled" && wanted.status === "sent") changes.status = "sent";
      if (wanted.status === "cancelled" && existing.status !== "cancelled") differences.push("the sheet has a vacation week here");
    } else {
      if (existing.issueNumber === undefined && wanted.issueNumber !== undefined) changes.issueNumber = wanted.issueNumber;
      if (existing.publicationDate !== wanted.publicationDate) differences.push(`date ${existing.publicationDate} vs sheet ${wanted.publicationDate}`);
      if (existing.issueNumber !== undefined && wanted.issueNumber !== undefined && existing.issueNumber !== wanted.issueNumber) {
        differences.push(`number #${existing.issueNumber} vs sheet #${wanted.issueNumber}`);
      }
    }
    const slots = {};
    for (const position of Object.keys(wanted.slots)) {
      const have = existing.slots?.[position] || {};
      const want = wanted.slots[position];
      const next = { ...have };
      for (const field of SLOT_FIELDS) {
        if (want[field] === undefined) continue;
        if (past || have[field] === undefined) next[field] = want[field];
        else if (have[field] !== want[field] && field === "sponsor") differences.push(`${position} sponsor "${have.sponsor}" vs sheet "${want.sponsor}"`);
      }
      // A past slot names the sheet's sponsor; its company link follows the name.
      if (past && want.sponsor !== undefined && !want.organizationId) delete next.organizationId;
      if (!same(next, have)) slots[position] = next;
    }
    if (Object.keys(slots).length) changes.slots = slots;
    if (past && wanted.planningNote && !existing.planningNote) changes.planningNote = wanted.planningNote;
    if (differences.length) plan.conflicts.push({ id: existing.id, label: existing.label, publicationDate: existing.publicationDate, differences });
    if (Object.keys(changes).length) plan.updates.push({ id: existing.id, label: existing.label, version: existing.version, publicationDate: existing.publicationDate, changes });
    else plan.unchanged += 1;
  }
  return plan;
}
