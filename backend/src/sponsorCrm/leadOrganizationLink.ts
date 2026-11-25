import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCrmRecords, updateCrmRecord, updateOrganizationAtomic, type CrmRecord } from '../db/sponsorCrm';
import { registrableDomain } from './model';

// Deterministic company linking for newsletter sponsor leads. A lead links to
// a CRM organization only on unique evidence:
//   - the sponsor URL's host is the organization's own domain (domains are
//     unique per organization), or
//   - the sponsor name equals exactly one active organization's display name
//     after whitespace/case normalization.
// When both signals exist they must agree. Anything else (several name
// matches, domain and name pointing at different companies, product or brand
// variants) is left unlinked for review. Never creates organizations or deals.

export type LeadLinkOutcome =
  | { kind: 'linked'; organization: CrmRecord; by: 'domain' | 'name' | 'domain+name' }
  | { kind: 'ambiguous'; reason: string; candidates: CrmRecord[] }
  | { kind: 'none' };

function normalizeName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function senderDomain(lead: CrmRecord): string | null {
  const newsletter = (lead.newsletter || {}) as Record<string, unknown>;
  const sender = String(newsletter.sender || '');
  const at = sender.lastIndexOf('@');
  return registrableDomain(at >= 0 ? sender.slice(at + 1).replace(/[>\s].*$/, '') : '');
}

export function matchLeadOrganization(lead: CrmRecord, organizations: CrmRecord[]): LeadLinkOutcome {
  const sponsor = (lead.sponsor || {}) as Record<string, unknown>;
  const active = organizations.filter((item) => !item.archivedAt);
  let domain = registrableDomain(sponsor.url);
  // A publisher's own domain says nothing about who sponsors its issue.
  if (domain && domain === senderDomain(lead)) domain = null;
  const byDomain = domain ? active.find((item) => String(item.domain || '').toLowerCase() === domain) : undefined;
  const name = normalizeName(sponsor.name);
  const byName = name ? active.filter((item) => normalizeName(item.displayName) === name) : [];

  if (byDomain && byName.length) {
    if (byName.length === 1 && byName[0].id === byDomain.id) return { kind: 'linked', organization: byDomain, by: 'domain+name' };
    return { kind: 'ambiguous', reason: 'domain and name point at different companies', candidates: [byDomain, ...byName.filter((item) => item.id !== byDomain.id)] };
  }
  if (byDomain) return { kind: 'linked', organization: byDomain, by: 'domain' };
  if (byName.length === 1) return { kind: 'linked', organization: byName[0], by: 'name' };
  if (byName.length > 1) return { kind: 'ambiguous', reason: 'several companies share this name', candidates: byName };
  return { kind: 'none' };
}

function sightingFrom(lead: CrmRecord) {
  const sponsor = (lead.sponsor || {}) as Record<string, unknown>;
  const newsletter = (lead.newsletter || {}) as Record<string, unknown>;
  return { leadId: lead.id, newsletter: newsletter.name || '', url: sponsor.url || '', blurb: sponsor.blurb || '', seenAt: lead.createdAt || new Date().toISOString() };
}

/** Link one lead to the organization; status and source evidence stay untouched. */
export async function linkLeadToOrganization(
  client: DynamoDBDocumentClient,
  lead: CrmRecord,
  organization: CrmRecord,
  actorId: string,
): Promise<{ lead: CrmRecord; organization: CrmRecord }> {
  const sightings = Array.isArray(organization.sightings) ? [...organization.sightings] : [];
  let current = organization;
  if (!sightings.some((item) => (item as { leadId?: string })?.leadId === lead.id)) {
    sightings.push(sightingFrom(lead));
    current = await updateOrganizationAtomic(client, organization, { sightings }, actorId, 'sighting');
  }
  const next = await updateCrmRecord(client, 'lead', lead, { organizationId: current.id });
  return { lead: next, organization: current };
}

export interface LeadLinkReport {
  dryRun: boolean;
  scanned: number;
  alreadyLinked: number;
  linked: number;
  ambiguous: number;
  unmatched: number;
  failed: number;
  examples: {
    linked: Array<{ leadId: string; sponsor: string; organizationId: string; organization: string; by: string }>;
    ambiguous: Array<{ leadId: string; sponsor: string; reason: string; candidates: Array<{ id: string; displayName: string }> }>;
  };
}

const EXAMPLE_LIMIT = 50;

/**
 * Link every unlinked lead that has one clear match. Idempotent: linked leads
 * are skipped, so reruns only touch what is still open. With dryRun nothing is
 * written. Reads organizations once; one lead failing never stops the rest.
 */
export async function reconcileLeadOrganizations(
  client: DynamoDBDocumentClient,
  options: { apply: boolean; actorId: string },
): Promise<LeadLinkReport> {
  const [leads, organizations] = await Promise.all([listCrmRecords(client, 'lead'), listCrmRecords(client, 'organization')]);
  const report: LeadLinkReport = { dryRun: !options.apply, scanned: leads.length, alreadyLinked: 0, linked: 0, ambiguous: 0, unmatched: 0, failed: 0, examples: { linked: [], ambiguous: [] } };
  const byId = new Map(organizations.map((item) => [item.id, item]));
  for (const lead of leads) {
    if (lead.organizationId) { report.alreadyLinked += 1; continue; }
    const outcome = matchLeadOrganization(lead, [...byId.values()]);
    const sponsorName = String(((lead.sponsor || {}) as Record<string, unknown>).name || '');
    if (outcome.kind === 'none') { report.unmatched += 1; continue; }
    if (outcome.kind === 'ambiguous') {
      report.ambiguous += 1;
      if (report.examples.ambiguous.length < EXAMPLE_LIMIT) report.examples.ambiguous.push({ leadId: lead.id, sponsor: sponsorName, reason: outcome.reason, candidates: outcome.candidates.map((item) => ({ id: item.id, displayName: String(item.displayName || '') })) });
      continue;
    }
    try {
      if (options.apply) {
        // Organizations change as sightings are appended; keep the fresh copy for later leads.
        const done = await linkLeadToOrganization(client, lead, byId.get(outcome.organization.id) || outcome.organization, options.actorId);
        byId.set(done.organization.id, done.organization);
      }
      report.linked += 1;
      if (report.examples.linked.length < EXAMPLE_LIMIT) report.examples.linked.push({ leadId: lead.id, sponsor: sponsorName, organizationId: outcome.organization.id, organization: String(outcome.organization.displayName || ''), by: outcome.by });
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
