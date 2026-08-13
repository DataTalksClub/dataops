/**
 * Behaviour tests for the SOP engine (`src/docs/sop/`), which is live runtime
 * code: `src/docs/contentApi.ts` serves parsed structure, `src/search/
 * sopExtract.ts` feeds the search index, and `lintText` drives process-quality
 * findings.
 *
 * Coverage comes from `tests/fixtures/sop-synthetic.json`: hand-written,
 * reviewable edge cases that exercise raw procedures, todos, prose, parse
 * errors, and every lint violation. The fixture is self-contained — each case
 * carries its own markdown — so it does not depend on the `content/` corpus.
 *
 * A second fixture, `sop-parity.json`, used to pin parsed output for 258
 * documents under `content/` against a snapshot from a Python implementation
 * (`lambda_functions.sop_parse`). That implementation has been retired, so
 * there was no parity target left, nothing checked in could regenerate the
 * snapshot, and every content edit broke the suite. It tested the content, not
 * the parser, and has been removed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ParseError, parse } from '../src/docs/sop/parse';
import { lintText } from '../src/docs/sop/lint';

const FIXTURES = path.resolve(__dirname, 'fixtures');

interface SyntheticCase {
  name: string;
  text: string;
  parse?: unknown;
  parse_error?: string;
  lint: string[];
}

function loadFixture<T>(file: string): { count: number; cases: T[] } {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf-8'));
}

describe('SOP engine — parity on synthetic edge cases', () => {
  const fixture = loadFixture<SyntheticCase>('sop-synthetic.json');

  it('covers raw procedures, todos, prose, errors, and all lint violations', () => {
    assert.ok(fixture.count >= 15, `expected edge-case coverage, got ${fixture.count}`);
  });

  for (const c of fixture.cases) {
    it(`synthetic parity: ${c.name}`, () => {
      if (c.parse_error !== undefined) {
        assert.throws(
          () => parse(c.text),
          (err: unknown) => {
            assert.ok(err instanceof ParseError, 'expected a ParseError');
            assert.strictEqual(err.toString(), c.parse_error);
            return true;
          },
          `expected parse error for ${c.name}`,
        );
      } else {
        const parsed = JSON.parse(JSON.stringify(parse(c.text)));
        assert.deepStrictEqual(parsed, c.parse, `parse mismatch for ${c.name}`);
      }
      assert.deepStrictEqual(lintText(c.text), c.lint, `lint mismatch for ${c.name}`);
    });
  }
});
