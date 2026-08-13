import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { isSponsorCommunicationRoute, route } from '../src/router';

const communicationRoutes = [
  '/api/sponsor-crm/communications/config',
  '/api/sponsor-crm/communications/evaluate',
  '/api/sponsor-crm/bookings/booking-1/communications',
  '/api/sponsor-crm/bookings/communications/communications',
  '/api/sponsor-crm/bookings/finance/communications',
  '/api/sponsor-crm/bookings/attempts/communications',
  '/api/sponsor-crm/bookings/%63ommunications/communications',
  '/api/sponsor-crm/communication-suggestions/suggestion-1/drafts',
  '/api/sponsor-crm/communications/communication-1/presentations',
  '/api/sponsor-crm/communications/communication-1/approve',
  '/api/sponsor-crm/communications/suppressions/presentations',
  '/api/sponsor-crm/communications/attempts/approve',
  '/api/sponsor-crm/communications/communication-1/presentations/presentation-1/reject',
  '/api/sponsor-crm/communications/attempts/attempt-1/cancel',
  '/api/sponsor-crm/communications/attempts/attempt-1/reconcile',
  '/api/sponsor-crm/contacts/contact-1/suppressions',
];

describe('sponsor route dispatch', () => {
  it('matches every reviewed-communication route family exactly', () => {
    for (const pathname of communicationRoutes) {
      assert.equal(
        isSponsorCommunicationRoute(pathname),
        true,
        `expected communication dispatch for ${pathname}`,
      );
    }
  });

  it('does not treat opaque booking IDs or encoded IDs as route families', () => {
    const financePaths = [
      '/api/sponsor-crm/bookings/communications/finance',
      '/api/sponsor-crm/bookings/finance/finance',
      '/api/sponsor-crm/bookings/attempts/finance',
      '/api/sponsor-crm/bookings/%63ommunications/finance',
      '/api/sponsor-crm/bookings/opaque%3Abooking/finance',
      '/api/sponsor-crm/bookings/opaque%2Fcommunications/finance',
    ];
    for (const pathname of financePaths) {
      assert.equal(
        isSponsorCommunicationRoute(pathname),
        false,
        `finance path was hijacked by communication dispatch: ${pathname}`,
      );
    }
  });

  it('dispatches colliding opaque booking IDs to the finance handler', async () => {
    const previous = process.env.SPONSOR_FINANCE_ENABLED;
    process.env.SPONSOR_FINANCE_ENABLED = 'false';
    try {
      for (const bookingId of [
        'communications',
        'finance',
        'attempts',
        '%63ommunications',
        'opaque%3Abooking',
        'opaque%2Fcommunications',
      ]) {
        const response = await route({
          httpMethod: 'GET',
          path: `/api/sponsor-crm/bookings/${bookingId}/finance`,
          headers: {},
          queryStringParameters: null,
          body: null,
        }, {} as DynamoDBDocumentClient);
        assert.equal(response.statusCode, 404);
        assert.deepEqual(
          JSON.parse(response.body),
          { error: 'Finance follow-through is disabled' },
          `wrong route handler for opaque booking ID ${bookingId}`,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.SPONSOR_FINANCE_ENABLED;
      else process.env.SPONSOR_FINANCE_ENABLED = previous;
    }
  });
});
