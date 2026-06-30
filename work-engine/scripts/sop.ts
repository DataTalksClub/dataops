#!/usr/bin/env tsx
/**
 * Node CLI for the SOP structured-markdown engine.
 *
 * Mirrors the Python `scripts/sop_parse.py` and `scripts/sop_lint.py` shims so
 * the single TypeScript backend (and CI) can parse/lint SOPs without Python.
 *
 * Usage:
 *   tsx scripts/sop.ts parse <file.md> [--pretty]
 *   tsx scripts/sop.ts lint  <file.md> [<file.md> ...]
 *
 * Exit codes match the Python CLI:
 *   parse: 0 = ok, 2 = parse error
 *   lint:  0 = clean, 1 = violations found
 */

import { readFileSync } from 'node:fs';

import { ParseError, parse } from '../src/docs/sop/parse';
import { lintText } from '../src/docs/sop/lint';

function parseCmd(argv: string[]): number {
  const pretty = argv.includes('--pretty');
  const paths = argv.filter((a) => a !== '--pretty');
  if (paths.length !== 1) {
    process.stderr.write('usage: sop.ts parse <file.md> [--pretty]\n');
    return 2;
  }
  const path = paths[0];
  const text = readFileSync(path, 'utf-8');
  try {
    const result = parse(text);
    process.stdout.write(JSON.stringify(result, null, pretty ? 2 : undefined) + '\n');
    return 0;
  } catch (e) {
    if (e instanceof ParseError) {
      process.stderr.write(`${path}: parse error: ${e.toString()}\n`);
      return 2;
    }
    throw e;
  }
}

function lintCmd(argv: string[]): number {
  const paths = argv;
  if (paths.length < 1) {
    process.stderr.write('usage: sop.ts lint <file.md> [<file.md> ...]\n');
    return 1;
  }
  let total = 0;
  for (const p of paths) {
    const violations = lintText(readFileSync(p, 'utf-8'));
    if (violations.length) {
      total += violations.length;
      for (const v of violations) {
        process.stdout.write(`${p}: ${v}\n`);
      }
    }
  }
  if (total) {
    process.stderr.write(
      `\n${total} violation(s) across ${paths.length} file(s)\n`,
    );
    return 1;
  }
  process.stdout.write(`OK: ${paths.length} file(s) clean\n`);
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'parse') return parseCmd(rest);
  if (cmd === 'lint') return lintCmd(rest);
  process.stderr.write(
    'usage: sop.ts <parse|lint> <file.md> ...\n' +
      '  (normalize is not ported; legacy SOPs were migrated with the Python tool)\n',
  );
  return 2;
}

process.exit(main(process.argv.slice(2)));
