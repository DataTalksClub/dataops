import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { fetchNewsletterTab, planNewsletterSync, readNewsletterCsv, sheetIssues } from "../newsletterSheet.mjs";

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
      [--time HH:MM] [--status S] [--note N] [--url URL]
                                  weekly by default, slots open, status planned
  dataops newsletter update <issue-id> [--date D] [--number N] [--time HH:MM] [--status S]
      [--primary-doc URL|none] [--secondary-doc URL|none] [--note N] [--url URL]
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
  dataops newsletter sync --sheet <spreadsheet-id> [--apply]
  dataops newsletter sync <newsletter.csv> [--apply]
                                  Bring issues in line with the schedule sheet's Newsletter
                                  tab, every row back to the start. Creates missing issues
                                  (past ones get no Card); past issues take the sheet's date,
                                  number and sponsors; upcoming ones only get what they lack,
                                  differences are listed. Links a sponsor to its company in
                                  the Sponsors tab when exactly one has that name. Never
                                  deletes, never creates deals. Dry run unless --apply.
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
  dataops newsletter update 34a14ba3-... --secondary-sponsor "Example Sponsor"
`;

const POSITIONS = ["primary", "secondary"];

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
  for (const [flag, key] of [["time", "publicationTime"], ["status", "status"], ["note", "planningNote"], ["url", "publicUrl"]]) {
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
  if (issue.card) io.print(`card: ${issue.card.id} ${issue.card.title} (${issue.card.openTaskCount}/${issue.card.taskCount} open)`);
  else if (issue.cardDueDate) io.print(`card: none yet; the daily run creates it on ${issue.cardDueDate}`);
  for (const link of issue.links || []) io.print(`link: ${link.name} ${link.url}`);
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

export const commands = {
  list,
  show,
  create,
  update,
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
