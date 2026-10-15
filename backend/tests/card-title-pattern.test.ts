import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  cardTitlePatternIssues,
  newsletterIssueTitleValues,
  podcastEpisodeTitleValues,
  renderCardTitle,
  shortDate,
} from '../src/cards/cardTitlePattern';

const NEWSLETTER = '{date} · #{issue} · {sponsors} · {variant}';

describe('card title patterns', () => {
  it('renders a weekly issue and drops empty parts with their separators', () => {
    const weekly = {
      kind: 'weekly', publicationDate: '2026-10-19', issueNumber: 299,
      slots: { primary: { ticked: true, sponsor: 'Synthetic Sponsor' }, secondary: { ticked: false } },
    };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterIssueTitleValues(weekly)), '19 Oct · #299 · Synthetic Sponsor');
    const unbooked = { ...weekly, slots: { primary: { ticked: true } } };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterIssueTitleValues(unbooked)), '19 Oct · #299');
  });

  it('names both slot sponsors of one issue, and stand-alone sends', () => {
    const both = {
      kind: 'weekly', publicationDate: '2026-10-05', issueNumber: 297,
      slots: { primary: { ticked: true, sponsor: 'Sponsor A' }, secondary: { ticked: true, sponsor: 'Sponsor B' } },
    };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterIssueTitleValues(both)), '5 Oct · #297 · Sponsor A + Sponsor B');
    assert.strictEqual(newsletterIssueTitleValues(both).sponsor, 'Sponsor A');
    const secondaryOnly = { ...both, slots: { primary: { ticked: true }, secondary: { ticked: true, sponsor: 'Sponsor B' } } };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterIssueTitleValues(secondaryOnly)), '5 Oct · #297 · Sponsor B');
    const standalone = { kind: 'standalone', publicationDate: '2026-10-21', slots: { primary: { ticked: true, sponsor: 'Synthetic Sponsor' } } };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterIssueTitleValues(standalone)), '21 Oct · Synthetic Sponsor · stand-alone');
  });

  it('renders podcast episode values', () => {
    const values = podcastEpisodeTitleValues({ season: 24, episode: 3, title: 'Synthetic topic', guests: [{ name: 'Ada' }, { name: 'Grace' }], recordingDate: '2027-01-05' });
    assert.strictEqual(renderCardTitle('{code} · {title} · {guests}', values), 'S24E3 · Synthetic topic · Ada & Grace');
    assert.strictEqual(renderCardTitle('{code} · {title}', { ...values, code: '' }), 'Synthetic topic');
  });

  it('formats dates without the year and ignores malformed ones', () => {
    assert.strictEqual(shortDate('2027-01-05'), '5 Jan');
    assert.strictEqual(shortDate(''), '');
    assert.strictEqual(shortDate('soon'), '');
  });

  it('validates tokens against the record that links the template', () => {
    assert.deepStrictEqual(cardTitlePatternIssues('newsletter', NEWSLETTER), []);
    assert.deepStrictEqual(cardTitlePatternIssues('newsletter-standalone', '{date} · {sponsor}'), []);
    assert.deepStrictEqual(cardTitlePatternIssues('podcast', '{code} · {title} · {guests} · {date}'), []);
    assert.match(cardTitlePatternIssues('newsletter', '{date} · {title}')[0], /token \{title\} is unknown/);
    assert.match(cardTitlePatternIssues('webinar', '{date}')[0], /only supported/);
    assert.match(cardTitlePatternIssues('newsletter', '{date')[0], /unbalanced brace/);
    assert.match(cardTitlePatternIssues('newsletter', '')[0], /non-empty string/);
  });
});
