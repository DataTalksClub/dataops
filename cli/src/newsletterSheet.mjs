// Read the retired schedule sheet's Newsletter tab from a CSV export and plan
// how DataOps newsletter issues catch up with it. The export keeps one row per
// sponsor placement: a Primary Slot and an optional Secondary Slot per weekly
// issue, a Stand-Alone Newsletter row per stand-alone send, and a Vacation row
// for a cancelled week. Every row has a stable ID (`NL-306`,
// `NL-306-secondary`, `NL-<date>-standalone`, `NL-<date>-vacation`); `NL-306`
// and `NL-306-secondary` are one issue. The tab's banner row sits above the
// header row, so the header is found by looking for the ID and Promo Type
// columns.
//
// Past issues follow the export's date, number, document links, and stats.
// Sponsor names and company links already in DataOps are never overwritten or
// cleared: the sync fills only what is missing and reports every difference.
// A sponsor is linked to its company only when exactly one company has the
// same name; an ambiguous name (NVIDIA/Nvidia) keeps the issue's existing
// link and is reported. The sync never creates deals or Cards and never
// deletes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { UsageError } from "./errors.mjs";
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

/** Parse an integer count cell ("99,714", "15,188 views", "33.193"); undefined when blank or non-numeric ("???"). */
export function sheetCount(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const match = text.match(/^(\d+(?:[.,]\d{3})*)(?:\s*(?:views|opens|clicks|impressions|deliveries))?$/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(/[.,]/g, ""));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Parse a percentage cell ("2.38%", "2.38") or derive it from numerator/denominator when blank or out of range. */
export function sheetRate(raw, numerator, denominator) {
  const text = String(raw ?? "").trim();
  if (text) {
    const match = text.match(/^(\d+(?:\.\d+)?)%?$/);
    if (match) {
      const parsed = Math.round(Number(match[1]) * 100) / 100;
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) return parsed;
    }
  }
  if (numerator !== undefined && denominator !== undefined && denominator > 0) {
    const computed = Math.round((numerator / denominator) * 10000) / 100;
    if (Number.isFinite(computed) && computed >= 0 && computed <= 100) return computed;
  }
  return undefined;
}

function compactObject(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function extractPlacementStats(values, links, issueOpens) {
  const sent = sheetCount(values["newsletter deliveries"]);
  const opens = sheetCount(values["newsletter views opens"]);
  const effectiveOpens = opens ?? issueOpens;
  const clicks = sheetCount(values.clicks);
  const uniqueClicks = sheetCount(values["unique clicks"]);
  const clickRate = sheetRate(values.ctr, clicks, effectiveOpens);
  const linkedinImpressions = sheetCount(values["linkedin impressions"]);
  const linkedinClicks = sheetCount(values["linkedin clicks"]);
  const linkedinCtr = sheetRate(values["linkedin ctr"], linkedinClicks, linkedinImpressions);
  const linkedinPostUrl = httpsLink(links["linkedin post"], values["linkedin post"]);
  const xImpressions = sheetCount(values["twitter impressions"]);
  const xClicks = sheetCount(values["twitter clicks"]);
  const xCtr = sheetRate(values["twitter ctr"], xClicks, xImpressions);
  const xPostUrl = httpsLink(links["twitter post"], values["twitter post"]);
  return {
    sent,
    opens,
    rawCtr: values.ctr,
    slotStats: compactObject({
      clicks,
      uniqueClicks,
      clickRate,
      linkedinImpressions,
      linkedinClicks,
      linkedinCtr,
      linkedinPostUrl,
      xImpressions,
      xClicks,
      xCtr,
      xPostUrl,
    }),
  };
}

/**
 * Sheet rows as `{ row, values, links }` keyed by header: `values` are the
 * displayed texts, `links` the cells' hyperlinks. The tab has a banner row
 * above the header, so the header is the first of the leading rows that names
 * the ID and Promo Type columns.
 */
function keyedRows(grid) {
  const headerAt = grid.slice(0, 5).findIndex((cells) => {
    const names = cells.map((cell) => squash(cell.value));
    return names.includes("id") && names.includes("promo type");
  });
  if (headerAt < 0) {
    throw new UsageError("No header row in the first 5 rows: a Newsletter export must name the ID and Promo Type columns.");
  }
  const [header = [], ...rows] = grid.slice(headerAt);
  const names = header.map((cell) => squash(cell.value));
  return rows.map((cells, index) => {
    const values = {};
    const links = {};
    names.forEach((name, column) => {
      if (!name || values[name] !== undefined) return;
      values[name] = String(cells[column]?.value ?? "").trim();
      links[name] = cells[column]?.link || "";
    });
    return { row: headerAt + index + 2, values, links };
  });
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
    const sponsor = String(values.sponsor ?? "").slice(0, 200);
    const number = /^NL-(\d+)(?:-secondary)?$/i.exec(id)?.[1] || /weekly-(\d+)\b/.exec(`${links.url || ""} ${values.url || ""}`)?.[1];
    placements.push({
      row, id, date, type,
      issueNumber: number ? Number(number) : undefined,
      sponsor: /^n\/?a$|^-$/i.test(sponsor) ? "" : sponsor,
      documentUrl: httpsLink(links.doc, values.doc),
      note: String(values.note ?? "").slice(0, 1000),
      values,
      links,
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
    const validSecondary = secondary && primary?.date === secondary.date ? secondary : undefined;
    const issueSent = sheetCount(primary?.values?.["newsletter deliveries"]) ?? sheetCount(validSecondary?.values?.["newsletter deliveries"]);
    const issueOpens = sheetCount(primary?.values?.["newsletter views opens"]) ?? sheetCount(validSecondary?.values?.["newsletter views opens"]);
    const primaryExtracted = primary ? extractPlacementStats(primary.values, primary.links, issueOpens) : null;
    const secondaryExtracted = validSecondary ? extractPlacementStats(validSecondary.values, validSecondary.links, issueOpens) : null;
    const issueClicks = primaryExtracted?.slotStats?.clicks ?? secondaryExtracted?.slotStats?.clicks;
    const issueUniqueClicks = primaryExtracted?.slotStats?.uniqueClicks ?? secondaryExtracted?.slotStats?.uniqueClicks;
    const issueStats = head.type === "vacation" ? undefined : compactObject({
      sent: issueSent,
      opens: issueOpens,
      clicks: issueClicks,
      uniqueClicks: issueUniqueClicks,
      openRate: sheetRate("", issueOpens, issueSent),
      clickRate: sheetRate(primaryExtracted?.rawCtr || secondaryExtracted?.rawCtr || "", issueClicks, issueOpens),
    });
    const slot = (placement, extracted) => {
      if (!placement) return {};
      return {
        sheetId: placement.id,
        ...(placement.sponsor ? { sponsor: placement.sponsor } : {}),
        ...(placement.documentUrl ? { documentUrl: placement.documentUrl } : {}),
        ...(extracted?.slotStats ? { stats: extracted.slotStats } : {}),
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
        ? { primary: slot(primary, primaryExtracted) }
        : head.type === "vacation"
          ? { primary: { sheetId: head.id }, secondary: {} }
          : { primary: slot(primary, primaryExtracted), secondary: slot(validSecondary, secondaryExtracted) },
      ...(issueStats ? { stats: issueStats } : {}),
      ...(note ? { planningNote: note } : {}),
      sourceKey: issueSourceKey(sheetId),
    });
  }
  issues.sort((left, right) => left.publicationDate.localeCompare(right.publicationDate));
  return { issues, skipped };
}

/** The live companies named `name`, ignoring case and punctuation. */
function companiesNamed(organizations) {
  const byName = new Map();
  for (const org of organizations) {
    if (org.archivedAt) continue;
    const key = squash(org.displayName);
    if (key) byName.set(key, [...(byName.get(key) || []), org.id]);
  }
  return (name) => byName.get(squash(name)) || [];
}

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Merge sheet stats into existing stats without overwriting existing non-empty
 * metrics. Any disagreement with an already-recorded metric is reported in
 * `differences` instead of clobbering DataOps.
 */
function mergeStats(haveStats, wantStats, prefix, differences) {
  if (!wantStats || typeof wantStats !== "object") return { next: haveStats, changed: false };
  const next = haveStats ? { ...haveStats } : {};
  let changed = false;
  for (const [field, wantVal] of Object.entries(wantStats)) {
    if (field === "recordedAt" || wantVal === undefined || wantVal === null || wantVal === "") continue;
    const haveVal = haveStats?.[field];
    if (haveVal === undefined || haveVal === null || haveVal === "") {
      next[field] = wantVal;
      changed = true;
    } else if (haveVal !== wantVal) {
      differences.push(`${prefix} ${field} ${haveVal} vs sheet ${wantVal}`);
    }
  }
  return { next: Object.keys(next).length ? next : undefined, changed };
}

/**
 * What to write: issues the sheet has and DataOps lacks, and changes to
 * matched issues. A past issue takes the sheet's date, number, document
 * links, and stats; one still to come only gets what it lacks. Sponsor names
 * and company links already in DataOps are never overwritten or cleared: the
 * plan fills what is missing and reports every difference. An ambiguous
 * company name keeps the slot's existing link and is reported.
 */
export function planNewsletterSync(sheet, issues, organizations, today) {
  const companiesOf = companiesNamed(organizations);
  const bySourceKey = new Map(issues.filter((issue) => issue.sourceKey).map((issue) => [issue.sourceKey, issue]));
  const byDate = new Map();
  for (const issue of issues) {
    if (issue.status === "cancelled") continue;
    const key = `${issue.publicationDate}|${issue.kind}`;
    byDate.set(key, [...(byDate.get(key) || []), issue]);
  }
  const plan = { creates: [], updates: [], conflicts: [], unchanged: 0, linked: 0, statsUpdated: 0 };
  const ambiguity = (position, sponsor, ids, kept) =>
    `${position} sponsor "${sponsor}" matches ${ids.length} companies (${ids.join(", ")})${kept ? "; keeping the existing company link" : "; no company link"}`;
  const ambiguousBySlotId = new Map();
  for (const wanted of sheet) {
    for (const slot of Object.values(wanted.slots)) {
      if (!slot.sponsor) continue;
      const ids = companiesOf(slot.sponsor);
      if (ids.length === 1) {
        slot.organizationId = ids[0];
        plan.linked += 1;
      } else if (ids.length > 1) {
        ambiguousBySlotId.set(slot.sheetId, ids);
      }
    }
    const candidates = byDate.get(`${wanted.publicationDate}|${wanted.kind}`) || [];
    const existing = bySourceKey.get(wanted.sourceKey) || (candidates.length === 1 ? candidates[0] : null);
    const { sheetId, ...body } = wanted;
    if (!existing) {
      const ambiguous = Object.entries(body.slots || {})
        .filter(([, slot]) => ambiguousBySlotId.has(slot.sheetId))
        .map(([position, slot]) => ambiguity(position, slot.sponsor, ambiguousBySlotId.get(slot.sheetId), false));
      const hasStats = Boolean(body.stats || Object.values(body.slots || {}).some((slot) => slot?.stats));
      if (hasStats) plan.statsUpdated += 1;
      plan.creates.push({ sheetId, ...(ambiguous.length ? { ambiguous } : {}), body: { ...body, sourceType: SOURCE_TYPE } });
      continue;
    }
    const past = existing.publicationDate < today && wanted.publicationDate < today;
    const changes = {};
    const differences = [];
    let issueStatsChanged = false;
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
      for (const field of ["sheetId", "documentUrl"]) {
        if (want[field] === undefined) continue;
        if (past || have[field] === undefined) next[field] = want[field];
      }
      // DataOps wins for sponsor names and company links: fill what is
      // missing, report the rest, never overwrite or clear.
      if (want.sponsor !== undefined) {
        if (have.sponsor === undefined) next.sponsor = want.sponsor;
        else if (squash(have.sponsor) !== squash(want.sponsor)) {
          differences.push(`${position} sponsor "${have.sponsor}" vs sheet "${want.sponsor}"`);
        }
      }
      const ambiguousIds = ambiguousBySlotId.get(want.sheetId);
      if (ambiguousIds) {
        differences.push(ambiguity(position, want.sponsor, ambiguousIds, Boolean(have.organizationId)));
      } else if (want.organizationId !== undefined) {
        if (have.organizationId === undefined) {
          // The sheet's link belongs to the sheet's name; apply it only when
          // that name is the one the slot keeps.
          if (have.sponsor === undefined || squash(have.sponsor) === squash(want.sponsor)) next.organizationId = want.organizationId;
        } else if (have.organizationId !== want.organizationId) {
          differences.push(`${position} company link ${have.organizationId} vs sheet ${want.organizationId}`);
        }
      }
      if (want.stats) {
        const mergedSlotStats = mergeStats(have.stats, want.stats, `${position} stats`, differences);
        if (mergedSlotStats.changed) {
          next.stats = mergedSlotStats.next;
          issueStatsChanged = true;
        }
      }
      if (!same(next, have)) slots[position] = next;
    }
    if (Object.keys(slots).length) changes.slots = slots;
    if (wanted.stats) {
      const mergedIssueStats = mergeStats(existing.stats, wanted.stats, "issue stats", differences);
      if (mergedIssueStats.changed) {
        changes.stats = mergedIssueStats.next;
        issueStatsChanged = true;
      }
    }
    if (past && wanted.planningNote && !existing.planningNote) changes.planningNote = wanted.planningNote;
    if (issueStatsChanged) plan.statsUpdated += 1;
    if (differences.length) plan.conflicts.push({ id: existing.id, label: existing.label, publicationDate: existing.publicationDate, differences });
    if (Object.keys(changes).length) plan.updates.push({ id: existing.id, label: existing.label, version: existing.version, publicationDate: existing.publicationDate, changes });
    else plan.unchanged += 1;
  }
  return plan;
}
