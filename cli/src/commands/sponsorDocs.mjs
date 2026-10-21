import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { rewriteVerificationUri } from "./auth.mjs";

export const summary = "Deprecated alias for `dataops newsletter doc` and `dataops podcast doc`";

export const TEMPLATES = [
  "newsletter-main",
  "newsletter-secondary",
  "newsletter-standalone",
  "podcast",
  "podcast-guest-research",
  "podcast-run-sheet",
  "podcast-episode-brief",
];

export const PODCAST_TEMPLATES = [
  "podcast",
  "podcast-guest-research",
  "podcast-run-sheet",
  "podcast-episode-brief",
];

export const newsletterDocHelp = `dataops newsletter doc - portal-hosted newsletter sponsor content documents

Usage
  dataops newsletter doc create <issue-id|card-id> [--slot primary|secondary] [--standalone]
      [--title T] [--sponsor NAME] [--date YYYY-MM-DD] [--link-type NAME] [--email]
  dataops newsletter doc show <doc-id>
  dataops newsletter doc export <doc-id>
  dataops newsletter doc delete <doc-id> --yes
  dataops newsletter doc list [--card <card-id>]
  dataops newsletter doc update <doc-id> [--status draft|submitted] [--field KEY=VALUE ...]
  dataops newsletter doc submit <doc-id>
  dataops newsletter doc reopen <doc-id>
  dataops newsletter doc email <doc-id>
  dataops newsletter doc rotate-code <doc-id>
`;

export const podcastDocHelp = `dataops podcast doc - portal-hosted podcast documents (guest materials + prep docs)

Usage
  dataops podcast doc create <card-id> [--template podcast|podcast-guest-research|podcast-run-sheet|podcast-episode-brief]
      [--title T] [--sponsor NAME] [--date YYYY-MM-DD] [--link-type NAME] [--email]
  dataops podcast doc show <doc-id>
  dataops podcast doc export <doc-id>
  dataops podcast doc delete <doc-id> --yes
  dataops podcast doc list [--card <card-id>]
  dataops podcast doc update <doc-id> [--status draft|submitted] [--field KEY=VALUE ...]
  dataops podcast doc submit <doc-id>
  dataops podcast doc reopen <doc-id>
  dataops podcast doc email <doc-id>
  dataops podcast doc rotate-code <doc-id>
  dataops podcast doc templates

Prep templates (default: podcast):
  podcast                  guest-facing materials from the guest (default)
  podcast-guest-research   internal source-backed guest research (staff-only)
  podcast-run-sheet        internal one-page host run sheet (staff-only)
  podcast-episode-brief    episode planning brief (replaces Google Doc brief)
`;

export const help = `Deprecated: \`dataops sponsor-docs\` has moved under the domain commands:

  dataops newsletter doc create <issue-id|card-id> [--slot primary|secondary] [--standalone] [--email]
  dataops newsletter doc show <doc-id>
  dataops newsletter doc export <doc-id>
  dataops newsletter doc delete <doc-id> --yes

  dataops podcast doc create <card-id> [--sponsor NAME] [--date YYYY-MM-DD] [--email]
  dataops podcast doc show <doc-id>
  dataops podcast doc export <doc-id>
  dataops podcast doc delete <doc-id> --yes
`;

export function extractDocId(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/\/sponsor-docs\/([^/?#]+)/);
  if (match) return decodeURIComponent(match[1]);
  return text;
}

function commandPrefix(args) {
  return args?._commandPrefix || "dataops newsletter doc";
}

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
  const domain = args._domain;
  const prefix = commandPrefix(args);
  const createUsage =
    domain === "podcast"
      ? `${prefix} create <card-id> [--template ${PODCAST_TEMPLATES.join("|")}] [--sponsor NAME] [--date YYYY-MM-DD] [--email]`
      : `${prefix} create <issue-id|card-id> [--slot primary|secondary] [--standalone] [--email]`;

  // Defensive recovery if a boolean flag (--standalone or --email) was placed immediately before the positional ID
  const positionals = [...(args._ || [])];
  let standalone = false;
  if (args.standalone !== undefined) {
    if (args.standalone === true || args.standalone === "true") {
      standalone = true;
    } else if (args.standalone === false || args.standalone === "false") {
      standalone = false;
    } else if (typeof args.standalone === "string") {
      standalone = true;
      positionals.unshift(args.standalone);
    }
  }
  let wantsEmail = false;
  if (args.email !== undefined) {
    if (args.email === true || args.email === "true") {
      wantsEmail = true;
    } else if (args.email === false || args.email === "false") {
      wantsEmail = false;
    } else if (typeof args.email === "string") {
      wantsEmail = true;
      positionals.unshift(args.email);
    }
  }

  const targetId = positional({ _: positionals }, 0, createUsage);
  const api = apiFor(args);
  const body = { cardId: targetId };

  const template = optionalString(args, "template");
  const slot = optionalString(args, "slot");

  if (domain === "podcast") {
    if (slot !== undefined || standalone) {
      throw new UsageError(`--slot and --standalone apply to \`dataops newsletter doc create\`, not \`${prefix} create\`.`);
    }
    if (template !== undefined && !PODCAST_TEMPLATES.includes(template)) {
      throw new UsageError(`--template must be one of: ${PODCAST_TEMPLATES.join(", ")}.`);
    }
    body.template = template || "podcast";
  } else {
    if (slot !== undefined) {
      if (!["primary", "secondary", "main", "standalone"].includes(slot)) {
        throw new UsageError("--slot must be primary or secondary.");
      }
      body.slot = slot;
    }
    if (standalone) {
      if (slot === "secondary") {
        throw new UsageError("--standalone cannot be combined with --slot secondary.");
      }
      body.standalone = true;
      body.template = "newsletter-standalone";
    } else if (template !== undefined) {
      if (!TEMPLATES.includes(template)) {
        throw new UsageError(`--template must be one of: ${TEMPLATES.join(", ")}.`);
      }
      body.template = template;
    } else if (slot === "secondary") {
      body.template = "newsletter-secondary";
    } else if (slot === "standalone") {
      body.template = "newsletter-standalone";
    }
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
  const targetLabel = card?.title
    ? `Card "${card.title}"`
    : result.issue?.publicationDate
      ? `issue ${result.issue.publicationDate} (${targetId})`
      : targetId;
  io.print(`Created sponsor doc ${doc.id} (${doc.template}) for ${targetLabel}.`);
  io.print(`Card link (${doc.linkType}): ${doc.docUrl}`);
  io.print(`Shareable link (with code): ${doc.shareUrl}`);
  io.print(`Access code: ${doc.accessCode}`);
  if (wantsEmail && doc.emailDraft) {
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
  let docs = (result.docs || []).map((d) => normalizeDocUrls(d, api.base));
  if (args._domain === "podcast") {
    docs = docs.filter((d) => d.template === "podcast" || String(d.template || "").startsWith("podcast-"));
  } else if (args._domain === "newsletter") {
    docs = docs.filter((d) => d.template !== "podcast" && !String(d.template || "").startsWith("podcast-"));
  }
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
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} show <doc-id>`));
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
  const showFields = (doc.templateDefinition?.sections || [])
    .flatMap((s) => s.fields || [])
    .concat(doc.templateDefinition?.fields || []);
  for (const field of showFields) {
    const val = doc.content?.[field.key] || "";
    io.print(`${field.label} (${field.key}): ${val ? val : "(empty)"}`);
  }
  return payload;
}

export async function update(args, io) {
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} update <doc-id> [--status draft|submitted] [--field KEY=VALUE ...]`));
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
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} submit <doc-id>`));
  return update({ ...args, _: [id], status: "submitted" }, io);
}

export async function reopen(args, io) {
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} reopen <doc-id>`));
  return update({ ...args, _: [id], status: "draft" }, io);
}

export async function exportMarkdown(args, io) {
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} export <doc-id>`));
  const api = apiFor(args);
  const result = await api.get(`/api/sponsor-docs/${enc(id)}/export`);
  if (args.json) return result;
  io.print(result.markdown || "");
  return result;
}

export async function email(args, io) {
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} email <doc-id>`));
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
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} rotate-code <doc-id>`));
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
      [
        "FIELDS",
        (t) =>
          (t.sections || [])
            .flatMap((s) => s.fields || [])
            .concat(t.fields || [])
            .map((f) => f.key)
            .join(", "),
      ],
      ["LABEL", (t) => t.label],
    ],
    "No templates.",
  );
  return result;
}

export async function remove(args, io) {
  const prefix = commandPrefix(args);
  const id = extractDocId(positional(args, 0, `${prefix} delete <doc-id> --yes`));
  if (!args.yes) {
    throw new UsageError(`Re-run with --yes to confirm deletion: ${prefix} delete ${id} --yes`);
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

/**
 * Handler for `dataops newsletter doc <action> ...` and `dataops podcast doc <action> ...`.
 */
export function domainDocCommand(domain) {
  const prefix = `dataops ${domain} doc`;
  return async function docHandler(args, io) {
    const [action, ...rest] = args._ || [];
    if (!action || action === "help") {
      if (!action) {
        const usageLine =
          domain === "podcast"
            ? `${prefix} <create|show|export|delete|list|update|submit|reopen|email|rotate-code> ...`
            : `${prefix} <create|show|export|delete|list|update|submit|reopen|email|rotate-code> ...`;
        throw new UsageError(`Missing doc action. Usage: ${usageLine}`);
      }
      io.print(domain === "podcast" ? podcastDocHelp : newsletterDocHelp);
      return undefined;
    }
    const fn = commands[action];
    if (!fn) {
      throw new UsageError(
        `Unknown subcommand: ${prefix} ${action}. One of: ${Object.keys(commands).join(", ")}.`,
      );
    }
    return fn(
      {
        ...args,
        _: rest,
        _domain: domain,
        _commandPrefix: prefix,
      },
      io,
    );
  };
}
