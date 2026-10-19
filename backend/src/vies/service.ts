/**
 * VAT validation policy, one entry point per caller:
 *
 * - `checkVatId` validates one VAT ID string (structure, then cache, then
 *   the VIES service) and records the outcome.
 * - `evaluateOrganization` decides what an EU B2B customer's VAT state
 *   means for compliance (blocking issue / flagged / ok).
 * - `evaluateDealVat` resolves a deal to its customer organization.
 * - `preflightOrganizations` is the report run before a bookkeeping pack
 *   leaves for the tax office: every EU customer, last known state, and
 *   what is missing or stale. Cached-only; the network refresh is an
 *   explicit follow-up (`refreshPreflight`).
 *
 * An `unavailable` outcome never counts as a validity answer: VIES being
 * down degrades to a warning, a definitive invalid answer blocks.
 */

import { getCrmRecord, listCrmRecords, type CrmRecord } from '../db/sponsorCrm';
import { lookupVies } from './client';
import { isEuMemberState, normalizeVatId, splitVatId } from './format';
import { getViesCheck, putViesCheck, type ViesCheck } from './store';

export type ViesLookup = typeof lookupVies;
export type ViesCheckOptions = { force?: boolean; cachedOnly?: boolean; lookup?: ViesLookup };

type ViesClient = Parameters<typeof getViesCheck>[0];

/**
 * Definitive outcomes stay fresh. Recheck-on-change falls out of the keying:
 * a changed VAT ID is a different record, so the cache misses and VIES runs.
 */
function isFresh(check: ViesCheck): boolean {
  return check.status !== 'unavailable';
}

function formatFailure(raw: string, error: string): ViesCheck {
  return {
    id: raw, recordType: 'vies-check', vatId: raw, country: '', number: '',
    status: 'invalid', source: 'vies', error: `format-${error}`,
    checkedAt: new Date().toISOString(), version: 0, createdAt: '', updatedAt: '',
  };
}

/**
 * Validate one VAT ID and persist the outcome. Structure-only failures
 * (missing prefix, wrong format) return an unpersisted invalid check: there
 * is no member-state number for VIES to confirm, and organization writes
 * reject them before they are stored.
 */
export async function checkVatId(client: ViesClient, raw: string, options: ViesCheckOptions = {}): Promise<ViesCheck> {
  const vatId = normalizeVatId(raw);
  const split = splitVatId(vatId);
  if ('error' in split) return formatFailure(vatId, split.error);
  const cached = await getViesCheck(client, vatId);
  if (options.cachedOnly) return cached || formatFailure(vatId, 'never-checked');
  if (cached && !options.force && isFresh(cached)) return cached;
  const answer = await (options.lookup || lookupVies)(split.country, split.number);
  const base = {
    vatId, country: split.country, number: split.number, source: 'vies' as const,
    checkedAt: new Date().toISOString(),
  };
  if (answer.kind === 'valid') {
    return putViesCheck(client, {
      ...base, recordType: 'vies-check', status: 'valid',
      ...(answer.name ? { name: answer.name } : {}),
      ...(answer.address ? { address: answer.address } : {}),
      ...(answer.responseDate ? { responseDate: answer.responseDate } : {}),
    });
  }
  if (answer.kind === 'not-found') {
    return putViesCheck(client, {
      ...base, recordType: 'vies-check', status: 'not-found',
      ...(answer.error ? { error: answer.error } : {}),
    });
  }
  return putViesCheck(client, {
    ...base, recordType: 'vies-check', status: 'unavailable', error: answer.error,
  });
}

export type VatBlocking = {
  reason: 'missing-vat-id' | 'malformed-vat-id' | 'invalid' | 'not-found';
  message: string;
};

export type OrganizationVatEvaluation = {
  /** Reverse charge applies: an EU B2B customer outside Germany. */
  required: boolean;
  organizationId: string;
  displayName?: string;
  country?: string;
  vatId?: string;
  check?: ViesCheck;
  blocking?: VatBlocking;
  warning?: { reason: 'vies-unavailable' | 'stale'; message: string };
};

/**
 * Whether a VAT check is required for a customer: a known EU member state
 * other than Germany, or any VAT ID at all (the ID's prefix implies the
 * member state). Domestic and non-EU customers are out of scope.
 */
export function vatRequired(organization: Record<string, unknown>): boolean {
  const country = typeof organization.country === 'string' ? organization.country.toUpperCase() : '';
  if (country) return isEuMemberState(country) && country !== 'DE';
  return typeof organization.vatId === 'string' && Boolean(organization.vatId.trim());
}

/** Read the last recorded check for an organization's VAT ID; no network. */
export async function lastViesCheck(client: ViesClient, organization: Record<string, unknown>): Promise<ViesCheck | null> {
  const vatId = normalizeVatId(String(organization.vatId || ''));
  return vatId ? getViesCheck(client, vatId) : null;
}

export async function evaluateOrganization(
  client: ViesClient,
  organization: CrmRecord,
  options: ViesCheckOptions = {},
): Promise<OrganizationVatEvaluation> {
  const evaluation: OrganizationVatEvaluation = {
    required: vatRequired(organization),
    organizationId: String(organization.id),
    ...(organization.displayName ? { displayName: String(organization.displayName) } : {}),
    ...(typeof organization.country === 'string' && organization.country ? { country: organization.country } : {}),
    ...(typeof organization.vatId === 'string' && organization.vatId ? { vatId: normalizeVatId(organization.vatId) } : {}),
  };
  if (!evaluation.required) return evaluation;
  if (!evaluation.vatId) {
    return {
      ...evaluation,
      blocking: {
        reason: 'missing-vat-id',
        message: 'EU B2B reverse charge requires a VAT ID: set one on the customer record before invoicing',
      },
    };
  }
  const check = await checkVatId(client, evaluation.vatId, options);
  const evaluated: OrganizationVatEvaluation = { ...evaluation, check };
  if (check.status === 'valid') return evaluated;
  if (check.status === 'unavailable') {
    return {
      ...evaluated,
      warning: { reason: 'vies-unavailable', message: `VIES could not confirm ${evaluation.vatId}: ${check.error || 'unavailable'}` },
    };
  }
  if (check.error?.startsWith('format-')) {
    if (check.error === 'format-never-checked') {
      return { ...evaluated, check: undefined, warning: { reason: 'stale', message: `${evaluation.vatId} has never been checked against VIES` } };
    }
    return {
      ...evaluated,
      blocking: { reason: 'malformed-vat-id', message: `${evaluation.vatId} is not a valid VAT ID format (${check.error.replace('format-', '')})` },
    };
  }
  return {
    ...evaluated,
    blocking: {
      reason: check.status === 'not-found' ? 'not-found' : 'invalid',
      message: `VIES reports ${evaluation.vatId} as ${check.status === 'not-found' ? 'not registered' : 'invalid'}: correct the customer's VAT ID before invoicing`,
    },
  };
}

export async function evaluateDealVat(client: ViesClient, dealId: string, options: ViesCheckOptions = {}): Promise<OrganizationVatEvaluation | null> {
  const deal = await getCrmRecord(client, 'deal', dealId);
  const organizationId = String(deal?.organizationId || '');
  if (!organizationId) return null;
  const organization = await getCrmRecord(client, 'organization', organizationId);
  if (!organization) return null;
  return evaluateOrganization(client, organization, options);
}

export type ViesPreflightFlag = 'missing-vat-id' | 'malformed-vat-id' | 'invalid' | 'not-found' | 'unavailable' | 'stale';

export type ViesPreflightEntry = OrganizationVatEvaluation & { flags: ViesPreflightFlag[] };

/**
 * Last-known VAT state for every in-scope customer organization. Never
 * touches the network: entries whose VAT ID has no recorded outcome are
 * flagged stale for an explicit refresh pass instead.
 */
export async function preflightOrganizations(client: Parameters<typeof listCrmRecords>[0]): Promise<{ scanned: number; entries: ViesPreflightEntry[] }> {
  const organizations = (await listCrmRecords(client, 'organization')).filter(
    (organization) => !organization.archivedAt && vatRequired(organization),
  );
  const entries: ViesPreflightEntry[] = [];
  for (const organization of organizations) {
    const evaluation = await evaluateOrganization(client, organization, { cachedOnly: true });
    const flags: ViesPreflightFlag[] = [];
    if (evaluation.blocking) flags.push(evaluation.blocking.reason);
    if (!evaluation.blocking && evaluation.vatId) {
      if (!evaluation.check) flags.push('stale');
      else if (evaluation.check.status === 'invalid') flags.push('invalid');
      else if (evaluation.check.status === 'not-found') flags.push('not-found');
      else if (evaluation.check.status === 'unavailable') flags.push('unavailable');
    }
    entries.push({ ...evaluation, flags });
  }
  return { scanned: organizations.length, entries };
}

/**
 * Refresh pass behind the preflight: re-run VIES for every entry whose
 * outcome is missing, stale or indefinite. Bounded per call so one request
 * cannot turn into an unbounded synchronous batch.
 */
export async function refreshPreflight(
  client: ViesClient,
  entries: ViesPreflightEntry[],
  options: { lookup?: ViesLookup; limit?: number } = {},
): Promise<{ refreshed: number }> {
  const limit = options.limit ?? 50;
  let refreshed = 0;
  for (const entry of entries) {
    if (refreshed >= limit) break;
    if (!entry.vatId) continue;
    if (entry.check && entry.check.status !== 'unavailable') continue;
    await checkVatId(client, entry.vatId, { lookup: options.lookup });
    refreshed += 1;
  }
  return { refreshed };
}
