import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitCombinedGuestIdentity } from '../src/sponsorDocs/guestIdentity';
import {
  getSponsorDocTemplate,
  renderSponsorDocMarkdownExport,
  SponsorDocValidationError,
  validateSubmittedContent,
} from '../src/sponsorDocs/templates';

describe('splitCombinedGuestIdentity', () => {
  it('splits "Name Role / Company" without comma (the Jordan Taylor case)', () => {
    assert.deepEqual(
      splitCombinedGuestIdentity('Jordan Taylor Forward Deployed Engineer / Eliza'),
      {
        guestName: 'Jordan Taylor',
        guestRole: 'Forward Deployed Engineer',
        guestCompany: 'Eliza',
        ambiguous: false,
      },
    );
  });

  it('splits "Name, Role at Company" and "Name, Role @ Company"', () => {
    assert.deepEqual(
      splitCombinedGuestIdentity('Jane Doe, VP of Data Engineering at Acme'),
      {
        guestName: 'Jane Doe',
        guestRole: 'VP of Data Engineering',
        guestCompany: 'Acme',
        ambiguous: false,
      },
    );
    assert.deepEqual(
      splitCombinedGuestIdentity('Julien Khaleghy, CTO @ CrawlCo'),
      {
        guestName: 'Julien Khaleghy',
        guestRole: 'CTO',
        guestCompany: 'CrawlCo',
        ambiguous: false,
      },
    );
  });

  it('splits "Name, Role / Company" and parenthetical forms', () => {
    assert.deepEqual(
      splitCombinedGuestIdentity('Jane Doe, Staff Engineer / Acme'),
      {
        guestName: 'Jane Doe',
        guestRole: 'Staff Engineer',
        guestCompany: 'Acme',
        ambiguous: false,
      },
    );
    assert.deepEqual(
      splitCombinedGuestIdentity('Jane Doe (Staff Engineer at Acme)'),
      {
        guestName: 'Jane Doe',
        guestRole: 'Staff Engineer',
        guestCompany: 'Acme',
        ambiguous: false,
      },
    );
  });

  it('preserves plain names and never drops text on ambiguous strings', () => {
    assert.deepEqual(
      splitCombinedGuestIdentity('Sofiia Hordiienko'),
      { guestName: 'Sofiia Hordiienko', guestRole: '', guestCompany: '', ambiguous: false },
    );
    const ambiguous = splitCombinedGuestIdentity('Some unusual unpunctuated multi word entry here');
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.guestName, 'Some unusual unpunctuated multi word entry here');
    assert.equal(ambiguous.guestRole, '');
    assert.equal(ambiguous.guestCompany, '');
  });
});

describe('podcast templates split guest identity fields', () => {
  it('defines Name, Role, and Company with maxChars hints on all four podcast templates', () => {
    for (const key of ['podcast', 'podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'] as const) {
      const fields = getSponsorDocTemplate(key).sections.flatMap((s) => s.fields);
      for (const [fieldKey, label] of [['guestName', 'Name'], ['guestRole', 'Role'], ['guestCompany', 'Company']] as const) {
        const f = fields.find((item) => item.key === fieldKey);
        assert.ok(f, `${key} should define ${fieldKey}`);
        assert.equal(f.label, label);
        assert.equal(f.maxCharsHint, 120);
        assert.equal(f.maxChars, 120);
      }
    }
  });

  it('validates maxChars on Name, Role, and Company on submit', () => {
    const over = 'x'.repeat(121);
    assert.throws(
      () => validateSubmittedContent('podcast', { guestName: over, guestRole: over, guestCompany: over }),
      (err: unknown) => err instanceof SponsorDocValidationError
        && Boolean(err.fields.guestName)
        && Boolean(err.fields.guestRole)
        && Boolean(err.fields.guestCompany),
    );
  });

  it('renders Name, Role, and Company in Markdown exports for all four podcast templates', () => {
    for (const template of ['podcast', 'podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'] as const) {
      const md = renderSponsorDocMarkdownExport({
        id: 'sdoc-1',
        title: 'Episode Title',
        template,
        status: 'draft',
        lastEditedAt: '2026-11-25T10:00:00.000Z',
        lastEditedBy: 'staff',
        content: {
          guestName: 'Jordan Taylor',
          guestRole: 'Forward Deployed Engineer',
          guestCompany: 'Eliza',
        },
      });
      assert.ok(md.includes('**Name:** Jordan Taylor'), `${template} missing Name`);
      assert.ok(md.includes('**Role:** Forward Deployed Engineer'), `${template} missing Role`);
      assert.ok(md.includes('**Company:** Eliza'), `${template} missing Company`);
    }
  });
});
