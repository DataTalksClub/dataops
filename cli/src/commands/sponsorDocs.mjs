import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { rewriteVerificationUri } from "./auth.mjs";

export const summary = "Create, share, and export sponsor content documents for Cards";

export const TEMPLATES = [
  "newsletter-main",
  "newsletter-secondary",
  "newsletter-standalone",
  "podcast",
];

export const help = `dataops sponsor-docs - portal-hosted sponsor content documents

Each sponsor document is created from a template for a Card, linked on the
Card's "Sponsorship document" slot, and gated by an 80-bit access code.
Sponsors can open the shareable link (/sponsor-docs/<id>?code=XXXX-XXXX-XXXX-XXXX)
directly in their browser without a Google account or DataOps login, or type
their access code on /sponsor-docs/<id>. Authenticated DataOps staff can view
and edit any sponsor document without a code.

Usage
  dataops sponsor-docs create <card-id> [--template ${TEMPLATES.join("|")}]
      [--slot primary|secondary] [--title T] [--sponsor NAME] [--date YYYY-MM-DD]
      [--link-type NAME] [--email]
                                  Creates the doc for the Card (auto-detecting the
                                  template from the Card/issue when --template is
                                  omitted), links it on the Card's "Sponsorship
                                  document" field, and prints the shareable link
                                  with the access code
  dataops sponsor-docs list [--card <card-id>]
  dataops sponsor-docs show <doc-id>
  dataops sponsor-docs update <doc-id> [--title T] [--sponsor NAME] [--date YYYY-MM-DD]
      [--status draft|submitted] [--field KEY=VALUE ...]
  dataops sponsor-docs submit <doc-id>            Mark the document as submitted/ready
  dataops sponsor-docs reopen <doc-id>            Move a submitted document back to draft
  dataops sponsor-docs export <doc-id>            Print the read-only Markdown export
  dataops sponsor-docs email <doc-id>             Print the ready-to-send sponsor email draft
  dataops sponsor-docs rotate-code <doc-id>       Issue a new access code (invalidates old code)
  dataops sponsor-docs templates                  List available sponsor doc templates
  dataops sponsor-docs delete <doc-id> --yes      Delete the sponsor document

Examples
  dataops sponsor-docs create 542df0a6-...
  dataops sponsor-docs create 542df0a6-... --template newsletter-secondary --sponsor "Acme AI" --email
  dataops sponsor-docs show 8b91c02e-...
  dataops sponsor-docs export 8b91c02e-...
`;

function normalizeDocUrls(doc, baseUrl) {
  if (!doc || !baseUrl) return doc;
  const next = { ...doc };
  if (next.docUrl) {
    next.docUrl = rewriteVerificationUri(next.docUrl, baseUrl);
  }
  if (next.shareUrl) {
    const rawShare = next.shareUrl;
    const rewrittenShare = rewriteVerificationUri(rawShare, baseUrl);
    next.shareUrl = rewrittenShare;
    if (next.emailDraft && typeof next.emailDraft.body === "string" && rawShare !== rewrittenShare) {
      next.emailDraft = {
        ...next.emailDraft,
        body: next.emailDraft.body.split(rawShare).join(rewrittenShare),
      };
    }
  }
  return next;
}

function parseFieldFlags(rawFieldFlag) {
  if (rawFieldFlag === undefined) return undefined;
  const entries = Array.isArray(rawFieldFlag) ? rawFieldFlag : [rawFieldFlag];
  const content = {};
  for (const raw of entries) {
    const text = String(raw);
    const eq = text.indexOf("=");
    if (eq < 1) {
      throw new UsageError(`--field takes KEY=VALUE, got "${text}".`);
    }
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1);
    content[key] = value;
  }
  return content;
}

export async function create(args, io) {
  const cardId = positional(
    args,
    0,
    "dataops sponsor-docs create <card-id> [--template newsletter-main|newsletter-secondary|newsletter-standalone|podcast]",
  );
  const api = apiFor(args);
  const body = { cardId };

  const template = optionalString(args, "template");
  if (template !== undefined) {
    if (!TEMPLATES.includes(template)) {
      throw new UsageError(`--template must be one of: ${TEMPLATES.join(", ")}.`);
    }
    body.template = template;
  }

  const slot = optionalString(args, "slot");
  if (slot !== undefined) {
    if (!["primary", "secondary", "main", "standalone"].includes(slot)) {
      throw new UsageError("--slot must be primary, secondary, or standalone.");
    }
    body.slot = slot;
  }

  const title = optionalString(args, "title");
  if (title !== undefined) body.title = title;

  const sponsorName = optionalString(args, "sponsor");
  if (sponsorName !== undefined) body.sponsorName = sponsorName;

  const date = isoDate(optionalString(args, "date"), "date");
  if (date !== undefined) body.publicationDate = date;

  const linkType = optionalString(args, "linkType");
  if (linkType !== undefined) body.linkType = linkType;

  const content = parseFieldFlags(args.field);
  if (content !== undefined) body.content = content;

  const result = await api.post("/api/sponsor-docs", body);
  if (result?.doc) {
    result.doc = normalizeDocUrls(result.doc, api.base);
  }
  if (args.json) return result;

  const doc = result.doc;
  const card = result.card;
  io.print(`Created sponsor doc ${doc.id} (${doc.template}) for Card "${card?.title || cardId}".`);
  io.print(`Card link (${doc.linkType}): ${doc.docUrl}`);
  io.print(`Shareable link (with code): ${doc.shareUrl}`);
  io.print(`Access code: ${doc.accessCode}`);
  if (args.email && doc.emailDraft) {
    io.print("");
    io.print(`Subject: ${doc.emailDraft.subject}`);
    io.print("");
    io.print(doc.emailDraft.body);
  }
  return result;
}

export async function list(args, io) {
  const api = apiFor(args);
  const cardId = optionalString(args, "card");
  const query = cardId ? { cardId } : {};
  const result = await api.get("/api/sponsor-docs", { query });
  const docs = (result.docs || []).map((d) => normalizeDocUrls(d, api.base));
  const payload = { ...result, docs };
  if (args.json) return payload;

  table(
    io,
    docs,
    [
      ["ID", (doc) => doc.id],
      ["STATUS", (doc) => doc.status],
      ["TEMPLATE", (doc) => doc.template],
      ["DATE", (doc) => doc.publicationDate || ""],
      ["SPONSOR", (doc) => doc.sponsorName || ""],
      ["LAST EDITED", (doc) => (doc.lastEditedAt ? `${doc.lastEditedAt.slice(0, 16).replace("T", " ")} (${doc.lastEditedBy || "staff"})` : "never")],
      ["TITLE", (doc) => doc.title],
    ],
    "No sponsor documents found.",
  );
  return payload;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs show <doc-id>");
  const api = apiFor(args);
  const result = await api.get(`/api/sponsor-docs/${enc(id)}`);
  const doc = normalizeDocUrls(result.doc, api.base);
  const payload = { ...result, doc };
  if (args.json) return payload;

  fields(io, [
    ["id", doc.id],
    ["card", doc.cardId],
    ["title", doc.title],
    ["template", `${doc.template} (${doc.templateDefinition?.label || ""})`],
    ["status", doc.status === "submitted" ? "submitted (ready)" : "draft"],
    ["sponsor", doc.sponsorName],
    ["publication date", doc.publicationDate],
    ["card link slot", doc.linkType],
    ["canonical url", doc.docUrl],
    ["shareable url", doc.shareUrl],
    ["access code", doc.accessCode],
    ["last edited at", doc.lastEditedAt || "never"],
    ["last edited by", doc.lastEditedBy ? `${doc.lastEditedBy}${doc.lastEditedByName ? ` (${doc.lastEditedByName})` : ""}` : "never"],
    ["submitted at", doc.submittedAt],
    ["version", doc.version],
  ]);
  io.print("");
  for (const field of doc.templateDefinition?.fields || []) {
    const val = doc.content?.[field.key] || "";
    io.print(`${field.label} (${field.key}): ${val ? val : "(empty)"}`);
  }
  return payload;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs update <doc-id> [--status draft|submitted] [--field KEY=VALUE ...]");
  const api = apiFor(args);
  const body = {};

  const title = optionalString(args, "title");
  if (title !== undefined) body.title = title;

  const sponsor = optionalString(args, "sponsor");
  if (sponsor !== undefined) body.sponsorName = sponsor === "none" ? null : sponsor;

  const date = optionalString(args, "date");
  if (date !== undefined) {
    body.publicationDate = date === "none" ? null : isoDate(date, "date");
  }

  const status = optionalString(args, "status");
  if (status !== undefined) {
    if (!["draft", "submitted"].includes(status)) {
      throw new UsageError("--status must be draft or submitted.");
    }
    body.status = status;
  }

  const content = parseFieldFlags(args.field);
  if (content !== undefined) body.content = content;

  if (!Object.keys(body).length) {
    throw new UsageError("Nothing to change. Pass --status, --field KEY=VALUE, --title, --sponsor, or --date.");
  }

  const result = await api.put(`/api/sponsor-docs/${enc(id)}`, body);
  const doc = normalizeDocUrls(result.doc, api.base);
  const payload = { ...result, doc };
  if (args.json) return payload;

  io.print(`Updated sponsor doc ${doc.id} [${doc.status}] (version ${doc.version}).`);
  return payload;
}

export async function submit(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs submit <doc-id>");
  return update({ ...args, _: [id], status: "submitted" }, io);
}

export async function reopen(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs reopen <doc-id>");
  return update({ ...args, _: [id], status: "draft" }, io);
}

export async function exportMarkdown(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs export <doc-id>");
  const api = apiFor(args);
  const result = await api.get(`/api/sponsor-docs/${enc(id)}/export`);
  if (args.json) return result;
  io.print(result.markdown || "");
  return result;
}

export async function email(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs email <doc-id>");
  const api = apiFor(args);
  const result = await api.get(`/api/sponsor-docs/${enc(id)}`);
  const doc = normalizeDocUrls(result.doc, api.base);
  if (args.json) return { id: doc.id, shareUrl: doc.shareUrl, accessCode: doc.accessCode, emailDraft: doc.emailDraft };
  if (!doc.emailDraft) {
    io.print(`Shareable link: ${doc.docUrl}`);
    return result;
  }
  io.print(`Subject: ${doc.emailDraft.subject}`);
  io.print("");
  io.print(doc.emailDraft.body);
  return { id: doc.id, shareUrl: doc.shareUrl, accessCode: doc.accessCode, emailDraft: doc.emailDraft };
}

export async function rotateCode(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs rotate-code <doc-id>");
  const api = apiFor(args);
  const result = await api.post(`/api/sponsor-docs/${enc(id)}/rotate-code`, {});
  const doc = normalizeDocUrls(result.doc, api.base);
  const payload = { ...result, doc };
  if (args.json) return payload;
  io.print(`Rotated access code for ${doc.id}.`);
  io.print(`Shareable link (with code): ${doc.shareUrl}`);
  io.print(`Access code: ${doc.accessCode}`);
  return payload;
}

export async function templates(args, io) {
  const api = apiFor(args);
  const result = await api.get("/api/sponsor-docs/templates");
  if (args.json) return result;
  table(
    io,
    result.templates || [],
    [
      ["TEMPLATE", (t) => t.key],
      ["LINK SLOT", (t) => t.defaultLinkType],
      ["FIELDS", (t) => (t.fields || []).map((f) => f.key).join(", ")],
      ["LABEL", (t) => t.label],
    ],
    "No templates.",
  );
  return result;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops sponsor-docs delete <doc-id> --yes");
  if (!args.yes) {
    throw new UsageError(`Re-run with --yes to confirm deletion: dataops sponsor-docs delete ${id} --yes`);
  }
  const api = apiFor(args);
  const result = await api.delete(`/api/sponsor-docs/${enc(id)}`);
  if (args.json) return result;
  io.print(`Deleted sponsor doc ${id} (${result.deleted?.title || ""}).`);
  return result;
}

export const commands = {
  create,
  list,
  show,
  update,
  submit,
  reopen,
  export: exportMarkdown,
  email,
  "rotate-code": rotateCode,
  templates,
  delete: remove,
};
