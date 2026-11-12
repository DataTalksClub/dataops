import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Unified event lifecycle (propose, approve, reschedule, update, release, show, retry, poll)";

export const help = `dataops event - unified event lifecycle driven by Card Templates

Every event Card (podcast, webinar, workshop, or any future event type) follows
the same lifecycle:
  propose -> approve -> reschedule (returns to proposed) -> approve -> release

Per-type behaviour (Google Calendar titles, duration, windows, Zoom location,
guest invites, transition emails, and guest calendar-accept auto-approval)
comes from the Card Template's eventPolicy. For a Card without a policy,
provide --date, --time, --duration and --guest-emails explicitly. DataOps
checks availability and saves a Calendar-only blocker policy on that event
using the standard join lead, required attendees and Zoom. No first-contact
email or automatic intake is enabled. Later changes reuse that saved policy.

For an attendee-free reservation with no guest email, use
--no-guest-notifications to suppress invitations and transition emails.
--expires-days N renews the proposal expiry from now (1–365 days).

Usage
  dataops event propose <card|hold|episode> --date YYYY-MM-DD [--time HH:MM | --window NAME]
      [--title T] [--topic TOPIC] [--guest-names "Name, Name"]
      [--guest-emails "a@b.c,d@e.f"] [--document-url URL] [--duration MINUTES] [--time-zone IANA]
  dataops event approve <card|hold|episode> [--guest-emails "a@b.c"] [--document-url URL]
  dataops event reschedule <card|hold|episode> --date YYYY-MM-DD [--time HH:MM | --window NAME]
      [--title T] [--topic TOPIC] [--guest-names "Name, Name"]
      [--guest-emails "a@b.c,d@e.f"] [--document-url URL] [--duration MINUTES] [--time-zone IANA]
      [--no-guest-notifications] [--expires-days N]
  dataops event update <card|hold|episode> [--title T] [--topic TOPIC]
      [--guest-names "Name, Name"] [--document-url URL]
  dataops event release <card|hold|episode>
  dataops event show <card|hold|episode>
  dataops event retry <card|hold|episode> [--force-email-retry]
  dataops event poll [<card|hold|episode>]
`;

function resolveTarget(args, usage) {
  const id =
    args._[0] ||
    optionalString(args, "card") ||
    optionalString(args, "cardId") ||
    optionalString(args, "hold") ||
    optionalString(args, "holdId") ||
    optionalString(args, "episode") ||
    optionalString(args, "episodeId") ||
    optionalString(args, "id");
  if (!id) throw new UsageError(`Usage: ${usage}`);
  return String(id).trim();
}

function parseGuestEmailsFlag(args) {
  const raw =
    optionalString(args, "guestEmails") ??
    optionalString(args, "guest-emails") ??
    optionalString(args, "guestEmail") ??
    optionalString(args, "guest-email") ??
    optionalString(args, "guestRef") ??
    optionalString(args, "guest-ref");
  if (raw === undefined) return undefined;
  return String(raw)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

export function holdReservationOptions(args) {
  const payload = {};
  if (args.noGuestNotifications !== undefined) {
    if (args.noGuestNotifications !== true) throw new UsageError('--no-guest-notifications is a boolean flag.');
    payload.suppressGuestNotifications = true;
  }
  if (args.expiresDays !== undefined) {
    const days = Number(args.expiresDays);
    if (typeof args.expiresDays === 'boolean' || !Number.isInteger(days) || days < 1 || days > 365) {
      throw new UsageError('--expires-days must be an integer from 1 to 365.');
    }
    payload.expiresDays = days;
  }
  return payload;
}

function buildTransitionPayload(args, { requireDate = false } = {}) {
  const dateRaw = optionalString(args, "date");
  if (requireDate && !dateRaw) {
    throw new UsageError("--date YYYY-MM-DD is required.");
  }
  const date = dateRaw ? isoDate(dateRaw, "date") : undefined;
  const time = optionalString(args, "time");
  const window = optionalString(args, "window");
  if (time !== undefined && window !== undefined) {
    throw new UsageError("Pass either --time HH:MM or --window NAME, not both.");
  }
  if (time !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    throw new UsageError("--time must be HH:MM (24h).");
  }
  const duration = args.duration === undefined ? undefined : Number(args.duration);
  if (duration !== undefined && (typeof args.duration === 'boolean' || !Number.isInteger(duration) || duration < 1 || duration > 1440)) throw new UsageError('--duration must be a positive number of minutes (at most 1440).');
  const timeZone = optionalString(args, 'timeZone');
  if (timeZone) { try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new UsageError('--time-zone must be an IANA time zone.'); } }
  const title = optionalString(args, "title");
  const topic = optionalString(args, "topic");
  const guestNames = optionalString(args, "guestNames") ?? optionalString(args, "guest-names");
  const guestEmails = parseGuestEmailsFlag(args);
  const documentUrl = optionalString(args, "documentUrl") ?? optionalString(args, "document-url");
  const operationKey = optionalString(args, "operationKey") ?? optionalString(args, "operation-key");

  return {
    ...holdReservationOptions(args),
    ...(duration !== undefined ? { durationMinutes: duration } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(time !== undefined ? { time } : {}),
    ...(window !== undefined ? { window } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(guestNames !== undefined ? { guestNames } : {}),
    ...(guestEmails !== undefined ? { guestEmails } : {}),
    ...(documentUrl !== undefined ? { documentUrl } : {}),
    ...(operationKey !== undefined ? { operationKey } : {}),
  };
}

function printLifecycleSummary(io, actionLabel, result) {
  const ev = result.event || {};
  const hold = result.hold || {};
  const summary = hold.googleTitle || ev.renderValues?.title || "";
  io.print(
    `${actionLabel} event ${ev.id || hold.id} (card ${ev.cardId || hold.cardId}): [${ev.status}] ${ev.date} ${ev.time} ${ev.timeZone} — ${summary}`,
  );
  if (result.sync?.state === "deferred") {
    io.print(`Google sync deferred: ${result.sync.reason || "retry required"}`);
  }
  if (result.rescheduleTaskId) io.print(`Reschedule checklist Task: ${result.rescheduleTaskId}`);
}

export async function propose(args, io) {
  const target = resolveTarget(
    args,
    "dataops event propose <card|hold|episode> --date YYYY-MM-DD [--time HH:MM | --window NAME]",
  );
  const payload = buildTransitionPayload(args, { requireDate: true });
  const result = await apiFor(args).post(`/api/events/${enc(target)}/propose`, payload);
  if (args.json) return result;
  printLifecycleSummary(io, "Proposed", result);
  return result;
}

export async function approve(args, io) {
  const target = resolveTarget(args, "dataops event approve <card|hold|episode>");
  const payload = buildTransitionPayload(args, { requireDate: false });
  const result = await apiFor(args).post(`/api/events/${enc(target)}/approve`, payload);
  if (args.json) return result;
  printLifecycleSummary(io, "Approved", result);
  return result;
}

export async function reschedule(args, io) {
  const target = resolveTarget(
    args,
    "dataops event reschedule <card|hold|episode> --date YYYY-MM-DD [--time HH:MM | --window NAME]",
  );
  const payload = buildTransitionPayload(args, { requireDate: true });
  const result = await apiFor(args).post(`/api/events/${enc(target)}/reschedule`, payload);
  if (args.json) return result;
  printLifecycleSummary(io, "Rescheduled", result);
  return result;
}

export async function update(args, io) {
  const target = resolveTarget(
    args,
    "dataops event update <card|hold|episode> [--title T] [--topic TOPIC] [--guest-names \"Name, Name\"] [--document-url URL]",
  );
  const payload = buildTransitionPayload(args, { requireDate: false });
  if (
    payload.date !== undefined ||
    payload.time !== undefined ||
    payload.window !== undefined ||
    payload.durationMinutes !== undefined ||
    payload.timeZone !== undefined ||
    payload.guestEmails !== undefined
  ) {
    throw new UsageError(
      "dataops event update only reconciles metadata (--title, --topic, --guest-names, --document-url, and policy Zoom); use reschedule to change date, time, or attendees.",
    );
  }
  const result = await apiFor(args).post(`/api/events/${enc(target)}/update`, payload);
  if (args.json) return result;
  printLifecycleSummary(io, "Updated", result);
  return result;
}

export async function release(args, io) {
  const target = resolveTarget(args, "dataops event release <card|hold|episode>");
  const payload = buildTransitionPayload(args, { requireDate: false });
  const result = await apiFor(args).post(`/api/events/${enc(target)}/release`, payload);
  if (args.json) return result;
  printLifecycleSummary(io, "Released", result);
  return result;
}

export async function retry(args, io) {
  const target = resolveTarget(args, "dataops event retry <card|hold|episode>");
  const forceEmailRetry = Boolean(args.forceEmailRetry || args["force-email-retry"]);
  const operationKey = optionalString(args, "operationKey") ?? optionalString(args, "operation-key");
  const result = await apiFor(args).post(`/api/events/${enc(target)}/retry`, {
    ...(forceEmailRetry ? { forceEmailRetry: true } : {}),
    ...(operationKey ? { operationKey } : {}),
  });
  if (args.json) return result;
  printLifecycleSummary(io, "Retried", result);
  return result;
}

export async function show(args, io) {
  const target = resolveTarget(args, "dataops event show <card|hold|episode>");
  const result = await apiFor(args).get(`/api/events/${enc(target)}`);
  if (args.json) return result;
  const ev = result.event || {};
  const hold = result.hold || {};
  fields(io, [
    ["id", ev.id],
    ["cardId", ev.cardId],
    ["templateId", ev.templateId],
    ["status", ev.status],
    ["generation", ev.generation],
    ["date", ev.date],
    ["time", `${ev.time} ${ev.timeZone}`],
    ["startIso", ev.startIso],
    ["endIso", ev.endIso],
    ["durationMinutes", ev.durationMinutes],
    ["googleTitle", hold.googleTitle],
    ["guestEmails", (ev.guestEmails || []).join(", ")],
    ["sync", result.sync?.state],
    ["declinedBy", (result.declinedBy || []).map((d) => `${d.email} (${d.at})`).join(", ")],
  ]);
  if ((result.history || []).length > 0) {
    io.print("\nHistory:");
    table(
      io,
      result.history,
      [
        ["AT", (h) => h.at],
        ["TRANSITION", (h) => h.transition],
        ["GEN", (h) => String(h.generation)],
        ["ACTOR", (h) => h.actor],
        ["NOTE", (h) => (h.note ? `${h.note}${h.attendeeEmail ? ` (${h.attendeeEmail})` : ""}` : "")],
      ],
      "No history.",
    );
  }
  return result;
}

export async function poll(args, io) {
  const target =
    args._[0] ||
    optionalString(args, "card") ||
    optionalString(args, "hold") ||
    optionalString(args, "id");
  const path = target ? `/api/events/${enc(String(target).trim())}/poll` : "/api/events/poll";
  const result = await apiFor(args).post(path, {});
  if (args.json) return result;
  io.print(`Polled ${result.checked || 0} proposed event(s):`);
  for (const outcome of result.outcomes || []) {
    const extra = outcome.acceptedEmails?.length
      ? ` accepted: ${outcome.acceptedEmails.join(", ")}`
      : outcome.declinedEmails?.length
        ? ` declined: ${outcome.declinedEmails.join(", ")}`
        : outcome.reason
          ? ` (${outcome.reason})`
          : "";
    io.print(`  ${outcome.holdId} (card ${outcome.cardId}): [${outcome.status}] -> ${outcome.action}${extra}`);
  }
  return result;
}

export const commands = {
  propose,
  approve,
  reschedule,
  update,
  release,
  show,
  retry,
  poll,
};
