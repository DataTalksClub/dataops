/**
 * `/api/offers`: DataTalks.Club commercial offers and sponsor rate card.
 *
 * All authenticated actors (including service tokens) can list and show offers
 * (`GET /api/offers`, `GET /api/offers/:slug`). Only admins can update the rate
 * card or individual packages (`PUT /api/offers`, `PUT /api/offers/:slug`).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  getOffersRecord,
  OffersConflictError,
  updateOffersRecord,
  upsertOfferPackage,
  type OffersRecordChanges,
} from '../db/offers';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { recordRequestError } from '../requestErrorLog';
import { realDate } from '../sponsorCrm/model';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

class OffersInputError extends Error {}

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parseBody(rawBody: string | null | undefined): Record<string, unknown> {
  if (!rawBody) throw new OffersInputError('A JSON body is required');
  try {
    const parsed = typeof rawBody === 'object' ? rawBody : JSON.parse(String(rawBody));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OffersInputError('Body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OffersInputError) throw error;
    throw new OffersInputError('Body is not valid JSON');
  }
}

function validateOptionalDate(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !realDate(value.trim())) {
    throw new OffersInputError(`${fieldName} must be a YYYY-MM-DD date or null`);
  }
  return value.trim();
}

function validatePackageInput(raw: unknown, indexLabel: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OffersInputError(`${indexLabel} must be an object`);
  }
  const rec = raw as Record<string, unknown>;
  const slug = String(rec.slug ?? rec.id ?? '').trim();
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new OffersInputError(`${indexLabel} requires a valid slug/id (letters, digits, "-", "_")`);
  }
  if (rec.name !== undefined && (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 200)) {
    throw new OffersInputError(`${indexLabel} name must be a non-empty string of at most 200 characters`);
  }
  if (rec.price !== undefined && rec.price !== null) {
    if (typeof rec.price === 'number') {
      if (!Number.isFinite(rec.price) || rec.price < 0) {
        throw new OffersInputError(`${indexLabel} price must be a non-negative number`);
      }
    } else if (typeof rec.price === 'object' && !Array.isArray(rec.price)) {
      const priceRec = rec.price as Record<string, unknown>;
      if (priceRec.amount !== undefined && priceRec.amount !== null) {
        if (typeof priceRec.amount !== 'number' || !Number.isFinite(priceRec.amount) || priceRec.amount < 0) {
          throw new OffersInputError(`${indexLabel} price.amount must be a non-negative number or null`);
        }
      }
      if (priceRec.currency !== undefined && priceRec.currency !== null) {
        if (typeof priceRec.currency !== 'string' || !/^[A-Za-z]{3}$/.test(priceRec.currency.trim())) {
          throw new OffersInputError(`${indexLabel} price.currency must be a 3-letter currency code like EUR or USD`);
        }
      }
      if (priceRec.range !== undefined && priceRec.range !== null) {
        if (typeof priceRec.range !== 'object' || Array.isArray(priceRec.range)) {
          throw new OffersInputError(`${indexLabel} price.range must be { min, max } or null`);
        }
        const rangeRec = priceRec.range as Record<string, unknown>;
        if (
          typeof rangeRec.min !== 'number'
          || typeof rangeRec.max !== 'number'
          || !Number.isFinite(rangeRec.min)
          || !Number.isFinite(rangeRec.max)
          || rangeRec.min < 0
          || rangeRec.max < rangeRec.min
        ) {
          throw new OffersInputError(`${indexLabel} price.range requires valid min <= max numbers`);
        }
      }
    } else {
      throw new OffersInputError(`${indexLabel} price must be an object, a non-negative number, or null`);
    }
  }
  for (const dateField of ['asOf', 'as_of', 'validFrom', 'valid_from', 'validUntil', 'valid_until']) {
    if (rec[dateField] !== undefined) {
      validateOptionalDate(rec[dateField], `${indexLabel}.${dateField}`);
    }
  }
  if (rec.validity !== undefined && rec.validity !== null) {
    if (typeof rec.validity !== 'object' || Array.isArray(rec.validity)) {
      throw new OffersInputError(`${indexLabel}.validity must be an object`);
    }
    const vRec = rec.validity as Record<string, unknown>;
    for (const dateField of ['asOf', 'as_of', 'validFrom', 'valid_from', 'validUntil', 'valid_until']) {
      if (vRec[dateField] !== undefined) {
        validateOptionalDate(vRec[dateField], `${indexLabel}.validity.${dateField}`);
      }
    }
  }
  return rec;
}

export async function handleOffersRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/offers')) return null;

  const isRead = method === 'GET';
  const resolution = await resolveInteractiveActor(client, event, isRead ? 'work-read' : 'work-write');
  if (!resolution.ok) return resolution.response;
  if (!isRead && !resolution.actor.isAdmin) {
    return workAdminForbidden('Admin access required to update offers');
  }

  const suffix = path.slice('/api/offers'.length);

  try {
    if (suffix === '' || suffix === '/') {
      if (method === 'GET') return await handleList(event, client);
      if (method === 'PUT') return await handleReplaceOrUpdateCard(event, client, resolution.actor.id);
      return json(405, { error: 'Method not allowed' });
    }

    const slugMatch = suffix.match(/^\/([^/]+)\/?$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      if (!SLUG_PATTERN.test(slug)) {
        return json(400, { error: 'Offer slug must be 1-64 characters of letters, digits, "-", "_"' });
      }
      if (method === 'GET') return await handleShowOffer(client, slug);
      if (method === 'PUT' || method === 'PATCH') {
        return await handleUpsertOffer(event, client, resolution.actor.id, slug);
      }
      return json(405, { error: 'Method not allowed' });
    }

    return json(404, { error: 'Not found' });
  } catch (error: unknown) {
    if (error instanceof OffersInputError) {
      return json(400, { error: error.message });
    }
    if (error instanceof OffersConflictError) {
      return json(409, {
        error: 'Offers rate card changed since you read it; reload and try again',
        code: 'version_conflict',
        current: await getOffersRecord(client),
      });
    }
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const record = await getOffersRecord(client);
  const channelFilter = event.queryStringParameters?.channel?.trim().toLowerCase();
  const tagFilter = event.queryStringParameters?.tag?.trim().toLowerCase();

  let offers = record.offers;
  if (channelFilter) {
    offers = offers.filter((item) => item.channels.some((ch) => ch.toLowerCase() === channelFilter));
  }
  if (tagFilter) {
    offers = offers.filter((item) => item.skill_tags.some((t) => t.toLowerCase() === tagFilter));
  }

  return json(200, {
    ...record,
    offers,
    packages: offers,
  });
}

async function handleShowOffer(client: DynamoDBDocumentClient, slug: string): Promise<LambdaResponse> {
  const record = await getOffersRecord(client);
  const offer = record.offers.find((item) => item.slug === slug || item.id === slug);
  if (offer) {
    return json(200, {
      ...offer,
      offer,
      package: offer,
      rateCardValidity: record.validity,
      version: record.version,
    });
  }
  const nonOffer = record.non_offers.find((item) => item.slug === slug);
  if (nonOffer) {
    return json(200, {
      ...nonOffer,
      non_offer: nonOffer,
      kind: 'non_offer',
      rateCardValidity: record.validity,
      version: record.version,
    });
  }
  return json(404, { error: `Offer '${slug}' not found` });
}

const ALLOWED_TOP_KEYS = new Set([
  'expectedVersion',
  'version',
  'meta',
  'validity',
  'offers',
  'packages',
  'non_offers',
  'inbound_routing',
  'title',
  'currency_default',
  'media_kit_url',
  'floor_eur',
  'rule',
  'as_of',
  'asOf',
  'valid_from',
  'validFrom',
  'valid_until',
  'validUntil',
]);

async function handleReplaceOrUpdateCard(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  actorId: string,
): Promise<LambdaResponse> {
  const body = parseBody(event.body);
  const rawExpected = body.expectedVersion ?? body.version;
  if (!Number.isInteger(rawExpected) || Number(rawExpected) < 0) {
    throw new OffersInputError('expectedVersion must be the offers record version you read (0 before the first save)');
  }
  const unknown = Object.keys(body).find((key) => !ALLOWED_TOP_KEYS.has(key));
  if (unknown) {
    throw new OffersInputError(`Unknown field '${unknown}'`);
  }

  const metaPatch: Record<string, unknown> = {};
  if (body.meta !== undefined) {
    if (!body.meta || typeof body.meta !== 'object' || Array.isArray(body.meta)) {
      throw new OffersInputError('meta must be an object');
    }
    Object.assign(metaPatch, body.meta);
  }
  for (const key of ['title', 'currency_default', 'media_kit_url', 'floor_eur', 'rule'] as const) {
    if (body[key] !== undefined) metaPatch[key] = body[key];
  }
  const validityPatch: Record<string, unknown> = {};
  if (body.validity !== undefined) {
    if (!body.validity || typeof body.validity !== 'object' || Array.isArray(body.validity)) {
      throw new OffersInputError('validity must be an object');
    }
    Object.assign(validityPatch, body.validity);
  }

  const asOfInput = body.as_of ?? body.asOf ?? validityPatch.asOf ?? validityPatch.as_of ?? metaPatch.as_of ?? metaPatch.asOf;
  if (asOfInput !== undefined) {
    const normalized = validateOptionalDate(asOfInput, 'as_of');
    metaPatch.as_of = normalized;
    validityPatch.asOf = normalized;
  }
  const validFromInput = body.valid_from ?? body.validFrom ?? validityPatch.validFrom ?? validityPatch.valid_from ?? metaPatch.valid_from ?? metaPatch.validFrom;
  if (validFromInput !== undefined) {
    const normalized = validateOptionalDate(validFromInput, 'valid_from');
    metaPatch.valid_from = normalized;
    validityPatch.validFrom = normalized;
  }
  const validUntilInput = body.valid_until ?? body.validUntil ?? validityPatch.validUntil ?? validityPatch.valid_until ?? metaPatch.valid_until ?? metaPatch.validUntil;
  if (validUntilInput !== undefined) {
    const normalized = validateOptionalDate(validUntilInput, 'valid_until');
    metaPatch.valid_until = normalized;
    validityPatch.validUntil = normalized;
  }

  if (
    typeof validityPatch.validFrom === 'string'
    && typeof validityPatch.validUntil === 'string'
    && validityPatch.validFrom > validityPatch.validUntil
  ) {
    throw new OffersInputError('valid_from must not be after valid_until');
  }

  const changes: OffersRecordChanges = {};
  if (Object.keys(metaPatch).length > 0) changes.meta = metaPatch;
  if (Object.keys(validityPatch).length > 0) changes.validity = validityPatch;

  const rawPackages = body.offers ?? body.packages;
  if (rawPackages !== undefined) {
    if (!Array.isArray(rawPackages)) {
      throw new OffersInputError('offers/packages must be an array');
    }
    const seen = new Set<string>();
    changes.offers = rawPackages.map((entry, idx) => {
      const validated = validatePackageInput(entry, `offers[${idx}]`);
      const slug = String(validated.slug ?? validated.id).trim();
      if (seen.has(slug)) {
        throw new OffersInputError(`Duplicate offer slug '${slug}'`);
      }
      seen.add(slug);
      return validated;
    });
  }

  if (body.non_offers !== undefined) {
    if (!Array.isArray(body.non_offers)) {
      throw new OffersInputError('non_offers must be an array');
    }
    changes.non_offers = body.non_offers as Array<Record<string, unknown>>;
  }

  if (body.inbound_routing !== undefined) {
    if (!Array.isArray(body.inbound_routing)) {
      throw new OffersInputError('inbound_routing must be an array');
    }
    changes.inbound_routing = body.inbound_routing as Array<Record<string, unknown>>;
  }

  if (Object.keys(changes).length === 0) {
    throw new OffersInputError('Nothing to change');
  }

  const updated = await updateOffersRecord(client, {
    changes,
    expectedVersion: Number(rawExpected),
    actorId: actorId || undefined,
  });
  return json(200, updated);
}

const ALLOWED_PACKAGE_KEYS = new Set([
  'expectedVersion',
  'version',
  'id',
  'slug',
  'name',
  'channels',
  'price',
  'priceEur',
  'price_eur',
  'priceUsd',
  'price_usd',
  'currency',
  'price_note',
  'notes',
  'validity',
  'asOf',
  'as_of',
  'validFrom',
  'valid_from',
  'validUntil',
  'valid_until',
  'deliverables',
  'when_to_offer',
  'when_to_deflect_elsewhere',
  'templates',
  'pitch_snippets',
  'does_not_offer',
  'evidence_strength',
  'skill_tags',
  'skillTags',
]);

async function handleUpsertOffer(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  actorId: string,
  slug: string,
): Promise<LambdaResponse> {
  const body = parseBody(event.body);
  const rawExpected = body.expectedVersion ?? body.version;
  if (!Number.isInteger(rawExpected) || Number(rawExpected) < 0) {
    throw new OffersInputError('expectedVersion must be the offers record version you read (0 before the first save)');
  }
  const unknown = Object.keys(body).find((key) => !ALLOWED_PACKAGE_KEYS.has(key));
  if (unknown) {
    throw new OffersInputError(`Unknown package field '${unknown}'`);
  }
  const { expectedVersion: _ev, version: _v, ...patch } = body;
  if (Object.keys(patch).length === 0) {
    throw new OffersInputError('Specify at least one package field to update');
  }
  validatePackageInput({ ...patch, slug }, `offer '${slug}'`);

  const { record, offer } = await upsertOfferPackage(client, {
    slug,
    patch,
    expectedVersion: Number(rawExpected),
    actorId: actorId || undefined,
  });

  return json(200, {
    ...offer,
    offer,
    package: offer,
    rateCardValidity: record.validity,
    version: record.version,
  });
}
