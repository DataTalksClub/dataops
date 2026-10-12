import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  matchNewsletterBySender,
  newsletterGraceDays,
  newsletterHealth,
  slugifyNewsletter,
  sortNewsletters,
  validateNewsletter,
} from '../src/sponsorCrm/newsletters';

describe('newsletter health', () => {
  it('maps cadence to a grace window and derived delivery health', () => {
    assert.equal(newsletterGraceDays(1), 3);
    assert.equal(newsletterGraceDays(7), 11);
    assert.equal(newsletterHealth({ subscriptionStatus: 'pending' }, '2026-10-12'), 'pending');
    assert.equal(newsletterHealth({
      subscriptionStatus: 'subscribed',
      expectedIntervalDays: 7,
      subscribedAt: '2026-10-10',
    }, '2026-10-12'), 'waiting');
    assert.equal(newsletterHealth({
      subscriptionStatus: 'subscribed',
      expectedIntervalDays: 7,
      subscribedAt: '2026-09-01',
    }, '2026-10-12'), 'missing');
    assert.equal(newsletterHealth({
      subscriptionStatus: 'subscribed',
      expectedIntervalDays: 7,
      lastReceivedAt: '2026-10-08T12:00:00Z',
    }, '2026-10-12'), 'current');
    assert.equal(newsletterHealth({
      subscriptionStatus: 'subscribed',
      expectedIntervalDays: 7,
      lastReceivedAt: '2026-09-20',
    }, '2026-10-12'), 'overdue');
  });

  it('sorts attention rows first and matches a unique sender', () => {
    const rows = sortNewsletters([
      { id: 'ok', name: 'Current Weekly', subscriptionStatus: 'subscribed', expectedIntervalDays: 7, lastReceivedAt: '2026-10-10' },
      { id: 'late', name: 'Quiet Weekly', subscriptionStatus: 'subscribed', expectedIntervalDays: 7, lastReceivedAt: '2026-09-01' },
      { id: 'sign', name: 'Pending Sign-in', subscriptionStatus: 'pending', expectedIntervalDays: 7 },
    ], '2026-10-12');
    assert.deepEqual(rows.map((item) => item.id), ['late', 'sign', 'ok']);
    assert.equal(matchNewsletterBySender([
      { id: 'dew', senders: ['dataengineeringweekly@substack.com'] },
      { id: 'elixir', senders: ['lon@dataelixir.com'] },
    ], 'Lon@DataElixir.com')?.id, 'elixir');
    assert.equal(matchNewsletterBySender([
      { id: 'dew', senders: ['shared@example.invalid'] },
      { id: 'elixir', senders: ['shared@example.invalid'] },
    ], 'shared@example.invalid'), null);
  });

  it('rejects invalid create payloads and slugifies names', () => {
    assert.equal(slugifyNewsletter('The AI Collective Newsletter'), 'the-ai-collective-newsletter');
    assert.equal(validateNewsletter({
      name: 'Example Digest',
      url: 'https://digest.example.invalid/archive',
      expectedIntervalDays: 7,
      subscriptionStatus: 'subscribed',
    }), '');
    assert.equal(validateNewsletter({
      name: 'Example Digest',
      url: 'http://digest.example.invalid/archive',
      expectedIntervalDays: 7,
      subscriptionStatus: 'subscribed',
    }), 'Invalid url');
  });
});
