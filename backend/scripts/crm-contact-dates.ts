#!/usr/bin/env node

/**
 * CRM First/Last Contact Dates Fill Script.
 *
 * Scans local mail corpus (~/prod/emails/alexey@datatalks.club and
 * ~/prod/emails/alexey.s.grigoriev@gmail.com, both mailboxes, any direction)
 * to populate `first_contact_at` and `last_contact_at` for every inbound-tagged record.
 *
 * Rerunnable:
 *   - Persons: first = min(existing, corpus), last = max(existing, corpus)
 *   - Companies: aggregated from their people, then min(existing, aggregated) / max(existing, aggregated)
 *   - Never moves backwards or overwrites wrongly.
 *   - Supports --dry-run (default) and --apply.
 *   - A post-apply dry-run rerun must produce 0 updates.
 */

import { promises as fs } from "fs";
import { createReadStream } from "fs";
import * as readline from "readline";
import path from "path";

const DEFAULT_ORIGIN = "https://ops.dtcdev.click";
const DEFAULT_MAIL_ROOT = "/home/alexey/prod/emails";

interface EmailStats {
  minDate: string;
  maxDate: string;
  count: number;
}

interface ExistingContact {
  id: string;
  organizationId?: string;
  name?: string;
  emails?: string[];
  tags?: string[];
  first_contact_at?: string;
  last_contact_at?: string;
  version: number;
}

interface ExistingOrganization {
  id: string;
  displayName?: string;
  domain?: string;
  tags?: string[];
  first_contact_at?: string;
  last_contact_at?: string;
  version: number;
}

export function extractEmails(header: unknown): string[] {
  if (typeof header !== "string" || !header.trim()) return [];
  const matches = header.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (!matches) return [];
  return matches.map((e) => e.toLowerCase().trim());
}

export function parseMessageDate(msg: any): string | null {
  if (msg.date) {
    const d = new Date(msg.date);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (msg.internalDate) {
    const d = new Date(Number(msg.internalDate));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export function minDate(d1?: string | null, d2?: string | null): string | undefined {
  if (d1 && d2) return d1 < d2 ? d1 : d2;
  return (d1 || d2) ?? undefined;
}

export function maxDate(d1?: string | null, d2?: string | null): string | undefined {
  if (d1 && d2) return d1 > d2 ? d1 : d2;
  return (d1 || d2) ?? undefined;
}

async function fetchCrmRecords(origin: string, token: string, kind: "organizations" | "contacts") {
  const records: any[] = [];
  let cursor = 0;
  while (true) {
    const url = `${origin}/api/sponsor-crm/${kind}?limit=100&cursor=${cursor}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${kind}: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { items?: any[]; nextCursor?: string | null };
    records.push(...(data.items || []));
    if (!data.nextCursor) break;
    cursor = Number(data.nextCursor);
  }
  return records;
}

async function apiUpdate(
  origin: string,
  token: string,
  kind: "organizations" | "contacts",
  id: string,
  body: Record<string, unknown>
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${origin}/api/sponsor-crm/${kind}/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to update ${kind} ${id}: ${res.status} ${text}`);
      }
      return (await res.json()) as Promise<any>;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function loadMailCorpusStats(mailRoot = DEFAULT_MAIL_ROOT) {
  const mailboxFiles = [
    { name: "alexey@datatalks.club", path: path.join(mailRoot, "alexey@datatalks.club/messages.jsonl") },
    { name: "alexey.s.grigoriev@gmail.com", path: path.join(mailRoot, "alexey.s.grigoriev@gmail.com/messages.jsonl") },
  ];

  const emailStats = new Map<string, EmailStats>();
  const mailboxStats: Record<string, { count: number; maxDate: string; minDate: string }> = {};

  for (const mb of mailboxFiles) {
    let count = 0;
    let minDateSeen = "";
    let maxDateSeen = "";
    const rl = readline.createInterface({
      input: createReadStream(mb.path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      count++;
      try {
        const msg = JSON.parse(line);
        const d = parseMessageDate(msg);
        if (!d) continue;

        if (!minDateSeen || d < minDateSeen) minDateSeen = d;
        if (!maxDateSeen || d > maxDateSeen) maxDateSeen = d;

        const emails = new Set([
          ...extractEmails(msg.from),
          ...extractEmails(msg.to),
          ...extractEmails(msg.cc),
          ...extractEmails(msg.bcc),
        ]);

        for (const email of emails) {
          const existing = emailStats.get(email);
          if (!existing) {
            emailStats.set(email, { minDate: d, maxDate: d, count: 1 });
          } else {
            if (d < existing.minDate) existing.minDate = d;
            if (d > existing.maxDate) existing.maxDate = d;
            existing.count++;
          }
        }
      } catch {
        // ignore parse error on individual line
      }
    }
    mailboxStats[mb.name] = { count, minDate: minDateSeen, maxDate: maxDateSeen };
  }

  return { emailStats, mailboxStats };
}

export async function main(argv = process.argv.slice(2)) {
  let mode: "dry-run" | "apply" = "dry-run";
  let origin = process.env.DATAOPS_URL || DEFAULT_ORIGIN;
  let token = process.env.DATAOPS_TOKEN || "";
  let mailRoot = DEFAULT_MAIL_ROOT;
  let reportPath = "";
  let outJsonPath = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--apply") mode = "apply";
    else if (arg === "--api-base-url" && argv[i + 1]) origin = argv[++i];
    else if (arg === "--token" && argv[i + 1]) token = argv[++i];
    else if (arg === "--mail-root" && argv[i + 1]) mailRoot = argv[++i];
    else if (arg === "--report" && argv[i + 1]) reportPath = argv[++i];
    else if (arg === "--out-json" && argv[i + 1]) outJsonPath = argv[++i];
  }

  if (!token) {
    try {
      const defaultTokenPath = path.join(process.env.HOME || "/home/alexey", ".config/dataops/import.token");
      token = (await fs.readFile(defaultTokenPath, "utf8")).trim();
    } catch {}
  }
  if (!token) throw new Error("Missing DATAOPS_TOKEN or ~/.config/dataops/import.token");

  console.log(`[crm-contact-dates] Mode: ${mode}, Origin: ${origin}`);

  // 1. Scan mail corpus
  console.log(`[crm-contact-dates] Loading mail corpus from ${mailRoot}...`);
  const { emailStats, mailboxStats } = await loadMailCorpusStats(mailRoot);
  console.log(`[crm-contact-dates] Indexed ${emailStats.size} distinct email addresses from corpus.`);

  // 2. Fetch CRM records
  console.log(`[crm-contact-dates] Fetching CRM organizations and contacts from ${origin}...`);
  const [rawOrgs, rawContacts] = await Promise.all([
    fetchCrmRecords(origin, token, "organizations"),
    fetchCrmRecords(origin, token, "contacts"),
  ]);

  const allOrgs = rawOrgs as ExistingOrganization[];
  const allContacts = rawContacts as ExistingContact[];

  const inboundOrgs = allOrgs.filter((org) => Array.isArray(org.tags) && org.tags.includes("inbound"));
  const inboundContacts = allContacts.filter((c) => Array.isArray(c.tags) && c.tags.includes("inbound"));

  console.log(`[crm-contact-dates] CRM totals: ${allOrgs.length} orgs (${inboundOrgs.length} inbound), ${allContacts.length} contacts (${inboundContacts.length} inbound).`);

  // 3. Compute person contact dates
  interface PlannedPersonUpdate {
    contact: ExistingContact;
    corpusFirst?: string;
    corpusLast?: string;
    targetFirst?: string;
    targetLast?: string;
    needsUpdate: boolean;
  }

  const personPlans = new Map<string, PlannedPersonUpdate>();
  const peopleNeedingUpdate: PlannedPersonUpdate[] = [];

  for (const contact of inboundContacts) {
    const emails = Array.isArray(contact.emails) ? contact.emails.map((e) => e.toLowerCase().trim()) : [];
    let corpusFirst: string | undefined;
    let corpusLast: string | undefined;

    for (const email of emails) {
      const stats = emailStats.get(email);
      if (stats) {
        corpusFirst = minDate(corpusFirst, stats.minDate);
        corpusLast = maxDate(corpusLast, stats.maxDate);
      }
    }

    const targetFirst = minDate(contact.first_contact_at, corpusFirst);
    const targetLast = maxDate(contact.last_contact_at, corpusLast);

    const needsUpdate =
      (targetFirst !== undefined && targetFirst !== contact.first_contact_at) ||
      (targetLast !== undefined && targetLast !== contact.last_contact_at);

    const plan: PlannedPersonUpdate = {
      contact,
      corpusFirst,
      corpusLast,
      targetFirst,
      targetLast,
      needsUpdate,
    };
    personPlans.set(contact.id, plan);
    if (needsUpdate) peopleNeedingUpdate.push(plan);
  }

  // 4. Compute company contact dates (aggregated from their people)
  // Map people to their organization
  const peopleByOrgId = new Map<string, PlannedPersonUpdate[]>();
  for (const plan of personPlans.values()) {
    const orgId = plan.contact.organizationId;
    if (orgId) {
      if (!peopleByOrgId.has(orgId)) peopleByOrgId.set(orgId, []);
      peopleByOrgId.get(orgId)!.push(plan);
    }
  }

  interface PlannedCompanyUpdate {
    org: ExistingOrganization;
    peopleFirst?: string;
    peopleLast?: string;
    targetFirst?: string;
    targetLast?: string;
    needsUpdate: boolean;
  }

  const companyPlans = new Map<string, PlannedCompanyUpdate>();
  const companiesNeedingUpdate: PlannedCompanyUpdate[] = [];

  for (const org of inboundOrgs) {
    const people = peopleByOrgId.get(org.id) || [];
    let peopleFirst: string | undefined;
    let peopleLast: string | undefined;

    for (const p of people) {
      peopleFirst = minDate(peopleFirst, p.targetFirst);
      peopleLast = maxDate(peopleLast, p.targetLast);
    }

    const targetFirst = minDate(org.first_contact_at, peopleFirst);
    const targetLast = maxDate(org.last_contact_at, peopleLast);

    const needsUpdate =
      (targetFirst !== undefined && targetFirst !== org.first_contact_at) ||
      (targetLast !== undefined && targetLast !== org.last_contact_at);

    const plan: PlannedCompanyUpdate = {
      org,
      peopleFirst,
      peopleLast,
      targetFirst,
      targetLast,
      needsUpdate,
    };
    companyPlans.set(org.id, plan);
    if (needsUpdate) companiesNeedingUpdate.push(plan);
  }

  console.log(`[crm-contact-dates] Evaluation results:`);
  console.log(`  People with contact dates: ${Array.from(personPlans.values()).filter((p) => p.targetFirst || p.targetLast).length} / ${inboundContacts.length}`);
  console.log(`  People needing updates: ${peopleNeedingUpdate.length}`);
  console.log(`  Companies with contact dates: ${Array.from(companyPlans.values()).filter((c) => c.targetFirst || c.targetLast).length} / ${inboundOrgs.length}`);
  console.log(`  Companies needing updates: ${companiesNeedingUpdate.length}`);

  // 5. Apply updates if in --apply mode
  let appliedPeopleCount = 0;
  let appliedCompanyCount = 0;

  if (mode === "apply") {
    console.log(`[crm-contact-dates] Applying updates to ${peopleNeedingUpdate.length} people...`);
    for (const p of peopleNeedingUpdate) {
      await apiUpdate(origin, token, "contacts", p.contact.id, {
        version: p.contact.version,
        ...(p.targetFirst ? { first_contact_at: p.targetFirst } : {}),
        ...(p.targetLast ? { last_contact_at: p.targetLast } : {}),
      });
      appliedPeopleCount++;
      if (appliedPeopleCount % 20 === 0 || appliedPeopleCount === peopleNeedingUpdate.length) {
        console.log(`  Applied ${appliedPeopleCount}/${peopleNeedingUpdate.length} people`);
      }
    }

    console.log(`[crm-contact-dates] Applying updates to ${companiesNeedingUpdate.length} companies...`);
    for (const c of companiesNeedingUpdate) {
      await apiUpdate(origin, token, "organizations", c.org.id, {
        version: c.org.version,
        ...(c.targetFirst ? { first_contact_at: c.targetFirst } : {}),
        ...(c.targetLast ? { last_contact_at: c.targetLast } : {}),
      });
      appliedCompanyCount++;
      if (appliedCompanyCount % 20 === 0 || appliedCompanyCount === companiesNeedingUpdate.length) {
        console.log(`  Applied ${appliedCompanyCount}/${companiesNeedingUpdate.length} companies`);
      }
    }
  }

  // Generate report
  const summary = {
    mode,
    origin,
    inboundContactsTotal: inboundContacts.length,
    inboundOrgsTotal: inboundOrgs.length,
    peopleWithDates: Array.from(personPlans.values()).filter((p) => p.targetFirst || p.targetLast).length,
    companiesWithDates: Array.from(companyPlans.values()).filter((c) => c.targetFirst || c.targetLast).length,
    peopleNeedingUpdate: peopleNeedingUpdate.length,
    companiesNeedingUpdate: companiesNeedingUpdate.length,
    appliedPeopleCount,
    appliedCompanyCount,
  };

  const markdownReport = generateMarkdownReport({
    title: mode === "apply" ? "CRM Contact Dates Backfill — Apply Run" : "CRM Contact Dates Backfill — Dry-Run",
    mode,
    origin,
    mailboxStats,
    summary,
    samplePeople: peopleNeedingUpdate.slice(0, 10).map((p) => ({
      id: p.contact.id,
      name: p.contact.name || "—",
      email: (p.contact.emails || [])[0] || "—",
      currentFirst: p.contact.first_contact_at || "—",
      currentLast: p.contact.last_contact_at || "—",
      newFirst: p.targetFirst || "—",
      newLast: p.targetLast || "—",
    })),
    sampleCompanies: companiesNeedingUpdate.slice(0, 10).map((c) => ({
      id: c.org.id,
      displayName: c.org.displayName || "—",
      domain: c.org.domain || "—",
      currentFirst: c.org.first_contact_at || "—",
      currentLast: c.org.last_contact_at || "—",
      newFirst: c.targetFirst || "—",
      newLast: c.targetLast || "—",
    })),
  });

  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, markdownReport, "utf8");
    console.log(`[crm-contact-dates] Wrote markdown report to ${reportPath}`);
  }

  if (outJsonPath) {
    const jsonOutput = {
      summary,
      mailboxStats,
      peopleUpdates: peopleNeedingUpdate.map((p) => ({
        id: p.contact.id,
        name: p.contact.name,
        emails: p.contact.emails,
        currentFirst: p.contact.first_contact_at,
        currentLast: p.contact.last_contact_at,
        targetFirst: p.targetFirst,
        targetLast: p.targetLast,
      })),
      companyUpdates: companiesNeedingUpdate.map((c) => ({
        id: c.org.id,
        displayName: c.org.displayName,
        domain: c.org.domain,
        currentFirst: c.org.first_contact_at,
        currentLast: c.org.last_contact_at,
        targetFirst: c.targetFirst,
        targetLast: c.targetLast,
      })),
    };
    await fs.mkdir(path.dirname(outJsonPath), { recursive: true });
    await fs.writeFile(outJsonPath, JSON.stringify(jsonOutput, null, 2), "utf8");
    console.log(`[crm-contact-dates] Wrote JSON output to ${outJsonPath}`);
  }

  return summary;
}

function generateMarkdownReport(data: {
  title: string;
  mode: string;
  origin: string;
  mailboxStats: Record<string, { count: number; minDate: string; maxDate: string }>;
  summary: any;
  samplePeople: any[];
  sampleCompanies: any[];
}) {
  const dateStr = new Date().toISOString().slice(0, 10);
  return `# ${data.title} (${dateStr})

## 1. Overview
- **Run Mode**: \`${data.mode}\`
- **Target Origin**: \`${data.origin}\`
- **Hub Intake**: \`585f95f2-93ba-4b8d-acb6-230840554239\`

## 2. Mailbox Corpus
| Mailbox | Messages Loaded | Date Range |
| --- | ---: | --- |
${Object.entries(data.mailboxStats).map(([mb, s]) => `| \`${mb}\` | ${s.count} | \`${s.minDate.slice(0, 10)}\` to \`${s.maxDate.slice(0, 10)}\` |`).join("\n")}

## 3. Summary Counts
| Category | Inbound Total | With Contact Dates | Needing Update | Applied |
| --- | ---: | ---: | ---: | ---: |
| **People (Contacts)** | ${data.summary.inboundContactsTotal} | ${data.summary.peopleWithDates} | ${data.summary.peopleNeedingUpdate} | ${data.summary.appliedPeopleCount} |
| **Companies (Organizations)** | ${data.summary.inboundOrgsTotal} | ${data.summary.companiesWithDates} | ${data.summary.companiesNeedingUpdate} | ${data.summary.appliedCompanyCount} |

## 4. Sample Person Updates
| Name | Email | Current First | Current Last | Target First | Target Last |
| --- | --- | --- | --- | --- | --- |
${data.samplePeople.length ? data.samplePeople.map((p) => `| ${p.name} | \`${p.email}\` | ${p.currentFirst} | ${p.currentLast} | \`${p.newFirst}\` | \`${p.newLast}\` |`).join("\n") : "| *(None)* | — | — | — | — | — |"}

## 5. Sample Company Updates
| Company | Domain | Current First | Current Last | Target First | Target Last |
| --- | --- | --- | --- | --- | --- |
${data.sampleCompanies.length ? data.sampleCompanies.map((c) => `| ${c.displayName} | \`${c.domain}\` | ${c.currentFirst} | ${c.currentLast} | \`${c.newFirst}\` | \`${c.newLast}\` |`).join("\n") : "| *(None)* | — | — | — | — | — |"}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
