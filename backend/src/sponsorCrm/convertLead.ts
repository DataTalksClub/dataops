import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  createOrganizationAtomic,
  getCrmRecord,
  listCrmRecords,
  updateCrmRecord,
  updateOrganizationAtomic,
  type CrmRecord,
} from '../db/sponsorCrm';
import { registrableDomain } from './model';

export type ConvertBody = {
  version: unknown;
  status?: unknown;
  organizationId?: unknown;
  createNew?: unknown;
};

export type ConvertResult =
  | { ok: true; lead: CrmRecord; organization: CrmRecord; created: boolean }
  | { ok: false; statusCode: number; error: string; candidates?: Array<{ id: string; displayName: string; domain?: string }> };

function sightingFrom(lead: CrmRecord) {
  const sponsor = (lead.sponsor || {}) as Record<string, unknown>;
  const newsletter = (lead.newsletter || {}) as Record<string, unknown>;
  return {
    leadId: lead.id,
    newsletter: newsletter.name || '',
    url: sponsor.url || '',
    blurb: sponsor.blurb || '',
    seenAt: lead.createdAt || new Date().toISOString(),
  };
}

function appendSighting(organization: CrmRecord, lead: CrmRecord) {
  const existing = Array.isArray(organization.sightings) ? [...organization.sightings] : [];
  if (existing.some((item) => item && typeof item === 'object' && (item as { leadId?: string }).leadId === lead.id)) {
    return existing;
  }
  existing.push(sightingFrom(lead));
  return existing;
}

export async function convertLead(
  client: DynamoDBDocumentClient,
  lead: CrmRecord,
  body: ConvertBody,
  actorId: string,
): Promise<ConvertResult> {
  const sponsor = (lead.sponsor || {}) as Record<string, unknown>;
  const domain = registrableDomain(sponsor.url);
  const organizations = await listCrmRecords(client, 'organization');
  const active = organizations.filter((item) => !item.archivedAt);
  const byDomain = domain ? active.find((item) => String(item.domain || '') === domain) : undefined;
  const requestedId = typeof body.organizationId === 'string' ? body.organizationId : '';
  const createNew = body.createNew === true;
  const name = String(sponsor.name || '').trim() || 'Untitled sponsor';

  if (domain && byDomain) {
    if (requestedId && requestedId !== byDomain.id) {
      return { ok: false, statusCode: 409, error: 'Domain already belongs to another company' };
    }
    const sightings = appendSighting(byDomain, lead);
    const organization = await updateOrganizationAtomic(client, byDomain, { sightings }, actorId, 'sighting');
    const next = await updateCrmRecord(client, 'lead', lead, { status: 'converted', organizationId: organization.id });
    return { ok: true, lead: next, organization, created: false };
  }

  if (domain && !byDomain) {
    if (requestedId) {
      const existing = await getCrmRecord(client, 'organization', requestedId);
      if (!existing || existing.archivedAt) return { ok: false, statusCode: 422, error: 'Invalid organization reference' };
      if (existing.domain && existing.domain !== domain) {
        return { ok: false, statusCode: 409, error: 'Organization domain does not match lead' };
      }
      const organization = await updateOrganizationAtomic(client, existing, { domain, sightings: appendSighting(existing, lead) }, actorId, 'sighting');
      const next = await updateCrmRecord(client, 'lead', lead, { status: 'converted', organizationId: organization.id });
      return { ok: true, lead: next, organization, created: false };
    }
    const created = await createOrganizationAtomic(client, {
      displayName: name,
      domain,
      sourceType: 'lead-convert',
      sightings: [sightingFrom(lead)],
      sourceKey: `lead-domain:${domain}`,
    }, actorId);
    const next = await updateCrmRecord(client, 'lead', lead, { status: 'converted', organizationId: created.item.id });
    return { ok: true, lead: next, organization: created.item, created: !created.duplicate };
  }

  if (requestedId) {
    const existing = await getCrmRecord(client, 'organization', requestedId);
    if (!existing || existing.archivedAt) return { ok: false, statusCode: 422, error: 'Invalid organization reference' };
    const organization = await updateOrganizationAtomic(client, existing, { sightings: appendSighting(existing, lead) }, actorId, 'sighting');
    const next = await updateCrmRecord(client, 'lead', lead, { status: 'converted', organizationId: organization.id });
    return { ok: true, lead: next, organization, created: false };
  }

  if (createNew) {
    const created = await createOrganizationAtomic(client, {
      displayName: name,
      sourceType: 'lead-convert',
      sightings: [sightingFrom(lead)],
      sourceKey: `lead-new:${lead.id}`,
    }, actorId);
    const next = await updateCrmRecord(client, 'lead', lead, { status: 'converted', organizationId: created.item.id });
    return { ok: true, lead: next, organization: created.item, created: !created.duplicate };
  }

  const needle = name.toLowerCase();
  const candidates = active
    .filter((item) => String(item.displayName || '').toLowerCase() === needle)
    .map((item) => ({ id: item.id, displayName: String(item.displayName || ''), domain: item.domain ? String(item.domain) : undefined }));
  return { ok: false, statusCode: 409, error: 'organization-picker-required', candidates };
}
