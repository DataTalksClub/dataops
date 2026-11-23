// `dataops newsletter relay-sync`: fill a Relay newsletter issue's sponsor
// block from the slot's DataOps sponsor document.
//
// Relay sits behind CloudFront, whose WAF rejects request bodies over ~8 KB
// with a bare 403. So this never sends the issue as one body: it reads the
// Relay issue, then writes exactly one block (PUT the existing sponsor block,
// or POST it when the issue has none), and refuses a block body that would
// not fit under the limit.

import { ApiError, createClient } from "../api.mjs";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { extractDocId } from "./sponsorDocs.mjs";
import { multipart } from "./tasks.mjs";

export const DEFAULT_RELAY_URL = "https://relay.datatalks.club";
export const DEFAULT_RELAY_SECRET = "relay-production.dtc-newsletter-api-key";
/** Per-request body cap, well under CloudFront's ~8 KB WAF body limit. */
export const MAX_BLOCK_BODY_BYTES = 7000;

const BLOCK_TYPE = { primary: "sponsor", secondary: "sponsor_secondary" };
// A campaign in any other state has been (or is being) sent; never edit it.
const EDITABLE_CAMPAIGN_STATUSES = new Set(["draft"]);

export const relaySyncHelp = `dataops newsletter relay-sync - fill the Relay sponsor block from the sponsor document

Usage
  dataops newsletter relay-sync <issue-id|issue-number> [--slot primary|secondary]
      [--relay-key <relay-issue-key>] [--doc <doc-id|url>] [--block-id <id>]
      [--relay-url <url>] [--dry-run] [--json]

Reads the slot's sponsor document (the issue's primary/secondary document
link, or --doc) and writes it into the Relay issue's sponsor block:

  sponsor doc            Relay block field
  title               -> title
  (fixed)             -> kicker "SPONSORED"
  intro               -> body
  bullets             -> bullets (one per line, markers stripped)
  closing             -> closing
  graphicsUrl         -> image_url (an uploaded data: image is first hosted
                         via the issue's public images); image_link = CTA URL
  ctaText / ctaUrl    -> cta_text / cta_url

The primary slot fills the "sponsor" block, the secondary slot the
"sponsor_secondary" block. The Relay issue key defaults to the issue's
Final render relay key (dataops newsletter final-render --relay-key).

Idempotent: an existing sponsor block (including the template placeholder)
is updated in place; a block is only added when the issue has none, and a
block already matching the document is left alone. Each write is one block,
kept under ${MAX_BLOCK_BODY_BYTES} bytes because Relay's CloudFront WAF rejects
bodies over ~8 KB. Refuses to edit an issue whose campaign is past draft.

Relay credentials: RELAY_API_KEY (and RELAY_URL) from the environment, else
the DataOps secret ${DEFAULT_RELAY_SECRET} (admin). The key is never printed.
--dry-run reads both sides and prints the planned block without writing.
`;

/** One bullet per line, list markers ("-", "*", "•", "→", "1.") stripped. */
export function normalizeBullets(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•→▸▪◦]|\d+[.)])\s*/u, "").trim())
    .filter(Boolean)
    .join("\n");
}

const text = (value) => String(value || "").trim();

/** Relay block data for a sponsor doc's content; empty fields are omitted (Relay drops them). */
export function sponsorBlockData(doc) {
  const content = doc?.content || {};
  const standalone = doc?.template === "newsletter-standalone";
  const body = standalone
    ? [text(content.intro), text(content.mainBodyOpening)].filter(Boolean).join("\n\n")
    : text(content.intro);
  const ctaText = standalone ? text(content.closingCtaText) || text(content.earlyCtaText) : text(content.ctaText);
  const ctaUrl = standalone ? text(content.closingCtaUrl) || text(content.earlyCtaUrl) : text(content.ctaUrl);
  const imageUrl = text(content.graphicsUrl);
  const data = {
    kicker: "SPONSORED",
    title: text(content.title),
    image_url: imageUrl,
    image_link: imageUrl ? ctaUrl : "",
    body,
    bullets: normalizeBullets(content.bullets),
    closing: text(content.closing),
    cta_text: ctaText,
    cta_url: ctaUrl,
  };
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value));
}

function sameData(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) if ((a?.[key] || "") !== (b?.[key] || "")) return false;
  return true;
}

/** Which block to write: the slot's existing block, or where to add one. */
export function planBlock(blocks, slot, blockId) {
  const type = BLOCK_TYPE[slot];
  const ordered = [...(blocks || [])].sort((a, b) => a.position - b.position);
  if (blockId !== undefined) {
    const chosen = ordered.find((block) => String(block.id) === String(blockId));
    if (!chosen) throw new UsageError(`Relay issue has no block ${blockId}.`);
    return { existing: chosen, type };
  }
  const matches = ordered.filter((block) => block.type === type);
  if (matches.length > 1) {
    const ids = matches.map((block) => `${block.id} (position ${block.position})`).join(", ");
    throw new UsageError(`Relay issue has ${matches.length} "${type}" blocks: ${ids}. Pick one with --block-id.`);
  }
  if (matches.length === 1) return { existing: matches[0], type };
  // No block yet: the primary goes right after the intro, the secondary after the primary.
  const anchor = slot === "primary"
    ? ordered.find((block) => block.type === "intro")
    : ordered.find((block) => block.type === "sponsor");
  return { existing: null, type, position: anchor ? anchor.position + 1 : slot === "primary" ? 0 : undefined };
}

function relayError(error) {
  if (!(error instanceof ApiError)) return error;
  const detail = error.body && typeof error.body === "object" ? JSON.stringify(error.body.error ?? error.body) : String(error.body || "");
  const hint = error.status === 403 && !detail.startsWith("{")
    ? " (a bare 403 from CloudFront usually means the WAF body-size limit)"
    : "";
  return new UsageError(`Relay ${error.status}: ${detail.slice(0, 500)}${hint}`);
}

async function relayCall(fn) {
  try {
    return await fn();
  } catch (error) {
    throw relayError(error);
  }
}

async function relayCredentials(args, api) {
  const url = optionalString(args, "relayUrl") || process.env.RELAY_URL || DEFAULT_RELAY_URL;
  let key = process.env.RELAY_API_KEY || "";
  let source = "RELAY_API_KEY";
  if (!key) {
    const name = optionalString(args, "relaySecret") || DEFAULT_RELAY_SECRET;
    let secret;
    try {
      secret = await api.get(`/api/secrets/${enc(name)}`);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new UsageError(
          `No Relay key: set RELAY_API_KEY, or have admin access to the DataOps secret ${name} (${error.status}).`,
        );
      }
      throw error;
    }
    key = secret?.secret?.fields?.value || "";
    source = `dataops secret ${name}`;
    if (!key) throw new UsageError(`DataOps secret ${name} has no "value" field.`);
  }
  return { url: url.replace(/\/+$/, ""), key, source };
}

async function findIssue(api, ref) {
  if (!/^\d{1,4}$/.test(ref)) return api.get(`/api/newsletter-issues/${enc(ref)}`);
  const from = new Date(Date.now() - 2 * 365 * 86400_000).toISOString().slice(0, 10);
  const listed = await api.get("/api/newsletter-issues", { query: { from, to: "2100-12-31", kind: "weekly" } });
  const matches = (listed.items || []).filter((issue) => String(issue.issueNumber) === ref);
  if (matches.length !== 1) {
    throw new UsageError(
      matches.length ? `Issue number ${ref} matches ${matches.length} issues; pass the issue id.` : `No weekly issue #${ref}.`,
    );
  }
  return api.get(`/api/newsletter-issues/${enc(matches[0].id)}`);
}

/** Host an uploaded `data:image/...` visual and return its public https URL. */
async function hostDataImage(api, issueId, dataUrl) {
  const match = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/is.exec(dataUrl);
  if (!match) throw new UsageError("The sponsor document's graphics is an unsupported data: URL; upload a PNG, JPEG, GIF or WebP.");
  const ext = match[2].toLowerCase() === "jpeg" ? "jpg" : match[2].toLowerCase();
  const bytes = Buffer.from(match[3], "base64");
  const { body, contentType } = multipart({}, { name: `sponsor-visual.${ext}`, bytes });
  const result = await api.post(`/api/newsletter-issues/${enc(issueId)}/images`, undefined, { rawBody: body, contentType });
  if (!result?.image?.url) throw new UsageError("Image upload did not return a public URL.");
  return result.image.url;
}

export async function relaySync(args, io) {
  const usage = "dataops newsletter relay-sync <issue-id|issue-number> [--slot primary|secondary] [--relay-key <key>] [--dry-run]";
  const ref = String(positional(args, 0, usage));
  const slot = optionalString(args, "slot") || "primary";
  if (!BLOCK_TYPE[slot]) throw new UsageError("--slot must be primary or secondary.");
  const dryRun = Boolean(args.dryRun);
  const api = apiFor(args);

  const issue = await findIssue(api, ref);
  const relayKey = optionalString(args, "relayKey") || issue.finalRender?.relayIssueKey;
  if (!relayKey) {
    throw new UsageError(
      `Issue ${issue.label || issue.id} has no Relay issue key. Pass --relay-key, or record it with ` +
        "`dataops newsletter final-render <issue-id> --relay-key <key>`.",
    );
  }
  const docRef = optionalString(args, "doc") || issue.slots?.[slot]?.documentUrl;
  if (!docRef) throw new UsageError(`The ${slot} slot of ${issue.label || issue.id} has no sponsor document. Pass --doc.`);
  const docId = extractDocId(docRef);
  const { doc } = await api.get(`/api/sponsor-docs/${enc(docId)}`);
  if (!String(doc?.template || "").startsWith("newsletter-")) {
    throw new UsageError(`Document ${docId} is a ${doc?.template || "unknown"} document, not a newsletter sponsor document.`);
  }

  const credentials = await relayCredentials(args, api);
  const relay = createClient({ url: credentials.url, token: credentials.key });
  const issuePath = `/api/newsletter-issues/${enc(relayKey)}`;
  const relayIssue = (await relayCall(() => relay.get(issuePath))).issue;
  const campaignStatus = relayIssue.campaign?.status;
  if (campaignStatus && !EDITABLE_CAMPAIGN_STATUSES.has(campaignStatus)) {
    throw new UsageError(`Relay issue ${relayKey} has a ${campaignStatus} campaign; its blocks are no longer edited.`);
  }

  let data = sponsorBlockData(doc);
  const plan = planBlock(relayIssue.blocks, slot, optionalString(args, "blockId"));
  if (plan.existing?.data?.meta) data = { ...data, meta: plan.existing.data.meta };

  let imageNote = "";
  if (/^data:/i.test(data.image_url || "")) {
    if (dryRun) {
      imageNote = "uploaded data: image (would be hosted on write)";
    } else {
      data.image_url = await hostDataImage(api, issue.id, data.image_url);
      imageNote = `hosted uploaded image at ${data.image_url}`;
    }
  }

  const request = plan.existing
    ? { method: "PUT", path: `${issuePath}/blocks/${plan.existing.id}`, body: { type: plan.type, data } }
    : { method: "POST", path: `${issuePath}/blocks`, body: { type: plan.type, data, ...(plan.position !== undefined ? { position: plan.position } : {}) } };
  const bytes = Buffer.byteLength(JSON.stringify(request.body), "utf8");
  if (bytes > MAX_BLOCK_BODY_BYTES && !dryRun) {
    throw new UsageError(
      `The ${plan.type} block body is ${bytes} bytes, over the ${MAX_BLOCK_BODY_BYTES}-byte per-request limit ` +
        "(Relay's CloudFront WAF rejects bodies over ~8 KB). Shorten the sponsor copy.",
    );
  }

  const unchanged = plan.existing && plan.existing.type === plan.type && !plan.existing.needs_review && sameData(plan.existing.data, data);
  let action;
  let block = plan.existing;
  if (unchanged) action = "unchanged";
  else if (dryRun) action = plan.existing ? "would update" : "would add";
  else {
    const result = await relayCall(() => relay.request(request.method, request.path, request.body));
    block = result.block;
    action = plan.existing ? "updated" : "added";
    if (!sameData(block?.data, data)) throw new UsageError(`Relay saved block ${block?.id} with different data than sent.`);
  }

  const summary = {
    issueId: issue.id,
    issueLabel: issue.label || "",
    slot,
    docId,
    docStatus: doc.status,
    sponsor: doc.sponsorName || "",
    relayUrl: credentials.url,
    relayKey,
    relayCredential: credentials.source,
    action,
    blockId: block?.id ?? null,
    blockType: plan.type,
    position: block?.position ?? plan.position ?? null,
    requestBytes: bytes,
    data,
    problems: block?.problems || [],
  };
  if (args.json) return summary;

  io.print(`issue: ${summary.issueLabel || issue.id} (${slot} slot)`);
  io.print(`sponsor doc: ${docId} (${doc.template}, ${doc.status === "submitted" ? "submitted" : "draft"})${summary.sponsor ? ` ${summary.sponsor}` : ""}`);
  if (doc.status !== "submitted") io.print("warning: the sponsor document is not submitted yet; its copy may still change.");
  io.print(`relay issue: ${relayKey} at ${credentials.url} (key from ${credentials.source})`);
  io.print(`block: ${action} ${block?.id ? `#${block.id} ` : ""}${plan.type}${summary.position !== null ? ` at position ${summary.position}` : ""}`);
  io.print(action === "unchanged"
    ? "request: none, the block already matches the sponsor document"
    : `request: ${dryRun ? "would " : ""}${request.method} one block, ${bytes} bytes (limit ${MAX_BLOCK_BODY_BYTES})`);
  if (imageNote) io.print(`image: ${imageNote}`);
  for (const [name, value] of Object.entries(data)) {
    const shown = value.length > 120 ? `${value.slice(0, 117)}...` : value;
    io.print(`  ${name}: ${shown.replace(/\n/g, " | ")}`);
  }
  const problemLabel = action.startsWith("would") ? "relay problem (current block)" : "relay problem";
  for (const problem of summary.problems) io.print(`${problemLabel}: ${typeof problem === "string" ? problem : JSON.stringify(problem)}`);
  if (bytes > MAX_BLOCK_BODY_BYTES) io.print(`warning: ${bytes} bytes is over the limit; a real run refuses this block.`);
  return summary;
}
