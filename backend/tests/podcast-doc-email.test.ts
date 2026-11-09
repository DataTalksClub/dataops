import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSponsorEmailDraft } from '../src/sponsorDocs/templates';

const base = { sponsorName: 'Sofiia Hordiienko', publicationDate: '2026-11-20 15:00', shareUrl: 'https://example.test/doc', accessCode: 'code-1' };

describe('podcast doc emails', () => {
  it('renders a guest email for the episode brief', () => {
    const { body } = renderSponsorEmailDraft({ ...base, template: 'podcast-episode-brief', recipientName: 'Sofiia Hordiienko' });
    assert.match(body, /Hi Sofiia,/);
    assert.match(body, /episode brief with the structure and questions for 2026-11-20 15:00/);
    assert.match(body, /https:\/\/example\.test\/doc/);
    assert.match(body, /code-1/);
    assert.match(body, /any changes/);
    assert.doesNotMatch(body, /Hi team|staff-only|Internal/);
  });

  it('falls back to the guest name on the doc, then to a neutral greeting, never a placeholder', () => {
    const fromDoc = renderSponsorEmailDraft({ ...base, template: 'podcast-episode-brief' }).body;
    assert.match(fromDoc, /^Hi Sofiia,/);
    const neutral = renderSponsorEmailDraft({ ...base, sponsorName: null, template: 'podcast-episode-brief' }).body;
    assert.match(neutral, /^Hi there,/);
    assert.doesNotMatch(neutral, /<NAME>/);
  });

  for (const template of ['podcast-guest-research', 'podcast-run-sheet'] as const) {
    it(`keeps staff wording for ${template}`, () => {
      const { body } = renderSponsorEmailDraft({ ...base, template });
      assert.match(body, /Hi team,/);
      assert.match(body, /staff-only working document/);
    });
  }
});
