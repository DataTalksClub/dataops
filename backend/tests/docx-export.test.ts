import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBuffer } from 'yauzl';
import { markdownToDocx } from '../src/docs/docxExport';

export async function unzip(bytes: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) return reject(error);
    const files: Record<string, string> = {};
    zip.on('error', reject);
    zip.on('end', () => resolve(files));
    zip.on('entry', (entry) => zip.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) return reject(streamError);
      const chunks: Buffer[] = [];
      stream.on('error', reject);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        files[entry.fileName] = Buffer.concat(chunks).toString('utf8');
        zip.readEntry();
      });
    }));
    zip.readEntry();
  }));
}

test('DOCX is a readable OOXML archive preserving Unicode, formatting, URLs, code and XML-sensitive text', async () => {
  const bytes = await markdownToDocx('# Café & <talk>\n**Bold** and *italic* [link](https://example.test/a?b=1&c=2)\n```ts\n# literal **code**\n```\ncontrol\u0001');
  const files = await unzip(bytes);
  assert.match(files['[Content_Types].xml'], /wordprocessingml.document.main\+xml/);
  assert.match(files['_rels/.rels'], /Target="word\/document.xml"/);
  assert.match(files['word/_rels/document.xml.rels'], /Target="styles.xml"/);
  const doc = files['word/document.xml'];
  assert.match(doc, /Heading1/);
  assert.match(doc, /Café &amp; &lt;talk&gt;/);
  assert.match(doc, /<w:b\/>/);
  assert.match(doc, /<w:i\/>/);
  assert.match(doc, /https:\/\/example.test\/a\?b=1&amp;c=2/);
  assert.match(doc, /# literal \*\*code\*\*/);
  assert.ok(!doc.includes('\u0001'));
});
