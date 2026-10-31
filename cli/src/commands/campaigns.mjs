import { readFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { enc, fields, optionalString, positional, required, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Cohort campaign calendar / social post rows";

export const help = `dataops campaigns - cohort campaign calendar and social post rows

Usage
  dataops campaigns list (--card ID | --template) [--channel CH] [--status ST] [--phase PH] [--owner OWN] [--format FMT] [--json]
  dataops campaigns show <row-id> [--json]
  dataops campaigns import (--card ID | --template) (--file PATH | --from-template) [--replace] [--channel CH] [--owner OWN] [--status ST] [--json]
  dataops campaigns create (--card ID | --template) (--date YYYY-MM-DD|TBD | --offset T-N) --channel CH --format FMT [--owner OWN] [--status ST] [--phase PH] [--weekday DAY] [--relative-week WK] [--title TITLE] [--audience AUD] [--cta CTA] [--phrases PH] [--assets ASSETS] [--typefully-examples EX] [--purpose PURPOSE] [--json]
  dataops campaigns update <row-id> [--date DATE] [--offset OFFSET] [--relative-week WK] [--phase PH] [--weekday DAY] [--channel CH] [--format FMT] [--owner OWN] [--status ST] [--title TITLE] [--audience AUD] [--cta CTA] [--phrases PH] [--assets ASSETS] [--typefully-examples EX] [--purpose PURPOSE] [--version N] [--json]
  dataops campaigns delete <row-id> [--version N] [--json]

Examples
  dataops campaigns import --template --file marketing/courses/process-templates/02-campaign-calendar.csv --replace --json
  dataops campaigns import --card <card-id> --file processes/02-campaign-calendar.csv --replace --json
  dataops campaigns list --card <card-id> --status Planned --json
  dataops campaigns update <row-id> --status Published --owner Orin --json
`;

function resolveCardId(args, allowPositional = false) {
  if (args.template === true) return "template";
  if (args.card !== undefined && args.card !== true && String(args.card).trim() !== "") {
    return String(args.card).trim();
  }
  if (allowPositional && args._[0] !== undefined && String(args._[0]).trim() !== "") {
    return String(args._[0]).trim();
  }
  throw new UsageError("--card ID (or --template) is required.");
}

function collectRowPatch(args) {
  const mapping = [
    ["date", "date"],
    ["offset", "offset"],
    ["relativeWeek", "relativeWeek"],
    ["phase", "phase"],
    ["weekday", "weekday"],
    ["channel", "channel"],
    ["format", "format"],
    ["owner", "owner"],
    ["status", "status"],
    ["title", "title"],
    ["audience", "audience"],
    ["cta", "cta"],
    ["phrases", "phrases"],
    ["assets", "assets"],
    ["typefullyExamples", "typefullyExamples"],
    ["purpose", "purpose"],
  ];
  const patch = {};
  for (const [argKey, bodyKey] of mapping) {
    const val = optionalString(args, argKey);
    if (val !== undefined) {
      patch[bodyKey] = val;
    }
  }
  if (args.rowIndex !== undefined) {
    const idx = Number(args.rowIndex);
    if (!Number.isSafeInteger(idx) || idx < 1) {
      throw new UsageError("--row-index must be a positive integer.");
    }
    patch.rowIndex = idx;
  }
  return patch;
}

export async function list(args, io) {
  const cardId = resolveCardId(args, true);
  const query = {
    cardId,
    channel: optionalString(args, "channel"),
    status: optionalString(args, "status"),
    phase: optionalString(args, "phase"),
    owner: optionalString(args, "owner"),
    format: optionalString(args, "format"),
  };
  const result = await apiFor(args).get("/api/campaign-calendar", { query });
  if (!args.json) {
    table(
      io,
      result.rows || [],
      [
        ["ID", (r) => r.id],
        ["#", (r) => r.rowIndex],
        ["DATE", (r) => r.date || r.offset],
        ["OFFSET", (r) => r.offset],
        ["PHASE", (r) => r.phase],
        ["CHANNEL", (r) => r.channel],
        ["FORMAT", (r) => r.format],
        ["OWNER", (r) => r.owner],
        ["STATUS", (r) => r.status],
        ["TITLE", (r) => r.title],
      ],
      "No campaign calendar rows.",
    );
  }
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops campaigns show <row-id>");
  const result = await apiFor(args).get(`/api/campaign-calendar/${enc(id)}`);
  if (!args.json) {
    fields(io, Object.entries(result.row));
  }
  return result;
}

export async function importCsv(args, io) {
  const cardId = resolveCardId(args, false);
  const fromTemplate = args.fromTemplate === true;
  const filePath = optionalString(args, "file") ?? (args._[0] ? String(args._[0]) : undefined);
  if (fromTemplate && filePath) {
    throw new UsageError("Use either --file PATH or --from-template, not both.");
  }
  if (!fromTemplate && !filePath) {
    throw new UsageError("--file PATH (or --from-template) is required.");
  }

  const body = {
    cardId,
    replace: Boolean(args.replace),
    channel: optionalString(args, "channel"),
    owner: optionalString(args, "owner"),
    status: optionalString(args, "status"),
  };

  if (fromTemplate) {
    body.fromTemplate = true;
  } else {
    let csv;
    try {
      csv = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read CSV file ${filePath}: ${error.message}`);
    }
    if (!csv.trim()) {
      throw new UsageError(`CSV file ${filePath} is empty.`);
    }
    body.csv = csv;
  }

  const result = await apiFor(args).post("/api/campaign-calendar/import", body);
  if (!args.json) {
    fields(io, [
      ["cardId", result.cardId],
      ["importedCount", result.importedCount],
      ["replacedCount", result.replacedCount],
    ]);
  }
  return result;
}

export async function create(args, io) {
  const cardId = resolveCardId(args, false);
  const patch = collectRowPatch(args);
  if (!patch.date && !patch.offset) {
    throw new UsageError("--date or --offset is required.");
  }
  if (!patch.channel) {
    throw new UsageError("--channel is required.");
  }
  if (!patch.format) {
    throw new UsageError("--format is required.");
  }
  const result = await apiFor(args).post("/api/campaign-calendar", {
    cardId,
    ...patch,
  });
  if (!args.json) {
    fields(io, [
      ["id", result.row.id],
      ["cardId", result.row.cardId],
      ["status", result.row.status],
      ["version", result.row.version],
    ]);
  }
  return result;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops campaigns update <row-id> [--status STATUS] ...");
  const patch = collectRowPatch(args);
  if (Object.keys(patch).length === 0) {
    throw new UsageError("Provide at least one field to update (e.g. --status, --owner, --date, --channel, --format).");
  }
  const api = apiFor(args);
  let version;
  if (args.version !== undefined) {
    version = Number(required(args, "version", "version"));
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new UsageError("--version must be a positive integer.");
    }
  } else {
    const current = await api.get(`/api/campaign-calendar/${enc(id)}`);
    version = current.row.version;
  }
  const result = await api.put(`/api/campaign-calendar/${enc(id)}`, {
    ...patch,
    version,
  });
  if (!args.json) {
    fields(io, [
      ["id", result.row.id],
      ["status", result.row.status],
      ["owner", result.row.owner],
      ["version", result.row.version],
    ]);
  }
  return result;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops campaigns delete <row-id> [--version N]");
  const api = apiFor(args);
  let version;
  if (args.version !== undefined) {
    version = Number(required(args, "version", "version"));
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new UsageError("--version must be a positive integer.");
    }
  } else {
    const current = await api.get(`/api/campaign-calendar/${enc(id)}`);
    version = current.row.version;
  }
  const result = await api.delete(`/api/campaign-calendar/${enc(id)}`, undefined, {
    query: { version },
  });
  if (!args.json) {
    io.print("Campaign calendar row deleted.");
  }
  return result;
}

export const commands = {
  list,
  show,
  import: importCsv,
  create,
  update,
  delete: remove,
};
