/**
 * Frontmatter helpers for plain-markdown knowledge documents.
 *
 * Every document is frontmatter (YAML between `---` lines) plus a plain
 * markdown body. There is no body parser: sections are `##` headings, steps
 * are numbered lists, images are `![](...)` with plain-paragraph captions.
 */

import yaml from 'js-yaml';

export type Frontmatter = Record<string, string | string[]>;

export class ParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
  }

  toString(): string {
    return `line ${this.line}: ${this.message}`;
  }
}

/**
 * Mirror Python's `str.splitlines()` for the line boundaries that occur in
 * markdown content (\n, \r, \r\n): a trailing line boundary does NOT produce a
 * final empty element, and an empty string yields `[]`.
 */
export function splitlines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/**
 * An optional leading UTF-8 BOM (`\uFEFF`, produced when Markdown is saved
 * as "UTF-8 with BOM") is not content: strip it before frontmatter matching
 * so a BOM-prefixed write parses the same frontmatter — and keeps the same
 * stable frontmatter `id` — as the identical bytes without a BOM. Without
 * frontmatter the input is returned untouched.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function splitFrontmatter(text: string): [string, string] {
  const normalized = stripBom(text);
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(normalized);
  if (!block) return ['', text];
  return [block[1], normalized.slice(block[0].length)];
}

/**
 * Parse YAML frontmatter with a real YAML parser.
 *
 * The failsafe schema keeps every scalar a string (`90`, `true`, `null` and
 * dates stay as written), which is the shape `Frontmatter` promises. Block
 * lists are read whether or not their items are indented, and folded scalars
 * keep their continuation lines. Lists keep their string items; nested
 * mappings are not part of the frontmatter contract and are dropped.
 * Malformed YAML raises a `ParseError` at the offending document line.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  let loaded: unknown;
  try {
    loaded = yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      // +2: the opening `---` line, and marks are zero-based.
      throw new ParseError(`invalid frontmatter YAML: ${err.reason}`, err.mark.line + 2);
    }
    throw err;
  }
  if (loaded === null || loaded === undefined) return {};
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new ParseError('frontmatter must be a YAML mapping', 2);
  }
  const data: Frontmatter = {};
  for (const [key, value] of Object.entries(loaded as Record<string, unknown>)) {
    if (value === null || value === undefined) data[key] = '';
    else if (typeof value === 'string') data[key] = value;
    else if (Array.isArray(value)) data[key] = value.filter((item): item is string => typeof item === 'string');
  }
  return data;
}
