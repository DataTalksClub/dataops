// Newsletter issue drafts: build the email in DataOps block by block, render
// it, read the audit history, and (owner only) approve it and hand the frozen
// payload to Relay for a test send or a scheduled send.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { formatLineDiff } from "./sponsorDocs.mjs";

export const draftHelp = `dataops newsletter draft / block / render / approve / test-send / schedule - the issue's email

Usage
  dataops newsletter draft <issue> [--show] [--json]          The draft: subject, blocks, approval
  dataops newsletter draft <issue> --create                   Start an empty draft (no Relay call)
  dataops newsletter draft <issue> [--subject <text>] [--preview <text>]
  dataops newsletter block list <issue> [--show]
  dataops newsletter block show <issue> <block-id>
  dataops newsletter block add <issue> --type <block-type> [--position N]
      [--field name=value ...] [--data-file <json>]
  dataops newsletter block edit <issue> <block-id> (--field name=value ... | --field <name> --value-file <path>
      | --data-file <json>)
  dataops newsletter block move <issue> <block-id> (--up | --down | --to N)
  dataops newsletter block delete <issue> <block-id> --yes
  dataops newsletter block-types <issue> [--json]
  dataops newsletter render <issue> [--out email.html] [--text] [--editor]
  dataops newsletter sponsor-sync <issue> --slot primary|secondary [--dry-run]
  dataops newsletter revisions <issue> [--block <id>] [--origin <origin>] [--diff] [--rev N] [--json]
  dataops newsletter approve <issue> --version N --hash <payload-sha256> [--note <text>]
  dataops newsletter test-send <issue> --to <email>[,<email>]
  dataops newsletter schedule <issue> --at <ISO time with offset> --version N --hash <payload-sha256> --yes
  dataops newsletter cancel-schedule <issue> --yes
  dataops newsletter delivery <issue> [--refresh]

DataOps owns the email. A draft starts empty (one intro block) and is built
here or on the issue page (/newsletter/<issue-id>): every change is a revision.
DataOps renders the email itself ("render" prints the subject, preview text
and payload sha256, --out writes the exact HTML, --text prints the text part;
--editor marks incomplete blocks). Nothing is imported from or written to
Relay while the draft is built.

A sponsor block comes only from its slot's sponsor document, an own
DataTalks.Club promo included: every doc save stages it into the draft
(DataOps only; "sponsor-sync" re-runs that by hand). Sponsor blocks cannot be
added or edited by hand. "approve" refuses a draft whose sponsor slot has no
linked doc, a subject over 65 characters (without the weekly suffix), preview
text over 140, a sponsor title over 12 words, or an own promo without bullets,
closing and utm tracking.

Only the owner approves, test-sends and schedules (signed in personally, not
with an API token). "approve" takes the --version and --hash that "render"
printed, so the approval covers exactly the reviewed email; any later edit
withdraws it. After approval, "test-send" and "schedule" hand the frozen
payload to Relay's campaign API (Relay is transport only); a schedule locks the
draft until "cancel-schedule". Refusals print the server's message and exit
non-zero.
`;

const issueArg = (args, usage) => String(positional(args, 0, usage));
const draftUrl = (issue, tail = "") => `/api/newsletter-issues/${enc(issue)}/draft${tail}`;

function blockRow(block) {
  const first = block.data?.title || block.data?.summary || block.data?.events || block.data?.links || block.data?.html || "";
  return { ...block, preview: String(first).replace(/\s+/g, " ").slice(0, 60) };
}

function printDraft(io, draft) {
  io.print(`subject: ${draft.subject || "(empty)"}`);
  io.print(`preview: ${draft.previewText || "(empty)"}`);
  const approval = draft.approval || {};
  io.print(`approval: ${approval.state}${approval.approvedAt ? ` (by ${approval.approvedByName || approval.approvedBy} at ${approval.approvedAt})` : ""}`);
  if (draft.delivery) io.print(`relay: ${draft.delivery.state} · ${draft.delivery.campaignKey} · ${draft.delivery.scheduledAt}`);
  io.print(`version: ${draft.version} · payload sha256: ${draft.payloadHash}`);
  table(
    io,
    draft.blocks.map(blockRow),
    [
      ["POS", (b) => String(b.position)],
      ["ID", (b) => b.id],
      ["TYPE", (b) => b.type],
      ["V", (b) => String(b.version)],
      ["RULE", (b) => (b.sponsor ? (b.sponsorDocUrl ? "from sponsor doc" : "needs sponsor doc") : b.pinned ? "pinned" : "")],
      ["TODO", (b) => (b.problems?.length ? "needs content" : "")],
      ["CONTENT", (b) => b.preview],
    ],
    "No blocks.",
  );
  for (const problem of draft.problems || []) io.print(`to finish: ${problem.message}`);
}

function printBlock(io, block) {
  io.print(`## ${block.id} · ${block.label} (v${block.version})`);
  if (block.readOnly && block.sponsorDocUrl) io.print(`sponsor block: edit it in the sponsor doc ${block.sponsorDocUrl}`);
  for (const [name, value] of Object.entries(block.data || {})) io.print(`${name}: ${String(value).replace(/\n/g, "\n  ")}`);
  for (const problem of block.problems || []) io.print(`to finish: ${problem}`);
}

export async function draft(args, io) {
  const usage = "dataops newsletter draft <issue> [--create] [--subject <text>] [--preview <text>] [--show]";
  const issue = issueArg(args, usage);
  const api = apiFor(args);
  let result;
  const subject = optionalString(args, "subject");
  const preview = optionalString(args, "preview");
  if (args.create) {
    result = await api.post(draftUrl(issue), {});
    if (!args.json) io.print("draft started in DataOps (nothing was imported)");
  } else if (subject !== undefined || preview !== undefined) {
    const current = (await api.get(draftUrl(issue))).draft;
    result = await api.put(draftUrl(issue), { version: current.version, ...(subject !== undefined ? { subject } : {}), ...(preview !== undefined ? { previewText: preview } : {}) });
    if (!args.json) io.print(result.changed ? "subject/preview saved" : "subject/preview unchanged");
  } else {
    result = await api.get(draftUrl(issue));
  }
  if (args.json) return result;
  printDraft(io, result.draft);
  if (args.show) for (const block of result.draft.blocks) { io.print(""); printBlock(io, block); }
  return result;
}

function parseFieldPairs(args) {
  const raw = args.field === undefined ? [] : Array.isArray(args.field) ? args.field : [args.field];
  const data = {};
  for (const pair of raw) {
    const text = String(pair);
    const at = text.indexOf("=");
    if (at < 1) throw new UsageError(`--field expects name=value, got "${text}".`);
    data[text.slice(0, at)] = text.slice(at + 1);
  }
  return data;
}

function dataFromArgs(args) {
  const dataFile = optionalString(args, "dataFile");
  return dataFile ? JSON.parse(readFileSync(dataFile, "utf8")) : parseFieldPairs(args);
}

function findBlock(set, ref) {
  const found = set.blocks.find((item) => item.id === ref);
  if (!found) throw new UsageError(`No block ${ref}. Blocks: ${set.blocks.map((b) => b.id).join(", ")}`);
  return found;
}

export async function blockCommand(args, io) {
  const usage = "dataops newsletter block list|show|add|edit|move|delete <issue> ...";
  const action = String(positional(args, 0, usage));
  const sub = { ...args, _: args._.slice(1) };
  const handler = { list: blockList, show: blockShow, add: blockAdd, edit: blockEdit, move: blockMove, delete: blockDelete }[action];
  if (!handler) throw new UsageError(`Unknown block action "${action}". ${usage}`);
  return handler(sub, io);
}

async function blockList(args, io) {
  const result = await apiFor(args).get(draftUrl(issueArg(args, "dataops newsletter block list <issue> [--show]")));
  if (args.json) return result;
  printDraft(io, result.draft);
  if (args.show) for (const block of result.draft.blocks) { io.print(""); printBlock(io, block); }
  return result;
}

async function blockShow(args, io) {
  const usage = "dataops newsletter block show <issue> <block-id>";
  const result = await apiFor(args).get(draftUrl(issueArg(args, usage)));
  const found = findBlock(result.draft, String(positional(args, 1, usage)));
  if (args.json) return { block: found };
  printBlock(io, found);
  return { block: found };
}

async function blockAdd(args, io) {
  const usage = "dataops newsletter block add <issue> --type <block-type> [--position N] [--field name=value ...]";
  const issue = issueArg(args, usage);
  const type = optionalString(args, "type");
  if (!type) throw new UsageError(`--type is required (see: dataops newsletter block-types <issue>). Usage: ${usage}`);
  const body = { type, data: dataFromArgs(args) };
  if (args.position !== undefined) {
    if (!/^\d+$/.test(String(args.position))) throw new UsageError(`--position must be a non-negative integer, got "${args.position}".`);
    body.position = Number(args.position);
  }
  const result = await apiFor(args).post(draftUrl(issue, "/blocks"), body);
  if (args.json) return result;
  io.print(`added ${result.block.id} (${result.block.label}) at position ${result.block.position}`);
  for (const problem of result.block.problems || []) io.print(`to finish: ${problem}`);
  return result;
}

async function blockEdit(args, io) {
  const usage = "dataops newsletter block edit <issue> <block-id> (--field name=value ... | --field <name> --value-file <path> | --data-file <json>)";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  const api = apiFor(args);
  const found = findBlock((await api.get(draftUrl(issue))).draft, ref);
  let data;
  if (optionalString(args, "dataFile")) {
    data = dataFromArgs(args);
  } else if (typeof args.field === "string" && !args.field.includes("=")) {
    const valueFile = optionalString(args, "valueFile");
    const value = valueFile ? readFileSync(valueFile, "utf8") : args.value;
    if (typeof value !== "string") throw new UsageError(`Pass --value <text> or --value-file <path>. Usage: ${usage}`);
    data = { ...found.data, [args.field]: value };
  } else {
    const changes = parseFieldPairs(args);
    if (!Object.keys(changes).length) throw new UsageError(`Nothing to change. Usage: ${usage}`);
    data = { ...found.data, ...changes };
  }
  const result = await api.put(draftUrl(issue, `/blocks/${enc(found.id)}`), { version: found.version, data });
  if (args.json) return result;
  io.print(result.changed ? `saved ${found.id}` : `${found.id} unchanged`);
  return result;
}

async function blockMove(args, io) {
  const usage = "dataops newsletter block move <issue> <block-id> (--up | --down | --to N)";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  let body;
  if (args.up) body = { direction: "up" };
  else if (args.down) body = { direction: "down" };
  else if (args.to !== undefined && /^\d+$/.test(String(args.to))) body = { to: Number(args.to) };
  else throw new UsageError(`Pass --up, --down or --to <index>. Usage: ${usage}`);
  const result = await apiFor(args).post(draftUrl(issue, `/blocks/${enc(ref)}/move`), body);
  if (args.json) return result;
  const moved = result.draft.blocks.find((item) => item.id === ref);
  io.print(`moved ${ref} to position ${moved?.position}`);
  return result;
}

async function blockDelete(args, io) {
  const usage = "dataops newsletter block delete <issue> <block-id> --yes";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  if (!args.yes) throw new UsageError(`Deleting ${ref} removes it from the draft. Re-run with --yes.`);
  const result = await apiFor(args).delete(draftUrl(issue, `/blocks/${enc(ref)}`));
  if (args.json) return result;
  io.print(`deleted ${ref}`);
  return result;
}

export async function blockTypes(args, io) {
  const result = await apiFor(args).get(draftUrl(String(positional(args, 0, "dataops newsletter block-types <issue>")), "/types"));
  if (args.json) return result;
  table(
    io,
    result.types,
    [
      ["TYPE", (t) => t.type],
      ["LABEL", (t) => t.label],
      ["ADD", (t) => (t.addable ? "yes" : "from sponsor doc")],
      ["FIELDS", (t) => t.fields.map((f) => `${f.name}${f.required ? "*" : ""}`).join(", ")],
    ],
    "No block types.",
  );
  return result;
}

export async function render(args, io) {
  const usage = "dataops newsletter render <issue> [--out email.html] [--text] [--editor]";
  const issue = issueArg(args, usage);
  const result = await apiFor(args).get(draftUrl(issue, "/render"), { query: args.editor ? { mode: "editor" } : undefined });
  const out = optionalString(args, "out");
  if (out) writeFileSync(out, result.render.html);
  if (args.json) return result;
  io.print(`subject: ${result.render.subject}`);
  io.print(`preview: ${result.render.previewText}`);
  io.print(`version: ${result.render.draftVersion}`);
  io.print(`payload sha256: ${result.render.payloadHash}`);
  io.print(`approval: ${result.approval?.state || "none"}`);
  io.print(`html: ${result.render.html.length} chars${out ? ` written to ${out}` : ""}`);
  for (const problem of result.render.problems || []) io.print(`to finish: ${problem.message}`);
  if (args.text) {
    io.print("");
    io.print(result.render.text);
  }
  return result;
}

export async function sponsorSync(args, io) {
  const usage = "dataops newsletter sponsor-sync <issue> --slot primary|secondary [--dry-run]";
  const issue = issueArg(args, usage);
  const slot = optionalString(args, "slot") || "primary";
  if (slot !== "primary" && slot !== "secondary") throw new UsageError("--slot must be primary or secondary.");
  const result = await apiFor(args).post(draftUrl(issue, "/sponsor-sync"), { slot, dryRun: Boolean(args.dryRun) });
  if (args.json) return result;
  io.print(`sponsor-sync ${slot}: ${result.summary}${args.dryRun ? " (dry run, nothing written)" : ""}`);
  return result;
}

function who(rev) {
  if (rev.origin === "relay-pull" || rev.origin === "relay-remove" || rev.origin === "import") return `Relay (archived): ${rev.relayActor || "?"}`;
  if (rev.origin === "sponsor-doc") return "sponsor doc";
  return rev.actorName || rev.actorUserId || "?";
}

export async function revisions(args, io) {
  const usage = "dataops newsletter revisions <issue> [--block <id>] [--origin <origin>] [--diff] [--rev N]";
  const issue = issueArg(args, usage);
  const block = optionalString(args, "block");
  const result = await apiFor(args).get(draftUrl(issue, "/revisions"), { query: block ? { block } : undefined });
  let list = result.revisions || [];
  const origin = optionalString(args, "origin");
  if (origin) list = list.filter((rev) => rev.origin === origin);
  if (args.rev !== undefined) {
    if (!/^[1-9]\d*$/.test(String(args.rev))) throw new UsageError(`--rev must be a positive integer, got "${args.rev}".`);
    list = list.filter((rev) => rev.revision === Number(args.rev));
    if (!list.length) throw new UsageError(`No revision ${args.rev} for issue ${issue}.`);
  }
  if (args.json) return { ...result, revisions: list };
  if (!args.diff && args.rev === undefined) {
    table(
      io,
      list,
      [
        ["REV", (r) => String(r.revision)],
        ["WHEN", (r) => r.createdAt.slice(0, 19).replace("T", " ")],
        ["BLOCK", (r) => `${r.blockId || "-"} ${r.blockType}`],
        ["ORIGIN", (r) => r.origin],
        ["BY", who],
        ["CHANGED", (r) => r.changes.map((c) => c.field).join(", ") || r.detail || "(none)"],
      ],
      `No revisions for issue ${issue}.`,
    );
    return { ...result, revisions: list };
  }
  for (const rev of list) {
    io.print(`=== rev ${rev.revision} · ${rev.blockId || "-"} ${rev.label} · ${rev.origin} by ${who(rev)} · ${rev.createdAt}`);
    if (rev.detail) io.print(rev.detail);
    if (!rev.changes.length) io.print("(no field changes)");
    for (const change of rev.changes) {
      io.print(`--- ${change.field} [before]`);
      io.print(`+++ ${change.field} [after]`);
      const lines = rev.before === null ? change.after.split("\n").map((line) => `+ ${line}`) : formatLineDiff(change.before, change.after);
      for (const line of lines) io.print(line);
    }
    io.print("");
  }
  return { ...result, revisions: list };
}

function versionArg(args, usage) {
  if (!/^\d+$/.test(String(args.version ?? ""))) throw new UsageError(`--version N is required (from "dataops newsletter render"). Usage: ${usage}`);
  return Number(args.version);
}

function hashArg(args, usage) {
  const hash = optionalString(args, "hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new UsageError(`--hash <payload sha256> is required (from "dataops newsletter render"). Usage: ${usage}`);
  return hash;
}

export async function approve(args, io) {
  const usage = "dataops newsletter approve <issue> --version N --hash <payload-sha256> [--note <text>]";
  const issue = issueArg(args, usage);
  const body = { version: versionArg(args, usage), payloadHash: hashArg(args, usage), note: optionalString(args, "note") || "" };
  const result = await apiFor(args).post(draftUrl(issue, "/approve"), body);
  if (args.json) return result;
  io.print(`approved version ${result.draft.approval.draftVersion}, payload sha256 ${result.payloadHash}`);
  return result;
}

export async function testSend(args, io) {
  const usage = "dataops newsletter test-send <issue> --to <email>[,<email>]";
  const issue = issueArg(args, usage);
  const to = optionalString(args, "to");
  if (!to) throw new UsageError(`--to is required. Usage: ${usage}`);
  const emails = to.split(",").map((value) => value.trim()).filter(Boolean);
  const result = await apiFor(args).post(draftUrl(issue, "/test-send"), { emails, requestId: `cli-${randomUUID()}` });
  if (args.json) return result;
  io.print(`test send via Relay campaign ${result.testSend.campaignKey}: ${result.testSend.status} (${result.testSend.emails.join(", ")})`);
  return result;
}

export async function schedule(args, io) {
  const usage = "dataops newsletter schedule <issue> --at <ISO time with offset> --version N --hash <payload-sha256> --yes";
  const issue = issueArg(args, usage);
  const at = optionalString(args, "at");
  if (!at) throw new UsageError(`--at is required, e.g. 2027-01-10T08:00:00Z. Usage: ${usage}`);
  const body = { scheduledAt: at, version: versionArg(args, usage), payloadHash: hashArg(args, usage), requestId: `cli-${randomUUID()}` };
  if (!args.yes) throw new UsageError(`This schedules the approved email in Relay for ${at}; Relay sends it then. Re-run with --yes.`);
  const result = await apiFor(args).post(draftUrl(issue, "/schedule"), body);
  if (args.json) return result;
  io.print(`scheduled in Relay campaign ${result.delivery.campaignKey} for ${result.delivery.scheduledAt}${result.adopted ? " (Relay already held this payload)" : ""}`);
  return result;
}

export async function cancelSchedule(args, io) {
  const usage = "dataops newsletter cancel-schedule <issue> --yes";
  const issue = issueArg(args, usage);
  if (!args.yes) throw new UsageError(`This cancels the scheduled send in Relay. Re-run with --yes.`);
  const result = await apiFor(args).post(draftUrl(issue, "/cancel"), {});
  if (args.json) return result;
  io.print(`cancelled Relay campaign ${result.delivery.campaignKey}; the draft is editable again`);
  return result;
}

export async function delivery(args, io) {
  const usage = "dataops newsletter delivery <issue> [--refresh]";
  const issue = issueArg(args, usage);
  const result = await apiFor(args).get(draftUrl(issue, "/delivery"), { query: args.refresh ? { refresh: "1" } : undefined });
  if (args.json) return result;
  const value = result.delivery;
  io.print(value ? `${value.state}${value.relayStatus ? ` (${value.relayStatus})` : ""} · ${value.campaignKey} · ${value.scheduledAt}${value.error ? ` · ${value.error}` : ""}` : "not handed to Relay");
  return result;
}
