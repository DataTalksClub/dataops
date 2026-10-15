import { readFileSync } from "node:fs";

import { ApiError } from "../api.mjs";
import { ConflictError, UsageError } from "../errors.mjs";
import { apiMutation, batches, commitFiles, planReconcile, prodLineage, recordedStates, repositoryName, resolveCommit } from "../knowledgePublish.mjs";
import { enc, fields, integer, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Explore, read, and search the knowledge base (SOPs, references, templates)";

export const help = `dataops kb - the knowledge base: process docs, SOPs, references, playbooks

Usage
  dataops kb search <query...> [--type sop|reference|template|...] [--domain D]
      [--tag T] [--system S] [--limit N]        Ranked matches with a snippet each
  dataops kb related <task-id|card-id> [--limit N]
                                               Docs for a piece of work: the docs it links,
                                               then search matches for its title/Template
  dataops kb show <doc-id|path> [--meta]       The document's markdown on stdout
  dataops kb tree [folder] [--depth N]         The folder tree with document titles
  dataops kb ls [folder]                       One folder: subfolders and documents
  dataops kb resolve <doc-id|alias|path>       The document's registry record
  dataops kb backlinks <doc-id|path>           Documents that link to it
  dataops kb history <doc-id|path>             Published versions of it
  dataops kb write <path> --file F [--create] [--title T] [--type T]
                                               Publish new content (as the web editor does)
  dataops kb publish [--head REV] [--repo DIR] [--dry-run]
                                               Make prod match a knowledge-repo commit; files
                                               edited in prod that Git has not seen are left
                                               alone, and real conflicts exit 5

Folders and paths may omit the leading "content/". Search runs on the server
against an index of the current knowledge publication; nothing is downloaded.

Examples
  dataops kb search "sponsor invoice" --type sop --limit 5
  dataops kb related b6fc790f-...            # "what do I read before doing this Task?"
  dataops kb show newsletter.schedule > /tmp/sop.md
  dataops kb tree 01-audience-growth --depth 2
`;

const CONTENT = "content/";

function folderOf(value) {
  if (value === undefined || value === true) return "";
  const text = String(value).replace(/^\/+|\/+$/g, "");
  if (!text || text === "content") return "";
  return text.startsWith(CONTENT) ? text.slice(CONTENT.length) : text;
}

async function documents(api) {
  const payload = await api.get("/docs");
  return Array.isArray(payload?.documents) ? payload.documents : [];
}

function relative(path) {
  return path.startsWith(CONTENT) ? path.slice(CONTENT.length) : path;
}

export async function resolveDocument(api, ref) {
  const { document } = await api.get("/docs/resolve", { query: { ref } });
  return document;
}

export async function search(args, io) {
  const query = args._.join(" ").trim();
  if (!query) throw new UsageError("Usage: dataops kb search <query...> [--type T] [--limit N]");
  const limit = integer(args.limit, "limit") ?? 10;
  const result = await apiFor(args).get("/search", {
    query: {
      q: query,
      source: "docs",
      limit,
      doc_type: optionalString(args, "type"),
      domain: optionalString(args, "domain"),
      tag: optionalString(args, "tag"),
      system: optionalString(args, "system"),
    },
  });
  const results = (result?.results || []).map((item, index) => ({
    rank: index + 1,
    id: item.id,
    path: item.path,
    title: item.title,
    doc_type: item.doc_type,
    domain: item.domain,
    score: item.score ?? null,
    summary: item.summary,
    snippet: item.snippet || item.summary || "",
    tags: item.tags || [],
  }));
  const output = { query, results };
  if (args.json) return output;
  printMatches(io, results, `No documents match "${query}".`);
  return output;
}

function printMatches(io, results, empty) {
  if (!results.length) {
    io.print(empty);
    return;
  }
  for (const item of results) {
    const score = typeof item.score === "number" ? `  score ${item.score.toFixed(2)}` : "";
    io.print(`${item.rank}. ${item.title} [${item.doc_type || "doc"}]${score}`);
    io.print(`   ${item.id}  ${item.path}`);
    if (item.snippet) io.print(`   ${item.snippet}`);
  }
}

export async function show(args, io) {
  const ref = positional(args, 0, "dataops kb show <doc-id|path>");
  const api = apiFor(args);
  const document = await resolveDocument(api, ref);
  const doc = await api.get("/docs", { query: { path: document.path } });
  const result = { document, path: doc.path, revision: doc.revision, content: doc.content };
  if (args.json) return result;
  if (args.meta) {
    fields(io, [
      ["id", document.id],
      ["title", document.title],
      ["type", document.doc_type],
      ["path", document.path],
      ["summary", document.summary],
      ["tags", document.tags],
      ["systems", document.systems],
      ["related", document.related_docs],
      ["revision", doc.revision],
    ]);
    io.print("");
  }
  io.print(doc.content);
  return result;
}

/** Folders and documents under one folder, from the document registry. */
function children(docs, folder) {
  const prefix = folder ? `${folder}/` : "";
  const folders = new Map();
  const files = [];
  for (const doc of docs) {
    const rel = relative(doc.path);
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(doc);
    else {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) || 0) + 1);
    }
  }
  return {
    folders: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, path: `${prefix}${name}`, documents: count })),
    documents: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function docSummary(doc) {
  return { id: doc.id, path: doc.path, title: doc.title, doc_type: doc.doc_type, summary: doc.summary };
}

export async function ls(args, io) {
  const folder = folderOf(args._[0]);
  const docs = await documents(apiFor(args));
  const listing = children(docs, folder);
  if (folder && !listing.folders.length && !listing.documents.length) {
    throw new ApiError(404, { error: `No folder content/${folder}` }, "");
  }
  const result = { folder: `${CONTENT}${folder}`.replace(/\/$/, ""), folders: listing.folders, documents: listing.documents.map(docSummary) };
  if (args.json) return result;
  for (const sub of listing.folders) io.print(`${sub.name}/  (${sub.documents} docs)`);
  if (listing.folders.length && !result.documents.length) return result;
  table(io, result.documents, [
    ["ID", (doc) => doc.id],
    ["TYPE", (doc) => doc.doc_type],
    ["TITLE", (doc) => doc.title],
  ], listing.folders.length ? "" : "No documents.");
  return result;
}

export async function tree(args, io) {
  const folder = folderOf(args._[0]);
  const depth = integer(args.depth, "depth") ?? Infinity;
  const docs = await documents(apiFor(args));
  function build(path, level) {
    const listing = children(docs, path);
    return {
      folders: level >= depth ? listing.folders.map((sub) => ({ ...sub, collapsed: true })) : listing.folders.map((sub) => ({ ...sub, ...build(sub.path, level + 1) })),
      documents: listing.documents.map(docSummary),
    };
  }
  const result = { folder: `${CONTENT}${folder}`.replace(/\/$/, ""), ...build(folder, 0) };
  if (args.json) return result;
  function render(node, indent) {
    for (const sub of node.folders) {
      io.print(`${indent}${sub.name}/${sub.collapsed ? ` (${sub.documents} docs)` : ""}`);
      if (!sub.collapsed) render(sub, `${indent}  `);
    }
    for (const doc of node.documents) io.print(`${indent}- ${doc.title} [${doc.doc_type}] ${doc.id}`);
  }
  io.print(`${result.folder}/`);
  render(result, "  ");
  return result;
}

export async function resolve(args, io) {
  const ref = positional(args, 0, "dataops kb resolve <doc-id|alias|path>");
  const document = await resolveDocument(apiFor(args), ref);
  if (args.json) return { document };
  fields(io, Object.entries(document).filter(([, value]) => typeof value !== "object" || Array.isArray(value)));
  return { document };
}

export async function backlinks(args, io) {
  const ref = positional(args, 0, "dataops kb backlinks <doc-id|path>");
  const api = apiFor(args);
  const document = await resolveDocument(api, ref);
  const result = await api.get("/docs/backlinks", { query: { path: document.path } });
  if (args.json) return result;
  table(io, result.backlinks || [], [["PATH", (item) => item.path], ["TITLE", (item) => item.title]], "No backlinks.");
  return result;
}

export async function history(args, io) {
  const ref = positional(args, 0, "dataops kb history <doc-id|path>");
  const api = apiFor(args);
  let path = ref;
  try {
    path = (await resolveDocument(api, ref)).path;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  const result = await api.get("/knowledge/history", { query: { path } });
  if (args.json) return result;
  table(io, result.versions || [], [
    ["REVISION", (item) => item.revision],
    ["TIME", (item) => item.time],
    ["ACTOR", (item) => item.actor],
    ["OPERATION", (item) => item.operation],
    ["MESSAGE", (item) => item.message],
  ], "No published versions.");
  return result;
}

export async function write(args, io) {
  const usage = "dataops kb write <path> --file F [--create] [--title T] [--type T]";
  const raw = positional(args, 0, usage);
  if (args.file === undefined || args.file === true) throw new UsageError(`--file is required. ${usage}`);
  const path = raw.startsWith(CONTENT) ? raw : `${CONTENT}${raw.replace(/^\/+/, "")}`;
  const content = String(args.file) === "-" ? readFileSync(0, "utf8") : readFileSync(String(args.file), "utf8");
  const api = apiFor(args);
  let revision;
  try {
    revision = (await api.get("/docs", { query: { path } })).revision;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    if (!args.create) throw new UsageError(`${path} does not exist. Pass --create to add it.`);
    const { revision: head } = await api.get("/knowledge/publication");
    const created = await api.post("/docs", {
      path,
      absent: true,
      expectedRevision: head,
      title: optionalString(args, "title"),
      doc_type: optionalString(args, "type"),
    });
    revision = created.revision;
  }
  const result = await api.put("/docs", { content, expectedRevision: revision }, { query: { path } });
  if (args.json) return result;
  io.print(`Published ${result.path} (revision ${result.revision}).`);
  for (const warning of result.warnings || []) io.print(`warning: ${warning}`);
  return result;
}

export async function publish(args, io) {
  const usage = "dataops kb publish [--head REV] [--repo DIR] [--dry-run]";
  if (args.base !== undefined) throw new UsageError(`--base is gone: publish reconciles prod with the whole commit. ${usage}`);
  const repo = optionalString(args, "repo") || ".";
  let head;
  try {
    head = resolveCommit(repo, optionalString(args, "head") || "HEAD");
  } catch (error) {
    throw new UsageError(`Cannot resolve the commit in ${repo}: ${String(error.stderr || error.message).trim()}`);
  }
  const api = apiFor(args);
  const manifest = await api.get("/knowledge/manifest");
  const files = commitFiles(repo, head, manifest.roots);
  const diverged = [...new Set([...files.keys(), ...Object.keys(manifest.entries)])]
    .filter((file) => (manifest.entries[file]?.sha256 ?? null) !== (files.get(file)?.sha ?? null));
  const recorded = recordedStates(repo, head, manifest.roots, diverged);
  const plan = await planReconcile({
    files, prod: manifest.entries, known: (file) => recorded.get(file), lineage: (file) => prodLineage(api, file),
  });
  let revision = manifest.revision;
  if (!args.dryRun && plan.mutations.length) {
    const message = `Publish ${repositoryName(repo)} ${head}`;
    for (const batch of batches(plan.mutations)) {
      revision = (await api.post("/knowledge/publish", { expectedRevision: revision, message, mutations: batch.map(apiMutation) })).revision;
    }
  }
  const result = {
    head, checkedRevision: manifest.revision, revision, dryRun: Boolean(args.dryRun),
    published: plan.mutations.map(({ path, operation }) => ({ path, operation })),
    ahead: plan.ahead, conflicts: plan.conflicts, unchanged: plan.unchanged,
  };
  if (!args.json) {
    const verb = args.dryRun ? "would " : "";
    for (const item of result.published) io.print(`${verb}${item.operation} ${item.path}`);
    for (const file of result.ahead) io.print(`prod ahead (left for the daily mirror) ${file}`);
    if (args.dryRun) io.print(`Dry run: ${result.published.length} file(s) would be published onto revision ${manifest.revision}; ${result.unchanged} already match.`);
    else if (result.published.length) io.print(`Published ${result.published.length} file(s) from ${head.slice(0, 12)} as revision ${revision}; ${result.unchanged} already matched.`);
    else io.print(`Nothing to publish: ${result.unchanged} file(s) already match prod.`);
  }
  if (plan.conflicts.length) {
    const lines = plan.conflicts.map((item) => `  ${item.path} (prod ${item.prod === "absent" ? "deleted it" : "edited it"} in a way Git has not seen, and Git's copy differs from where that edit started)`);
    throw new ConflictError(
      `${plan.conflicts.length} file(s) changed both in prod and in Git; they were left untouched${args.dryRun ? "" : ", everything else was published"}:\n${lines.join("\n")}\n`
        + "Merge the prod edit into Git (copy it from the web editor or wait for the daily mirror), then push again.",
      result,
    );
  }
  return result;
}

// ── related: docs for a Task or Card ─────────────────────────────────────────

/** A doc reference inside a link the web app or a Template points at. */
export function docRefFromUrl(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text, "https://placeholder.invalid");
    const path = parsed.searchParams.get("path") || parsed.searchParams.get("doc") || "";
    if (path) return path;
    const docId = parsed.searchParams.get("docId") || parsed.searchParams.get("id") || "";
    if (docId && /\/(docs|knowledge)\b/.test(parsed.pathname)) return docId;
    const contentAt = parsed.pathname.indexOf("/content/");
    if (contentAt !== -1 && parsed.pathname.endsWith(".md")) return decodeURIComponent(parsed.pathname.slice(contentAt + 1));
  } catch {
    return "";
  }
  return "";
}

const NOISE = /\b\d{4}-\d{2}-\d{2}\b|\b\d+\b|[#@]/g;

function searchText(parts) {
  return parts.filter(Boolean).join(" ").replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

async function workItem(api, id) {
  try {
    const task = await api.get(`/api/tasks/${enc(id)}`);
    let card = null;
    if (task.cardId) {
      try {
        card = (await api.get(`/api/cards/${enc(task.cardId)}`)).card;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
    }
    return { kind: "task", task, card };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  try {
    const { card } = await api.get(`/api/cards/${enc(id)}`);
    return { kind: "card", task: null, card };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError(404, { error: `No Task or Card with id ${id}` }, error.url);
    }
    throw error;
  }
}

export async function related(args, io) {
  const id = positional(args, 0, "dataops kb related <task-id|card-id>");
  const limit = integer(args.limit, "limit") ?? 5;
  const api = apiFor(args);
  const { kind, task, card } = await workItem(api, id);
  const templateId = task?.templateId || card?.templateId;
  let template = null;
  if (templateId) {
    try {
      template = (await api.get(`/api/templates/${enc(templateId)}`)).template;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }

  // Explicit links first: the doc the Task's instructions name, then source
  // docs of the Task, its Card, and its Template, then doc links in references.
  const refs = [];
  const add = (ref, via) => {
    const value = String(ref || "").trim();
    if (value && !refs.some((item) => item.ref === value)) refs.push({ ref: value, via });
  };
  add(task?.instructionDocId, "task instructions");
  for (const ref of task?.sourceDocIds || []) add(ref, "task source docs");
  add(docRefFromUrl(task?.instructionsUrl), "task instructions link");
  for (const ref of card?.sourceDocIds || []) add(ref, "card source docs");
  for (const ref of template?.sourceDocIds || []) add(ref, "template source docs");
  for (const item of [...(card?.references || []), ...(template?.references || [])]) {
    add(docRefFromUrl(item?.url), "reference link");
  }

  const linked = [];
  const unresolved = [];
  for (const { ref, via } of refs) {
    try {
      const document = await resolveDocument(api, ref);
      if (!linked.some((item) => item.id === document.id)) linked.push({ ...docSummary(document), via });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      unresolved.push({ ref, via, error: error.message });
    }
  }

  const query = searchText([task?.description, card?.title, template?.name]);
  let matches = [];
  if (query) {
    const found = await api.get("/search", { query: { q: query, source: "docs", limit: limit + linked.length } });
    const linkedPaths = new Set(linked.map((doc) => doc.path));
    matches = (found?.results || [])
      .filter((item) => !linkedPaths.has(item.path))
      .slice(0, limit)
      .map((item, index) => ({
        rank: index + 1,
        id: item.id,
        path: item.path,
        title: item.title,
        doc_type: item.doc_type,
        score: item.score ?? null,
        snippet: item.snippet || item.summary || "",
      }));
  }

  const subject = kind === "task"
    ? { kind, id: task.id, title: task.description, cardId: task.cardId || null, templateId: templateId || null }
    : { kind, id: card.id, title: card.title, templateId: templateId || null };
  const result = { subject, linked, unresolved, query, matches };
  if (args.json) return result;
  io.print(`${kind === "task" ? "Task" : "Card"}: ${subject.title}`);
  if (card && kind === "task") io.print(`Card: ${card.title}`);
  if (template) io.print(`Template: ${template.name}`);
  io.print("");
  io.print("Linked docs");
  if (!linked.length) io.print("  (none linked)");
  for (const doc of linked) io.print(`  ${doc.title} [${doc.doc_type}]  ${doc.id}  (${doc.via})`);
  for (const item of unresolved) io.print(`  unresolved: ${item.ref} (${item.via})`);
  io.print("");
  io.print(`Search matches for "${query}"`);
  printMatches({ print: (line) => io.print(`  ${line}`) }, matches, "No matches.");
  io.print("");
  io.print("Read one with: dataops kb show <doc-id>");
  return result;
}

export const commands = { search, related, show, tree, ls, resolve, backlinks, history, write, publish };
