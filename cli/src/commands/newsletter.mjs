import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Plan newsletter slots and link them to Cards";

export const help = `dataops newsletter - newsletter publication slots (the web Planning > Newsletter view)

Usage
  dataops newsletter list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--status S] [--booked true|false]
  dataops newsletter list --card <card-id>     The slot a Card is linked to
  dataops newsletter show <slot-id>
  dataops newsletter create --date YYYY-MM-DD [--time HH:MM] [--label L] [--number N] [--status S]
      [--card ID] [--sponsor-booking ID] [--booked-by NAME] [--note N] [--url URL]
                                  --status defaults to open
  dataops newsletter update <slot-id> [same flags as create]
  dataops newsletter link-card <slot-id> <card-id|none>   Link (or unlink) a newsletter Card
  dataops newsletter create-card <slot-id>
                                  Create the issue Card from the newsletter Template and link it
  dataops newsletter delete <slot-id>
  dataops newsletter dismiss-alert <alert-id>

Statuses: open, reserved, draft, drafting, review, scheduled, sent, cancelled.
--from defaults to today on the server. Writes send the slot's current version.
A slot links at most one newsletter Card, and a Card at most one slot; a linked
slot keeps the Card's date and issue number in step with its own, and its
date, issue, sponsor and variant re-render the Card title when the newsletter
Template authors a card_title pattern.

Examples
  dataops newsletter list --from 2026-11-01 --to 2026-11-30
  dataops newsletter create-card 34a14ba3-...
`;

const FLAGS = [
  ["date", "publicationDate"],
  ["time", "publicationTime"],
  ["utcOffset", "utcOffset"],
  ["label", "campaignLabel"],
  ["status", "status"],
  ["card", "cardId"],
  ["sponsorBooking", "sponsorBookingId"],
  ["bookedBy", "bookedByDisplayName"],
  ["note", "planningNote"],
  ["url", "publicUrl"],
];

function slotBody(args) {
  const body = {};
  for (const [flag, key] of FLAGS) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value === "none" && ["cardId", "sponsorBookingId"].includes(key) ? null : value;
  }
  if (body.publicationDate) isoDate(body.publicationDate, "date");
  if (args.number !== undefined) body.campaignNumber = integer(args.number, "number");
  return body;
}

export async function list(args, io) {
  const booked = optionalString(args, "booked");
  if (booked !== undefined && !["true", "false"].includes(booked)) throw new UsageError("--booked must be true or false.");
  const card = optionalString(args, "card");
  const query = card
    ? { cardId: card }
    : { from: isoDate(args.from, "from"), to: isoDate(args.to, "to"), status: optionalString(args, "status"), booked };
  const result = await apiFor(args).get("/api/newsletter-slots", { query });
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (slot) => slot.id],
    ["DATE", (slot) => `${slot.publicationDate}${slot.publicationTime ? ` ${slot.publicationTime}` : ""}`],
    ["STATUS", (slot) => slot.status],
    ["CARD", (slot) => slot.cardId || ""],
    ["SPONSOR", (slot) => slot.bookedByDisplayName || slot.sponsorBookingId || ""],
    ["LABEL", (slot) => slot.campaignLabel || ""],
  ], "No newsletter slots in range.");
  for (const alert of result.alerts || []) io.print(`alert ${alert.id}: ${alert.reasonCode} (${alert.slotId})`);
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops newsletter show <slot-id>");
  const slot = await apiFor(args).get(`/api/newsletter-slots/${enc(id)}`);
  if (args.json) return slot;
  fields(io, Object.entries(slot).filter(([, value]) => typeof value !== "object" || value === null));
  if (slot.sponsor) io.print(`sponsor: ${JSON.stringify(slot.sponsor)}`);
  return slot;
}

export async function create(args, io) {
  const body = slotBody(args);
  if (!body.publicationDate) throw new UsageError("--date is required.");
  body.status = body.status || "open";
  const slot = await apiFor(args).post("/api/newsletter-slots", body);
  if (args.json) return slot;
  io.print(`Created slot ${slot.id} on ${slot.publicationDate} [${slot.status}].`);
  return slot;
}

async function put(args, io, id, body, verb) {
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-slots/${enc(id)}`);
  const slot = await api.put(`/api/newsletter-slots/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return slot;
  io.print(`${verb} slot ${slot.id} on ${slot.publicationDate} [${slot.status}]${slot.cardId ? `, Card ${slot.cardId}` : ""}.`);
  return slot;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops newsletter update <slot-id> [--status S] ...");
  const body = slotBody(args);
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. See `dataops newsletter --help`.");
  return put(args, io, id, body, "Updated");
}

export async function linkCard(args, io) {
  const usage = "dataops newsletter link-card <slot-id> <card-id>";
  const cardId = positional(args, 1, usage);
  return put(args, io, positional(args, 0, usage), { cardId: cardId === "none" ? null : cardId }, cardId === "none" ? "Unlinked" : "Linked");
}

export async function createCard(args, io) {
  const id = positional(args, 0, "dataops newsletter create-card <slot-id>");
  const api = apiFor(args);
  const slot = await api.get(`/api/newsletter-slots/${enc(id)}`);
  if (slot.cardId) throw new UsageError(`Slot ${id} is already linked to Card ${slot.cardId}.`);
  const result = await api.post(`/api/newsletter-slots/${enc(id)}/card`, { version: slot.version });
  if (args.json) return result;
  io.print(`Created Card ${result.card.id} - ${result.card.title} and linked it to slot ${id}.`);
  return result;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops newsletter delete <slot-id>");
  const api = apiFor(args);
  const current = await api.get(`/api/newsletter-slots/${enc(id)}`);
  const result = await api.delete(`/api/newsletter-slots/${enc(id)}`, { version: current.version });
  if (args.json) return result ?? { status: "deleted", id };
  io.print(`Deleted slot ${id}.`);
  return result;
}

export async function dismissAlert(args, io) {
  const id = positional(args, 0, "dataops newsletter dismiss-alert <alert-id>");
  const result = await apiFor(args).post(`/api/newsletter-slots/alerts/${enc(id)}/dismiss`, {});
  if (!args.json) io.print(`Dismissed alert ${id}.`);
  return result;
}

export const commands = {
  list,
  show,
  create,
  update,
  "link-card": linkCard,
  "create-card": createCard,
  delete: remove,
  "dismiss-alert": dismissAlert,
};
