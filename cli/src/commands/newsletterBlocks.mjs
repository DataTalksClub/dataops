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
  dataops newsletter revisions <issue> [--block <id>] [--origin edit|import|relay-pull]
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
        ["CHANGED", (r) => r.changes.map((c) => c.field).join(", ") || "(none)"],
      ],
      `No revisions for issue ${issue}.`,
    );
    return { ...result, revisions: list };
  }
  for (const rev of list) {
    io.print(`=== rev ${rev.revision} · ${rev.blockId} ${rev.label} · ${rev.origin} by ${who(rev)} · ${rev.createdAt}`);
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
