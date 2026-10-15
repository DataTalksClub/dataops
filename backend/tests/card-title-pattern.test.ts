import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  cardTitlePatternIssues,
  newsletterSlotTitleValues,
  podcastEpisodeTitleValues,
  renderCardTitle,
  shortDate,
} from '../src/cards/cardTitlePattern';

const NEWSLETTER = '{date} · #{issue} · {sponsor} · {variant}';

describe('card title patterns', () => {
  it('renders a weekly issue and drops empty parts with their separators', () => {
    const weekly = { publicationDate: '2026-10-19', campaignNumber: 299, campaignLabel: 'Weekly #299', bookedByDisplayName: 'Synthetic Sponsor' };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterSlotTitleValues(weekly)), '19 Oct · #299 · Synthetic Sponsor');
    const unbooked = { ...weekly, bookedByDisplayName: undefined };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterSlotTitleValues(unbooked)), '19 Oct · #299');
  });

  it('names secondary and stand-alone sends, taking the issue from the label', () => {
    const secondary = { publicationDate: '2026-12-07', campaignLabel: 'Weekly #306 secondary slot', bookedByDisplayName: 'Synthetic Sponsor' };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterSlotTitleValues(secondary)), '7 Dec · #306 · Synthetic Sponsor · secondary');
    const standalone = { publicationDate: '2026-10-21', campaignLabel: 'Stand-Alone Newsletter', bookedByDisplayName: 'Synthetic Sponsor' };
    assert.strictEqual(renderCardTitle(NEWSLETTER, newsletterSlotTitleValues(standalone)), '21 Oct · Synthetic Sponsor · stand-alone');
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
