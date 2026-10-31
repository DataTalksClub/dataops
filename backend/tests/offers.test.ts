import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import { truncateTestTables } from './helpers/db';
import type { LambdaResponse } from '../src/types';

function invoke(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  query?: Record<string, string>,
): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
    queryStringParameters: query || null,
  };
  return handler(event, {});
}

const ADMIN_ID = 'offers-admin-0001';
const OPERATOR_ID = 'offers-operator-01';
const adminHeaders = { 'x-user-id': ADMIN_ID };
const operatorHeaders = { 'x-user-id': OPERATOR_ID };

const SAMPLE_RATE_CARD = {
  meta: {
    title: 'DataTalks.Club commercial offers',
    currency_default: 'EUR',
    media_kit_url: 'https://datatalks.club/mediakit/',
    floor_eur: 1000,
    rule: 'Never invent rates or packages not listed here or in the live media kit.',
    as_of: '2026-10-19',
    valid_from: '2026-01-01',
    valid_until: '2026-12-31',
  },
  offers: [
    {
      slug: 'newsletter-primary',
      name: 'Newsletter primary (main) slot',
      price: { amount: 1500, currency: 'EUR', range: null },
      price_note: '2026 live rate card / INDEX',
      deliverables: ['Primary/main slot in weekly newsletter (typically Monday)'],
      when_to_offer: ['They ask newsletter or primary pricing'],
      when_to_deflect_elsewhere: ['Vague ask -> media-kit first'],
      templates: ['reply.pricing-newsletter'],
      pitch_snippets: [{ text: 'For the main slot it is 1500 Eur.', thread_id: null }],
      does_not_offer: [],
      evidence_strength: 'high',
      skill_tags: ['newsletter', 'sponsor'],
    },
    {
      slug: 'workshop-sponsor-delivers',
      name: 'Workshop (sponsor delivers, Alexey hosts)',
      price: { amount: 5000, currency: 'EUR', range: null },
      price_note: '5000 Eur if sponsor delivers',
      deliverables: ['Workshop on DTC channel / YouTube'],
      when_to_offer: ['YouTube / webinar / deep product demo'],
      when_to_deflect_elsewhere: [],
      templates: ['reply.pricing-workshop'],
      pitch_snippets: [],
      does_not_offer: [],
      evidence_strength: 'high',
      skill_tags: ['workshop', 'youtube', 'sponsor'],
    },
  ],
  non_offers: [
    {
      slug: 'no-free-organic',
      name: 'Free / organic editorial',
      response: 'Direct no; send media kit',
      templates: ['reply.no-free-organic'],
      evidence: [{ thread_id: '1a0f637146fbf2c7' }],
    },
  ],
  inbound_routing: [
    {
      inbound_type: 'newsletter_pricing',
      offer_slugs: ['newsletter-primary'],
    },
  ],
};

describe('API — Commercial offers & rate card (/api/offers)', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
  });

  afterEach(async () => {
    await truncateTestTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
  });

  after(async () => {
    await stopLocal();
  });

  it('starts at version 0 and round-trips rate card with packages, prices, and validity', async () => {
    const initialRes = await invoke('GET', '/api/offers', undefined, operatorHeaders);
    assert.equal(initialRes.statusCode, 200);
    const initial = JSON.parse(initialRes.body);
    assert.equal(initial.version, 0);
    assert.deepEqual(initial.offers, []);
    assert.deepEqual(initial.packages, []);

    const putRes = await invoke('PUT', '/api/offers', { ...SAMPLE_RATE_CARD, expectedVersion: 0 }, adminHeaders);
    assert.equal(putRes.statusCode, 200);
    const saved = JSON.parse(putRes.body);
    assert.equal(saved.version, 1);
    assert.equal(saved.validity.asOf, '2026-10-19');
    assert.equal(saved.validity.validFrom, '2026-01-01');
    assert.equal(saved.validity.validUntil, '2026-12-31');
    assert.equal(saved.offers.length, 2);
    assert.equal(saved.packages.length, 2);
    assert.equal(saved.offers[0].id, 'newsletter-primary');
    assert.equal(saved.offers[0].slug, 'newsletter-primary');
    assert.equal(saved.offers[0].priceEur, 1500);
    assert.deepEqual(saved.offers[0].channels, ['newsletter', 'main']);
    assert.equal(saved.offers[0].validity.validFrom, '2026-01-01');
    assert.equal(saved.non_offers.length, 1);
    assert.equal(saved.inbound_routing.length, 1);

    // Operator can read list and show
    const listRes = await invoke('GET', '/api/offers', undefined, operatorHeaders, { channel: 'newsletter' });
    assert.equal(listRes.statusCode, 200);
    const filtered = JSON.parse(listRes.body);
    assert.equal(filtered.offers.length, 1);
    assert.equal(filtered.offers[0].slug, 'newsletter-primary');

    const showRes = await invoke('GET', '/api/offers/newsletter-primary', undefined, operatorHeaders);
    assert.equal(showRes.statusCode, 200);
    const shown = JSON.parse(showRes.body);
    assert.equal(shown.slug, 'newsletter-primary');
    assert.equal(shown.price.amount, 1500);
    assert.equal(shown.offer.slug, 'newsletter-primary');
    assert.equal(shown.package.slug, 'newsletter-primary');

    const nonOfferRes = await invoke('GET', '/api/offers/no-free-organic', undefined, operatorHeaders);
    assert.equal(nonOfferRes.statusCode, 200);
    const nonOffer = JSON.parse(nonOfferRes.body);
    assert.equal(nonOffer.kind, 'non_offer');
    assert.equal(nonOffer.slug, 'no-free-organic');

    const missingRes = await invoke('GET', '/api/offers/nonexistent-sku', undefined, operatorHeaders);
    assert.equal(missingRes.statusCode, 404);
  });

  it('allows admin single-package updates and enforces optimistic concurrency and admin role', async () => {
    await invoke('PUT', '/api/offers', { ...SAMPLE_RATE_CARD, expectedVersion: 0 }, adminHeaders);

    // Operator cannot update rate card or single package
    const opDeniedCard = await invoke('PUT', '/api/offers', { floor_eur: 1200, expectedVersion: 1 }, operatorHeaders);
    assert.equal(opDeniedCard.statusCode, 403);
    const opDeniedPkg = await invoke('PUT', '/api/offers/newsletter-primary', { price: 1600, expectedVersion: 1 }, operatorHeaders);
    assert.equal(opDeniedPkg.statusCode, 403);

    // Admin updates single package
    const pkgRes = await invoke(
      'PUT',
      '/api/offers/newsletter-primary',
      {
        price: { amount: 1600, currency: 'EUR', range: null, usd: 1750 },
        notes: 'Updated 2026 primary rate',
        validFrom: '2026-02-01',
        expectedVersion: 1,
      },
      adminHeaders,
    );
    assert.equal(pkgRes.statusCode, 200);
    const updatedPkg = JSON.parse(pkgRes.body);
    assert.equal(updatedPkg.version, 2);
    assert.equal(updatedPkg.price.amount, 1600);
    assert.equal(updatedPkg.priceEur, 1600);
    assert.equal(updatedPkg.priceUsd, 1750);
    assert.equal(updatedPkg.notes, 'Updated 2026 primary rate');
    assert.equal(updatedPkg.validity.validFrom, '2026-02-01');

    // Stale version fails with 409
    const staleRes = await invoke('PUT', '/api/offers/newsletter-primary', { price: 1700, expectedVersion: 1 }, adminHeaders);
    assert.equal(staleRes.statusCode, 409);
  });
});
