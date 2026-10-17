import { readFileSync } from "node:fs";

import { UsageError } from "../errors.mjs";
import { enc, fields, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Company/vendor details for sponsor onboarding (admin only)";

export const help = `dataops company - DataTalks.Club company/vendor details (admin only)

Legal name, registered address, VAT/tax IDs, and bank details per
account/currency, as sponsors need them for vendor onboarding (bill.com,
AP portals, W-8BEN-E style forms). The profile is non-sensitive; bank
values are encrypted at rest in the team secrets store and every bank
read is audited. Only admins can read or change anything here.

Usage
  dataops company show [--section bank|tax|address]
                                                Default: profile + bank list (ids, no values)
  dataops company set --data '{...}'            Update the profile; the CLI reads
                                                the current version first
  dataops company set-bank <id> --label NAME --currency EUR --field IBAN=...
                                                Bare --field KEY reads that value
                                                from stdin; --from-file bank.json
                                                takes {"label","currency","details":{...}}
  dataops company delete-bank <id>
  dataops company import --from-file company.json [--apply]
                                                Load profile + bank accounts from
                                                a file. Prints the plan (field
                                                names only, never values) unless
                                                --apply is given.

--data takes a JSON object, @file.json, or - for stdin: legalName,
tradeName, registeredAddress {line1,city,postalCode,country}, tax
{vatId,taxId,entityType,countryOfIncorporation}, contact {email,phone}.
Pass null to clear an optional block.

Loading real data (Alexey/Orin only): the source of truth is the
letterhead documents on Google Drive. Copy the values into a file shaped
like the import example below and run:

  dataops company import --from-file /tmp/company.json
  dataops company import --from-file /tmp/company.json --apply
  dataops company show --section bank --json | jq '{accounts: [.accounts[] | {id, label, currency}]}'

Verify the import shows the right accounts, then delete the file
(shred /tmp/company.json). Never commit the file or paste values into
chat, logs, or reports.

Import file example (bank details go under "details", one entry per
account id; "latest" wins for repeated ids):

  {"profile": {"legalName": "...", "registeredAddress": {"line1": "...", "city": "...", "postalCode": "...", "country": "..."}, "tax": {"vatId": "..."}}, "bankAccounts": [{"id": "eur", "label": "...", "currency": "EUR", "details": {"IBAN": "...", "BIC": "..."}}]}

Notes
  Bank account ids are 1-32 chars: lowercase letters, digits, "_", "-".
  set-bank replaces the whole account; include every detail to keep.
  Values are shown only for an explicit bank read; the default show,
  confirmations, and error messages never carry them.
`;

const SECTIONS = ["bank", "tax", "address"];

export async function show(args, io) {
  const section = optionalString(args, "section");
  if (section !== undefined && !SECTIONS.includes(section)) {
    throw new UsageError("--section must be one of bank, tax, address.");
  }
  const result = await apiFor(args).get("/api/company", { query: { section } });
  if (args.json) return result;
  const company = result?.company || {};
  if (section === "bank") {
    io.print(JSON.stringify({ accounts: result?.accounts || [], version: result?.version }, null, 2));
    return result;
  }
  if (section === "tax") {
    fields(io, [["VAT/tax IDs", JSON.stringify(company.tax || null)]]);
    return result;
  }
  if (section === "address") {
    const address = company.registeredAddress || {};
    fields(io, [
      ["Line 1", address.line1],
      ["Line 2", address.line2],
      ["City", address.city],
      ["Postal code", address.postalCode],
      ["Country", address.country],
    ]);
    return result;
  }
  fields(io, [
    ["Legal name", company.legalName],
    ["Trade name", company.tradeName],
    ["Address", company.registeredAddress ? [company.registeredAddress.line1, company.registeredAddress.city, company.registeredAddress.country].filter(Boolean).join(", ") : ""],
    ["VAT/tax IDs", company.tax ? JSON.stringify(company.tax) : ""],
    ["Contact", company.contact ? JSON.stringify(company.contact) : ""],
    ["Version", String(company.version ?? "")],
  ]);
  table(io, company.bankAccounts || [], [
    ["ID", (account) => account.id],
    ["LABEL", (account) => account.label],
    ["CURRENCY", (account) => account.currency],
  ], "No bank accounts stored.");
  return result;
}

export async function set(args, io) {
  const data = jsonData(args);
  const api = apiFor(args);
  const current = await api.get("/api/company");
  const result = await api.put("/api/company", { ...data, expectedVersion: current?.company?.version ?? 0 });
  if (!args.json) io.print(`Updated company profile (version ${result?.company?.version}).`);
  return result;
}

export async function setBank(args, io) {
  const id = positional(args, 0, "dataops company set-bank <id> --label NAME --currency EUR --field KEY=VALUE ...");
  const { label, currency, details } = collectBank(args);
  const result = await apiFor(args).put(`/api/company/bank/${enc(id)}`, { label, currency, details });
  if (!args.json) io.print(`Set bank account ${id} (${currency}).`);
  return result;
}

export async function deleteBank(args, io) {
  const id = positional(args, 0, "dataops company delete-bank <id>");
  const result = await apiFor(args).delete(`/api/company/bank/${enc(id)}`);
  if (!args.json) io.print(`Deleted bank account ${id}.`);
  return result;
}

export async function importCompany(args, io) {
  if (args.fromFile === undefined || args.fromFile === true || args.fromFile === "") {
    throw new UsageError("--from-file needs a path, or - for stdin.");
  }
  const raw = args.fromFile === "-" ? readFileSync(0, "utf8") : readFileSync(args.fromFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--from-file is not valid JSON.");
  }
  const plan = importPlan(parsed);
  if (!args.apply) {
    if (args.json) return { mode: "dry-run", ...plan };
    io.print(`dry-run: profile fields: ${plan.profileFields.join(", ") || "none"}; bank accounts: ${plan.bankAccounts.map((a) => `${a.id} (${a.currency}, fields: ${a.fields.join(",")})`).join("; ") || "none"}. Re-run with --apply to write.`);
    return { mode: "dry-run", ...plan };
  }
  const api = apiFor(args);
  const current = await api.get("/api/company");
  const profile = await api.put("/api/company", { ...plan.profile, expectedVersion: current?.company?.version ?? 0 });
  const accounts = [];
  for (const account of plan.accounts) {
    const saved = await api.put(`/api/company/bank/${enc(account.id)}`, {
      label: account.label,
      currency: account.currency,
      details: account.details,
    });
    accounts.push(saved?.account?.id || account.id);
  }
  const result = { mode: "apply", version: profile?.company?.version, accounts };
  if (!args.json) io.print(`Imported company profile (version ${result.version}) and ${accounts.length} bank account(s): ${accounts.join(", ") || "none"}.`);
  return result;
}

/** Validate an import file; return the plan with field NAMES only (never values). */
export function importPlan(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("Import file must hold a JSON object {profile, bankAccounts}.");
  }
  const profile = parsed.profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new UsageError('Import file needs a "profile" object.');
  }
  const allowed = new Set(["legalName", "tradeName", "registeredAddress", "tax", "contact"]);
  for (const key of Object.keys(profile)) {
    if (!allowed.has(key)) throw new UsageError(`Unknown profile field '${key}'.`);
  }
  const rawAccounts = parsed.bankAccounts ?? [];
  if (!Array.isArray(rawAccounts)) throw new UsageError('"bankAccounts" must be a list.');
  const seen = new Map();
  for (const entry of rawAccounts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new UsageError('Each bank account needs {id, label, currency, details}.');
    }
    const { id, label, currency, details } = entry;
    if (typeof id !== "string" || !id) throw new UsageError("Each bank account needs a non-empty id.");
    if (typeof label !== "string" || !label) throw new UsageError(`Bank account '${id}' needs a label.`);
    if (typeof currency !== "string" || !currency) throw new UsageError(`Bank account '${id}' needs a currency.`);
    if (!details || typeof details !== "object" || Array.isArray(details) || !Object.keys(details).length) {
      throw new UsageError(`Bank account '${id}' needs a non-empty details object.`);
    }
    seen.set(id, { id, label, currency, details });
  }
  const accounts = [...seen.values()];
  return {
    profile,
    profileFields: Object.keys(profile),
    accounts,
    bankAccounts: accounts.map((account) => ({ id: account.id, currency: account.currency, fields: Object.keys(account.details) })),
  };
}

function collectBank(args) {
  let label = optionalString(args, "label");
  let currency = optionalString(args, "currency");
  let details = {};
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
      throw new UsageError('--from-file must hold {"label", "currency", "details": {...}}.');
    }
    if (parsed.label !== undefined) label = String(parsed.label);
    if (parsed.currency !== undefined) currency = String(parsed.currency);
    if (parsed.details !== undefined) {
      if (!parsed.details || typeof parsed.details !== "object" || Array.isArray(parsed.details)) {
        throw new UsageError('--from-file "details" must be an object of {field: value}.');
      }
      for (const [key, value] of Object.entries(parsed.details)) {
        if (typeof value !== "string" || !value) throw new UsageError(`--from-file detail '${key}' must be a non-empty string.`);
        details[key] = value;
      }
    }
  }
  let specs = args.field;
  if (specs === undefined) specs = [];
  else if (!Array.isArray(specs)) specs = [specs];
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
    details[key] = value;
  }
  if (bare.length > 1) throw new UsageError("Only one --field KEY may read its value from stdin; pass the rest as KEY=VALUE or via --from-file.");
  for (const key of bare) details[key] = readStdinValue(key);
  if (!label) throw new UsageError("--label is required (or \"label\" in --from-file).");
  if (!currency) throw new UsageError("--currency is required, e.g. EUR (or \"currency\" in --from-file).");
  if (!Object.keys(details).length) {
    throw new UsageError("Nothing to set: pass --field KEY=VALUE, --field KEY (value on stdin), or --from-file.");
  }
  return { label, currency, details };
}

function readStdinValue(key) {
  const text = readFileSync(0, "utf8");
  const value = text.replace(/\n$/, "");
  if (!value) throw new UsageError(`No value on stdin for --field ${key}.`);
  return value;
}

export const commands = { show, set, "set-bank": setBank, "delete-bank": deleteBank, import: importCompany };
