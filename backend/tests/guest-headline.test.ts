import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guestHeadline, guestHeadlineProblem } from '../src/guestHeadline';
import { getSponsorDocTemplate, validateSubmittedContent, SponsorDocValidationError } from '../src/sponsorDocs/templates';

describe('guest headline rule', () => {
  it('accepts a short plain title or company and refuses blanks, links, long and multi-line values', () => {
    assert.equal(guestHeadlineProblem('Job title', ' AI Engineer '), '');
    assert.equal(guestHeadlineProblem('Company', 'Booking.com'), '');
    assert.equal(guestHeadlineProblem('Company', 'DataTalks.Club'), '');
    assert.equal(guestHeadlineProblem('Job title', '   '), 'Job title is required.');
    assert.equal(guestHeadlineProblem('Company', 'https://ibm.com'), 'Company must be plain text, not a link.');
    assert.equal(guestHeadlineProblem('Company', 'www.ibm.com'), 'Company must be plain text, not a link.');
    assert.equal(guestHeadlineProblem('Company', 'linkedin.com/company/ibm'), 'Company must be plain text, not a link.');
    assert.equal(guestHeadlineProblem('Job title', 'x'.repeat(81)), 'Job title must be at most 80 characters.');
    assert.equal(guestHeadlineProblem('Job title', 'x'.repeat(80)), '');
    assert.equal(guestHeadlineProblem('Job title', 'Engineer\nat IBM'), 'Job title must be a single line.');
  });

  it('forms the website headline only from both parts', () => {
    assert.equal(guestHeadline(' AI Engineer ', 'IBM'), 'AI Engineer at IBM');
    assert.equal(guestHeadline('AI Engineer', ''), '');
    assert.equal(guestHeadline(undefined, 'IBM'), '');
  });

  for (const key of ['webinar', 'workshop', 'podcast'] as const) {
    it(`the ${key} guest form requires a job title and company before submit`, () => {
      const fields = getSponsorDocTemplate(key).sections.filter((s) => !s.internal).flatMap((s) => s.fields);
      for (const name of ['jobTitle', 'company']) {
        const field = fields.find((f) => f.key === name);
        assert.ok(field, `${key} has ${name}`);
        assert.equal(field!.required, true);
        assert.equal(field!.format, 'headline');
        assert.equal(field!.maxCharsHint, 80);
      }
      assert.throws(() => validateSubmittedContent(key, {}), (error: unknown) => {
        assert.ok(error instanceof SponsorDocValidationError);
        assert.equal(error.fields.jobTitle, 'Job title is required.');
        assert.equal(error.fields.company, 'Company is required.');
        return true;
      });
    });
  }

  it('the podcast name field no longer asks for role and company in one line', () => {
    const guestName = getSponsorDocTemplate('podcast').sections.flatMap((s) => s.fields).find((f) => f.key === 'guestName');
    assert.equal(guestName?.label, 'Your name');
  });
});
