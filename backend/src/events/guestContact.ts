import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord } from '../db/sponsorCrm';

export interface GuestContactInput {
  guestEmail?: unknown;
  guestName?: unknown;
  guestPersonId?: unknown;
  guestContactId?: unknown;
  guestReference?: unknown;
}

export interface ResolvedGuestContact {
  email?: string;
  name?: string;
  reference?: { kind: 'contact'; id: string };
}

export class GuestContactInputError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'invalid_guest_contact') {
    super(message);
    this.name = 'GuestContactInputError';
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const blocked = (record: Record<string, unknown>) => Boolean(record.doNotContact
  || (Array.isArray(record.tags) && record.tags.includes('do-not-contact')));

/** CRM People are CONTACT projections. Public website speaker profiles have no private email. */
export async function resolveGuestContact(
  client: DynamoDBDocumentClient,
  input: GuestContactInput,
): Promise<ResolvedGuestContact> {
  let email: string | undefined;
  if (input.guestEmail !== undefined && input.guestEmail !== '') {
    if (typeof input.guestEmail !== 'string' || input.guestEmail.trim().length > 254 || !EMAIL.test(input.guestEmail.trim())) {
      throw new GuestContactInputError('guestEmail must be a valid email address');
    }
    email = input.guestEmail.trim().toLowerCase();
  }
  let name: string | undefined;
  if (input.guestName !== undefined && input.guestName !== '') {
    if (typeof input.guestName !== 'string' || input.guestName.length > 200 || /[\r\n]/.test(input.guestName)) {
      throw new GuestContactInputError('guestName must be a single-line name of at most 200 characters');
    }
    name = input.guestName.trim() || undefined;
  }
  const references = [input.guestPersonId, input.guestContactId].filter(value => value !== undefined && value !== '');
  if (input.guestReference !== undefined) {
    const ref = input.guestReference;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || !['person', 'contact'].includes(String((ref as Record<string, unknown>).kind))) {
      throw new GuestContactInputError('guestReference must identify a saved CRM person or contact');
    }
    references.push((ref as Record<string, unknown>).id);
  }
  if (!references.length) return { ...(email ? { email } : {}), ...(name ? { name } : {}) };
  if (references.some(value => typeof value !== 'string' || !ID.test(value.trim()))) {
    throw new GuestContactInputError('The saved guest reference must be a valid CRM id');
  }
  const ids = [...new Set((references as string[]).map(value => value.trim()))];
  if (ids.length !== 1) throw new GuestContactInputError('Guest references identify different saved contacts');
  const contact = await getCrmRecord(client, 'contact', ids[0]);
  if (!contact) throw new GuestContactInputError('Saved guest contact not found', 404, 'guest_contact_not_found');
  if (contact.archivedAt || contact.active === false) {
    throw new GuestContactInputError('The saved guest contact is inactive', 422, 'guest_contact_inactive');
  }
  const company = typeof contact.organizationId === 'string'
    ? await getCrmRecord(client, 'organization', contact.organizationId) : null;
  if (blocked(contact) || (company && blocked(company))) {
    throw new GuestContactInputError('The saved guest is marked do not contact', 422, 'guest_contact_blocked');
  }
  const savedEmail = Array.isArray(contact.emails)
    ? contact.emails.find(value => typeof value === 'string' && value.trim().length <= 254 && EMAIL.test(value.trim())) : undefined;
  // Only the structured email list is a source. Notes, social links and plain Card.people names are not.
  email ||= typeof savedEmail === 'string' ? savedEmail.trim().toLowerCase() : undefined;
  name ||= typeof contact.name === 'string' ? contact.name.trim() || undefined : undefined;
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), reference: { kind: 'contact', id: ids[0] } };
}
