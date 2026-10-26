import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { fetchNewsletterTab, planNewsletterSync, readNewsletterCsv, sheetIssues } from "../newsletterSheet.mjs";
import { rewriteVerificationUri } from "./auth.mjs";
import { domainDocCommand } from "./sponsorDocs.mjs";

export const summary = "Plan newsletter issues, their sponsor slots, and their Cards";

export const help = `dataops newsletter - newsletter issues (the web Planning > Newsletter view)

An issue is one email. A weekly issue has an issue number and two sponsor
slots, primary and secondary; a stand-alone issue has one. A slot is booked
when it names a sponsor and open otherwise. Booking a slot for a sponsor from
the Sponsors tab records a deliverable on their deal for the issue; booking
adds the slot's sponsor Tasks to the issue's Card, releasing it skips the
slot's open Tasks (done ones stay).

An issue is planned without a Card. The daily run creates its Card
card-lead-days before the issue date (earlier if the Template has an earlier
Task); create-card makes it now. The new Card is filled from the issue: its
booked sponsors and its links. remove-card takes it away again and keeps the
issue, moving the Card's links onto it; it refuses while the Card holds work
(a done Task, comments, notes, files) unless --confirm. Cancelling or
deleting the issue deletes its Card.

Usage
  dataops newsletter list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--status S] [--kind K]
      [--booked true|false]       true: a sponsor is booked; false: the primary slot has none
  dataops newsletter list --card <card-id>     The issue a Card belongs to
  dataops newsletter show <issue-id>
  dataops newsletter create --date YYYY-MM-DD [--kind weekly|standalone] [--number N]
      [--time HH:MM] [--status S] [--note N] [--public-url URL]
                                  weekly by default, slots open, status planned
  dataops newsletter update <issue-id> [--date D] [--number N] [--time HH:MM] [--status S]
      [--primary-doc URL|none] [--secondary-doc URL|none] [--note N] [--public-url URL]
      [--link "NAME=URL"|"NAME=none" ...] [--confirm]
  dataops newsletter create-card <issue-id>    Create the issue's Card now
  dataops newsletter remove-card <issue-id> [--dry-run] [--confirm]
                                  Remove the Card, keep the issue; --dry-run shows what
                                  would move to the issue and what keeps the Card
  dataops newsletter due-cards [--dry-run]     Run the daily Card creation now
  dataops newsletter sponsors                  Who a slot can be booked for (deals, organizations)
  dataops newsletter book <issue-id> <primary|secondary> (--deal <deal-id> | --organization <org-id>)
                                  Books the slot (replacing a previous sponsor); an
                                  organization without a live deal gets a new open deal
  dataops newsletter release <issue-id> <primary|secondary> [--confirm]
                                  Frees the slot; its deliverable is marked withdrawn
  dataops newsletter doc create <issue-id|card-id> [--slot primary|secondary] [--standalone] [--email]
                                  Create the portal sponsor content document for the issue
                                  or Card, link it on the Card's "Sponsorship document"
                                  field, and print the shareable link with the access code
  dataops newsletter doc show <doc-id>
  dataops newsletter doc export <doc-id>
  dataops newsletter doc delete <doc-id> --yes
  dataops newsletter markdown set <issue-id> [issue|sources|brief] --file <path>
  dataops newsletter markdown set <issue-id> [--issue-file <path>] [--sources-file <path>] [--brief-file <path>]
                                  Store the Newsletter Markdown package (issue.md, sources.md,
                                  brief.md) on the issue in DataOps, link the HTML preview on
                                  the Card, and print the shareable preview link (?code=)
  dataops newsletter markdown show <issue-id> [issue|sources|brief]
  dataops newsletter markdown preview <issue-id>
  dataops newsletter markdown rotate-code <issue-id>
  dataops newsletter stats <issue-id> [primary|secondary]
      [--deliveries N] [--opens N] [--clicks N] [--unique-clicks N]
      [--open-rate PCT] [--click-rate PCT]
      [--linkedin-impressions N] [--linkedin-clicks N] [--linkedin-ctr PCT] [--linkedin-post URL|none]
      [--x-impressions N] [--x-clicks N] [--x-ctr PCT] [--x-post URL|none]
      [--clear]
                                  Show or set Mailchimp issue stats and per-slot
                                  (primary / secondary) link + LinkedIn + X stats
  dataops newsletter report <issue-id> [primary|secondary] [--contact NAME]
  dataops newsletter report --sponsor <name> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--contact NAME]
                                  Sponsor performance report (template.newsletter.newsletter-performance)
  dataops newsletter sync --sheet <spreadsheet-id> [--apply]
  dataops newsletter sync <newsletter.csv> [--apply]
                                  Bring issues in line with the schedule sheet's Newsletter
                                  tab, every row back to the start. Creates missing issues
                                  (past ones get no Card); past issues take the sheet's date,
                                  number, sponsors, and Mailchimp/LinkedIn/X stats; upcoming
                                  ones only get what they lack, differences are listed. Links
                                  a sponsor to its company in the Sponsors tab when exactly
                                  one has that name. Never deletes, never creates deals.
                                  Dry run unless --apply.
                                  --sheet needs a Google token in DAPIER_ACCESS_TOKEN:
                                    uv run dapier token exec drive <account> --agent admin-os -- \\
                                      node <dataops>/cli/bin/dataops.mjs newsletter sync --sheet <id>
  dataops newsletter delete <issue-id> [--confirm]   Deletes the issue and its Card
  dataops newsletter dismiss-alert <alert-id>
  dataops newsletter card-lead-days [<days>]    Show, or set (admin), how many days before
                                  an issue's date the daily run creates its Card (default 21)

Statuses: planned, drafting, review, scheduled, sent, cancelled. Cancelling
deletes the Card; reinstating a cancelled issue creates a new one. --confirm
is needed when that deletes completed Tasks, or when releasing a slot whose
Tasks are partly done. A stand-alone issue's slot is "primary". Writes send
the issue's current version.

Examples
  dataops newsletter list --from 2026-11-01 --to 2026-11-30 --booked false
  dataops newsletter doc create <issue-id|card-id> --slot primary --email
  dataops newsletter stats <issue-id> primary --deliveries 99714 --opens 34886 --clicks 831 --unique-clicks 651
  dataops newsletter report <issue-id> primary --contact "Alex"
`;

const POSITIONS = ["primary", "secondary"];
const fmtNum = (n) => new Intl.NumberFormat("en-US").format(n);

function formatIssueStatsLine(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.deliveries !== undefined) parts.push(`${fmtNum(stats.deliveries)} deliveries`);
  if (stats.opens !== undefined) {
    parts.push(`${fmtNum(stats.opens)} opens${stats.openRate !== undefined ? ` (${stats.openRate}%)` : ""}`);
  }
  if (stats.clicks !== undefined) {
    const uniq = stats.uniqueClicks !== undefined ? `, ${fmtNum(stats.uniqueClicks)} unique` : "";
    const rate = stats.clickRate !== undefined ? `, ${stats.clickRate}% CTR` : "";
    parts.push(`${fmtNum(stats.clicks)} clicks${uniq || rate ? ` (${[uniq.replace(/^, /, ""), rate.replace(/^, /, "")].filter(Boolean).join(", ")})` : ""}`);
  }
  return parts.join(" · ");
}

function formatSlotStatsLine(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.clicks !== undefined) {
    const uniq = stats.uniqueClicks !== undefined ? `${fmtNum(stats.uniqueClicks)} unique` : "";
    const rate = stats.clickRate !== undefined ? `${stats.clickRate}% CTR` : "";
    const detail = [uniq, rate].filter(Boolean).join(", ");
    parts.push(`newsletter ${fmtNum(stats.clicks)} clicks${detail ? ` (${detail})` : ""}`);
  }
  if (stats.linkedinImpressions !== undefined || stats.linkedinClicks !== undefined || stats.linkedinPostUrl) {
    const li = [];
    if (stats.linkedinImpressions !== undefined) li.push(`${fmtNum(stats.linkedinImpressions)} imp`);
    if (stats.linkedinClicks !== undefined) li.push(`${fmtNum(stats.linkedinClicks)} clicks`);
    if (stats.linkedinCtr !== undefined) li.push(`${stats.linkedinCtr}% CTR`);
    if (stats.linkedinPostUrl) li.push(stats.linkedinPostUrl);
    parts.push(`LinkedIn ${li.join(" / ")}`);
  }
  if (stats.xImpressions !== undefined || stats.xClicks !== undefined || stats.xPostUrl) {
    const x = [];
    if (stats.xImpressions !== undefined) x.push(`${fmtNum(stats.xImpressions)} imp`);
    if (stats.xClicks !== undefined) x.push(`${fmtNum(stats.xClicks)} clicks`);
    if (stats.xCtr !== undefined) x.push(`${stats.xCtr}% CTR`);
    if (stats.xPostUrl) x.push(stats.xPostUrl);
    parts.push(`X ${x.join(" / ")}`);
  }
  return parts.join(" · ");
}

/** Placement-document changes from flags, applied over `current` slots. */
function slotChanges(args, current = {}) {
  const slots = {};
  for (const position of POSITIONS) {
    const documentUrl = optionalString(args, `${position}Doc`);
    if (documentUrl === undefined) continue;
    const slot = { ...(current[position] || {}) };
    if (documentUrl === "none") delete slot.documentUrl;
    else slot.documentUrl = documentUrl;
    slots[position] = slot;
  }
  return slots;
}

/** `--link "Name=https://..."` adds or replaces a link by name; `Name=none` removes it. */
function linkChanges(args, current = []) {
  if (args.link === undefined) return undefined;
  const links = [...current];
  for (const value of Array.isArray(args.link) ? args.link : [args.link]) {
    const text = String(value);
    const at = text.indexOf("=");
    if (at < 1) throw new UsageError(`--link takes NAME=URL, got "${text}".`);
    const name = text.slice(0, at).trim();
    const url = text.slice(at + 1).trim();
    const index = links.findIndex((link) => link.name === name);
    if (index >= 0) links.splice(index, 1);
    if (url !== "none") links.push({ name, url });
  }
  return links;
}

function issueFields(args) {
  const body = {};
  const date = isoDate(optionalString(args, "date"), "date");
  if (date) body.publicationDate = date;
  for (const [flag, key] of [["time", "publicationTime"], ["status", "status"], ["note", "planningNote"], ["publicUrl", "publicUrl"]]) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value;
  }
  if (args.number !== undefined) body.issueNumber = integer(args.number, "number");
  return body;
}

const cardText = (issue) => {
  if (issue.card) return `${issue.card.openTaskCount}/${issue.card.taskCount} open`;
  if (issue.cardId) return `${issue.cardId} (unavailable)`;
  return issue.cardDueDate ? `due ${issue.cardDueDate}` : "";
};

const slotText = (issue) =>
  POSITIONS.filter((position) => issue.slots?.[position])
    .map((position) => `${position}: ${issue.slots[position].sponsor || "open"}`)
    .join(", ");

export async function list(args, io) {
  const booked = optionalString(args, "booked");
  if (booked !== undefined && !["true", "false"].includes(booked)) throw new UsageError("--booked must be true or false.");
  const card = optionalString(args, "card");
  const query = card
    ? { cardId: card }
    : {
      from: isoDate(args.from, "from"),
      to: isoDate(args.to, "to"),
      status: optionalString(args, "status"),
      kind: optionalString(args, "kind"),
      booked,
    };
  const result = await apiFor(args).get("/api/newsletter-issues", { query });
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (issue) => issue.id],
    ["DATE", (issue) => `${issue.publicationDate}${issue.publicationTime ? ` ${issue.publicationTime}` : ""}`],
    ["ISSUE", (issue) => issue.label || ""],
    ["STATUS", (issue) => issue.status],
    ["SLOTS", slotText],
    ["CARD", cardText],
  ], "No newsletter issues in range.");
  for (const alert of result.alerts || []) io.print(`alert ${alert.id}: ${alert.reasonCode} (${alert.issueId})`);
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops newsletter show <issue-id>");
  const issue = await apiFor(args).get(`/api/newsletter-issues/${enc(id)}`);
  if (args.json) return issue;
  fields(io, Object.entries(issue).filter(([, value]) => typeof value !== "object" || value === null));
  io.print(`slots: ${slotText(issue)}`);
  if (issue.stats) io.print(`stats: ${formatIssueStatsLine(issue.stats)}`);
  for (const position of POSITIONS) {
    const slotStats = issue.slots?.[position]?.stats;
    if (slotStats) io.print(`${position} stats: ${formatSlotStatsLine(slotStats)}`);
  }
  if (issue.card) io.print(`card: ${issue.card.id} ${issue.card.title} (${issue.card.openTaskCount}/${issue.card.taskCount} open)`);
  else if (issue.cardDueDate) io.print(`card: none yet; the daily run creates it on ${issue.cardDueDate}`);
  for (const link of issue.links || []) io.print(`link: ${link.name} ${link.url}`);
  if (issue.markdown) {
    const present = ["issue", "sources", "brief"].filter((k) => issue.markdown[k]);
    if (present.length) {
      io.print(`markdown: ${present.join(", ")}${issue.markdown.updatedAt ? ` (updated ${issue.markdown.updatedAt})` : ""}`);
    }
  }
  if (issue.previewShareUrl || issue.previewUrl) {
    io.print(`preview link: ${rewriteVerificationUri(issue.previewShareUrl || issue.previewUrl, apiFor(args).base)}`);
  }
  return issue;
}

export async function create(args, io) {
  const body = issueFields(args);
  if (!body.publicationDate) throw new UsageError("--date is required.");
  const kind = optionalString(args, "kind") || "weekly";
  if (!["weekly", "standalone"].includes(kind)) throw new UsageError("--kind must be weekly or standalone.");
  body.kind = kind;
  body.status = body.status || "planned";
  body.slots = Object.fromEntries((kind === "weekly" ? POSITIONS : ["primary"]).map((position) => [position, {}]));
  const issue = await apiFor(args).post("/api/newsletter-issues", body);
  if (args.json) return issue;
  io.print(`Created ${issue.label} on ${issue.publicationDate} [${issue.status}]${issue.cardId ? `, Card ${issue.cardId}` : ""}.`);
  return issue;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops newsletter update <issue-id> [--status S] ...");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const body = issueFields(args);
  const slots = slotChanges(args, current.slots);
  if (Object.keys(slots).length) body.slots = slots;
  const links = linkChanges(args, current.links);
  if (links !== undefined) body.links = links;
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. See `dataops newsletter --help`.");
  if (args.confirm) Object.assign(body, { confirmCardDeletion: true, confirmSlotRemoval: true });
  const issue = await api.put(`/api/newsletter-issues/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return issue;
  io.print(`Updated ${issue.label} on ${issue.publicationDate} [${issue.status}]${issue.cardId ? `, Card ${issue.cardId}` : ", no Card"}.`);
  return issue;
}

function nonNegativeIntArg(args, names, label) {
  for (const name of names) {
    if (args[name] === undefined) continue;
    const cleaned = String(args[name]).replace(/,/g, "").trim();
    const num = Number(cleaned);
    if (!Number.isSafeInteger(num) || num < 0) throw new UsageError(`--${label} must be a non-negative integer.`);
    return num;
  }
  return undefined;
}

function rateArg(args, names, label) {
  for (const name of names) {
    if (args[name] === undefined) continue;
    const cleaned = String(args[name]).replace(/%$/, "").trim();
    const num = Number(cleaned);
    if (!Number.isFinite(num) || num < 0 || num > 100) throw new UsageError(`--${label} must be a percentage between 0 and 100.`);
    return Math.round(num * 100) / 100;
  }
  return undefined;
}

function urlArg(args, names) {
  for (const name of names) {
    const val = optionalString(args, name);
    if (val !== undefined) return val;
  }
  return undefined;
}

function deriveRate(numerator, denominator) {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined;
  const rate = Math.round((numerator / denominator) * 10000) / 100;
  return rate >= 0 && rate <= 100 ? rate : undefined;
}

function applySlotStatFlags(currentSlotStats, spec, issueOpens) {
  const next = { ...(currentSlotStats || {}) };
  let touched = false;
  for (const [key, value] of Object.entries(spec.metrics)) {
    if (value === undefined) continue;
    next[key] = value;
    touched = true;
  }
  for (const [key, value] of Object.entries(spec.urls)) {
    if (value === undefined) continue;
    if (value === "none") delete next[key];
    else next[key] = value;
    touched = true;
  }
  if (!touched) return null;
  if (spec.metrics.clickRate === undefined && (spec.metrics.clicks !== undefined || spec.opensChanged)) {
    const rate = deriveRate(next.clicks, issueOpens);
    if (rate !== undefined) next.clickRate = rate;
  }
  if (spec.metrics.linkedinCtr === undefined && (spec.metrics.linkedinClicks !== undefined || spec.metrics.linkedinImpressions !== undefined)) {
    const rate = deriveRate(next.linkedinClicks, next.linkedinImpressions);
    if (rate !== undefined) next.linkedinCtr = rate;
  }
  if (spec.metrics.xCtr === undefined && (spec.metrics.xClicks !== undefined || spec.metrics.xImpressions !== undefined)) {
    const rate = deriveRate(next.xClicks, next.xImpressions);
    if (rate !== undefined) next.xCtr = rate;
  }
  delete next.recordedAt;
  return next;
}

export async function stats(args, io) {
  const usage = "dataops newsletter stats <issue-id> [primary|secondary] [--deliveries N] [--opens N] [--clicks N] ...";
  const id = positional(args, 0, usage);
  const posArg = args._[1] !== undefined ? String(args._[1]) : optionalString(args, "slot");
  if (posArg !== undefined && !POSITIONS.includes(posArg)) {
    throw new UsageError("The slot is primary or secondary.");
  }
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  if (posArg === "secondary" && current.kind === "standalone") {
    throw new UsageError("A stand-alone issue has no secondary slot.");
  }

  const deliveries = nonNegativeIntArg(args, ["deliveries"], "deliveries");
  const opens = nonNegativeIntArg(args, ["opens", "views"], "opens");
  const openRate = rateArg(args, ["openRate"], "open-rate");
  const directClicks = nonNegativeIntArg(args, ["clicks"], "clicks");
  const directUniqueClicks = nonNegativeIntArg(args, ["uniqueClicks"], "unique-clicks");
  const directClickRate = rateArg(args, ["clickRate", "ctr"], "click-rate");
  const directLiImp = nonNegativeIntArg(args, ["linkedinImpressions"], "linkedin-impressions");
  const directLiClicks = nonNegativeIntArg(args, ["linkedinClicks"], "linkedin-clicks");
  const directLiCtr = rateArg(args, ["linkedinCtr"], "linkedin-ctr");
  const directLiPost = urlArg(args, ["linkedinPost", "linkedinUrl"]);
  const directXImp = nonNegativeIntArg(args, ["xImpressions", "twitterImpressions"], "x-impressions");
  const directXClicks = nonNegativeIntArg(args, ["xClicks", "twitterClicks"], "x-clicks");
  const directXCtr = rateArg(args, ["xCtr", "twitterCtr"], "x-ctr");
  const directXPost = urlArg(args, ["xPost", "xUrl", "twitterPost", "twitterUrl"]);

  const perSlotSpecs = {};
  for (const position of POSITIONS) {
    const isTarget = (posArg || "primary") === position;
    const hasSocialDirect = directLiImp !== undefined || directLiClicks !== undefined || directLiCtr !== undefined || directLiPost !== undefined
      || directXImp !== undefined || directXClicks !== undefined || directXCtr !== undefined || directXPost !== undefined;
    const useDirectSlot = posArg === position || (!posArg && position === "primary" && (hasSocialDirect || directClicks !== undefined || directUniqueClicks !== undefined || directClickRate !== undefined));
    perSlotSpecs[position] = {
      opensChanged: opens !== undefined,
      metrics: {
        clicks: nonNegativeIntArg(args, [`${position}Clicks`], `${position}-clicks`) ?? (useDirectSlot ? directClicks : undefined),
        uniqueClicks: nonNegativeIntArg(args, [`${position}UniqueClicks`], `${position}-unique-clicks`) ?? (useDirectSlot ? directUniqueClicks : undefined),
        clickRate: rateArg(args, [`${position}ClickRate`, `${position}Ctr`], `${position}-click-rate`) ?? (useDirectSlot ? directClickRate : undefined),
        linkedinImpressions: nonNegativeIntArg(args, [`${position}LinkedinImpressions`], `${position}-linkedin-impressions`) ?? (isTarget ? directLiImp : undefined),
        linkedinClicks: nonNegativeIntArg(args, [`${position}LinkedinClicks`], `${position}-linkedin-clicks`) ?? (isTarget ? directLiClicks : undefined),
        linkedinCtr: rateArg(args, [`${position}LinkedinCtr`], `${position}-linkedin-ctr`) ?? (isTarget ? directLiCtr : undefined),
        xImpressions: nonNegativeIntArg(args, [`${position}XImpressions`, `${position}TwitterImpressions`], `${position}-x-impressions`) ?? (isTarget ? directXImp : undefined),
        xClicks: nonNegativeIntArg(args, [`${position}XClicks`, `${position}TwitterClicks`], `${position}-x-clicks`) ?? (isTarget ? directXClicks : undefined),
        xCtr: rateArg(args, [`${position}XCtr`, `${position}TwitterCtr`], `${position}-x-ctr`) ?? (isTarget ? directXCtr : undefined),
      },
      urls: {
        linkedinPostUrl: urlArg(args, [`${position}LinkedinPost`, `${position}LinkedinUrl`]) ?? (isTarget ? directLiPost : undefined),
        xPostUrl: urlArg(args, [`${position}XPost`, `${position}XUrl`, `${position}TwitterPost`, `${position}TwitterUrl`]) ?? (isTarget ? directXPost : undefined),
      },
    };
  }

  const effectiveOpens = opens ?? current.stats?.opens;
  const body = {};
  const nextSlots = {};

  if (args.clear) {
    if (posArg) {
      nextSlots[posArg] = { ...(current.slots?.[posArg] || {}), stats: null };
    } else {
      body.stats = null;
      for (const position of POSITIONS) {
        if (current.slots?.[position]?.stats) {
          nextSlots[position] = { ...current.slots[position], stats: null };
        }
      }
    }
  } else {
    for (const position of POSITIONS) {
      if (position === "secondary" && current.kind === "standalone") continue;
      const updatedSlotStats = applySlotStatFlags(current.slots?.[position]?.stats, perSlotSpecs[position], effectiveOpens);
      if (updatedSlotStats) {
        nextSlots[position] = { ...(current.slots?.[position] || {}), stats: updatedSlotStats };
      }
    }

    const issueClicks = posArg !== "secondary" ? directClicks : undefined;
    const issueUniqueClicks = posArg !== "secondary" ? directUniqueClicks : undefined;
    const issueClickRate = posArg !== "secondary" ? directClickRate : undefined;
    if (
      deliveries !== undefined || opens !== undefined || openRate !== undefined
      || issueClicks !== undefined || issueUniqueClicks !== undefined || issueClickRate !== undefined
    ) {
      const nextIssueStats = { ...(current.stats || {}) };
      if (deliveries !== undefined) nextIssueStats.deliveries = deliveries;
      if (opens !== undefined) nextIssueStats.opens = opens;
      if (openRate !== undefined) nextIssueStats.openRate = openRate;
      else if (deliveries !== undefined || opens !== undefined) {
        const derivedOpenRate = deriveRate(nextIssueStats.opens, nextIssueStats.deliveries);
        if (derivedOpenRate !== undefined) nextIssueStats.openRate = derivedOpenRate;
      }
      if (issueClicks !== undefined) nextIssueStats.clicks = issueClicks;
      if (issueUniqueClicks !== undefined) nextIssueStats.uniqueClicks = issueUniqueClicks;
      if (issueClickRate !== undefined) nextIssueStats.clickRate = issueClickRate;
      else if (issueClicks !== undefined || opens !== undefined) {
        const derivedClickRate = deriveRate(nextIssueStats.clicks, nextIssueStats.opens);
        if (derivedClickRate !== undefined) nextIssueStats.clickRate = derivedClickRate;
      }
      delete nextIssueStats.recordedAt;
      body.stats = nextIssueStats;
    }
  }

  if (Object.keys(nextSlots).length) body.slots = nextSlots;

  // When called with no mutation flags, print the current stats.
  if (!Object.keys(body).length) {
    if (args.json) {
      return {
        id: current.id,
        label: current.label,
        publicationDate: current.publicationDate,
        stats: current.stats || null,
        slots: Object.fromEntries(
          POSITIONS.filter((pos) => current.slots?.[pos]).map((pos) => [
            pos,
            { sponsor: current.slots[pos].sponsor || null, stats: current.slots[pos].stats || null },
          ]),
        ),
      };
    }
    io.print(`${current.label} (${current.publicationDate})`);
    io.print(`issue stats: ${formatIssueStatsLine(current.stats) || "none recorded"}`);
    for (const position of POSITIONS) {
      if (posArg && posArg !== position) continue;
      const slot = current.slots?.[position];
      if (!slot) continue;
      io.print(`${position} (${slot.sponsor || "open"}): ${formatSlotStatsLine(slot.stats) || "none recorded"}`);
    }
    return current;
  }

  const updated = await api.put(`/api/newsletter-issues/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return updated;
  io.print(`Updated stats on ${updated.label} (${updated.publicationDate}).`);
  if (updated.stats) io.print(`issue stats: ${formatIssueStatsLine(updated.stats)}`);
  for (const position of POSITIONS) {
    const slot = updated.slots?.[position];
    if (slot?.stats) io.print(`${position} (${slot.sponsor || "open"}): ${formatSlotStatsLine(slot.stats)}`);
  }
  return updated;
}

export async function report(args, io) {
  const usage = "dataops newsletter report (<issue-id> [primary|secondary] | --sponsor <name>) [--contact <name>]";
  const sponsor = optionalString(args, "sponsor");
  const organizationId = optionalString(args, "organization");
  const contactName = optionalString(args, "contact");
  const api = apiFor(args);

  if (sponsor || organizationId) {
    const slot = optionalString(args, "slot");
    if (slot !== undefined && !POSITIONS.includes(slot)) throw new UsageError("The slot is primary or secondary.");
    const query = {
      ...(sponsor ? { sponsor } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(slot ? { slot } : {}),
      ...(args.from ? { from: isoDate(args.from, "from") } : {}),
      ...(args.to ? { to: isoDate(args.to, "to") } : {}),
      ...(contactName ? { contactName } : {}),
    };
    const result = await api.get("/api/newsletter-issues/report", { query });
    if (args.json) return result;
    if (!result.items?.length) {
      io.print("No matching sponsor newsletter placements found.");
      return result;
    }
    for (const [index, item] of result.items.entries()) {
      if (index > 0) io.print("\n---\n");
      io.print(`${item.label} · ${item.publicationDate} · ${item.slot} (${item.sponsor || "open"})`);
      io.print(item.message);
    }
    return result;
  }

  const id = positional(args, 0, usage);
  const slot = args._[1] !== undefined ? String(args._[1]) : optionalString(args, "slot");
  if (slot !== undefined && !POSITIONS.includes(slot)) throw new UsageError("The slot is primary or secondary.");
  const query = {
    ...(slot ? { slot } : {}),
    ...(contactName ? { contactName } : {}),
  };
  const result = await api.get(`/api/newsletter-issues/${enc(id)}/report`, { query });
  if (args.json) return result;
  for (const [index, item] of (result.reports || []).entries()) {
    if (index > 0) io.print("\n---\n");
    io.print(`${item.label} · ${item.publicationDate} · ${item.slot} (${item.sponsor || "open"})`);
    io.print(item.message);
  }
  return result;
}

export async function sponsors(args, io) {
  const result = await apiFor(args).get("/api/newsletter-issues/sponsor-options");
  if (args.json) return result;
  table(io, result.items || [], [
    ["SPONSOR", (item) => item.name],
    ["DEAL", (item) => item.dealId ? `${item.dealId} ${item.dealTitle || ""} [${item.dealStatus}]`.trim() : "-"],
    ["ORGANIZATION", (item) => item.organizationId],
  ], "No sponsors in the Sponsors tab yet.");
  return result;
}

function slotArgs(args, usage) {
  const id = positional(args, 0, usage);
  const position = positional(args, 1, usage);
  if (!POSITIONS.includes(position)) throw new UsageError("The slot is primary or secondary.");
  return { id, position };
}

export async function book(args, io) {
  const usage = "dataops newsletter book <issue-id> <primary|secondary> (--deal <id> | --organization <id>)";
  const { id, position } = slotArgs(args, usage);
  const deal = optionalString(args, "deal");
  const organization = optionalString(args, "organization");
  if (Boolean(deal) === Boolean(organization)) throw new UsageError(`Name one of --deal or --organization. ${usage}`);
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const issue = await api.put(`/api/newsletter-issues/${enc(id)}/slots/${position}`, {
    version: current.version,
    ...(deal ? { dealId: deal } : { organizationId: organization }),
  });
  if (!args.json) io.print(`Booked ${issue.slots[position].sponsor} on the ${position} slot of ${issue.label} (deliverable ${issue.deliverableId}).`);
  return issue;
}

export async function release(args, io) {
  const { id, position } = slotArgs(args, "dataops newsletter release <issue-id> <primary|secondary> [--confirm]");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const issue = await api.delete(`/api/newsletter-issues/${enc(id)}/slots/${position}`, {
    version: current.version,
    ...(args.confirm ? { confirmSlotRemoval: true } : {}),
  });
  if (!args.json) io.print(`Released the ${position} slot of ${issue.label}; ${issue.withdrawnDeliverables.length} deliverable(s) marked withdrawn.`);
  return issue;
}

export async function createCard(args, io) {
  const id = positional(args, 0, "dataops newsletter create-card <issue-id>");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const issue = await api.post(`/api/newsletter-issues/${enc(id)}/card`, { version: current.version });
  if (!args.json) io.print(`${current.cardId ? "Already has" : "Created"} Card ${issue.cardId} for ${issue.label} on ${issue.publicationDate}.`);
  return issue;
}

export async function removeCard(args, io) {
  const id = positional(args, 0, "dataops newsletter remove-card <issue-id> [--dry-run] [--confirm]");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const result = await api.delete(`/api/newsletter-issues/${enc(id)}/card`, {
    version: current.version,
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.confirm ? { confirmCardDeletion: true } : {}),
  });
  if (args.json) return result;
  io.print(`${result.removed ? "Removed" : "Would remove"} Card ${result.cardId} from ${current.label}.`);
  for (const reason of result.keep || []) io.print(`keeps it: ${reason}`);
  for (const move of result.moves || []) io.print(`moves ${move.from} -> ${move.to}`);
  return result;
}

export async function dueCards(args, io) {
  const result = await apiFor(args).post("/api/newsletter-issues/create-due-cards", args.dryRun ? { dryRun: true } : {});
  if (args.json) return result;
  const rows = result.dryRun ? result.due : result.created;
  io.print(`${result.dryRun ? "Due" : "Created"}: ${rows.length} Card(s) for ${result.today}.`);
  for (const row of rows) io.print(`  ${row.publicationDate} ${row.label}${row.cardId ? ` -> ${row.cardId}` : ""}`);
  for (const failure of result.failures) io.print(`  failed: ${failure.label}: ${failure.error}`);
  return result;
}

async function allPages(api, route) {
  const items = [];
  let cursor = "0";
  while (cursor !== null && cursor !== undefined) {
    const page = await api.get(route, { query: { limit: "100", cursor } });
    items.push(...(page.items || []));
    cursor = page.nextCursor;
  }
  return items;
}

export async function sync(args, io) {
  let rows;
  if (typeof args.sheet === "string" && args.sheet) {
    const token = process.env.DAPIER_ACCESS_TOKEN;
    if (!token) throw new UsageError("--sheet needs a Google access token in DAPIER_ACCESS_TOKEN: run the command under `dapier token exec drive <account>`.");
    rows = await fetchNewsletterTab(args.sheet, token);
  } else if (args._[0]) rows = readNewsletterCsv(args._[0]);
  else throw new UsageError("Pass --sheet <spreadsheet-id> or a CSV export of the Newsletter tab.");
  const api = apiFor(args);
  const today = new Date().toISOString().slice(0, 10);
  const { issues: sheet, skipped } = sheetIssues(rows, today);
  const existing = (await api.get("/api/newsletter-issues", { query: { from: "2000-01-01" } })).items || [];
  const plan = planNewsletterSync(sheet, existing, await allPages(api, "/api/sponsor-crm/organizations"), today);
  const counts = {
    sheetIssues: sheet.length,
    create: plan.creates.length,
    update: plan.updates.length,
    statsUpdated: plan.statsUpdated || 0,
    unchanged: plan.unchanged,
    differences: plan.conflicts.length,
    skippedRows: skipped.length,
    sponsorsLinked: plan.linked,
  };
  const result = { mode: args.apply ? "apply" : "dry-run", counts, plan, skipped, failures: [] };
  if (args.apply) {
    for (const item of plan.creates) {
      try {
        await api.post("/api/newsletter-issues", item.body);
      } catch (error) {
        result.failures.push({ sheetId: item.sheetId, error: error.message });
      }
    }
    for (const item of plan.updates) {
      try {
        await api.put(`/api/newsletter-issues/${enc(item.id)}`, { ...item.changes, version: item.version });
      } catch (error) {
        result.failures.push({ id: item.id, error: error.message });
      }
    }
  }
  if (!args.json) {
    if (!args.quiet) {
      for (const item of plan.creates) io.print(`create  ${item.body.publicationDate}  ${item.sheetId}  ${item.body.status}`);
      for (const item of plan.updates) io.print(`update  ${item.publicationDate}  ${item.label}  ${Object.keys(item.changes).join(", ")}`);
      for (const item of plan.conflicts) io.print(`differs ${item.publicationDate}  ${item.label}  ${item.differences.join("; ")}`);
      for (const item of skipped) io.print(`skip    row ${item.row}  ${item.reason}`);
    }
    io.print(`${result.mode}: ${Object.entries(counts).map(([name, value]) => `${name} ${value}`).join(", ")}`);
    for (const failure of result.failures) io.print(`failed  ${failure.sheetId || failure.id}  ${failure.error}`);
  }
  if (result.failures.length) throw new Error(`${result.failures.length} issues could not be written; rerun to retry.`);
  return result;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops newsletter delete <issue-id> [--confirm]");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-issues/${enc(id)}`);
  const result = await api.delete(`/api/newsletter-issues/${enc(id)}`, {
    version: current.version,
    ...(args.confirm ? { confirmCardDeletion: true } : {}),
  });
  if (args.json) return result ?? { status: "deleted", id };
  io.print(`Deleted ${current.label || "issue"} ${id}${current.cardId ? ` and its Card ${current.cardId}` : ""}.`);
  return result;
}

export async function dismissAlert(args, io) {
  const id = positional(args, 0, "dataops newsletter dismiss-alert <alert-id>");
  const result = await apiFor(args).post(`/api/newsletter-issues/alerts/${enc(id)}/dismiss`, {});
  if (!args.json) io.print(`Dismissed alert ${id}.`);
  return result;
}

export async function cardLeadDays(args, io) {
  const api = apiFor(args);
  const current = await api.get("/api/workspace-settings");
  const value = args._?.[0];
  if (value === undefined) {
    if (!args.json) io.print(`Newsletter Cards are created ${current.newsletterCardLeadDays} days before the issue date.`);
    return current;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0) throw new UsageError("<days> must be a whole number, 0 or more.");
  const result = await api.put("/api/workspace-settings", {
    newsletterCardLeadDays: days,
    expectedVersion: current.version,
  });
  if (!args.json) io.print(`Newsletter Cards are now created ${result.newsletterCardLeadDays} days before the issue date.`);
  return result;
}

export const doc = domainDocCommand("newsletter");

const MARKDOWN_KINDS = ["issue", "sources", "brief"];

export const newsletterMarkdownHelp = `dataops newsletter markdown - store and preview Newsletter Markdown packages in DataOps

Newsletter Markdown packages (issue.md, sources.md, brief.md) live directly on the
newsletter issue in DataOps and are never committed to Git.

Usage
  dataops newsletter markdown set <issue-id> [issue|sources|brief] --file <path>
  dataops newsletter markdown set <issue-id> [--issue-file <path>] [--sources-file <path>] [--brief-file <path>]
  dataops newsletter markdown show <issue-id> [issue|sources|brief]
  dataops newsletter markdown preview <issue-id>
  dataops newsletter markdown rotate-code <issue-id>
`;

function normalizeMarkdownPayloadUrls(payload, baseUrl) {
  if (!payload || !baseUrl) return payload;
  const next = { ...payload };
  if (next.previewUrl) next.previewUrl = rewriteVerificationUri(next.previewUrl, baseUrl);
  if (next.shareUrl) next.shareUrl = rewriteVerificationUri(next.shareUrl, baseUrl);
  return next;
}

function readMarkdownFileArg(filePath, flagName) {
  try {
    return readFileSync(String(filePath), "utf-8");
  } catch (err) {
    throw new UsageError(`Could not read ${flagName} "${filePath}": ${err.message}`);
  }
}

function inferKindFromPath(filePath) {
  const base = basename(String(filePath || "")).toLowerCase();
  if (base === "issue.md") return "issue";
  if (base === "sources.md") return "sources";
  if (base === "brief.md") return "brief";
  return null;
}

async function markdownSet(args, io) {
  const usage =
    "dataops newsletter markdown set <issue-id> [issue|sources|brief] (--file <path> | --issue-file <path> [--sources-file <path>] [--brief-file <path>])";
  const id = positional(args, 0, usage);
  const posKind = args._?.[1] !== undefined ? String(args._[1]).trim() : optionalString(args, "kind");
  if (posKind !== undefined && !MARKDOWN_KINDS.includes(posKind)) {
    throw new UsageError(`Markdown kind must be one of: ${MARKDOWN_KINDS.join(", ")}.`);
  }

  const body = {};
  for (const kind of MARKDOWN_KINDS) {
    const fileFlag = optionalString(args, `${kind}File`);
    const contentFlag = optionalString(args, kind);
    if (fileFlag !== undefined) {
      body[kind] = readMarkdownFileArg(fileFlag, `--${kind}-file`);
    } else if (contentFlag !== undefined) {
      body[kind] = contentFlag;
    }
  }

  const singleFile = optionalString(args, "file");
  const singleContent = optionalString(args, "content");
  if (singleFile !== undefined || singleContent !== undefined) {
    const targetKind = posKind || (singleFile ? inferKindFromPath(singleFile) : null) || "issue";
    if (!MARKDOWN_KINDS.includes(targetKind)) {
      throw new UsageError(`Specify which markdown kind to set: ${MARKDOWN_KINDS.join(", ")}.`);
    }
    body[targetKind] = singleFile !== undefined
      ? readMarkdownFileArg(singleFile, "--file")
      : singleContent;
  }

  if (Object.keys(body).length === 0) {
    throw new UsageError(`Provide --file <path> or --issue-file / --sources-file / --brief-file. Usage: ${usage}`);
  }

  const api = apiFor(args);
  const rawResult = await api.put(`/api/newsletter-issues/${enc(id)}/markdown`, body);
  const result = normalizeMarkdownPayloadUrls(rawResult, api.base);
  if (args.json) return result;

  const updatedKinds = Object.keys(body).join(", ");
  io.print(`Stored Newsletter Markdown (${updatedKinds}) on ${result.label} (${result.publicationDate}).`);
  io.print(`Preview link: ${result.previewUrl}`);
  if (result.shareUrl) io.print(`Shareable preview link (with code): ${result.shareUrl}`);
  if (result.accessCode) io.print(`Access code: ${result.accessCode}`);
  return result;
}

async function markdownShow(args, io) {
  const usage = "dataops newsletter markdown show <issue-id> [issue|sources|brief]";
  const id = positional(args, 0, usage);
  const kind = args._?.[1] !== undefined ? String(args._[1]).trim() : optionalString(args, "kind");
  if (kind !== undefined && !MARKDOWN_KINDS.includes(kind)) {
    throw new UsageError(`Markdown kind must be one of: ${MARKDOWN_KINDS.join(", ")}.`);
  }

  const api = apiFor(args);
  const rawResult = await api.get(`/api/newsletter-issues/${enc(id)}/markdown`);
  const result = normalizeMarkdownPayloadUrls(rawResult, api.base);
  if (args.json) return result;

  if (kind) {
    io.print(result.markdown?.[kind] || "");
    return result;
  }

  fields(io, [
    ["issueId", result.issueId],
    ["cardId", result.cardId],
    ["label", result.label],
    ["publicationDate", result.publicationDate],
    ["status", result.status],
    ["previewUrl", result.previewUrl],
    ["shareUrl", result.shareUrl],
    ["accessCode", result.accessCode],
    ["updatedAt", result.markdown?.updatedAt || "never"],
    ["updatedBy", result.markdown?.updatedByName || result.markdown?.updatedBy || "never"],
  ]);
  for (const k of MARKDOWN_KINDS) {
    const content = result.markdown?.[k] || "";
    io.print(`\n--- ${k}.md (${content.length} chars) ---`);
    io.print(content || "(empty)");
  }
  return result;
}

async function markdownPreview(args, io) {
  const usage = "dataops newsletter markdown preview <issue-id>";
  const id = positional(args, 0, usage);
  const api = apiFor(args);
  const rawResult = await api.get(`/api/newsletter-issues/${enc(id)}/markdown`);
  const result = normalizeMarkdownPayloadUrls(rawResult, api.base);
  if (args.json) return result;
  io.print(`${result.label} (${result.publicationDate})`);
  io.print(`Preview link: ${result.previewUrl}`);
  if (result.shareUrl) io.print(`Shareable preview link (with code): ${result.shareUrl}`);
  if (result.accessCode) io.print(`Access code: ${result.accessCode}`);
  return result;
}

async function markdownRotateCode(args, io) {
  const usage = "dataops newsletter markdown rotate-code <issue-id>";
  const id = positional(args, 0, usage);
  const api = apiFor(args);
  const rawResult = await api.post(`/api/newsletter-issues/${enc(id)}/markdown/rotate-code`, {});
  const result = normalizeMarkdownPayloadUrls(rawResult, api.base);
  if (args.json) return result;
  io.print(`Rotated preview access code for ${result.label} (${result.publicationDate}).`);
  io.print(`Shareable preview link (with code): ${result.shareUrl}`);
  io.print(`Access code: ${result.accessCode}`);
  return result;
}

const markdownSubcommands = {
  set: markdownSet,
  show: markdownShow,
  preview: markdownPreview,
  link: markdownPreview,
  "rotate-code": markdownRotateCode,
};

export async function markdown(args, io) {
  const [action, ...rest] = args._ || [];
  if (!action || action === "help") {
    if (!action) {
      throw new UsageError(
        "Missing markdown action. Usage: dataops newsletter markdown <set|show|preview|rotate-code> <issue-id> ...",
      );
    }
    io.print(newsletterMarkdownHelp);
    return undefined;
  }
  const fn = markdownSubcommands[action];
  if (!fn) {
    throw new UsageError(
      `Unknown subcommand: dataops newsletter markdown ${action}. One of: ${Object.keys(markdownSubcommands).join(", ")}.`,
    );
  }
  return fn({ ...args, _: rest }, io);
}

export const commands = {
  list,
  show,
  create,
  update,
  doc,
  markdown,
  stats,
  report,
  delete: remove,
  sponsors,
  book,
  release,
  "create-card": createCard,
  "remove-card": removeCard,
  "due-cards": dueCards,
  sync,
  "dismiss-alert": dismissAlert,
  "card-lead-days": cardLeadDays,
};

