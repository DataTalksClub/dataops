import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { extractTarGz } from '../src/docs/tarball';

const BLOCK = 512;

/** One ustar member with a hand-built header (checksummed like real writers). */
function ustarEntry(path: string, content: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(path.slice(0, 100), 0, 'utf8');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
  header.write(type, 156, 'utf8');
  header.write('ustar\0', 257, 'utf8');
  header.write('00', 263, 'utf8');
  header.fill(' ', 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  return Buffer.concat([header, content, Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK, 0)]);
}

/** Length-prefixed pax record: `<len> <key>=<value>\n` where len counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const payload = key.length + value.length + 3;
  let length = payload;
  while (String(length).length + payload !== length) {
    length = String(length).length + payload;
  }
  return Buffer.from(`${length} ${key}=${value}\n`, 'utf8');
}

/** A pax extended header pair that overrides the next entry's path. */
function paxLongPathEntry(path: string, content: Buffer): Buffer {
  const record = paxRecord('path', path);
  const override = ustarEntry('PaxHeader', record, 'x');
  const real = ustarEntry('entry', content); // short placeholder name
  return Buffer.concat([override, real]);
}

/** A GNU long-name pair (`L` record carrying the next entry's name). */
function gnuLongNameEntry(path: string, content: Buffer): Buffer {
  const name = ustarEntry('././@LongLink', Buffer.concat([Buffer.from(path), Buffer.alloc(1)]), 'L');
  const real = ustarEntry('entry', content);
  return Buffer.concat([name, real]);
}

function buildTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(2 * BLOCK, 0)]);
}

async function extract(
  tar: Buffer,
  options: { include?: (path: string) => boolean } = {},
): Promise<{ path: string; bytes: string }[]> {
  const files: { path: string; bytes: string }[] = [];
  // Fixtures are plain tar bytes; production archives always arrive gzipped.
  const stream = Readable.from([gzipSync(tar)]);
  await extractTarGz(stream, {
    include: options.include,
    onFile: (path, bytes) => files.push({ path, bytes: bytes.toString('utf8') }),
  });
  return files;
}

describe('tarball extractor', () => {
  it('extracts regular files with the archive root stripped', async () => {
    const tar = buildTar([
      ustarEntry('dataops-knowledge-abc123/content', Buffer.alloc(0), '5'),
      ustarEntry('dataops-knowledge-abc123/content/a.md', Buffer.from('# A')),
      ustarEntry('dataops-knowledge-abc123/content/sub/b.md', Buffer.from('beta')),
      ustarEntry('dataops-knowledge-abc123/README.md', Buffer.from('no')),
    ]);
    const files = await extract(tar, { include: (path) => path.startsWith('content/') });
    assert.deepStrictEqual(files, [
      { path: 'content/a.md', bytes: '# A' },
      { path: 'content/sub/b.md', bytes: 'beta' },
    ]);
  });

  it('keeps parser alignment when the filter rejects entries', async () => {
    const tar = buildTar([
      ustarEntry('root/content/first.md', Buffer.from('one')),
      ustarEntry('root/content/images/skip.png', Buffer.from('binary-bytes')),
      ustarEntry('root/content/last.md', Buffer.from('two')),
    ]);
    const files = await extract(tar, { include: (path) => path.endsWith('.md') });
    assert.deepStrictEqual(files, [
      { path: 'content/first.md', bytes: 'one' },
      { path: 'content/last.md', bytes: 'two' },
    ]);
  });

  it('reads pax long paths beyond the ustar field width', async () => {
    const deep = `content/${'nested/'.repeat(12)}document-with-a-very-long-name.md`;
    assert.ok(deep.length > 100, 'path must exceed the ustar name field');
    const tar = buildTar([paxLongPathEntry(`repo-main/${deep}`, Buffer.from('long'))]);
    assert.deepStrictEqual(await extract(tar), [{ path: deep, bytes: 'long' }]);
  });

  it('reads GNU long-name entries', async () => {
    const deep = `content/${'chain/'.repeat(15)}gnu-named.md`;
    const tar = buildTar([gnuLongNameEntry(`repo-main/${deep}`, Buffer.from('gnu'))]);
    assert.deepStrictEqual(await extract(tar), [{ path: deep, bytes: 'gnu' }]);
  });

  it('tolerates content lengths that are exact block multiples', async () => {
    const exact = Buffer.alloc(BLOCK * 2, 0x61);
    const tar = buildTar([ustarEntry('repo-main/content/exact.md', exact)]);
    const files = await extract(tar);
    assert.strictEqual(files[0].bytes.length, BLOCK * 2);
  });

  it('rejects truncated archives instead of extracting partial files', async () => {
    const tar = buildTar([ustarEntry('repo-main/content/a.md', Buffer.from('aaaa'))]);
    await assert.rejects(() => extract(tar.subarray(0, tar.length - 600)), /Truncated/);
  });

  it('rejects input that is not gzip data', async () => {
    await assert.rejects(() => extract(Buffer.from('<html>sign in</html>')));
  });
});
