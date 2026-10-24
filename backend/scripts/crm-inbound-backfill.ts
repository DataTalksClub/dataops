#!/usr/bin/env node

/**
 * CRM Inbound Promotion/Sponsorship Asks Backfill.
 *
 * Scans local mail corpus (alexey@datatalks.club and alexey.s.grigoriev@gmail.com)
 * for inbound promotion/sponsorship asks (paid placement, workshops/webinars,
 * newsletter slots, podcast guest PR pitches, share/promote asks).
 *
 * Excludes students, spam, recruiters, pure community questions, publisher pitches,
 * and internal DTC outbound threads.
 *
 * Idempotent:
 * - Upserts companies deduped by domain (ignoring generic domains like gmail.com).
 * - Upserts people deduped by email (case-insensitive).
 * - Matches existing records first (e.g. Kastra / Carlos).
 * - Adds "inbound" tag to new and existing records without clobbering other fields/tags.
 * - In --dry-run mode, computes counts and writes report without mutating CRM.
 * - In --apply mode, mutates CRM via the canonical organizations and contacts API.
 * - Rerun post-apply produces 0 new records and 0 new tags.
 */

import { promises as fs } from "fs";
import * as readline from "readline";
import { createReadStream } from "fs";
import path from "path";

const DEFAULT_ORIGIN = "https://ops.dtcdev.click";
const DEFAULT_MAIL_ROOT = "/home/alexey/prod/emails";

const INTERNAL_EMAILS = new Set([
  "alexey@datatalks.club",
  "alexey.s.grigoriev@gmail.com",
  "amitfrancisterence@gmail.com",
]);

const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "protonmail.com", "proton.me", "aol.com", "zoho.com",
  "yandex.ru", "mail.ru", "gmx.de", "web.de", "live.com", "me.com",
  "mac.com", "fastmail.com", "hey.com",
]);

const NOISE_DOMAINS = new Set([
  "meetup.com", "stripe.com", "paypal.com", "paypal.de", "github.com",
  "google.com", "linkedin.com", "twitter.com", "x.com", "youtube.com",
  "calendar.google.com", "docusign.net", "zoom.us", "calendly.com",
  "slack.com", "sponsorscout.io", "eventbrite.com", "ilz-steuerberatung.de",
  "ramp.com", "wise.com", "aws.com", "amazon.com", "substack.com",
  "uber.com", "airbnb.com", "booking.com", "flyeralarm.com",
]);

const NOISE_SENDER_PATTERNS = /(noreply@|no-reply@|notifications@|mailer-daemon|donotreply@|notification@|alerts@|support@github\.com|invitations@linkedin\.com|calendar-notification@google\.com|billing@|receipts@|invoicing@)/i;
const STUDENT_PATTERNS = /\b(zoomcamp|de-zoomcamp|mlops-zoomcamp|llm-zoomcamp|homework\s*[0-9]|homework deadline|course certificate|peer review|cohort\s*[0-9]|slack invite|invite to slack|join slack|course completion certificate|capstone project|certificate of completion|late submission|extend the deadline)\b/i;
const RECRUITER_PATTERNS = /\b(recruiting for|hiring for|job opportunity|open role|career opportunity|recruitment consultant|executive search|confidential search|talent acquisition|are you open to new roles|are you open to opportunities|are you interested in exploring a new opportunity|staff engineer role|director of data role|head of ml role|role at [A-Za-z]+|recruiting team|recruitment partner)\b/i;
const COMMUNITY_PATTERNS = /\b(machine learning bookcamp|reading your book|love your book|question about chapter|career advice|transition to data science|transition into tech|review my resume|review my cv|1:1 mentorship|how to break into data|career guidance)\b/i;
const PUBLISHER_PATTERNS = /\b(manning\.com|packtpub\.com|packt\.com|book proposal|review proposal|review manuscript|technical reviewer for|reviewing our new book|endorse my book)\b/i;
const COLD_SERVICE_SPAM = /\b(improve your seo|website redesign|audit of datatalks\.club|hire offshore developers|lead generation list|b2b email list|verified emails of|app development services|outsource your|offshore engineering)\b/i;

const ASK_PATTERNS = [
  { type: "podcast_guest_pitch", pat: /\b(podcast guest|be a guest on your podcast|guest on datatalks|guest on the datatalks\.club podcast|pitch for your podcast|suggest a guest|podcast interview|recommend as a guest|pitching [A-Za-z0-9]+ for your podcast|feature on your podcast|appear on your podcast|guest speaker on your podcast|guest on your show|interview on your podcast)\b/i },
  { type: "newsletter_slot", pat: /\b(newsletter slot|primary slot|secondary slot|standalone newsletter|sponsor your newsletter|newsletter sponsor|sponsor the newsletter|feature in your newsletter|ad in your newsletter|newsletter ad|advertise in your newsletter|newsletter sponsorship)\b/i },
  { type: "sponsored_workshop_webinar", pat: /\b(hands-on workshop|sponsor(?:ed)? workshop|host a workshop|co-host a (?:webinar|workshop)|webinar sponsorship|partner on a workshop|workshop sponsor|co-host a workshop|sponsor an event|event sponsorship)\b/i },
  { type: "paid_placement", pat: /\b(media kit|mediakit|sponsorship opportunities|sponsorship deck|sponsorship rate|advertising rates|sponsorship packages|interested in sponsoring|partnership opportunities|sponsor datatalks|commercial partnership|paid partnership|paid placement|paid collaboration|promotional packages|ad rates|rates for sponsoring|sponsorship pricing|sponsorship inquiry|sponsor inquiry)\b/i },
  { type: "share_promote", pat: /\b(share with your community|share with datatalks|share this with your community|promote our|feature our tool|amplify our|cross-promote|partner to promote|share our launch|share our project|share our dataset|share in your slack|post in your community|share on your socials|promote this launch|share it with your community|feature this in datatalks)\b/i },
];

interface RawMailMessage {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  body?: string;
  internalDate?: string;
}

interface ClassifiedCandidate {
  threadId: string;
  name: string;
  email: string;
  domain: string | null;
  askType: string;
  subject: string;
  date: string;
  reason: string;
}

interface ExistingOrganization {
  id: string;
  displayName: string;
  domain?: string;
  domains?: string[];
  tags?: string[];
  version: number;
}

interface ExistingContact {
  id: string;
  name: string;
  organizationId: string;
  emails?: string[];
  tags?: string[];
  version: number;
}

function parseEmail(from?: string): { name: string; email: string } {
  if (!from) return { name: "", email: "" };
  const match = from.match(/^(.*?)(?:<([^>]+)>)?$/);
  if (!match) return { name: "", email: from.trim().toLowerCase() };
  let name = (match[1] || "").trim().replace(/^["']|["']$/g, "");
  let email = (match[2] || match[1] || "").trim().toLowerCase();
  if (email.includes("<")) email = email.replace(/.*<([^>]+)>.*/, "$1");
  return { name, email };
}

function cleanPersonName(name: string, email: string): string {
  if (name && !name.includes("@") && name.length <= 200) return name;
  const local = email.split("@")[0] || "";
  const cleaned = local.replace(/[._+-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return cleaned || "Contact";
}

function deriveCompanyName(domain: string): string {
  const parts = domain.split(".");
  const namePart = parts.length > 2 && ["co", "com", "org", "net", "io"].includes(parts[parts.length - 2])
    ? parts[parts.length - 3]
    : parts[0];
  return namePart.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
    const data = await res.json() as { items?: any[]; nextCursor?: string | null };
    records.push(...(data.items || []));
    if (!data.nextCursor) break;
    cursor = Number(data.nextCursor);
  }
  return records;
}

async function apiCreate(origin: string, token: string, kind: "organizations" | "contacts", body: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${origin}/api/sponsor-crm/${kind}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to create ${kind}: ${res.status} ${text}`);
      }
      return await res.json() as Promise<any>;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function apiUpdate(origin: string, token: string, kind: "organizations" | "contacts", id: string, body: Record<string, unknown>) {
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
      return await res.json() as Promise<any>;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let mode: "dry-run" | "apply" = "dry-run";
  let origin = process.env.DATAOPS_URL || DEFAULT_ORIGIN;
  let token = process.env.DATAOPS_TOKEN || "";
  let mailRoot = DEFAULT_MAIL_ROOT;
  let reportPath = "";
  let reportTitle = "";
  let outJsonPath = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--apply") mode = "apply";
    else if (arg === "--api-base-url" && argv[i + 1]) origin = argv[++i];
    else if (arg === "--token" && argv[i + 1]) token = argv[++i];
    else if (arg === "--mail-root" && argv[i + 1]) mailRoot = argv[++i];
    else if (arg === "--report" && argv[i + 1]) reportPath = argv[++i];
    else if (arg === "--report-title" && argv[i + 1]) reportTitle = argv[++i];
    else if (arg === "--out-json" && argv[i + 1]) outJsonPath = argv[++i];
  }

  if (!token) {
    try {
      const defaultTokenPath = path.join(process.env.HOME || "/home/alexey", ".config/dataops/import.token");
      token = (await fs.readFile(defaultTokenPath, "utf8")).trim();
    } catch {}
  }
  if (!token) throw new Error("Missing DATAOPS_TOKEN or ~/.config/dataops/import.token");

  console.log(`[crm-inbound-backfill] Mode: ${mode}, Origin: ${origin}`);

  // 1. Load Mailboxes
  const mailboxFiles = [
    { name: "alexey@datatalks.club", path: path.join(mailRoot, "alexey@datatalks.club/messages.jsonl") },
    { name: "alexey.s.grigoriev@gmail.com", path: path.join(mailRoot, "alexey.s.grigoriev@gmail.com/messages.jsonl") },
  ];

  const threads = new Map<string, RawMailMessage[]>();
  const mailboxStats: Record<string, { count: number; maxDate: string }> = {};

  for (const mb of mailboxFiles) {
    let count = 0;
    let maxDate = "";
    const rl = readline.createInterface({
      input: createReadStream(mb.path),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      count++;
      try {
        const msg = JSON.parse(line) as RawMailMessage;
        const tid = msg.threadId || msg.id;
        if (!threads.has(tid)) threads.set(tid, []);
        threads.get(tid)!.push(msg);

        if (msg.internalDate) {
          const dateStr = new Date(Number(msg.internalDate)).toISOString();
          if (dateStr > maxDate) maxDate = dateStr;
        }
      } catch {}
    }
    mailboxStats[mb.name] = { count, maxDate };
    console.log(`[crm-inbound-backfill] Loaded ${count} messages from ${mb.name} (maxDate: ${maxDate})`);
  }

  // 2. Classify Threads
  const exclusions: Record<string, number> = {
    alexey_outbound_or_internal: 0,
    transactional_system_sender: 0,
    student_inquiry: 0,
    recruiter_pitch: 0,
    community_question: 0,
    publisher_inquiry: 0,
    cold_service_spam: 0,
    no_sponsorship_ask: 0,
  };

  const candidates: ClassifiedCandidate[] = [];

  for (const [tid, msgs] of threads.entries()) {
    msgs.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
    const first = msgs[0];
    const { name: rawName, email } = parseEmail(first.from);
    if (!email || !email.includes("@")) continue;
    const domain = email.split("@")[1].toLowerCase();
    const subject = first.subject || "";

    if (INTERNAL_EMAILS.has(email) || email.endsWith("@datatalks.club")) {
      exclusions.alexey_outbound_or_internal++;
      continue;
    }
    if (NOISE_DOMAINS.has(domain) || NOISE_SENDER_PATTERNS.test(email)) {
      exclusions.transactional_system_sender++;
      continue;
    }

    const firstSnippet = first.snippet || "";
    if (STUDENT_PATTERNS.test(subject) || STUDENT_PATTERNS.test(firstSnippet)) {
      exclusions.student_inquiry++;
      continue;
    }
    if (RECRUITER_PATTERNS.test(subject) || RECRUITER_PATTERNS.test(firstSnippet)) {
      exclusions.recruiter_pitch++;
      continue;
    }
    if (COMMUNITY_PATTERNS.test(subject) || COMMUNITY_PATTERNS.test(firstSnippet)) {
      exclusions.community_question++;
      continue;
    }
    if (PUBLISHER_PATTERNS.test(subject) || PUBLISHER_PATTERNS.test(firstSnippet)) {
      exclusions.publisher_inquiry++;
      continue;
    }
    if (COLD_SERVICE_SPAM.test(subject) || COLD_SERVICE_SPAM.test(firstSnippet)) {
      exclusions.cold_service_spam++;
      continue;
    }

    const threadText = msgs.map((m) => `${m.subject || ""} ${m.snippet || ""} ${(m.body || "").slice(0, 3000)}`).join(" ");

    let matchedAsk: string | null = null;
    let matchedReason = "";
    for (const ask of ASK_PATTERNS) {
      const match = ask.pat.exec(threadText);
      if (match) {
        matchedAsk = ask.type;
        matchedReason = `Matched pattern "${match[0]}" for ${ask.type}`;
        break;
      }
    }
    if (!matchedAsk) {
      exclusions.no_sponsorship_ask++;
      continue;
    }
    if (STUDENT_PATTERNS.test(threadText)) {
      exclusions.student_inquiry++;
      continue;
    }
    if (RECRUITER_PATTERNS.test(threadText)) {
      exclusions.recruiter_pitch++;
      continue;
    }

    const date = first.internalDate ? new Date(Number(first.internalDate)).toISOString().slice(0, 10) : "";
    const cleanName = cleanPersonName(rawName, email);
    const validDomain = GENERIC_DOMAINS.has(domain) ? null : domain;

    candidates.push({
      threadId: tid,
      name: cleanName,
      email,
      domain: validDomain,
      askType: matchedAsk,
      subject,
      date,
      reason: matchedReason,
    });
  }

  // Sort candidates by date desc
  candidates.sort((a, b) => b.date.localeCompare(a.date));
  console.log(`[crm-inbound-backfill] Identified ${candidates.length} inbound promotion/sponsorship asks`);

  // 3. Deduplicate candidates
  const peopleToUpsert = new Map<string, ClassifiedCandidate>();
  const companiesToUpsert = new Map<string, { domain: string; displayName: string; askType: string; date: string }>();

  for (const c of candidates) {
    if (!peopleToUpsert.has(c.email)) {
      peopleToUpsert.set(c.email, c);
    }
    if (c.domain && !companiesToUpsert.has(c.domain)) {
      companiesToUpsert.set(c.domain, {
        domain: c.domain,
        displayName: deriveCompanyName(c.domain),
        askType: c.askType,
        date: c.date,
      });
    }
  }

  console.log(`[crm-inbound-backfill] Deduped: ${companiesToUpsert.size} companies, ${peopleToUpsert.size} people`);

  // 4. Fetch Existing CRM Records
  console.log(`[crm-inbound-backfill] Fetching existing organizations and contacts from ${origin}...`);
  const [existingOrgsRaw, existingContactsRaw] = await Promise.all([
    fetchCrmRecords(origin, token, "organizations"),
    fetchCrmRecords(origin, token, "contacts"),
  ]);

  const existingOrgs = existingOrgsRaw as ExistingOrganization[];
  const existingContacts = existingContactsRaw as ExistingContact[];
  console.log(`[crm-inbound-backfill] Fetched ${existingOrgs.length} organizations and ${existingContacts.length} contacts`);

  const existingOrgsByDomain = new Map<string, ExistingOrganization>();
  for (const org of existingOrgs) {
    if (org.domain) existingOrgsByDomain.set(org.domain.toLowerCase(), org);
    if (Array.isArray(org.domains)) {
      for (const d of org.domains) existingOrgsByDomain.set(d.toLowerCase(), org);
    }
  }

  const existingContactsByEmail = new Map<string, ExistingContact>();
  for (const contact of existingContacts) {
    if (Array.isArray(contact.emails)) {
      for (const e of contact.emails) existingContactsByEmail.set(e.toLowerCase(), contact);
    }
  }

  // 5. Plan Mutations & Actions
  const newCompanies: { domain: string; displayName: string }[] = [];
  const existingCompaniesToTag: { org: ExistingOrganization; domain: string }[] = [];
  const companiesAlreadyTagged: string[] = [];

  for (const [dom, info] of companiesToUpsert.entries()) {
    const existing = existingOrgsByDomain.get(dom);
    if (!existing) {
      newCompanies.push({ domain: dom, displayName: info.displayName });
    } else {
      const currentTags = existing.tags || [];
      if (!currentTags.includes("inbound")) {
        existingCompaniesToTag.push({ org: existing, domain: dom });
      } else {
        companiesAlreadyTagged.push(dom);
      }
    }
  }

  const newPeople: ClassifiedCandidate[] = [];
  const existingPeopleToTag: { contact: ExistingContact; candidate: ClassifiedCandidate }[] = [];
  const peopleAlreadyTagged: string[] = [];

  for (const [email, candidate] of peopleToUpsert.entries()) {
    const existing = existingContactsByEmail.get(email);
    if (!existing) {
      newPeople.push(candidate);
    } else {
      const currentTags = existing.tags || [];
      if (!currentTags.includes("inbound")) {
        existingPeopleToTag.push({ contact: existing, candidate });
      } else {
        peopleAlreadyTagged.push(email);
      }
    }
  }

  // Check Kastra and Carlos specifically
  const kastraMatch = existingOrgsByDomain.get("kastra.ai");
  const carlosMatch = existingContactsByEmail.get("carlos@kastra.ai");

  const summaryCounts = {
    newCompanies: newCompanies.length,
    newPeople: newPeople.length,
    existingCompaniesToTag: existingCompaniesToTag.length,
    existingPeopleToTag: existingPeopleToTag.length,
    totalTaggedInbound: newCompanies.length + newPeople.length + existingCompaniesToTag.length + existingPeopleToTag.length,
    alreadyTaggedInboundCompanies: companiesAlreadyTagged.length,
    alreadyTaggedInboundPeople: peopleAlreadyTagged.length,
  };

  console.log("[crm-inbound-backfill] Planned Actions:", summaryCounts);
  console.log(`[crm-inbound-backfill] Kastra matched existing? ${!!kastraMatch} (id: ${kastraMatch?.id})`);
  console.log(`[crm-inbound-backfill] Carlos matched existing? ${!!carlosMatch} (id: ${carlosMatch?.id})`);

  // 6. Execute Mutations if Mode == 'apply'
  let appliedNewCompanies = 0;
  let appliedNewPeople = 0;
  let appliedTaggedCompanies = 0;
  let appliedTaggedPeople = 0;

  if (mode === "apply") {
    console.log("[crm-inbound-backfill] Applying changes to CRM...");

    // Map to keep track of created or existing org IDs for people
    const orgIdMap = new Map<string, string>();
    for (const [dom, org] of existingOrgsByDomain.entries()) {
      orgIdMap.set(dom, org.id);
    }

    // A. Create new companies
    for (const comp of newCompanies) {
      const created = await apiCreate(origin, token, "organizations", {
        displayName: comp.displayName,
        domain: comp.domain,
        tags: ["inbound"],
      });
      orgIdMap.set(comp.domain, created.id);
      appliedNewCompanies++;
    }

    // B. Tag existing companies
    for (const { org } of existingCompaniesToTag) {
      const updatedTags = Array.from(new Set([...(org.tags || []), "inbound"]));
      await apiUpdate(origin, token, "organizations", org.id, {
        version: org.version,
        tags: updatedTags,
      });
      appliedTaggedCompanies++;
    }

    // C. Create new people
    for (const person of newPeople) {
      let orgId = person.domain ? orgIdMap.get(person.domain) : undefined;
      if (!orgId) {
        // Individual shell required by contact API
        const shellOrg = await apiCreate(origin, token, "organizations", {
          displayName: person.name,
          tags: ["inbound"],
          notes: "Individual contact shell required by contact API",
        });
        orgId = shellOrg.id;
        if (person.domain) orgIdMap.set(person.domain, orgId);
      }

      await apiCreate(origin, token, "contacts", {
        organizationId: orgId,
        name: person.name,
        emails: [person.email],
        tags: ["inbound"],
      });
      appliedNewPeople++;
    }

    // D. Tag existing people
    for (const { contact } of existingPeopleToTag) {
      const updatedTags = Array.from(new Set([...(contact.tags || []), "inbound"]));
      await apiUpdate(origin, token, "contacts", contact.id, {
        version: contact.version,
        tags: updatedTags,
      });
      appliedTaggedPeople++;
    }

    console.log(`[crm-inbound-backfill] Apply complete: created ${appliedNewCompanies} companies, created ${appliedNewPeople} people, tagged ${appliedTaggedCompanies} existing companies, tagged ${appliedTaggedPeople} existing people.`);
  }

  // 7. Generate Reports
  const samples = candidates.slice(0, 16).map((c) => ({
    name: c.name,
    email: c.email,
    company: c.domain ? deriveCompanyName(c.domain) : "Individual",
    domain: c.domain || "(generic)",
    askType: c.askType,
    subject: c.subject.replace(/\|/g, "-"),
    date: c.date,
    reason: c.reason,
  }));

  const reportMarkdown = generateMarkdownReport({
    title: reportTitle || (mode === "dry-run" ? "CRM Inbound Backfill Dry-Run Report" : "CRM Inbound Backfill Apply Report"),
    mode,
    origin,
    mailboxStats,
    exclusions,
    summaryCounts,
    applied: mode === "apply" ? {
      appliedNewCompanies,
      appliedNewPeople,
      appliedTaggedCompanies,
      appliedTaggedPeople,
    } : undefined,
    kastraMatch: kastraMatch ? { id: kastraMatch.id, displayName: kastraMatch.displayName } : null,
    carlosMatch: carlosMatch ? { id: carlosMatch.id, name: carlosMatch.name } : null,
    samples,
  });

  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, reportMarkdown, "utf8");
    console.log(`[crm-inbound-backfill] Wrote markdown report to ${reportPath}`);
  }

  if (outJsonPath) {
    const jsonOutput = {
      mode,
      origin,
      mailboxStats,
      exclusions,
      summaryCounts,
      applied: mode === "apply" ? {
        appliedNewCompanies,
        appliedNewPeople,
        appliedTaggedCompanies,
        appliedTaggedPeople,
      } : undefined,
      samples,
    };
    await fs.mkdir(path.dirname(outJsonPath), { recursive: true });
    await fs.writeFile(outJsonPath, JSON.stringify(jsonOutput, null, 2), "utf8");
    console.log(`[crm-inbound-backfill] Wrote JSON output to ${outJsonPath}`);
  }

  return {
    mode,
    summaryCounts,
    applied: mode === "apply" ? {
      appliedNewCompanies,
      appliedNewPeople,
      appliedTaggedCompanies,
      appliedTaggedPeople,
    } : undefined,
  };
}

function generateMarkdownReport(data: {
  title: string;
  mode: string;
  origin: string;
  mailboxStats: Record<string, { count: number; maxDate: string }>;
  exclusions: Record<string, number>;
  summaryCounts: any;
  applied?: any;
  kastraMatch: any;
  carlosMatch: any;
  samples: any[];
}) {
  const dateStr = new Date().toISOString().slice(0, 10);
  return `# ${data.title} (${dateStr})

## Overview
- **Run Mode**: \`${data.mode}\`
- **Target Origin**: \`${data.origin}\`
- **Hub Intake ID**: \`d1f88e54-d2ba-491f-bdd7-5d75d0903a55\`
- **Requester**: Alexey (\`t752u\`) via Orin Vale

## 1. Mailbox Corpus Refresh
| Mailbox | Messages Loaded | Max Date |
| --- | ---: | --- |
${Object.entries(data.mailboxStats).map(([mb, s]) => `| \`${mb}\` | ${s.count} | ${s.maxDate} |`).join("\n")}

## 2. Classification & Exclusions Breakdown
| Exclusion Reason | Count | Notes |
| --- | ---: | --- |
| \`alexey_outbound_or_internal\` | ${data.exclusions.alexey_outbound_or_internal} | Outbound outreach threads or internal communication |
| \`transactional_system_sender\` | ${data.exclusions.transactional_system_sender} | Stripe, PayPal, GitHub, Meetup, Zoom, Calendly, alerts |
| \`student_inquiry\` | ${data.exclusions.student_inquiry} | Zoomcamp homework, certificates, extensions, slack invites |
| \`recruiter_pitch\` | ${data.exclusions.recruiter_pitch} | Job opportunities, executive search, headhunting |
| \`community_question\` | ${data.exclusions.community_question} | Book readers, general career advice, 1-on-1 mentorship |
| \`publisher_inquiry\` | ${data.exclusions.publisher_inquiry} | Manning/Packt book reviews and endorsements |
| \`cold_service_spam\` | ${data.exclusions.cold_service_spam} | Agency SEO / offshore dev vendor pitches to DTC |
| \`no_sponsorship_ask\` | ${data.exclusions.no_sponsorship_ask} | General non-commercial inquiries |

## 3. Backfill Action Counts
| Metric | Planned Count | ${data.applied ? "Applied Count |" : ""}
| --- | ---: | ${data.applied ? "---: |" : ""}
| **New Companies** | ${data.summaryCounts.newCompanies} | ${data.applied ? `${data.applied.appliedNewCompanies} |` : ""}
| **New People** | ${data.summaryCounts.newPeople} | ${data.applied ? `${data.applied.appliedNewPeople} |` : ""}
| **Existing Companies Tagged \`inbound\`** | ${data.summaryCounts.existingCompaniesToTag} | ${data.applied ? `${data.applied.appliedTaggedCompanies} |` : ""}
| **Existing People Tagged \`inbound\`** | ${data.summaryCounts.existingPeopleToTag} | ${data.applied ? `${data.applied.appliedTaggedPeople} |` : ""}
| **Already Tagged Companies** | ${data.summaryCounts.alreadyTaggedInboundCompanies} | ${data.applied ? "- |" : ""}
| **Already Tagged People** | ${data.summaryCounts.alreadyTaggedInboundPeople} | ${data.applied ? "- |" : ""}
| **Total Inbound Records (New + Existing Tagged)** | ${data.summaryCounts.totalTaggedInbound} | ${data.applied ? `${data.applied.appliedNewCompanies + data.applied.appliedNewPeople + data.applied.appliedTaggedCompanies + data.applied.appliedTaggedPeople} |` : ""}

## 4. Existing Records Verification (Kastra / Carlos)
- **Kastra Org**: ${data.kastraMatch ? `Matched existing record ID \`${data.kastraMatch.id}\` (\`${data.kastraMatch.displayName}\`). Not duplicated.` : "Not found in CRM"}
- **Carlos Contact**: ${data.carlosMatch ? `Matched existing record ID \`${data.carlosMatch.id}\` (\`${data.carlosMatch.name}\`). Not duplicated.` : "Not found in CRM"}

## 5. Sample Inbound Asks (${data.samples.length} Samples)
| Name | Email | Company / Domain | Ask Type | Subject | Date | Classification Reason |
| --- | --- | --- | --- | --- | --- | --- |
${data.samples.map((s) => `| ${s.name} | \`${s.email}\` | ${s.company} (\`${s.domain}\`) | \`${s.askType}\` | ${s.subject.slice(0, 45)} | ${s.date} | ${s.reason} |`).join("\n")}

## 6. Safety & Boundary Confirmation
- No Slack messages, Telegram messages, or emails sent.
- No reports written to \`dataops-knowledge\`.
- No deals created in CRM; companies and people records only.
- Mail bodies and private message contents omitted from reports and git commits.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
