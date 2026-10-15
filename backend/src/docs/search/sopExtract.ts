/**
 * SOP structured-text extraction for the search index (#86 integration point).
 *
 * Ports the `schema_version: 1` branch of `docs_index.doc_to_search_text`
 * (`lambda-functions/.../docs_index.py`). For marked-up SOPs this routes the raw
 * markdown through the TS SOP parser so step bodies, prose, group titles, and
 * screenshot captions are indexed without the HTML-comment marker noise. For any
 * other document it returns `null` so the caller falls back to the cleaned raw
 * body.
 *
 * Pass {@link sopStructuredText} as the `structuredText` option to `extractDoc` /
 * `iterContentDocs` (see `search/extract.ts`).
 */

import { parse, parseCodeView, parseFrontmatter, splitFrontmatter, ParseError, CodeViewParseError } from '../sop';
import type { Frontmatter, ParsedCodeView, ParsedSop, ProcedureSection, Section, Step } from '../sop';

/**
 * Structured search text for a `schema_version: 1` SOP, or `null` when the
 * document is not a structured SOP (or fails to parse).
 */
export function sopStructuredText(rawText: string): string | null {
  let parsed: ParsedSop;
  try {
    parsed = parse(rawText);
  } catch (err) {
    if (err instanceof ParseError) return null;
    throw err;
  }
  if (String(parsed.schema_version) !== '1') return null;
  return extractStructuredText(parsed);
}

function extractStructuredText(parsed: ParsedSop): string {
  const chunks: string[] = [];
  for (const [name, section] of Object.entries(parsed.sections)) {
    if (name === 'procedure' && !section.raw && 'groups' in section) {
      chunks.push(...extractProcedureText(section));
    } else {
      const body = rawBody(section);
      if (body) chunks.push(body);
    }
  }
  return chunks.join('\n');
}

function extractProcedureText(procedure: ProcedureSection): string[] {
  const chunks: string[] = [];
  for (const group of procedure.groups || []) {
    if (group.title) chunks.push(group.title);
    for (const step of group.steps || []) chunks.push(...extractStepText(step));
  }
  for (const step of procedure.flat_steps || []) chunks.push(...extractStepText(step));
  for (const prose of procedure.prose || []) {
    if (prose.body_md) chunks.push(prose.body_md);
  }
  for (const todo of procedure.todos || []) {
    if (todo) chunks.push(todo);
  }
  return chunks;
}

function extractStepText(step: Step): string[] {
  const chunks: string[] = [];
  if (step.body_md) chunks.push(step.body_md);
  for (const shot of step.screenshots || []) {
    if (shot.caption) chunks.push(shot.caption);
  }
  return chunks;
}

function rawBody(section: Section): string {
  return 'body_md' in section && typeof section.body_md === 'string' ? section.body_md : '';
}

/**
 * Per-doc-type structured search text: SOP extraction for structured SOPs,
 * code-view extraction (filenames, prose, and code — the default cleaner would
 * drop fenced code, which for a recipe is the content) for `code-view` docs,
 * and `null` for everything else so the caller falls back to the raw body.
 */
export function docsStructuredText(rawText: string): string | null {
  const [rawFm] = splitFrontmatter(rawText);
  let fm: Frontmatter = {};
  try {
    if (rawFm) fm = parseFrontmatter(rawFm);
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
  if (fm.doc_type === 'code-view') return codeViewStructuredText(rawText);
  return sopStructuredText(rawText);
}

function codeViewStructuredText(rawText: string): string | null {
  let parsed: ParsedCodeView;
  try {
    parsed = parseCodeView(rawText);
  } catch (err) {
    if (err instanceof CodeViewParseError) return null;
    throw err;
  }
  const chunks: string[] = [];
  for (const key of ['title', 'summary'] as const) {
    const value = parsed.frontmatter[key];
    if (typeof value === 'string' && value) chunks.push(value);
  }
  for (const block of parsed.blocks) {
    if (block.kind === 'file') {
      chunks.push(block.name);
      if (block.language) chunks.push(block.language);
      chunks.push(block.code);
    } else {
      chunks.push(block.body_md);
    }
  }
  return chunks.join('\n');
}
