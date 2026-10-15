/**
 * Parse and validate the alternate code-only view of a SOP.
 *
 * A code view is a separate knowledge document (`doc_type: code-view`) linked
 * to its canonical SOP through the frontmatter `sop:` reference. Its body is an
 * author-ordered sequence of named file blocks and interleaved markdown prose:
 *
 *     ```bash file=normalize-audio.sh
 *     #!/usr/bin/env bash
 *     ...
 *     ```
 *
 *     Then run the second pass.
 *
 *     ```bash file=verify-loudness.sh
 *     ...
 *     ```
 *
 * Code inside a `file=` fence is preserved verbatim (the fenced lines joined
 * with `\n`); prose between fences is markdown. Plain fenced blocks without
 * `file=` belong to the surrounding prose, so examples stay possible. The
 * format spec is `docs/code-view-format.md`.
 */

import { lintText } from './lint';
import { parseFrontmatter, splitFrontmatter, splitlines } from './parse';
import type { Frontmatter } from './types';

export interface CodeViewFile {
  name: string;
  language: string;
  anchor: string;
}

export type CodeViewBlock =
  | { kind: 'file'; name: string; language: string; code: string; anchor: string }
  | { kind: 'markdown'; anchor: string; heading: string; body_md: string };

export interface ParsedCodeView {
  schema_version: string | string[] | null;
  frontmatter: Frontmatter;
  /** All blocks in author order: file blocks interleaved with markdown prose. */
  blocks: CodeViewBlock[];
  /** The file blocks only, in author order — the navigation index. */
  files: CodeViewFile[];
}

export class CodeViewParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'CodeViewParseError';
    this.line = line;
  }

  toString(): string {
    return `line ${this.line}: ${this.message}`;
  }
}

/** A fence opener: at least three backticks, then an info string. */
const FENCE_OPEN_RE = /^(`{3,})[ \t]*(.*)$/;
/** `key=value` / `key="value"` attributes in a fence info string. */
const INFO_ATTR_RE_G = /(\w+)\s*=\s*(?:"([^"]*)"|(\S+))/g;
/** Filenames are display labels and anchor sources — no paths, no traversal. */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** True when `line` closes a fence opened with `fence` (same length or longer). */
function closesFence(line: string, fence: string): boolean {
  if (!line.startsWith(fence)) return false;
  return /^`+[ \t]*$/.test(line);
}

function parseInfoLanguage(info: string): string {
  const m = /^([A-Za-z0-9_+#.-]+)/.exec(info.trim());
  return m ? m[1] : '';
}

function parseInfoAttrs(info: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of info.matchAll(INFO_ATTR_RE_G)) {
    attrs.set(m[1], m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Parse a code-view markdown document into ordered blocks.
 *
 * Throws {@link CodeViewParseError} on structural faults: an unclosed fence, a
 * file fence without `file=`, an unsafe or duplicate filename, or a body with
 * no file blocks at all (a code view without code is not a code view).
 */
export function parseCodeView(text: string): ParsedCodeView {
  const [rawFm, body] = splitFrontmatter(text);
  const frontmatter: Frontmatter = rawFm ? parseFrontmatter(rawFm) : {};
  const schemaVersion =
    'schema_version' in frontmatter ? frontmatter.schema_version : null;

  const lines = splitlines(body);
  // A leading `# Title` is the document heading (already in frontmatter), not
  // a prose section — the Gist view gets its title from the frontmatter.
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && /^#\s+\S/.test(lines[0])) lines.shift();
  const blocks: CodeViewBlock[] = [];
  const files: CodeViewFile[] = [];
  const fileNames = new Set<string>();
  const anchors = new Set<string>();
  let markdownLines: string[] = [];
  let sectionIndex = 0;

  const uniqueAnchor = (base: string): string => {
    let anchor = base;
    for (let n = 2; anchors.has(anchor); n += 1) anchor = `${base}-${n}`;
    anchors.add(anchor);
    return anchor;
  };

  const flushMarkdown = () => {
    const content = markdownLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    markdownLines = [];
    if (!content) return;
    sectionIndex += 1;
    let heading = '';
    for (const line of content.split('\n')) {
      const h = HEADING_RE.exec(line);
      if (h) {
        heading = h[2].trim();
        break;
      }
    }
    blocks.push({
      kind: 'markdown',
      anchor: uniqueAnchor(`section-${sectionIndex}-${slugify(heading || 'notes')}`),
      heading,
      body_md: content,
    });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const open = FENCE_OPEN_RE.exec(line);
    if (!open) {
      markdownLines.push(line);
      continue;
    }
    const fence = open[1];
    const info = open[2].trim();
    const attrs = parseInfoAttrs(info);

    if (!attrs.has('file')) {
      // Plain markdown fence: part of the surrounding prose, kept verbatim.
      markdownLines.push(line);
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j], fence)) {
        markdownLines.push(lines[j]);
        j += 1;
      }
      if (j >= lines.length) {
        throw new CodeViewParseError('unclosed fenced block', i + 1);
      }
      markdownLines.push(lines[j]);
      i = j;
      continue;
    }

    const name = attrs.get('file')!;
    if (!FILE_NAME_RE.test(name)) {
      throw new CodeViewParseError(
        `file name '${name}' must be a bare filename (no paths, no traversal)`,
        i + 1,
      );
    }
    if (fileNames.has(name)) {
      throw new CodeViewParseError(`duplicate file block '${name}'`, i + 1);
    }
    const codeLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closesFence(lines[j], fence)) {
      codeLines.push(lines[j]);
      j += 1;
    }
    if (j >= lines.length) {
      throw new CodeViewParseError(`file block '${name}' is never closed`, i + 1);
    }
    flushMarkdown();
    const language = parseInfoLanguage(info);
    const anchor = uniqueAnchor(`file-${slugify(name)}`);
    fileNames.add(name);
    files.push({ name, language, anchor });
    blocks.push({ kind: 'file', name, language, code: codeLines.join('\n'), anchor });
    i = j;
  }
  flushMarkdown();

  if (files.length === 0) {
    throw new CodeViewParseError(
      'a code view needs at least one ```lang file=name block',
      lines.length,
    );
  }

  return { schema_version: schemaVersion, frontmatter, blocks, files };
}

/**
 * Validate a code-view document against `docs/code-view-format.md`.
 * Structural faults surface as a single `parse error:` violation; frontmatter
 * semantics (doc_type, title, the `sop` back-reference) are checked here.
 * The registry additionally checks that `sop` resolves and stays unique.
 */
export function lintCodeView(text: string): string[] {
  const violations: string[] = [];
  const [rawFm] = splitFrontmatter(text);
  if (!rawFm) {
    violations.push('missing frontmatter');
    return violations;
  }
  const fm = parseFrontmatter(rawFm);
  const docType = 'doc_type' in fm ? fm.doc_type : null;
  if (docType !== 'code-view') {
    violations.push(`doc_type must be 'code-view' (got ${repr(docType)})`);
  }
  if (!fm.title) violations.push('frontmatter is missing `title`');
  if (!fm.sop) violations.push('frontmatter is missing `sop` (the canonical SOP this view codes)');
  const schemaVersion = fm.schema_version;
  if (schemaVersion === undefined) return violations;
  if (typeof schemaVersion !== 'string' || !/^\d+$/.test(schemaVersion)) {
    violations.push(`schema_version must be an integer (got ${repr(schemaVersion)})`);
    return violations;
  }
  if (schemaVersion !== '1') {
    violations.push(`unsupported schema_version: ${schemaVersion}`);
    return violations;
  }
  try {
    parseCodeView(text);
  } catch (err) {
    if (err instanceof CodeViewParseError) {
      violations.push(`parse error: ${err.toString()}`);
      return violations;
    }
    throw err;
  }
  return violations;
}

/** Python-ish repr for lint messages over the frontmatter value shapes. */
function repr(value: Frontmatter[string] | null | undefined): string {
  if (value === undefined || value === null) return 'None';
  if (Array.isArray(value)) return `[${value.map((v) => repr(v)).join(', ')}]`;
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Route linting by the document's own `doc_type`: SOP engine rules for
 * sop/checklist, code-view rules for code-view, no rules for other types.
 */
export function lintDocument(text: string): string[] {
  const [rawFm] = splitFrontmatter(text);
  const fm = rawFm ? parseFrontmatter(rawFm) : {};
  if (fm.doc_type === 'code-view') return lintCodeView(text);
  if (fm.doc_type === 'sop' || fm.doc_type === 'checklist') return lintText(text);
  return [];
}
