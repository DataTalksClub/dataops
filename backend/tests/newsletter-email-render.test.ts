import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blockRows, blockText, markdownBlocks, renderIssueEmail } from '../src/newsletter/emailRender';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures/newsletter-relay-golden.json'), 'utf8')) as {
  subject: string;
  preheader: string;
  webViewUrl: string;
  forwardUrl: string;
  blocks: { type: string; data: Record<string, string>; rowsSha256: string }[];
  htmlSha256: string;
};

describe('newsletter email renderer (DataOps port of Relay layout)', () => {
  it('renders every block of issue #302 byte for byte like Relay did', () => {
    for (const [index, block] of golden.blocks.entries()) {
      assert.strictEqual(sha(blockRows(block.type, block.data)), block.rowsSha256, `block ${index} (${block.type})`);
    }
  });

  it('fills the #302 shell exactly like Relay (subject, preheader, intro, sections, footer)', () => {
    const email = renderIssueEmail({
      subject: golden.subject,
      previewText: golden.preheader,
      blocks: golden.blocks.map(({ type, data }) => ({ type, data })),
      webViewUrl: golden.webViewUrl,
    });
    const comparable = email.html.replace(/mailto:\?subject=[^"]*/, golden.forwardUrl);
    assert.strictEqual(sha(comparable), golden.htmlSha256);
  });

  it('escapes raw HTML in Markdown and keeps only http(s)/mailto links', () => {
    assert.deepStrictEqual(markdownBlocks('<img src=x onerror=alert(1)> [a](javascript:x) [b](https://ok.example/?a=1&b=2) [c](mailto:x@y.z)'), [
      '<p>&lt;img src=x onerror=alert(1)&gt; <a href="#" target="_blank">a</a> <a href="https://ok.example/?a=1&amp;b=2" target="_blank">b</a> <a href="mailto:x@y.z" target="_blank">c</a></p>',
    ]);
    const injected = markdownBlocks('[x](https://a.co/`"onmouseover="alert(1)//`)')[0];
    assert.ok(!/<a [^>]*onmouseover/.test(injected), injected);
    assert.deepStrictEqual(markdownBlocks('one\ntwo\n\n- a\n- b'), ['<p>one<br/>two</p>', '<ul><li><p>a</p></li><li><p>b</p></li></ul>']);
  });

  it('writes the plain-text part with links in brackets and the CTA', () => {
    const text = blockText('sponsor', { title: 'T', body: 'See [docs](https://d.example).', cta_text: 'Go', cta_url: 'https://g.example' });
    assert.strictEqual(text, `SPONSORED\n\n\n** T\n${'-'.repeat(60)}\n\nSee docs (https://d.example).\n\nGo (https://g.example)`);
  });

  it('is deterministic: the same draft always gives the same bytes', () => {
    const input = { subject: 'S', previewText: 'P', blocks: golden.blocks.slice(0, 3).map(({ type, data }) => ({ type, data })), webViewUrl: '#' };
    assert.strictEqual(renderIssueEmail(input).html, renderIssueEmail(input).html);
  });
});
