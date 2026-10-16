import { apiFor } from "../session.mjs";
import { resolveDocument } from "./kb.mjs";

const client = apiFor;

export const summary = "Recurring schedules that generate Tasks";

export const help = `dataops recurring - schedules that generate Tasks on a cron cadence

Usage
  dataops recurring list
  dataops recurring create --description D --cron "0 9 * * 1" [--assignee ID] [--doc DOC] [--paused]
  dataops recurring edit <id> [--description D] [--cron C] [--assignee ID] [--doc DOC|none]
  dataops recurring pause <id> | resume <id> | delete <id>
  dataops recurring generate [--date YYYY-MM-DD] [--until YYYY-MM-DD]

<id> may be a unique prefix. Deleting a schedule keeps the Tasks it generated.
--doc names the process doc (an id, alias or path, as for \`dataops kb show\`)
that every Task the schedule generates links; \`--doc none\` removes it.
`;

function configsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.recurringConfigs || payload?.configs || [];
}

/** Cadence and next run as the API reports them, never a client-side guess. */
function scheduleLine(config) {
  const cadence = config.scheduleLabel || config.cronExpression || "no schedule";
  if (config.enabled === false) return `${cadence} - paused`;
  return config.nextRunLabel ? `${cadence} - next ${config.nextRunLabel}` : cadence;
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

/** The canonical id of the process doc `--doc` names; null for `none`. */
async function processDocId(api, ref, { allowNone }) {
  const value = ref === true ? "" : String(ref ?? "").trim();
  if (allowNone && value.toLowerCase() === "none") return null;
  if (!value) {
    throw new Error(
      allowNone
        ? "--doc needs a process doc id, alias or path, or none."
        : "--doc needs a process doc id, alias or path.",
    );
  }
  const document = await resolveDocument(api, value);
  return String(document.id);
}

function docSuffix(config) {
  return config.instructionDocId ? `  [doc ${config.instructionDocId}]` : "";
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
        `(${scheduleLine(config)})`,
      ].join("  ") + docSuffix(config),
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
  const api = client(args);
  if (args.doc !== undefined)
    body.instructionDocId = await processDocId(api, args.doc, { allowNone: false });
  const result = await api.post("/api/recurring", body);
  if (args.json) return result;
  const config = result.recurringConfig || result;
  io.print(
    `Created ${config.id} - ${config.description} (${scheduleLine(config)}).${docSuffix(config)}`,
  );
  return result;
}

export async function edit(args, io) {
  const id = args._[0];
  if (!id)
    throw new Error(
      "Usage: dataops recurring edit <id> [--description D] [--cron C] [--assignee ID] [--doc DOC|none]",
    );
  const api = client(args);
  const config = await findConfig(api, id);
  const body = {};
  if (args.description !== undefined)
    body.description = String(args.description);
  if (args.cron !== undefined) body.cronExpression = requireCron(args.cron);
  if (args.assignee !== undefined) body.assigneeId = String(args.assignee);
  if (args.doc !== undefined)
    body.instructionDocId = await processDocId(api, args.doc, { allowNone: true });
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Nothing to change. Pass --description, --cron, --assignee, or --doc.",
    );
  }
  const result = await api.put(
    `/api/recurring/${encodeURIComponent(config.id)}`,
    body,
  );
  if (args.json) return result;
  const updated = result.recurringConfig || result;
  io.print(
    `Updated ${config.id} - ${updated.description} (${scheduleLine(updated)}).${docSuffix(updated)}`,
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
