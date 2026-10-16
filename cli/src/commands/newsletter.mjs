import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Plan newsletter issues, their sponsor slots, and their Cards";

export const help = `dataops newsletter - newsletter issues (the web Planning > Newsletter view)

An issue is one email. A weekly issue has an issue number and two sponsor
slots, primary and secondary; a stand-alone issue has one slot. A ticked slot
is part of the issue (its sponsor may still be TBD); ticking a slot adds its
sponsor Tasks to the issue's Card, unticking skips the slot's open Tasks.
Every issue that is not cancelled has exactly one Card, created with it from
the Template of its kind. The Card cannot be linked or unlinked; cancelling or
deleting the issue deletes its Card.

Usage
  dataops newsletter list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--status S] [--kind K]
      [--booked true|false]       true: a sponsor is booked; false: a ticked slot has none
  dataops newsletter list --card <card-id>     The issue a Card belongs to
  dataops newsletter show <issue-id>
  dataops newsletter create --date YYYY-MM-DD [--kind weekly|standalone] [--number N]
      [--primary-sponsor NAME] [--secondary on|off] [--secondary-sponsor NAME]
      [--time HH:MM] [--status S] [--note N] [--url URL]
                                  weekly by default, primary slot ticked, status planned
  dataops newsletter update <issue-id> [--date D] [--number N] [--time HH:MM] [--status S]
      [--primary on|off] [--primary-sponsor NAME|none] [--primary-doc URL|none]
      [--secondary on|off] [--secondary-sponsor NAME|none] [--secondary-doc URL|none]
      [--note N] [--url URL] [--confirm]
  dataops newsletter delete <issue-id> [--confirm]   Deletes the issue and its Card
  dataops newsletter dismiss-alert <alert-id>
  dataops newsletter card-lead-days [<days>]    Show, or set (admin), how many days before
                                  an issue's date the daily run creates its Card (default 21)

Statuses: planned, drafting, review, scheduled, sent, cancelled. Cancelling
deletes the Card; reinstating a cancelled issue creates a new one. --confirm
is needed when that deletes completed Tasks, or when unticking a slot whose
Tasks are partly done (done Tasks stay). Naming a sponsor ticks its slot.
Writes send the issue's current version.

Examples
  dataops newsletter list --from 2026-11-01 --to 2026-11-30 --booked false
  dataops newsletter update 34a14ba3-... --secondary-sponsor "Example Sponsor"
`;

const POSITIONS = ["primary", "secondary"];

function switchValue(args, name) {
  const value = optionalString(args, name);
  if (value === undefined) return undefined;
  if (!["on", "off"].includes(value)) throw new UsageError(`--${name} must be on or off.`);
  return value === "on";
}

/** Slot changes from flags, applied over `current` slots. */
function slotChanges(args, current = {}) {
  const slots = {};
  for (const position of POSITIONS) {
    const ticked = switchValue(args, position);
    const sponsor = optionalString(args, `${position}Sponsor`);
    const documentUrl = optionalString(args, `${position}Doc`);
    if (ticked === undefined && sponsor === undefined && documentUrl === undefined) continue;
    const slot = { ...(current[position] || { ticked: false }) };
    if (sponsor !== undefined) {
      if (sponsor === "none") delete slot.sponsor;
      else {
        slot.sponsor = sponsor;
        slot.ticked = true;
      }
    }
    if (documentUrl !== undefined) {
      if (documentUrl === "none") delete slot.documentUrl;
      else slot.documentUrl = documentUrl;
    }
    if (ticked !== undefined) {
      slot.ticked = ticked;
      if (!ticked) for (const name of ["sponsor", "bookedByUserId", "sponsorBookingId"]) delete slot[name];
    }
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
    .map((position) => {
      const slot = issue.slots[position];
      if (!slot.ticked) return `${position}: -`;
      return `${position}: ${slot.sponsor || "TBD"}`;
    })
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
  body.slots = slotChanges(args, kind === "weekly"
    ? { primary: { ticked: true }, secondary: { ticked: false } }
    : { primary: { ticked: true } });
  for (const position of kind === "weekly" ? POSITIONS : ["primary"]) {
    body.slots[position] ||= { ticked: position === "primary" };
  }
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
  "dismiss-alert": dismissAlert,
  "card-lead-days": cardLeadDays,
};
