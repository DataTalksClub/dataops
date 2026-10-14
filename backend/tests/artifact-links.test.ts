import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  externalLinkKey,
  normalizeExternalTitle,
  normalizeExternalUrl,
  parseLinkText,
} from '../src/artifactLinks';

describe('artifact links', () => {
  it('recovers the target from Markdown and broken Markdown link text', () => {
    assert.deepEqual(parseLinkText('[Doc](https://example.com/a "‌")'), { url: 'https://example.com/a', label: 'Doc' });
    assert.equal(normalizeExternalUrl('https://luma.com/x](https://luma.com/x'), 'https://luma.com/x');
    assert.equal(
      normalizeExternalUrl('https://www.meetup.com/g/events/1/?slug=g&isFirstPublish=true]'),
      'https://www.meetup.com/g/events/1/',
    );
    assert.equal(
      normalizeExternalUrl('https://docs.google.com/document/d/1I\\_Lc/edit?usp=sharing&urp=gmail_link'),
      'https://docs.google.com/document/d/1I_Lc/edit',
    );
    assert.equal(normalizeExternalUrl('https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
    assert.equal(normalizeExternalUrl('content/process.md'), null);
    assert.equal(normalizeExternalUrl('not a link'), null);
  });

  it('keys links that open the same page together', () => {
    assert.equal(
      externalLinkKey('https://docs.google.com/document/d/abc/edit?tab=t.k#heading=h.1'),
      externalLinkKey('https://docs.google.com/document/d/abc/edit'),
    );
    assert.equal(externalLinkKey('https://www.linkedin.com/in/a/'), externalLinkKey('https://linkedin.com/in/a'));
    assert.notEqual(externalLinkKey('https://luma.com/a'), externalLinkKey('https://luma.com/b'));
  });

  it('keeps operator labels and replaces URL-shaped titles with the clean URL', () => {
    assert.equal(normalizeExternalTitle('Speaker profile', 'https://linkedin.com/in/a'), 'Speaker profile');
    assert.equal(normalizeExternalTitle('https://luma.com/x](https://luma.com/x', 'https://luma.com/x'), 'https://luma.com/x');
    assert.equal(normalizeExternalTitle('', 'https://luma.com/x'), 'https://luma.com/x');
  });
});
