import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  issueBelongsTo,
  issueNewsletter,
  issueSponsors,
  matchNewsletterBySender,
  newsletterIssueRecord,
  newsletterIssueStats,
  receiptPatch,
  validateNewsletterIssue,
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

describe('newsletter issues', () => {
  const weekly = { id: 'n1', name: 'Example Weekly', slug: 'example-weekly', senders: ['weekly@news.example.invalid'] };
  const digest = { id: 'n2', name: 'Example Digest', slug: 'example-digest', senders: [] };
  const newsletters = [weekly, digest];

  it('validates issue payloads', () => {
    const valid = { issueKey: 'news.example.invalid/p/1', title: 'Issue 1', publishedAt: '2026-10-01', source: 'public-archive' };
    assert.equal(validateNewsletterIssue(valid), '');
    assert.equal(validateNewsletterIssue({ ...valid, issueKey: '' }), 'Invalid issueKey');
    assert.equal(validateNewsletterIssue({ ...valid, publishedAt: '2026-02-30' }), 'Invalid publishedAt');
    assert.equal(validateNewsletterIssue({ ...valid, url: 'http://news.example.invalid/p/1' }), 'Invalid url');
    assert.equal(validateNewsletterIssue({ ...valid, source: 'rss' }), 'Invalid source');
    assert.equal(validateNewsletterIssue({ ...valid, sender: 'nope' }), 'Invalid sender');
  });

  it('links issues by id, then sender, then unique name', () => {
    const record = newsletterIssueRecord(weekly, { issueKey: 'k1', title: 'One', publishedAt: '2026-10-01', source: 'inbox' });
    assert.equal(record.newsletterId, 'n1');
    assert.equal(record.sourceKey, 'issue:k1');
    assert.equal(issueNewsletter(newsletters, 'weekly@news.example.invalid', 'Whatever'), weekly);
    assert.equal(issueNewsletter(newsletters, 'other@news.example.invalid', 'Example Digest'), digest);
    assert.equal(issueNewsletter(newsletters, 'other@news.example.invalid', 'Unknown'), null);
    const unlinked = { issueKey: 'k2', sender: 'other@news.example.invalid', newsletterName: 'Example Digest' };
    assert.equal(issueBelongsTo(unlinked, digest, newsletters), true);
    assert.equal(issueBelongsTo(unlinked, weekly, newsletters), false);
    assert.equal(issueBelongsTo({ ...unlinked, newsletterId: 'n1' }, weekly, newsletters), true);
  });

  it('derives sponsors and stats from leads keyed by the issue', () => {
    const issues = [
      { issueKey: 'k1', publishedAt: '2026-10-01' },
      { issueKey: 'k2', publishedAt: '2026-10-08' },
    ];
    const leads = [
      { id: 'l1', messageId: 'k1', status: 'new', sponsor: { name: 'Acme', url: 'https://acme.example.invalid' } },
      { id: 'l2', messageId: 'k1', status: 'converted', organizationId: 'o1', sponsor: { name: 'Beta' } },
      { id: 'l3', messageId: 'elsewhere', status: 'new', sponsor: { name: 'Acme' } },
    ];
    assert.deepEqual(issueSponsors(issues[0], leads).map((item) => [item.leadId, item.name, item.organizationId]), [
      ['l1', 'Acme', undefined],
      ['l2', 'Beta', 'o1'],
    ]);
    assert.deepEqual(issueSponsors(issues[1], leads), []);
    assert.deepEqual(newsletterIssueStats(issues, leads), {
      issueCount: 2,
      lastIssueAt: '2026-10-08',
      issuesWithoutSponsors: 1,
      sponsorSightings: 2,
      sponsors: [{ name: 'Acme', count: 1 }, { name: 'Beta', count: 1 }],
    });
  });

  it('moves the latest receipt forward only for newer issues and learns senders', () => {
    const record = { senders: ['weekly@news.example.invalid'], lastReceivedAt: '2026-10-08T08:00:00Z', lastMessageId: 'm2' };
    const receipt = { sender: 'Weekly@News.example.invalid', subject: 'Three', receivedAt: '2026-10-15T08:00:00Z', messageId: 'm3' };
    assert.deepEqual(receiptPatch(record, receipt), {
      lastReceivedAt: '2026-10-15T08:00:00Z',
      lastSender: 'weekly@news.example.invalid',
      lastSubject: 'Three',
      lastMessageId: 'm3',
    });
    assert.equal(receiptPatch(record, { ...receipt, receivedAt: '2026-10-01T08:00:00Z' }), null);
    assert.deepEqual(receiptPatch(record, { ...receipt, sender: 'new@news.example.invalid', receivedAt: '2026-10-01T08:00:00Z' }), {
      senders: ['weekly@news.example.invalid', 'new@news.example.invalid'],
    });
  });
});
