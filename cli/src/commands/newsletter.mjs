import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Plan newsletter issues, their sponsor slots, and their Cards";

export const help = `dataops newsletter - newsletter issues (the web Planning > Newsletter view)

An issue is one email. A weekly issue has an issue number and two sponsor
slots, primary and secondary; a stand-alone issue has one. A slot is booked
when it names a sponsor and open otherwise. Booking a slot for a sponsor from
the Sponsors tab records a deliverable on their deal for the issue; booking
adds the slot's sponsor Tasks to the issue's Card, releasing it skips the
slot's open Tasks (done ones stay). Every issue that is not cancelled has one
Card; cancelling or deleting the issue deletes it.

Usage
  dataops newsletter list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--status S] [--kind K]
      [--booked true|false]       true: a sponsor is booked; false: the primary slot has none
  dataops newsletter list --card <card-id>     The issue a Card belongs to
  dataops newsletter show <issue-id>
  dataops newsletter create --date YYYY-MM-DD [--kind weekly|standalone] [--number N]
      [--time HH:MM] [--status S] [--note N] [--url URL]
                                  weekly by default, slots open, status planned
  dataops newsletter update <issue-id> [--date D] [--number N] [--time HH:MM] [--status S]
      [--primary-doc URL|none] [--secondary-doc URL|none] [--note N] [--url URL] [--confirm]
  dataops newsletter sponsors                  Who a slot can be booked for (deals, organizations)
  dataops newsletter book <issue-id> <primary|secondary> (--deal <deal-id> | --organization <org-id>)
                                  Books the slot (replacing a previous sponsor); an
                                  organization without a live deal gets a new open deal
  dataops newsletter release <issue-id> <primary|secondary> [--confirm]
                                  Frees the slot; its deliverable is marked withdrawn
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
    ["CARD", (issue) => issue.card ? `${issue.card.openTaskCount}/${issue.card.taskCount} open` : issue.cardId || ""],
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
  "dismiss-alert": dismissAlert,
  "card-lead-days": cardLeadDays,
};
