// Newsletter issue blocks: list, import from Relay, edit, sync with Relay, and
// read the revision history (who changed which block, and how).

import { readFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { formatLineDiff } from "./sponsorDocs.mjs";

export const blocksHelp = `dataops newsletter blocks / block-edit / blocks-sync / revisions - issue content blocks

Usage
  dataops newsletter blocks <issue-id|issue-number> [--show] [--json]
  dataops newsletter blocks <issue> --import <relay-issue-key> [--target production|dev]
  dataops newsletter block-edit <issue> <block-id> --field <name> --value <text>
  dataops newsletter block-edit <issue> <block-id> --field <name> --value-file <path>
  dataops newsletter block-edit <issue> <block-id> --data-file <block-data.json>
  dataops newsletter blocks-sync <issue> [--dry-run] [--json]
  dataops newsletter block list <issue> [--show]
  dataops newsletter block show <issue> <block-id>
  dataops newsletter block add <issue> --type <block-type> [--position N]
      [--field name=value ...] [--data-file <json>]
  dataops newsletter block edit <issue> <block-id> --field name=value ... | --data-file <json>
  dataops newsletter block move <issue> <block-id> (--up | --down | --to N)
  dataops newsletter block delete <issue> <block-id> --yes
  dataops newsletter block-types [--json]
  dataops newsletter sponsor-sync <issue> --slot primary|secondary [--dry-run] [--force]
  dataops newsletter revisions <issue> [--block <id>] [--origin edit|import|relay-pull|add|move|delete|sponsor-doc]
      [--diff] [--rev N] [--json]

Every block of the issue (intro, sponsor, event spotlight, course updates,
events list, recording, article, ...) is editable in DataOps on the issue page
(/newsletter/<issue-id>) and here. Each edit is a revision; "revisions" lists
them and --diff prints a line diff per changed field (--rev N for one).

Sync with Relay is two-way, per block, against the content both sides last
agreed on: blocks edited only in DataOps are pushed, blocks edited only in
Relay are pulled. A block edited on both sides is a conflict and the whole
sync is refused before anything is written. --dry-run shows the plan.
Pushing is refused once the Relay campaign has left draft. Nothing is sent.

Adding, moving and deleting blocks is local until the next blocks-sync, which
creates, reorders and deletes the blocks in Relay (DataOps is the source of
truth for structure; a Relay-side change to the same block is a conflict).

Sponsor blocks follow the sponsor document, not the editor:
  - the main sponsor block is pinned as the first content block: it cannot be
    moved or deleted, and nothing can be placed above it;
  - secondary sponsor blocks can be moved but not deleted (they go away when the
    slot is removed from the document);
  - sponsor block content is read-only here: edit it in the sponsor document;
    every sponsor-doc save syncs it. "sponsor-sync" re-runs that sync by hand
    (--force overwrites a block changed in Relay after the last sync).
Refusals print the server's message and exit non-zero.
`;

function blockRow(block) {
  const first = block.data?.title || block.data?.summary || block.data?.events || block.data?.html || "";
  return {
    ...block,
    preview: String(first).replace(/\s+/g, " ").slice(0, 60),
  };
}

function printSet(io, set) {
  io.print(`relay: ${set.relay.target} ${set.relay.issueKey} · subject: ${set.relayIssue?.subject || ""}`);
  if (set.lastSync) io.print(`last sync: ${set.lastSync.at} by ${set.lastSync.byName || "?"} (${set.lastSync.summary})`);
  table(
    io,
    set.blocks.map(blockRow),
    [
      ["POS", (b) => String(b.position)],
      ["ID", (b) => b.id],
      ["TYPE", (b) => b.type],
      ["V", (b) => String(b.version)],
      ["STATE", (b) => (b.changedSinceSync ? "edited, not pushed" : "in sync")],
      ["EDITED BY", (b) => b.updatedByName || ""],
      ["CONTENT", (b) => b.preview],
    ],
    "No blocks.",
  );
}

export async function blocks(args, io) {
  const usage = "dataops newsletter blocks <issue> [--import <relay-issue-key> [--target production|dev]]";
  const issue = String(positional(args, 0, usage));
  const api = apiFor(args);
  const importKey = optionalString(args, "import");
  const result = importKey
    ? await api.post(`/api/newsletter-issues/${enc(issue)}/blocks/import`, {
        issueKey: importKey,
        target: optionalString(args, "target") || "production",
      })
    : await api.get(`/api/newsletter-issues/${enc(issue)}/blocks`);
  if (args.json) return result;
  if (importKey) io.print(`imported ${result.blocks.blocks.length} blocks from Relay ${result.blocks.relay.target} ${importKey}`);
  printSet(io, result.blocks);
  if (args.show) {
    for (const block of result.blocks.blocks) {
      io.print("");
      io.print(`## ${block.id} · ${block.label} (v${block.version})`);
      for (const [name, value] of Object.entries(block.data || {})) io.print(`${name}: ${String(value).replace(/\n/g, "\n  ")}`);
    }
  }
  return result;
}

export async function blockEdit(args, io) {
  const usage = "dataops newsletter block-edit <issue> <block-id> (--field <name> --value <text> | --value-file <path> | --data-file <path>)";
  const issue = String(positional(args, 0, usage));
  const blockId = String(positional(args, 1, usage));
  const api = apiFor(args);
  const current = (await api.get(`/api/newsletter-issues/${enc(issue)}/blocks`)).blocks;
  const block = current.blocks.find((item) => item.id === blockId || String(item.relayBlockId) === blockId);
  if (!block) throw new UsageError(`No block ${blockId}. Blocks: ${current.blocks.map((b) => b.id).join(", ")}`);
  let data;
  const dataFile = optionalString(args, "dataFile");
  if (dataFile) {
    data = JSON.parse(readFileSync(dataFile, "utf8"));
  } else {
    const field = optionalString(args, "field");
    if (!field) throw new UsageError(usage);
    const valueFile = optionalString(args, "valueFile");
    const value = valueFile ? readFileSync(valueFile, "utf8") : args.value;
    if (typeof value !== "string") throw new UsageError(`Pass --value <text> or --value-file <path>. Usage: ${usage}`);
    data = { ...block.data, [field]: value };
  }
  const result = await api.put(`/api/newsletter-issues/${enc(issue)}/blocks/${enc(block.id)}`, { version: block.version, data });
  if (args.json) return result;
  const saved = result.blocks.blocks.find((item) => item.id === block.id);
  io.print(result.changed ? `saved ${block.id} as version ${saved.version} (not pushed to Relay yet; run blocks-sync)` : `${block.id} unchanged`);
  return result;
}

export async function blocksSync(args, io) {
  const usage = "dataops newsletter blocks-sync <issue> [--dry-run]";
  const issue = String(positional(args, 0, usage));
  const api = apiFor(args);
  const result = await api.post(`/api/newsletter-issues/${enc(issue)}/blocks/sync`, { dryRun: Boolean(args.dryRun) });
  if (args.json) return result;
  io.print(`relay: ${result.relay.target} ${result.relay.issueKey} (${result.relay.url})${result.dryRun ? " · dry run, nothing written" : ""}`);
  table(
    io,
    result.plan,
    [
      ["RELAY ID", (s) => String(s.relayBlockId)],
      ["TYPE", (s) => s.type],
      ["ACTION", (s) => s.action],
      ["WHY", (s) => s.reason],
    ],
    "No blocks.",
  );
  if (!result.dryRun) io.print(`pushed: ${result.pushed.join(", ") || "none"} · pulled: ${result.pulled.join(", ") || "none"}`);
  return result;
}

function who(rev) {
  if (rev.origin === "relay-pull" || rev.origin === "relay-remove") return `Relay: ${rev.relayActor || "?"}`;
  if (rev.origin === "sponsor-doc") return "sponsor doc";
  return rev.actorName || rev.actorUserId || "?";
}

export async function revisions(args, io) {
  const usage = "dataops newsletter revisions <issue> [--block <id>] [--origin <origin>] [--diff] [--rev N]";
  const issue = String(positional(args, 0, usage));
  const api = apiFor(args);
  const block = optionalString(args, "block");
  const result = await api.get(`/api/newsletter-issues/${enc(issue)}/blocks/revisions`, {
    query: block ? { block: block.replace(/^rb-/, "") } : undefined,
  });
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
        ["BLOCK", (r) => `${r.blockId} ${r.blockType}`],
        ["ORIGIN", (r) => r.origin],
        ["BY", who],
        ["CHANGED", (r) => r.changes.map((c) => c.field).join(", ") || r.detail || "(none)"],
      ],
      `No revisions for issue ${issue}.`,
    );
    return { ...result, revisions: list };
  }
  for (const rev of list) {
    io.print(`=== rev ${rev.revision} · ${rev.blockId} ${rev.label} · ${rev.origin} by ${who(rev)} · ${rev.createdAt}`);
    if (rev.detail) io.print(rev.detail);
    if (!rev.changes.length) io.print("(no field changes)");
    for (const change of rev.changes) {
      io.print(`--- ${change.field} [before]`);
      io.print(`+++ ${change.field} [after]`);
      const lines = rev.before === null
        ? change.after.split("\n").map((line) => `+ ${line}`)
        : formatLineDiff(change.before, change.after);
      for (const line of lines) io.print(line);
    }
    io.print("");
  }
  return { ...result, revisions: list };
}

const issueArg = (args, usage) => String(positional(args, 0, usage));
const blocksUrl = (issue, tail = "") => `/api/newsletter-issues/${enc(issue)}/blocks${tail}`;

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
  const block = set.blocks.find((item) => item.id === ref || String(item.relayBlockId) === ref);
  if (!block) throw new UsageError(`No block ${ref}. Blocks: ${set.blocks.map((b) => b.id).join(", ")}`);
  return block;
}

function stateLabel(block) {
  const state = block.pushState || (block.changedSinceSync ? "edited" : "in-sync");
  return { new: "new, not in Relay", edited: "edited, not pushed", "in-sync": "in sync" }[state] || state;
}

function printBlock(io, block) {
  io.print(`## ${block.id} · ${block.label} (v${block.version}) · ${stateLabel(block)}`);
  if (block.sponsor) io.print(`sponsor block (${block.sponsor}): read-only here, edit in the sponsor doc${block.sponsorDocUrl ? ` ${block.sponsorDocUrl}` : ""}`);
  for (const [name, value] of Object.entries(block.data || {})) io.print(`${name}: ${String(value).replace(/\n/g, "\n  ")}`);
}

export async function blockCommand(args, io) {
  const usage = "dataops newsletter block list|show|add|edit|move|delete <issue> ...";
  const action = String(positional(args, 0, usage));
  const sub = { ...args, _: args._.slice(1) };
  const handler = { list: blockList, show: blockShow, add: blockAdd, edit: blockEditV2, move: blockMove, delete: blockDelete }[action];
  if (!handler) throw new UsageError(`Unknown block action "${action}". ${usage}`);
  return handler(sub, io);
}

async function blockList(args, io) {
  const usage = "dataops newsletter block list <issue> [--show]";
  const result = await apiFor(args).get(blocksUrl(issueArg(args, usage)));
  if (args.json) return result;
  const set = result.blocks;
  io.print(`relay: ${set.relay.target} ${set.relay.issueKey} · subject: ${set.relayIssue?.subject || ""}`);
  if (set.orderChanged) io.print("order changed in DataOps, not pushed to Relay yet");
  for (const gone of set.deletedPending || []) io.print(`deleted in DataOps, still in Relay until sync: ${gone.id} ${gone.type}`);
  table(
    io,
    set.blocks.map(blockRow),
    [
      ["POS", (b) => String(b.position)],
      ["ID", (b) => b.id],
      ["TYPE", (b) => b.type],
      ["V", (b) => String(b.version)],
      ["STATE", stateLabel],
      ["RULE", (b) => (b.pinned ? "pinned" : b.sponsor ? "sponsor doc only" : "")],
      ["CONTENT", (b) => b.preview],
    ],
    "No blocks.",
  );
  if (args.show) for (const block of set.blocks) { io.print(""); printBlock(io, block); }
  return result;
}

async function blockShow(args, io) {
  const usage = "dataops newsletter block show <issue> <block-id>";
  const result = await apiFor(args).get(blocksUrl(issueArg(args, usage)));
  const block = findBlock(result.blocks, String(positional(args, 1, usage)));
  if (args.json) return { block };
  printBlock(io, block);
  return { block };
}

async function blockAdd(args, io) {
  const usage = "dataops newsletter block add <issue> --type <block-type> [--position N] [--field name=value ...]";
  const issue = issueArg(args, usage);
  const type = optionalString(args, "type");
  if (!type) throw new UsageError(`--type is required (see: dataops newsletter block-types). Usage: ${usage}`);
  const body = { type, data: dataFromArgs(args) };
  if (args.position !== undefined) {
    if (!/^\d+$/.test(String(args.position))) throw new UsageError(`--position must be a non-negative integer, got "${args.position}".`);
    body.position = Number(args.position);
  }
  const result = await apiFor(args).post(blocksUrl(issue), body);
  if (args.json) return result;
  const added = result.block || result.blocks.blocks.find((b) => b.type === type);
  io.print(`added ${added?.id || type} at position ${added?.position ?? "end"} (not in Relay yet; run blocks-sync)`);
  return result;
}

async function blockEditV2(args, io) {
  const usage = "dataops newsletter block edit <issue> <block-id> (--field name=value ... | --data-file <json>)";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  const api = apiFor(args);
  const block = findBlock((await api.get(blocksUrl(issue))).blocks, ref);
  let data;
  if (optionalString(args, "dataFile")) {
    data = dataFromArgs(args);
  } else {
    const single = typeof args.field === "string" && !args.field.includes("=");
    if (single) {
      const valueFile = optionalString(args, "valueFile");
      const value = valueFile ? readFileSync(valueFile, "utf8") : args.value;
      if (typeof value !== "string") throw new UsageError(`Pass --value <text> or --value-file <path>. Usage: ${usage}`);
      data = { ...block.data, [args.field]: value };
    } else {
      const changes = parseFieldPairs(args);
      if (!Object.keys(changes).length) throw new UsageError(`Nothing to change. Usage: ${usage}`);
      data = { ...block.data, ...changes };
    }
  }
  const result = await api.put(blocksUrl(issue, `/${enc(block.id)}`), { version: block.version, data });
  if (args.json) return result;
  io.print(result.changed ? `saved ${block.id} (not pushed to Relay yet; run blocks-sync)` : `${block.id} unchanged`);
  return result;
}

async function blockMove(args, io) {
  const usage = "dataops newsletter block move <issue> <block-id> (--up | --down | --to N)";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  const api = apiFor(args);
  const block = findBlock((await api.get(blocksUrl(issue))).blocks, ref);
  let body;
  if (args.up) body = { direction: "up" };
  else if (args.down) body = { direction: "down" };
  else if (args.to !== undefined && /^\d+$/.test(String(args.to))) body = { to: Number(args.to) };
  else throw new UsageError(`Pass --up, --down or --to <index>. Usage: ${usage}`);
  const result = await api.post(blocksUrl(issue, `/${enc(block.id)}/move`), body);
  if (args.json) return result;
  const moved = result.blocks.blocks.find((item) => item.id === block.id);
  io.print(`moved ${block.id} to position ${moved?.position} (not pushed to Relay yet; run blocks-sync)`);
  return result;
}

async function blockDelete(args, io) {
  const usage = "dataops newsletter block delete <issue> <block-id> --yes";
  const issue = issueArg(args, usage);
  const ref = String(positional(args, 1, usage));
  const api = apiFor(args);
  const block = findBlock((await api.get(blocksUrl(issue))).blocks, ref);
  if (!args.yes) throw new UsageError(`Deleting ${block.id} (${block.label}) removes it from the issue and, on the next sync, from Relay. Re-run with --yes.`);
  const result = await api.delete(blocksUrl(issue, `/${enc(block.id)}`));
  if (args.json) return result;
  io.print(`deleted ${block.id} (removed from Relay on the next blocks-sync)`);
  return result;
}

export async function blockTypes(args, io) {
  const result = await apiFor(args).get(blocksUrl(String(positional(args, 0, "dataops newsletter block-types <issue>")), "/types"));
  if (args.json) return result;
  table(
    io,
    result.types,
    [
      ["TYPE", (t) => t.type],
      ["LABEL", (t) => t.label],
      ["ADD", (t) => (t.addable ? "yes" : "sponsor doc only")],
      ["FIELDS", (t) => t.fields.map((f) => `${f.name}${f.required ? "*" : ""}`).join(", ")],
    ],
    "No block types.",
  );
  return result;
}

export async function sponsorSync(args, io) {
  const usage = "dataops newsletter sponsor-sync <issue> --slot primary|secondary [--dry-run] [--force]";
  const issue = issueArg(args, usage);
  const slot = optionalString(args, "slot") || "primary";
  if (slot !== "primary" && slot !== "secondary") throw new UsageError("--slot must be primary or secondary.");
  const result = await apiFor(args).post(blocksUrl(issue, "/sponsor-sync"), {
    slot,
    dryRun: Boolean(args.dryRun),
    force: Boolean(args.force),
  });
  if (args.json) return result;
  const detail = result.result || result;
  io.print(`sponsor-sync ${slot}: ${detail.summary || detail.action || "done"}${args.dryRun ? " (dry run, nothing written)" : ""}`);
  return result;
}
