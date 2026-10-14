#!/usr/bin/env node

/**
 * One-off importer for the private newsletter catalog (the newsletters we
 * subscribe to, their past issues, and the sponsors seen in each issue).
 *
 * The catalog is private and lives outside this repository. Each newsletter
 * is matched to an existing record by slug, name, or site/sender domain and
 * is created when none matches; a match only gains fields it lacks. Every
 * issue is upserted through POST /api/sponsor-crm/newsletters/<id>/issues,
 * which stores its sponsors as leads. Leads that Dapier delivered before
 * issues were recorded get their issue too (matched to a newsletter by
 * sender, then name). Re-running is idempotent.
 *
 * Without --write nothing is written: the run reads the destination (when a
 * session token is set, or from --existing-scan, a DynamoDB scan export of
 * the sponsor CRM table) and prints what it would do.
 *
 * Usage:
 *   tsx scripts/import-sponsor-newsletters.ts --source newsletters.json \
 *     [--api-base-url URL] [--existing-scan scan.json] \
 *     [--confirm-origin URL] [--write]
 *
 * Writes require DATAOPS_OPERATOR_SESSION_TOKEN and an exact --confirm-origin.
 */

import { promises as fs } from "fs";
import path from "path";

const PRODUCTION_ORIGIN = "https://ops.dtcdev.click";
const NEWSLETTER_FIELDS = [
  "name", "slug", "url", "mailbox", "senders", "cadence",
  "expectedIntervalDays", "subscriptionStatus", "subscribedAt", "notes",
] as const;

type Sponsor = { name: string; url?: string | null; category?: string | null; blurb?: string | null };
type Issue = {
  issueKey: string;
  title: string;
  publishedAt: string;
  url?: string | null;
  source: string;
  sponsors: Sponsor[];
};
type CatalogNewsletter = Record<string, unknown> & {
  name: string;
  slug: string;
  url: string;
  senders?: string[];
  publisher?: string;
  issues?: Issue[];
};
type Existing = Record<string, unknown> & { id: string; name: string; slug: string; version: number };
type Arguments = {
  sourceFile?: string;
  existingScan?: string;
  origin: string;
  confirmOrigin?: string;
  write: boolean;
};

export class ImportFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ImportFailure";
  }
}

export function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { origin: PRODUCTION_ORIGIN, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--write") result.write = true;
    else if (["--source", "--existing-scan", "--api-base-url", "--confirm-origin"].includes(flag) && value) {
      if (flag === "--source") result.sourceFile = path.resolve(value);
      if (flag === "--existing-scan") result.existingScan = path.resolve(value);
      if (flag === "--api-base-url") result.origin = value.replace(/\/$/, "");
      if (flag === "--confirm-origin") result.confirmOrigin = value.replace(/\/$/, "");
      index += 1;
    } else throw new ImportFailure(`unknown-argument:${flag}`);
  }
  if (!result.sourceFile) throw new ImportFailure("source-required");
  return result;
}

function https(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && !/\s/.test(value.trim()) ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(value: unknown): string {
  const url = https(value);
  return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : "";
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Lead intake rejects control characters other than newline/tab in long text.
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

/** The newsletter fields the API accepts, with the publisher folded into the notes. */
export function newsletterBody(item: CatalogNewsletter): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const name of NEWSLETTER_FIELDS) if (item[name] !== undefined && item[name] !== null) body[name] = item[name];
  const publisher = typeof item.publisher === "string" ? item.publisher.trim() : "";
  const notes = typeof item.notes === "string" ? item.notes.trim() : "";
  if (publisher && !notes.includes(publisher)) body.notes = [`Publisher: ${publisher}.`, notes].filter(Boolean).join(" ");
  if (typeof body.notes === "string") body.notes = body.notes.slice(0, 2000);
  return body;
}

/** One issue as the issues endpoint accepts it: https links only, sponsors deduplicated. */
export function issueBody(issue: Issue): Record<string, unknown> {
  const seen = new Set<string>();
  const sponsors = [];
  for (const sponsor of issue.sponsors || []) {
    const name = clip(sponsor.name, 200);
    if (!name) continue;
    const url = https(sponsor.url) || "";
    const key = `${name.toLowerCase().replace(/\s+/g, " ")}\n${hostOf(url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sponsors.push({
      name,
      ...(url ? { url } : {}),
      ...(clip(sponsor.category, 40) ? { category: clip(sponsor.category, 40) } : {}),
      ...(clip(sponsor.blurb, 2000) ? { blurb: clip(sponsor.blurb, 2000) } : {}),
    });
  }
  return {
    issueKey: issue.issueKey.trim(),
    title: clip(issue.title, 500) || issue.issueKey.trim().slice(0, 500),
    publishedAt: issue.publishedAt,
    ...(https(issue.url) ? { url: https(issue.url) } : {}),
    source: issue.source,
    sponsors: sponsors.slice(0, 20),
  };
}

/** Match by slug, then exact name, then site or sender domain (unique matches only). */
export function matchExisting(item: CatalogNewsletter, existing: Existing[]): Existing | null {
  const bySlug = existing.find((row) => row.slug === item.slug);
  if (bySlug) return bySlug;
  const name = item.name.trim().toLowerCase();
  const byName = existing.filter((row) => String(row.name || "").trim().toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  const host = hostOf(item.url);
  const senders = new Set((item.senders || []).map((sender) => sender.toLowerCase()));
  const byDomain = existing.filter((row) =>
    (host && hostOf(row.url) === host)
    || (Array.isArray(row.senders) && row.senders.some((sender) => senders.has(String(sender).toLowerCase()))));
  return byDomain.length === 1 ? byDomain[0] : null;
}

/** Fields the catalog knows that the existing record lacks; never overwrites. */
export function missingFields(body: Record<string, unknown>, existing: Existing): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) {
    if (name === "slug" || name === "name" || name === "subscriptionStatus") continue;
    const current = existing[name];
    const empty = current === undefined || current === null || current === ""
      || (Array.isArray(current) && current.length === 0);
    if (empty) patch[name] = value;
  }
  return patch;
}

function unmarshall(value: Record<string, unknown>): unknown {
  const [type, inner] = Object.entries(value)[0] || [];
  if (type === "S" || type === "BOOL") return inner;
  if (type === "N") return Number(inner);
  if (type === "NULL") return null;
  if (type === "L") return (inner as Array<Record<string, unknown>>).map(unmarshall);
  if (type === "SS") return inner;
  if (type === "M") {
    return Object.fromEntries(Object.entries(inner as Record<string, Record<string, unknown>>)
      .map(([name, entry]) => [name, unmarshall(entry)]));
  }
  return inner;
}

/** Records of one kind from `aws dynamodb scan --output json` of the sponsor CRM table. */
export function recordsFromScan(scan: { Items?: Array<Record<string, Record<string, unknown>>> }, prefix: string) {
  return (scan.Items || [])
    .map((item) => Object.fromEntries(Object.entries(item).map(([name, value]) => [name, unmarshall(value)])))
    .filter((item) => String(item.PK || "").startsWith(prefix));
}

type Lead = Record<string, unknown> & { messageId?: string; sourceType?: string; newsletter?: Record<string, unknown> };

/** One inbox issue per message that delivered Dapier leads, for the newsletter it names. */
export function leadIssues(leads: Lead[], catalog: CatalogNewsletter[]) {
  const issues = new Map<string, { slug: string; body: Record<string, unknown> }>();
  const unmatched = new Set<string>();
  for (const lead of leads) {
    if (lead.sourceType !== "leads-intake" || !lead.messageId || issues.has(lead.messageId)) continue;
    const newsletter = lead.newsletter || {};
    const sender = String(newsletter.sender || "").toLowerCase();
    const slugName = String(newsletter.name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const bySender = catalog.filter((item) => (item.senders || []).map((value) => value.toLowerCase()).includes(sender));
    const match = bySender.length === 1 ? bySender[0] : catalog.find((item) => item.slug === slugName);
    if (!match) {
      unmatched.add(String(newsletter.name || lead.messageId));
      continue;
    }
    issues.set(lead.messageId, {
      slug: match.slug,
      body: {
        issueKey: lead.messageId,
        title: clip(newsletter.subject, 500) || lead.messageId,
        publishedAt: String(newsletter.receivedAt),
        source: "inbox",
        ...(sender ? { sender } : {}),
        // Its sponsors are the delivered leads, already keyed by this message.
        sponsors: [],
      },
    });
  }
  return { issues: [...issues.values()], unmatched: [...unmatched] };
}

async function api(origin: string, token: string | undefined, method: string, route: string, body?: unknown) {
  const response = await fetch(`${origin}/api/sponsor-crm${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new ImportFailure(`api-${method}-${route.split("/")[1]}-${response.status}:${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export function plan(catalog: CatalogNewsletter[], existing: Existing[], leads: Lead[] = []) {
  const delivered = leadIssues(leads, catalog);
  const rows = catalog.map((item) => {
    const match = matchExisting(item, existing);
    const body = newsletterBody(item);
    const archived = new Set((item.issues || []).map((issue) => issue.issueKey));
    const issues = [
      ...(item.issues || []).map(issueBody),
      ...delivered.issues.filter((entry) => entry.slug === item.slug && !archived.has(String(entry.body.issueKey))).map((entry) => entry.body),
    ];
    return {
      item,
      body,
      match,
      patch: match ? missingFields(body, match) : null,
      issues,
      sightings: issues.reduce((sum, issue) => sum + (issue.sponsors as unknown[]).length, 0),
    };
  });
  const sponsors = new Map<string, number>();
  for (const row of rows) {
    for (const issue of row.issues) {
      for (const sponsor of issue.sponsors as Sponsor[]) sponsors.set(sponsor.name, (sponsors.get(sponsor.name) || 0) + 1);
    }
  }
  return {
    rows,
    summary: {
      newsletters: rows.length,
      create: rows.filter((row) => !row.match).length,
      update: rows.filter((row) => row.match && Object.keys(row.patch || {}).length).length,
      unchanged: rows.filter((row) => row.match && !Object.keys(row.patch || {}).length).length,
      issues: rows.reduce((sum, row) => sum + row.issues.length, 0),
      issuesFromDeliveredLeads: delivered.issues.length,
      deliveredLeadsWithoutNewsletter: delivered.unmatched,
      issuesWithSponsors: rows.reduce((sum, row) => sum + row.issues.filter((issue) => (issue.sponsors as unknown[]).length).length, 0),
      sponsorSightings: rows.reduce((sum, row) => sum + row.sightings, 0),
      distinctSponsors: sponsors.size,
      topSponsors: [...sponsors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15),
      perNewsletter: rows
        .map((row) => ({
          name: row.item.name,
          action: row.match ? (Object.keys(row.patch || {}).length ? "update" : "unchanged") : "create",
          status: row.item.subscriptionStatus,
          issues: row.issues.length,
          sightings: row.sightings,
        }))
        .sort((a, b) => b.issues - a.issues),
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const source = JSON.parse(await fs.readFile(args.sourceFile!, "utf8"));
  const catalog = (source.subscriptions || source.newsletters) as CatalogNewsletter[];
  if (!Array.isArray(catalog) || !catalog.length) throw new ImportFailure("source-has-no-newsletters");
  const token = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;

  let existing: Existing[] = [];
  let leads: Lead[] = [];
  let existingFrom = "none (destination not read)";
  if (args.existingScan) {
    const scan = JSON.parse(await fs.readFile(args.existingScan, "utf8"));
    existing = recordsFromScan(scan, "NEWSLETTER#") as Existing[];
    leads = recordsFromScan(scan, "LEAD#") as Lead[];
    existingFrom = `scan ${path.basename(args.existingScan)}`;
  } else if (token || args.write) {
    existing = (await api(args.origin, token, "GET", "/newsletters?limit=100")).items;
    for (let cursor: string | null = "0"; cursor !== null;) {
      const result = await api(args.origin, token, "GET", `/leads?limit=100&cursor=${cursor}`);
      leads.push(...result.items);
      cursor = result.nextCursor;
    }
    existingFrom = args.origin;
  }
  const { rows, summary } = plan(catalog, existing, leads);
  console.log(JSON.stringify({ mode: args.write ? "write" : "dry-run", origin: args.origin, existingFrom, existing: existing.length, leads: leads.length, ...summary }, null, 2));
  if (!args.write) return summary;

  if (args.confirmOrigin !== args.origin) throw new ImportFailure("origin-confirmation-required");
  if (!token) throw new ImportFailure("operator-session-required");
  const results = { created: 0, updated: 0, issuesCreated: 0, issuesExisting: 0, leadsCreated: 0, leadConflicts: 0 };
  for (const row of rows) {
    let record = row.match;
    if (!record) {
      record = await api(args.origin, token, "POST", "/newsletters", row.body) as Existing;
      results.created += 1;
    } else if (Object.keys(row.patch || {}).length) {
      record = await api(args.origin, token, "PATCH", `/newsletters/${record.id}`, { ...row.patch, version: record.version }) as Existing;
      results.updated += 1;
    }
    for (const issue of row.issues) {
      const stored = await api(args.origin, token, "POST", `/newsletters/${record!.id}/issues`, issue);
      if (stored.outcome === "created") results.issuesCreated += 1;
      else results.issuesExisting += 1;
      for (const lead of stored.leads) {
        if (lead.outcome === "created") results.leadsCreated += 1;
        if (lead.outcome === "conflict") results.leadConflicts += 1;
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
  return summary;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof ImportFailure ? `import failed: ${error.reason}` : error);
    process.exitCode = 1;
  });
