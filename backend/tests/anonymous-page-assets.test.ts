import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { isAnonymousDocumentReviewAsset } from '../src/documents/reviews';
import { isAnonymousSponsorContractAsset } from '../src/routes/sponsorContracts';
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

const PAGES: Array<[string, (method: string, path: string) => boolean]> = [
  ['src/sponsor-doc-page.js', isAnonymousSponsorDocAsset],
  ['src/contract-sign-page.js', isAnonymousSponsorContractAsset],
  ['src/document-review-page.js', isAnonymousDocumentReviewAsset],
];

describe('anonymous page assets', () => {
  for (const [entry, isAllowed] of PAGES) {
    it(`lets an anonymous visitor load every module ${entry} imports`, () => {
      const blocked = [...importGraph(entry)]
        .map((file) => `/${relative(FRONTEND_ROOT, file)}`)
        .filter((path) => !isAllowed('GET', path));
      assert.deepStrictEqual(blocked, []);
    });
  }
});

describe('anonymous page assets in the shipped manifest', () => {
  // The build copies only files listed in frontend-assets.json; a module
  // imported by an anonymous page but missing there fails the deploy build.
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../src/docs/frontend-assets.json'), 'utf8'));
  const shipped = new Set<string>(JSON.stringify(manifest).match(/src\/[^"]+/g) || []);
  for (const [entry] of PAGES) {
    it(`lists every module ${entry} imports`, () => {
      const missing = [...importGraph(entry)]
        .map((file) => relative(FRONTEND_ROOT, file))
        .filter((path) => !shipped.has(path));
      assert.deepStrictEqual(missing, []);
    });
  }
});

describe('anonymous page scripts', () => {
  it('parse as modules', () => {
    for (const [entry] of PAGES) {
      for (const file of importGraph(entry)) {
        const result = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(file, 'utf8') });
        assert.strictEqual(result.status, 0, `${relative(FRONTEND_ROOT, file)}: ${result.stderr}`);
      }
    }
  });
});
