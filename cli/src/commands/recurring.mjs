import { createClient } from "../api.mjs";
import { resolveProfile } from "../config.mjs";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function client(args) {
  const profile = resolveProfile(args);
  if (!profile.token) throw new Error("Not signed in. Run `dataops login`.");
  return createClient(profile);
}

function configsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.recurringConfigs || payload?.configs || [];
}

/** Same plain-English rendering the Recurring tab shows. */
export function describeSchedule(cronExpression) {
  const parts = String(cronExpression || "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return String(cronExpression || "no schedule");
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (month !== "*" || !/^\d+$/.test(minute) || !/^\d+$/.test(hour))
    return cronExpression;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `every day at ${time}`;
  if (dayOfMonth === "*" && /^\d$/.test(dayOfWeek)) {
    return `every ${WEEKDAYS[Number(dayOfWeek)]} at ${time}`;
  }
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") {
    return `monthly on day ${dayOfMonth} at ${time}`;
  }
  return cronExpression;
}

function requireCron(value) {
  const cronExpression = String(value || "")
    .trim()
    .replace(/\s+/g, " ");
  if (cronExpression.split(" ").length !== 5) {
    throw new Error('--cron needs five fields, for example "0 9 * * 1".');
  }
  return cronExpression;
}

async function findConfig(api, idOrPrefix) {
  const configs = configsFrom(await api.get("/api/recurring"));
  const matches = configs.filter(
    (config) =>
      config.id === idOrPrefix || String(config.id).startsWith(idOrPrefix),
  );
  if (matches.length === 0)
    throw new Error(`No recurring schedule matching ${idOrPrefix}.`);
  if (matches.length > 1)
    throw new Error(`${idOrPrefix} matches ${matches.length} schedules.`);
  return matches[0];
}

export async function list(args, io) {
  const result = await client(args).get("/api/recurring");
  if (args.json) return result;
  const configs = configsFrom(result);
  if (configs.length === 0) {
    io.print("No recurring schedules.");
    return result;
  }
  for (const config of configs) {
    io.print(
      [
        String(config.id).slice(0, 8),
        config.enabled === false ? "paused " : "active ",
        config.description,
        `(${describeSchedule(config.cronExpression)})`,
      ].join("  "),
    );
  }
  return result;
}

export async function create(args, io) {
  if (!args.description) throw new Error("--description is required.");
  const body = {
    description: String(args.description),
    cronExpression: requireCron(args.cron),
    enabled: args.paused ? false : true,
  };
  if (args.assignee) body.assigneeId = String(args.assignee);
  const result = await client(args).post("/api/recurring", body);
  if (args.json) return result;
  const config = result.recurringConfig || result;
  io.print(
    `Created ${config.id} - ${config.description} (${describeSchedule(config.cronExpression)}).`,
  );
  return result;
}

export async function edit(args, io) {
  const id = args._[0];
  if (!id)
    throw new Error(
      "Usage: dataops recurring edit <id> [--description D] [--cron C]",
    );
  const api = client(args);
  const config = await findConfig(api, id);
  const body = {};
  if (args.description !== undefined)
    body.description = String(args.description);
  if (args.cron !== undefined) body.cronExpression = requireCron(args.cron);
  if (args.assignee !== undefined) body.assigneeId = String(args.assignee);
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Nothing to change. Pass --description, --cron, or --assignee.",
    );
  }
  const result = await api.put(
    `/api/recurring/${encodeURIComponent(config.id)}`,
    body,
  );
  if (args.json) return result;
  const updated = result.recurringConfig || result;
  io.print(
    `Updated ${config.id} - ${updated.description} (${describeSchedule(updated.cronExpression)}).`,
  );
  return result;
}

async function setEnabled(args, io, enabled) {
  const id = args._[0];
  if (!id)
    throw new Error(
      `Usage: dataops recurring ${enabled ? "resume" : "pause"} <id>`,
    );
  const api = client(args);
  const config = await findConfig(api, id);
  const result = await api.put(
    `/api/recurring/${encodeURIComponent(config.id)}`,
    { enabled },
  );
  if (args.json) return result;
  io.print(`${enabled ? "Resumed" : "Paused"} ${config.description}.`);
  return result;
}

export const pause = (args, io) => setEnabled(args, io, false);
export const resume = (args, io) => setEnabled(args, io, true);

export async function remove(args, io) {
  const id = args._[0];
  if (!id) throw new Error("Usage: dataops recurring delete <id>");
  const api = client(args);
  const config = await findConfig(api, id);
  // Deleting removes the schedule only; tasks it already generated stay.
  await api.delete(`/api/recurring/${encodeURIComponent(config.id)}`);
  if (args.json) return { status: "deleted", id: config.id };
  io.print(
    `Deleted schedule ${config.description}. Tasks it already generated are kept.`,
  );
  return { status: "deleted", id: config.id };
}

export async function generate(args, io) {
  const date = String(args.date || new Date().toISOString().slice(0, 10));
  const result = await client(args).post("/api/recurring/generate", {
    startDate: date,
    endDate: args.until ? String(args.until) : date,
  });
  if (args.json) return result;
  io.print(
    `Generated ${result.generated?.length ?? 0}, skipped ${result.skipped ?? 0}.`,
  );
  return result;
}
