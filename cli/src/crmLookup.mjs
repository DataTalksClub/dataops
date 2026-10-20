import { ApiError } from "./api.mjs";
import { UsageError } from "./errors.mjs";
import { berlinToday, enc, isoDate } from "./format.mjs";

// Free-mail domains carry no company signal: a gmail.com sender cannot be
// matched to an organization by domain.
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "web.de", "mail.com", "fastmail.com", "hey.com",
  "t-online.de", "mail.ru", "qq.com", "163.com",
]);
const GENERIC_DOMAIN_PREFIXES = ["yahoo", "gmx", "yandex"];

export function isGenericDomain(domain) {
  const value = String(domain || "").toLowerCase();
  if (!value || GENERIC_DOMAINS.has(value)) return true;
  return GENERIC_DOMAIN_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}.`));
}

export function domainOf(email) {
  const at = String(email || "").lastIndexOf("@");
  return at === -1 ? "" : String(email).slice(at + 1).toLowerCase();
}

/** Follow a directory/pipeline list endpoint until exhausted (bounded). */
async function paged(api, route, query, maxPages = 5) {
  const items = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await api.get(route, { query: { ...query, limit: "100", ...(cursor ? { cursor } : {}) } });
    items.push(...(result?.items || []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return items;
}

async function notesForDeal(api, dealId) {
  try {
    const result = await api.get(`/api/sponsor-crm/notes/deal/${enc(dealId)}`, { query: { limit: "5" } });
    return result?.items || [];
  } catch (error) {
    // Archived deals refuse note listings; a lookup should still succeed.
    if (error instanceof ApiError && (error.status === 404 || error.status === 422)) return [];
    throw error;
  }
}

/**
 * Exact email match first (case-insensitive over people emails), then the
 * sender domain against the company directory (generic domains skipped).
 * People on the same deal come along as the organization's contacts.
 */
export async function resolveMatch(api, { email, domain } = {}) {
  let people = [];
  let organization = null;
  let matchedVia = null;

  if (email) {
    const found = await paged(api, "/api/sponsor-crm/directory/people", { search: email, active: "all" });
    const needle = String(email).toLowerCase();
    people = found
      .filter((person) => (person.emails || []).some((address) => String(address).toLowerCase() === needle))
      .map((person) => ({ ...person, matched: true }));
    if (people.length) {
      matchedVia = "email";
      const organizationId = people.find((person) => person.organizationId)?.organizationId;
      if (organizationId) {
        organization = await api.get(`/api/sponsor-crm/directory/companies/${enc(organizationId)}`).catch((error) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        });
        const colleagues = await paged(api, "/api/sponsor-crm/directory/people", { company: organizationId, active: "all" });
        const seen = new Set(people.map((person) => person.id));
        for (const contact of colleagues) if (!seen.has(contact.id)) people.push({ ...contact, matched: false });
      }
    }
  }

  const senderDomain = domain ? String(domain).toLowerCase() : domainOf(email);
  if (!people.length && senderDomain && !isGenericDomain(senderDomain)) {
    const companies = await paged(api, "/api/sponsor-crm/directory/companies", { search: senderDomain, active: "all" });
    const hits = companies.filter((company) => String(company.domain || "").toLowerCase() === senderDomain);
    if (hits.length) {
      organization = hits[0];
      matchedVia = "domain";
      people = (await paged(api, "/api/sponsor-crm/directory/people", { company: organization.id, active: "all" }))
        .map((person) => ({ ...person, matched: false }));
    }
  }

  return { people, organization, matchedVia, domain: senderDomain || null };
}

async function dealRows(api, organizationId) {
  return paged(api, "/api/sponsor-crm/pipeline", { organizationId, view: "all" }, 10);
}

function publicOrg(organization) {
  return {
    id: organization.id,
    name: organization.displayName || organization.name || "",
    ...(organization.domain ? { domain: organization.domain } : {}),
    ...(organization.relationship ? { relationship: organization.relationship } : {}),
  };
}

function publicPerson(person) {
  return {
    id: person.id,
    name: person.name || "",
    emails: person.emails || [],
    ...(person.role ? { role: person.role } : {}),
    primary: !!person.primary,
    ...(person.companyName ? { companyName: person.companyName } : {}),
    matched: !!person.matched,
  };
}

function publicDeal(row, notes) {
  const task = row.nextTask;
  return {
    id: row.id,
    title: row.title || "",
    stage: row.stage || "",
    status: row.status || "",
    money: row.money || "none",
    fulfillment: row.fulfillment || "none",
    amountEur: row.amountEur ?? null,
    nextTask: task ? {
      description: task.description ?? null,
      date: task.date ?? null,
      status: task.status ?? null,
      deferred: !!task.deferred,
      assigneeId: task.assigneeId ?? null,
    } : null,
    replyReview: !!row.replyReview,
    ...(row.lastContacted ? { lastContacted: row.lastContacted } : {}),
    notes,
  };
}

/** One deal's verdict against today: waiting beats an inbound-reply nudge — the marker is the decision. */
function dealDecision(deal, today) {
  const task = deal.nextTask;
  const date = task?.date ? String(task.date).slice(0, 10) : null;
  const marked = task && (task.status === "waiting" || task.deferred === true);
  if (task && date && date > today && marked) {
    return { state: "waiting", until: date, reason: `${task.deferred ? "deferred" : "waiting"}: ${task.description || "return later"} (revisit ${date})` };
  }
  if (deal.replyReview) return { state: "proceed", reason: "inbound reply may be needed" };
  if (!task || !date) return { state: "proceed", reason: task ? "next action has no date" : "no dated next action" };
  if (date <= today) return { state: "proceed", reason: `next action due ${date}` };
  return { state: "waiting", until: date, reason: `scheduled: ${task.description || "next action"} (due ${date})` };
}

export function decide({ people, organization, deals }, today) {
  if (!people.length && !organization) {
    return { action: "no_match", until: null, reason: "no person or organization matches this address" };
  }
  if (!deals.length) {
    return {
      action: "proceed",
      until: null,
      reason: organization ? "no CRM deals; treat as new outreach" : "matched person has no linked organization or deals",
    };
  }
  const active = deals.filter((deal) => !["closed", "lost"].includes(deal.stage));
  if (!active.length) return { action: "skip", until: null, reason: "all deals closed or lost" };
  const judged = active.map((deal) => ({ deal, ...dealDecision(deal, today) }));
  const proceed = judged.find((entry) => entry.state === "proceed");
  if (proceed) {
    return { action: "proceed", until: null, reason: `${proceed.deal.title || proceed.deal.id}: ${proceed.reason}` };
  }
  const waits = judged.filter((entry) => entry.state === "waiting");
  return {
    action: "waiting",
    until: waits.map((entry) => entry.until).sort()[0] || null,
    reason: waits[0].reason,
  };
}

export async function runLookup(api, { email, domain } = {}) {
  const match = await resolveMatch(api, { email, domain });
  const rows = match.organization ? await dealRows(api, match.organization.id) : [];
  const deals = [];
  for (const row of rows) deals.push(publicDeal(row, await notesForDeal(api, row.id)));
  return {
    query: { ...(email ? { email } : {}), ...(domain ? { domain } : {}) },
    matchedVia: match.matchedVia,
    domain: match.domain,
    organization: match.organization ? publicOrg(match.organization) : null,
    people: match.people.map(publicPerson),
    deals,
    decision: decide({ people: match.people, organization: match.organization, deals }, berlinToday()),
  };
}

/**
 * Mark the matched deal "wait, revisit later" using the existing CRM model:
 * every open Task on the deal goes `waiting` with a follow-up date (so a stale
 * due task cannot shadow the marker); a deal without open Tasks gets one
 * waiting Task created against it.
 */
export async function runSetWait(api, { email, domain, until, reason, dealId } = {}) {
  const followUpAt = isoDate(until, "until");
  if (!followUpAt) throw new UsageError("--set-wait needs --until YYYY-MM-DD (or a relative date like +14d).");
  const trimmedReason = String(reason || "").trim();
  if (!trimmedReason) throw new UsageError("--set-wait needs --reason TEXT.");
  const waitingFor = trimmedReason.length > 160 ? `${trimmedReason.slice(0, 157)}...` : trimmedReason;

  const match = await resolveMatch(api, { email, domain });
  if (!match.organization && !match.people.length) {
    throw new ApiError(404, { error: "no CRM match for this address; nothing to mark waiting" }, "/api/sponsor-crm/directory/people");
  }
  if (!match.organization) {
    throw new UsageError("The matched people have no linked organization; --set-wait marks a deal, and there is none to pick.");
  }

  const orgLabel = match.organization.displayName || match.organization.name || match.organization.id;
  const rows = await dealRows(api, match.organization.id);
  let target;
  if (dealId) {
    target = rows.find((row) => row.id === dealId);
    if (!target) {
      throw new UsageError(`Deal ${dealId} does not belong to ${orgLabel}. Deals: ${rows.map((row) => row.id).join(", ") || "none"}.`);
    }
  } else {
    const active = rows.filter((row) => !["closed", "lost"].includes(row.stage));
    if (active.length === 0) {
      throw new UsageError(`${orgLabel} has no active deals. Deals: ${rows.map((row) => row.id).join(", ") || "none"}.`);
    }
    if (active.length > 1) {
      throw new UsageError(`${orgLabel} has several active deals (${active.map((row) => `${row.id} ${row.title || ""}`.trim()).join("; ")}); pass --deal-id.`);
    }
    target = active[0];
  }

  const deal = await api.get(`/api/sponsor-crm/deals/${enc(target.id)}`);
  const openTasks = Array.isArray(deal?.openTasks) ? deal.openTasks : [];
  const marked = [];
  for (const task of openTasks) {
    await api.post(`/api/tasks/${enc(task.id)}/actions/mark-waiting`, { waitingFor, followUpAt, channel: "other" });
    marked.push(task.id);
  }
  let createdTaskId = null;
  if (!openTasks.length) {
    const created = await api.post("/api/tasks", {
      description: `Waiting: ${trimmedReason}`,
      date: berlinToday(),
      status: "waiting",
      waitingFor,
      followUpAt,
      comment: trimmedReason,
      subject: { type: "sponsor-deal", id: target.id },
    });
    createdTaskId = created?.id || null;
  }
  return { dealId: target.id, dealTitle: target.title || null, markedTaskIds: marked, createdTaskId };
}
