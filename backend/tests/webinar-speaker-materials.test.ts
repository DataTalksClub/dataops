import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSponsorDocTemplate, renderSponsorDocMarkdownExport, renderSponsorEmailDraft, validateSubmittedContent } from '../src/sponsorDocs/templates';

const content = { talkTitle: 'Practical pipelines', outline: '- Design\n- Build\n- Monitor', bio: 'A data engineer.' };

describe('webinar speaker materials validation', () => {
  it('requires title, outline and bio, and makes summary and links optional', () => {
    const fields = getSponsorDocTemplate('webinar').sections.flatMap((s) => s.fields);
    assert.deepEqual(fields.filter((f) => f.required).map((f) => f.key), ['talkTitle', 'outline', 'bio']);
    assert.doesNotThrow(() => validateSubmittedContent('webinar', content));
    for (const key of ['talkTitle', 'outline', 'bio']) {
      assert.throws(() => validateSubmittedContent('webinar', { ...content, [key]: '  ' }), /required/);
    }
  });
  it('requires 3–4 nonempty bullets and validates optional links', () => {
    for (const outline of ['one\ntwo', '- \n- \n- ', '1\n2\n3\n4\n5']) {
      assert.throws(() => validateSubmittedContent('webinar', { ...content, outline }), /non-empty bullets/);
    }
    assert.doesNotThrow(() => validateSubmittedContent('webinar', { ...content, outline: 'one\ntwo\nthree\nfour' }));
    for (const key of ['linkedinUrl', 'twitterUrl', 'githubUrl', 'websiteUrl']) {
      for (const value of ['example.test', 'javascript:alert(1)', 'ftp://example.test']) {
        assert.throws(() => validateSubmittedContent('webinar', { ...content, [key]: value }), /full http/);
      }
      assert.doesNotThrow(() => validateSubmittedContent('webinar', { ...content, [key]: 'https://example.test/profile' }));
    }
  });
  it('exports every supplied field and renders a speaker invite without sponsor or internal jargon', () => {
    const exported = renderSponsorDocMarkdownExport({ id: 'synthetic-doc', title: 'Speaker materials', template: 'webinar', sponsorName: 'Test Speaker', status: 'submitted', lastEditedAt: '2026-10-23', lastEditedBy: 'sponsor', content: { ...content, summary: 'A practical introduction', linkedinUrl: 'https://example.test/linkedin', twitterUrl: 'https://example.test/x', githubUrl: 'https://example.test/github', websiteUrl: 'https://example.test/site' } });
    for (const value of ['Practical pipelines', 'A practical introduction', '- Design', 'A data engineer.', '/linkedin', '/x', '/github', '/site', 'Speaker']) assert.ok(exported.includes(value));
    const draft = renderSponsorEmailDraft({ template: 'webinar', shareUrl: 'https://example.test/form', accessCode: 'synthetic' });
    assert.ok(draft.body.includes('https://example.test/form'));
    assert.doesNotMatch(draft.subject + draft.body + exported, /sponsor|\bhub\b/i);
  });
});
