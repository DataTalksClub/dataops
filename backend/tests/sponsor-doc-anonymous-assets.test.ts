import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { isAnonymousSponsorDocAsset } from '../src/routes/sponsorDocs';

const FRONTEND_ROOT = resolve(__dirname, '../../frontend');

function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(FRONTEND_ROOT, entry)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), match[1] || match[2]));
    }
  }
  return seen;
}

describe('sponsor doc anonymous assets', () => {
  it('lets an anonymous visitor load every module the sponsor doc page imports', () => {
    const blocked = [...importGraph('src/sponsor-doc-page.js')]
      .map((file) => `/${relative(FRONTEND_ROOT, file)}`)
      .filter((path) => !isAnonymousSponsorDocAsset('GET', path));
    assert.deepStrictEqual(blocked, []);
  });
});
