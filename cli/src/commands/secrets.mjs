import { chmodSync, readFileSync, writeFileSync } from "node:fs";

import { ApiError } from "../api.mjs";
import { UsageError } from "../errors.mjs";
import { enc, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Team secrets store: shared service logins (admin only)";

export const help = `dataops secrets - the team secrets store (admin only)

Service logins shared by the team (e.g. Airtable: username, password, notes,
URL, TOTP seed). Values are encrypted at rest, returned only to a get of a
single secret, never shown in lists, and every access is audited.

Usage
  dataops secrets list                          Names + field names, never values
  dataops secrets get <name>                    All fields as JSON on stdout
  dataops secrets get <name> --field password   One raw value on stdout (pipe-friendly)
  dataops secrets get <name> --field password --out /tmp/pw
                                                Write to a file (mode 600) instead
  dataops secrets set <name> --field username=me@x.y --field password
                                                Bare --field reads that value from
                                                stdin: printf '%s' "$PW" | dataops secrets set airtable --field password
  dataops secrets set <name> --from-file secret.json [-]
                                                JSON object {"field": "value"}; "-" reads stdin
  dataops secrets delete <name>

Notes
  set replaces the whole field set; include every field you want to keep.
  Confirmations go to stdout; pipe only with --field or --json.
  Names are 1-64 chars: lowercase letters, digits, '.', '_', '-'.
  Values never go through --json output, list results, or error messages.
`;

/** One secret's fields, reading bare `--field k` values from stdin. */
function collectFields(args) {
  let specs = args.field;
  if (specs === undefined) specs = [];
  else if (!Array.isArray(specs)) specs = [specs];

  const fields = {};
  if (args.fromFile !== undefined) {
    if (args.fromFile === true) throw new UsageError("--from-file needs a path, or - for stdin.");
    const raw = args.fromFile === "-" ? readFileSync(0, "utf8") : readFileSync(args.fromFile, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new UsageError("--from-file is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError("--from-file must hold a JSON object of {field: value}.");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !value) throw new UsageError(`--from-file field '${key}' must be a non-empty string.`);
      fields[key] = value;
    }
  }

  const bare = [];
  for (const spec of specs) {
    if (typeof spec !== "string" || !spec) throw new UsageError("--field needs KEY=VALUE, or KEY to read the value from stdin.");
    const eq = spec.indexOf("=");
    if (eq === -1) {
      bare.push(spec);
      continue;
    }
    const key = spec.slice(0, eq);
    const value = spec.slice(eq + 1);
    if (!key || !value) throw new UsageError("--field needs KEY=VALUE with both parts non-empty.");
    fields[key] = value;
  }
  if (bare.length > 1) throw new UsageError("Only one --field KEY may read its value from stdin; pass the rest as KEY=VALUE or via --from-file.");
  for (const key of bare) fields[key] = readStdinValue(key);

  if (!Object.keys(fields).length) {
    throw new UsageError("Nothing to set: pass --field KEY=VALUE, --field KEY (value on stdin), or --from-file.");
  }
  return fields;
}

function readStdinValue(key) {
  const text = readFileSync(0, "utf8");
  // One trailing newline is the shell's `echo`/heredoc convention, not data.
  const value = text.replace(/\n$/, "");
  if (!value) throw new UsageError(`No value on stdin for --field ${key}.`);
  return value;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/secrets");
  const secrets = result?.secrets || [];
  if (args.json) return result;
  table(io, secrets, [
    ["NAME", (secret) => secret.name],
    ["FIELDS", (secret) => (secret.fields || []).join(",")],
    ["UPDATED", (secret) => String(secret.updatedAt || "").slice(0, 16).replace("T", " ")],
    ["BY", (secret) => secret.updatedBy || ""],
  ], "No secrets stored.");
  return result;
}

export async function get(args, io) {
  const name = positional(args, 0, "dataops secrets get <name> [--field password] [--out file]");
  const secret = await apiFor(args).get(`/api/secrets/${enc(name)}`);
  const fields = secret?.secret?.fields || {};

  if (args.field !== undefined) {
    if (typeof args.field !== "string" || !args.field) throw new UsageError("--field needs a field name.");
    const field = args.field;
    if (!(field in fields)) {
      const available = Object.keys(fields).join(", ") || "none";
      throw new ApiError(404, { error: `Secret '${name}' has no field '${field}' (fields: ${available})` }, `secret:${name}`);
    }
    if (args.out !== undefined) {
      if (args.out === true || args.out === "") throw new UsageError("--out needs a file path.");
      writeOut(args.out, fields[field]);
      return { written: args.out, name, field };
    }
    if (args.json) return { name, field, value: fields[field] };
    io.print(fields[field]);
    return undefined;
  }

  if (args.out !== undefined) {
    if (args.out === true || args.out === "") throw new UsageError("--out needs a file path.");
    writeOut(args.out, `${JSON.stringify(fields, null, 2)}\n`);
    return { written: args.out, name };
  }
  return secret;
}

export async function set(args, io) {
  const name = positional(args, 0, "dataops secrets set <name> --field KEY=VALUE ... | --from-file file.json");
  const fields = collectFields(args);
  const result = await apiFor(args).put(`/api/secrets/${enc(name)}`, { fields });
  if (!args.json) io.print(`Set ${name} (${(result?.secret?.fields || Object.keys(fields)).join(", ")}).`);
  return result;
}

export async function remove(args, io) {
  const name = positional(args, 0, "dataops secrets delete <name>");
  const result = await apiFor(args).delete(`/api/secrets/${enc(name)}`);
  if (!args.json) io.print(`Deleted ${name}.`);
  return result;
}

function writeOut(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const commands = { list, get, set, delete: remove };
