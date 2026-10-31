/**
 * Commercial offers / sponsor rate-card record: one structured record in the
 * Users table (`SETTINGS#offers`) next to the workspace settings and company
 * profile.
 *
 * All authenticated actors (including service tokens) can read the rate card
 * and individual offer packages (`GET /api/offers`, `GET /api/offers/:slug`);
 * only admins can update or import offers (`PUT /api/offers`,
 * `PUT /api/offers/:slug`).
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';

const OFFERS_KEY = { PK: 'SETTINGS#offers', SK: 'SETTINGS#offers' } as const;

export interface OfferPriceRange {
  min: number;
  max: number;
}

export interface OfferPrice {
  amount: number | null;
  currency: string;
  range: OfferPriceRange | null;
  usd?: number | null;
}

export interface OfferPitchSnippet {
  text: string;
  thread_id?: string | null;
  message_id?: string | null;
  source?: string | null;
  note?: string | null;
}

export interface OfferValidity {
  asOf: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface OfferPackage {
  id: string;
  slug: string;
  name: string;
  channels: string[];
  price: OfferPrice | null;
  priceEur: number | null;
  priceUsd: number | null;
  currency: string | null;
  price_note: string | null;
  notes: string | null;
  validity: OfferValidity;
  deliverables: string[];
  when_to_offer: string[];
  when_to_deflect_elsewhere: string[];
  templates: string[];
  pitch_snippets: OfferPitchSnippet[];
  does_not_offer: string[];
  evidence_strength: string | null;
  skill_tags: string[];
}

export interface NonOfferItem {
  slug: string;
  name: string;
  response: string;
  templates: string[];
  evidence: Array<Record<string, unknown>>;
}

export interface InboundRoutingRule {
  inbound_type: string;
  offer_slugs: string[];
  notes?: string | null;
}

export interface OffersMeta {
  title: string;
  currency_default: string;
  media_kit_url: string;
  floor_eur: number | null;
  rule: string;
  as_of: string | null;
  valid_from: string | null;
  valid_until: string | null;
  corpus?: string | null;
  templates_dir?: string | null;
  related?: string[];
  generated_for?: string | null;
}

export interface OffersRecord {
  meta: OffersMeta;
  validity: OfferValidity;
  offers: OfferPackage[];
  packages: OfferPackage[];
  non_offers: NonOfferItem[];
  inbound_routing: InboundRoutingRule[];
  /** 0 until the record is first written. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export class OffersConflictError extends Error {
  constructor(readonly expectedVersion: number) {
    super(`Offers rate card changed since version ${expectedVersion}`);
    this.name = 'OffersConflictError';
  }
}

const DEFAULT_META: OffersMeta = Object.freeze({
  title: 'DataTalks.Club commercial offers',
  currency_default: 'EUR',
  media_kit_url: 'https://datatalks.club/mediakit/',
  floor_eur: 1000,
  rule: 'Never invent rates or packages not listed here or in the live media kit. Prefer kit link when unsure.',
  as_of: null,
  valid_from: null,
  valid_until: null,
});

const DEFAULT_CHANNELS_BY_SLUG: Record<string, readonly string[]> = Object.freeze({
  'media-kit': ['mediakit'],
  'newsletter-primary': ['newsletter', 'main'],
  'newsletter-secondary': ['newsletter', 'secondary'],
  'newsletter-standalone': ['newsletter', 'standalone'],
  'social-x-linkedin': ['social', 'x', 'linkedin'],
  'video-plus-substack': ['social', 'x', 'linkedin', 'substack'],
  'meetup-group-message': ['meetup', 'event'],
  'substack': ['substack'],
  'sponsored-blog-post': ['blog', 'website'],
  'website-link-placement': ['website'],
  'workshop-sponsor-delivers': ['workshop', 'youtube'],
  'workshop-alexey-delivers': ['workshop', 'youtube'],
  'course-mention-package': ['course', 'zoomcamp'],
  'package-volume': ['newsletter', 'workshop', 'package'],
  'in-person-berlin': ['event', 'in-person'],
});

export function defaultChannelsForSlug(slug: string, skillTags: string[] = []): string[] {
  const mapped = DEFAULT_CHANNELS_BY_SLUG[slug];
  if (mapped) return [...mapped];
  if (skillTags.length > 0) return [...skillTags];
  return slug ? [slug] : [];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizePrice(
  rawPrice: unknown,
  fallbackCurrency: string,
  explicitEur?: unknown,
  explicitUsd?: unknown,
): { price: OfferPrice | null; priceEur: number | null; priceUsd: number | null; currency: string | null } {
  const usdVal = typeof explicitUsd === 'number' && Number.isFinite(explicitUsd) ? explicitUsd : null;
  if (typeof rawPrice === 'number' && Number.isFinite(rawPrice)) {
    const currency = fallbackCurrency || 'EUR';
    return {
      price: { amount: rawPrice, currency, range: null, ...(usdVal !== null ? { usd: usdVal } : {}) },
      priceEur: currency === 'EUR' ? rawPrice : (typeof explicitEur === 'number' ? explicitEur : null),
      priceUsd: currency === 'USD' ? rawPrice : usdVal,
      currency,
    };
  }
  if (rawPrice && typeof rawPrice === 'object' && !Array.isArray(rawPrice)) {
    const rec = rawPrice as Record<string, unknown>;
    const amount = typeof rec.amount === 'number' && Number.isFinite(rec.amount) ? rec.amount : null;
    const currency = typeof rec.currency === 'string' && rec.currency.trim() ? rec.currency.trim().toUpperCase() : (fallbackCurrency || 'EUR');
    let range: OfferPriceRange | null = null;
    if (rec.range && typeof rec.range === 'object' && !Array.isArray(rec.range)) {
      const r = rec.range as Record<string, unknown>;
      if (typeof r.min === 'number' && typeof r.max === 'number' && Number.isFinite(r.min) && Number.isFinite(r.max)) {
        range = { min: r.min, max: r.max };
      }
    }
    const nestedUsd = typeof rec.usd === 'number' && Number.isFinite(rec.usd) ? rec.usd : usdVal;
    const price: OfferPrice = {
      amount,
      currency,
      range,
      ...(nestedUsd !== null ? { usd: nestedUsd } : {}),
    };
    const priceEur = currency === 'EUR'
      ? amount
      : (typeof explicitEur === 'number' && Number.isFinite(explicitEur) ? explicitEur : null);
    const priceUsd = currency === 'USD' ? amount : nestedUsd;
    return { price, priceEur, priceUsd, currency };
  }
  if (typeof explicitEur === 'number' && Number.isFinite(explicitEur)) {
    return {
      price: { amount: explicitEur, currency: 'EUR', range: null, ...(usdVal !== null ? { usd: usdVal } : {}) },
      priceEur: explicitEur,
      priceUsd: usdVal,
      currency: 'EUR',
    };
  }
  return { price: null, priceEur: null, priceUsd: usdVal, currency: null };
}

export function normalizeOfferPackage(
  raw: Record<string, unknown>,
  cardValidity: OfferValidity,
  defaultCurrency = 'EUR',
): OfferPackage {
  const slug = String(raw.slug || raw.id || '').trim();
  const name = String(raw.name || slug).trim();
  const skillTags = normalizeStringList(raw.skill_tags ?? raw.skillTags);
  const rawChannels = normalizeStringList(raw.channels);
  const channels = rawChannels.length > 0 ? rawChannels : defaultChannelsForSlug(slug, skillTags);

  const fallbackCurrency = typeof raw.currency === 'string' && raw.currency.trim()
    ? raw.currency.trim().toUpperCase()
    : defaultCurrency;
  const { price, priceEur, priceUsd, currency } = normalizePrice(
    raw.price,
    fallbackCurrency,
    raw.priceEur ?? raw.price_eur,
    raw.priceUsd ?? raw.price_usd,
  );

  const noteText = typeof raw.price_note === 'string' && raw.price_note.trim()
    ? raw.price_note.trim()
    : (typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null);

  const rawValidity = raw.validity && typeof raw.validity === 'object' && !Array.isArray(raw.validity)
    ? (raw.validity as Record<string, unknown>)
    : {};
  const asOf = typeof raw.asOf === 'string' ? raw.asOf
    : (typeof raw.as_of === 'string' ? raw.as_of
      : (typeof rawValidity.asOf === 'string' ? rawValidity.asOf
        : (typeof rawValidity.as_of === 'string' ? rawValidity.as_of : cardValidity.asOf)));
  const validFrom = typeof raw.validFrom === 'string' ? raw.validFrom
    : (typeof raw.valid_from === 'string' ? raw.valid_from
      : (typeof rawValidity.validFrom === 'string' ? rawValidity.validFrom
        : (typeof rawValidity.valid_from === 'string' ? rawValidity.valid_from : cardValidity.validFrom)));
  const validUntil = typeof raw.validUntil === 'string' ? raw.validUntil
    : (typeof raw.valid_until === 'string' ? raw.valid_until
      : (typeof rawValidity.validUntil === 'string' ? rawValidity.validUntil
        : (typeof rawValidity.valid_until === 'string' ? rawValidity.valid_until : cardValidity.validUntil)));

  const pitchSnippets: OfferPitchSnippet[] = Array.isArray(raw.pitch_snippets)
    ? raw.pitch_snippets
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s) && typeof (s as Record<string, unknown>).text === 'string')
      .map((s) => ({
        text: String(s.text),
        ...(s.thread_id !== undefined ? { thread_id: s.thread_id === null ? null : String(s.thread_id) } : {}),
        ...(s.message_id !== undefined ? { message_id: s.message_id === null ? null : String(s.message_id) } : {}),
        ...(typeof s.source === 'string' ? { source: s.source } : {}),
        ...(typeof s.note === 'string' ? { note: s.note } : {}),
      }))
    : [];

  return {
    id: slug,
    slug,
    name,
    channels,
    price,
    priceEur,
    priceUsd,
    currency: price ? price.currency : currency,
    price_note: noteText,
    notes: noteText,
    validity: {
      asOf: asOf || null,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
    },
    deliverables: normalizeStringList(raw.deliverables),
    when_to_offer: normalizeStringList(raw.when_to_offer),
    when_to_deflect_elsewhere: normalizeStringList(raw.when_to_deflect_elsewhere),
    templates: normalizeStringList(raw.templates),
    pitch_snippets: pitchSnippets,
    does_not_offer: normalizeStringList(raw.does_not_offer),
    evidence_strength: typeof raw.evidence_strength === 'string' && raw.evidence_strength.trim() ? raw.evidence_strength.trim() : null,
    skill_tags: skillTags,
  };
}

function normalizeMetaAndValidity(
  rawMeta: unknown,
  rawValidity: unknown,
  fallbackMeta: OffersMeta = DEFAULT_META,
): { meta: OffersMeta; validity: OfferValidity } {
  const m = (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta))
    ? (rawMeta as Record<string, unknown>)
    : {};
  const v = (rawValidity && typeof rawValidity === 'object' && !Array.isArray(rawValidity))
    ? (rawValidity as Record<string, unknown>)
    : {};

  const asOf = typeof v.asOf === 'string' && v.asOf.trim() ? v.asOf.trim()
    : (typeof v.as_of === 'string' && v.as_of.trim() ? v.as_of.trim()
      : (typeof m.as_of === 'string' && m.as_of.trim() ? m.as_of.trim()
        : (typeof m.asOf === 'string' && m.asOf.trim() ? m.asOf.trim() : fallbackMeta.as_of)));

  const validFrom = typeof v.validFrom === 'string' && v.validFrom.trim() ? v.validFrom.trim()
    : (typeof v.valid_from === 'string' && v.valid_from.trim() ? v.valid_from.trim()
      : (typeof m.valid_from === 'string' && m.valid_from.trim() ? m.valid_from.trim()
        : (typeof m.validFrom === 'string' && m.validFrom.trim() ? m.validFrom.trim() : fallbackMeta.valid_from)));

  const validUntil = typeof v.validUntil === 'string' && v.validUntil.trim() ? v.validUntil.trim()
    : (typeof v.valid_until === 'string' && v.valid_until.trim() ? v.valid_until.trim()
      : (typeof m.valid_until === 'string' && m.valid_until.trim() ? m.valid_until.trim()
        : (typeof m.validUntil === 'string' && m.validUntil.trim() ? m.validUntil.trim() : fallbackMeta.valid_until)));

  const meta: OffersMeta = {
    title: typeof m.title === 'string' && m.title.trim() ? m.title.trim() : fallbackMeta.title,
    currency_default: typeof m.currency_default === 'string' && m.currency_default.trim()
      ? m.currency_default.trim().toUpperCase()
      : fallbackMeta.currency_default,
    media_kit_url: typeof m.media_kit_url === 'string' && m.media_kit_url.trim()
      ? m.media_kit_url.trim()
      : fallbackMeta.media_kit_url,
    floor_eur: m.floor_eur === null
      ? null
      : (typeof m.floor_eur === 'number' && Number.isFinite(m.floor_eur) ? m.floor_eur : fallbackMeta.floor_eur),
    rule: typeof m.rule === 'string' && m.rule.trim() ? m.rule.trim() : fallbackMeta.rule,
    as_of: asOf || null,
    valid_from: validFrom || null,
    valid_until: validUntil || null,
    ...(typeof m.corpus === 'string' ? { corpus: m.corpus } : (fallbackMeta.corpus ? { corpus: fallbackMeta.corpus } : {})),
    ...(typeof m.templates_dir === 'string' ? { templates_dir: m.templates_dir } : (fallbackMeta.templates_dir ? { templates_dir: fallbackMeta.templates_dir } : {})),
    ...(Array.isArray(m.related) ? { related: normalizeStringList(m.related) } : (fallbackMeta.related ? { related: fallbackMeta.related } : {})),
    ...(typeof m.generated_for === 'string' ? { generated_for: m.generated_for } : (fallbackMeta.generated_for ? { generated_for: fallbackMeta.generated_for } : {})),
  };

  const validity: OfferValidity = {
    asOf: meta.as_of,
    validFrom: meta.valid_from,
    validUntil: meta.valid_until,
  };

  return { meta, validity };
}

function normalizeNonOffers(raw: unknown): NonOfferItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).slug === 'string')
    .map((item) => ({
      slug: String(item.slug).trim(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : String(item.slug).trim(),
      response: typeof item.response === 'string' ? item.response.trim() : '',
      templates: normalizeStringList(item.templates),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
        : [],
    }));
}

function normalizeInboundRouting(raw: unknown): InboundRoutingRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).inbound_type === 'string')
    .map((item) => ({
      inbound_type: String(item.inbound_type).trim(),
      offer_slugs: normalizeStringList(item.offer_slugs),
      ...(typeof item.notes === 'string' && item.notes.trim() ? { notes: item.notes.trim() } : {}),
    }));
}

export async function getOffersRecord(client: DynamoDBDocumentClient): Promise<OffersRecord> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_USERS,
    Key: OFFERS_KEY,
    ConsistentRead: true,
  }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) {
    const { meta, validity } = normalizeMetaAndValidity(undefined, undefined);
    return {
      meta,
      validity,
      offers: [],
      packages: [],
      non_offers: [],
      inbound_routing: [],
      version: 0,
    };
  }
  const { meta, validity } = normalizeMetaAndValidity(item.meta, item.validity);
  const rawOffers = Array.isArray(item.offers)
    ? item.offers
    : (Array.isArray(item.packages) ? item.packages : []);
  const offers = rawOffers
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => normalizeOfferPackage(entry, validity, meta.currency_default));
  return {
    meta,
    validity,
    offers,
    packages: offers,
    non_offers: normalizeNonOffers(item.non_offers),
    inbound_routing: normalizeInboundRouting(item.inbound_routing),
    version: Number(item.version) || 0,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
  };
}

export interface OffersRecordChanges {
  meta?: Record<string, unknown>;
  validity?: Record<string, unknown>;
  offers?: Array<Record<string, unknown>>;
  packages?: Array<Record<string, unknown>>;
  non_offers?: Array<Record<string, unknown>>;
  inbound_routing?: Array<Record<string, unknown>>;
}

export async function updateOffersRecord(
  client: DynamoDBDocumentClient,
  input: { changes: OffersRecordChanges; expectedVersion: number; actorId?: string },
): Promise<OffersRecord> {
  const current = await getOffersRecord(client);
  if (current.version !== input.expectedVersion) {
    throw new OffersConflictError(input.expectedVersion);
  }
  const mergedMetaInput = {
    ...current.meta,
    ...(input.changes.meta || {}),
  };
  const mergedValidityInput = {
    ...current.validity,
    ...(input.changes.validity || {}),
  };
  const { meta, validity } = normalizeMetaAndValidity(mergedMetaInput, mergedValidityInput, current.meta);

  const rawOffersInput = input.changes.offers ?? input.changes.packages;
  const offers = rawOffersInput !== undefined
    ? rawOffersInput.map((entry) => normalizeOfferPackage(entry, validity, meta.currency_default))
    : current.offers.map((entry) => normalizeOfferPackage(entry as unknown as Record<string, unknown>, validity, meta.currency_default));

  const nonOffers = input.changes.non_offers !== undefined
    ? normalizeNonOffers(input.changes.non_offers)
    : current.non_offers;

  const inboundRouting = input.changes.inbound_routing !== undefined
    ? normalizeInboundRouting(input.changes.inbound_routing)
    : current.inbound_routing;

  const next: OffersRecord = {
    meta,
    validity,
    offers,
    packages: offers,
    non_offers: nonOffers,
    inbound_routing: inboundRouting,
    version: input.expectedVersion + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };

  try {
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: { ...OFFERS_KEY, ...next },
      ConditionExpression: input.expectedVersion === 0
        ? 'attribute_not_exists(PK)'
        : '#version = :expectedVersion',
      ...(input.expectedVersion === 0 ? {} : {
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': input.expectedVersion },
      }),
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new OffersConflictError(input.expectedVersion);
    }
    throw error;
  }

  return next;
}

export async function upsertOfferPackage(
  client: DynamoDBDocumentClient,
  input: {
    slug: string;
    patch: Record<string, unknown>;
    expectedVersion: number;
    actorId?: string;
  },
): Promise<{ record: OffersRecord; offer: OfferPackage }> {
  const current = await getOffersRecord(client);
  if (current.version !== input.expectedVersion) {
    throw new OffersConflictError(input.expectedVersion);
  }
  const existingIndex = current.offers.findIndex((item) => item.slug === input.slug || item.id === input.slug);
  const base = existingIndex >= 0
    ? (current.offers[existingIndex] as unknown as Record<string, unknown>)
    : { slug: input.slug, id: input.slug, name: input.slug };

  const normalizedPatch: Record<string, unknown> = { ...input.patch };
  if (Object.hasOwn(normalizedPatch, 'notes') && !Object.hasOwn(normalizedPatch, 'price_note')) {
    normalizedPatch.price_note = normalizedPatch.notes;
  } else if (Object.hasOwn(normalizedPatch, 'price_note') && !Object.hasOwn(normalizedPatch, 'notes')) {
    normalizedPatch.notes = normalizedPatch.price_note;
  }

  const mergedRaw: Record<string, unknown> = {
    ...base,
    ...normalizedPatch,
    slug: input.slug,
    id: input.slug,
  };
  const updatedOffer = normalizeOfferPackage(mergedRaw, current.validity, current.meta.currency_default);
  const nextOffers = [...current.offers];
  if (existingIndex >= 0) {
    nextOffers[existingIndex] = updatedOffer;
  } else {
    nextOffers.push(updatedOffer);
  }

  const record = await updateOffersRecord(client, {
    changes: {
      offers: nextOffers as unknown as Array<Record<string, unknown>>,
    },
    expectedVersion: input.expectedVersion,
    actorId: input.actorId,
  });
  const saved = record.offers.find((item) => item.slug === input.slug) || updatedOffer;
  return { record, offer: saved };
}
