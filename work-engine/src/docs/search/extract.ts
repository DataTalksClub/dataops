/**
 * Docs search field extraction.
 *
 * Ports the document-field derivation from
 * `lambda-functions/src/lambda_functions/docs_index.py` (`iter_docs`) and the
 * id/domain/doc_type inference from `doc_registry.py`. Each `content/` markdown
 * file becomes a flat {@link SearchDocument} whose fields line up exactly with
 * the `minsearch` text/keyword fields:
 *
 *   text:    title, summary, description, purpose, headings, body, tags, systems
 *   keyword: path, id, domain, doc_type
 *
 * Frontmatter is parsed with `gray-matter` (the Node equivalent of
 * `python-frontmatter`, per `_docs/TARGET_ARCHITECTURE.md`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';

import matter from 'gray-matter';

import type { SearchDocument } from '../searchIndex';

// ── Markdown cleaning regexes (ported from docs_index.py) ─────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_TAG_RE = /<[^>]+>/g;
const MARKDOWN_MARKERS_RE = /[*_>#~]/g;

const ID_STRIP_DIRS = new Set(['sops', 'templates', 'reference', 'playbooks']);

/** Mirror of Python `str.title()` over alphabetic runs. */
function pyTitle(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

/** Strip HTML/markdown markers and collapse whitespace (Python `clean_text`). */
export function cleanText(text: string): string {
  let out = text.replace(HTML_COMMENT_RE, ' ');
  out = out.replace(HTML_TAG_RE, ' ');
  out = out.replace(MARKDOWN_MARKERS_RE, ' ');
  out = out.replace(/\s+/g, ' ');
  return out.trim();
}

/** Reduce raw markdown to readable search text (Python `markdown_to_search_text`). */
export function markdownToSearchText(markdown: string): string {
  let text = markdown.replace(CODE_BLOCK_RE, ' ');
  text = text.replace(IMAGE_RE, ' ');
  text = text.replace(LINK_RE, '$1');
  text = text.replace(INLINE_CODE_RE, '$1');
  return cleanText(text);
}

/** Cleaned `#`-heading texts in document order (Python `extract_headings`). */
export function extractHeadings(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(HEADING_RE)) {
    out.push(cleanText(match[2]));
  }
  return out;
}

/** Coerce a frontmatter value to text (Python `scalar_frontmatter_value`). */
export function scalarFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${item}`)
      .join(', ');
  }
  return String(value);
}

/** First-segment-after-`content/` domain (Python `infer_domain`). */
export function inferDomain(repoPath: string): string {
  const parts = repoPath.split('/');
  if (parts.length >= 2 && parts[0] === 'content') return parts[1];
  return 'unknown';
}

/** Path-based doc-type inference (Python `infer_doc_type`). */
export function inferDocType(repoPath: string): string {
  const parts = new Set(repoPath.split('/'));
  if (parts.has('sops')) return 'sop';
  if (parts.has('templates')) return 'template';
  if (parts.has('reference')) return 'reference';
  if (parts.has('playbooks')) return 'playbook';
  if (parts.has('prompts')) return 'prompt';
  if (parts.has('archive')) return 'archive';
  return 'doc';
}

/** Generated document id (Python `doc_registry._generated_id`). */
export function generatedId(repoPath: string, docType: string): string {
  const path = repoPath.replace(/^content\//, '').replace(/\.md$/, '');
  const parts = path.split('/').filter((part) => !ID_STRIP_DIRS.has(part));
  const slug = parts.join('.');
  return `${docType}.${slug}`.replace(/_/g, '-');
}

/**
 * Build the indexed search body for a document.
 *
 * TODO(#86): SOP-structure-aware extraction. The Python `doc_to_search_text`
 * routes `schema_version: 1` SOPs through `sop_parse.parse()` so step bodies,
 * prose, and screenshot captions are indexed without marker noise. The SOP
 * engine port landed under `work-engine/src/docs/sop/` (#86) but is wired into
 * the live content path only at #87. Until then we index the cleaned raw
 * markdown body for every doc (recall-preserving; SOP step text is still
 * present in the raw body). To enable structured extraction, pass a
 * `structuredText` extractor here that calls `sopEngine.parse(rawText)` and
 * flattens sections/steps — this is the single integration point.
 */
export function docToSearchText(
  rawText: string,
  fallbackBody: string,
  structuredText?: (rawText: string) => string | null,
): string {
  if (structuredText) {
    const structured = structuredText(rawText);
    if (structured) return cleanText(structured);
  }
  return markdownToSearchText(fallbackBody);
}

/** Options for {@link extractDoc}. */
export interface ExtractOptions {
  /** Optional SOP structured-text extractor (TODO #86 integration point). */
  structuredText?: (rawText: string) => string | null;
}

/**
 * Extract a flat search document from a markdown file's raw text and its
 * repo-relative path (e.g. `content/maven/index.md`). Mirrors the per-doc
 * record built by Python `iter_docs`.
 */
export function extractDoc(repoPath: string, rawText: string, options: ExtractOptions = {}): SearchDocument {
  const parsed = matter(rawText);
  const metadata = parsed.data as Record<string, unknown>;
  const body = parsed.content;

  const headings = extractHeadings(body);
  const stem = repoPath.split('/').pop()!.replace(/\.md$/, '');
  const title =
    scalarOr(metadata.title) || (headings.length > 0 ? headings[0] : pyTitle(stem.replace(/-/g, ' ')));

  const docType = scalarOr(metadata.doc_type) || inferDocType(repoPath);
  const id = scalarOr(metadata.id) || generatedId(repoPath, docType);

  const summary = scalarFrontmatterValue(metadata.summary);
  const description = scalarFrontmatterValue(metadata.description) || summary;

  return {
    path: repoPath,
    id,
    title,
    domain: inferDomain(repoPath),
    doc_type: docType,
    summary,
    description,
    purpose: scalarFrontmatterValue(metadata.purpose),
    tags: scalarFrontmatterValue(metadata.tags),
    systems: scalarFrontmatterValue(metadata.systems),
    headings: headings.join('\n'),
    body: docToSearchText(rawText, body, options.structuredText),
  };
}

/** `str(metadata.get(...) or "")` — empty for missing/blank scalars. */
function scalarOr(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Recursively collect `*.md` files under `dir`, sorted (posix order). */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk a `content/` directory and yield a search document per markdown file.
 * `contentDir` is an absolute path; repo-relative paths are computed against
 * its parent (the repo root), matching Python `iter_docs`.
 */
export function iterContentDocs(contentDir: string, options: ExtractOptions = {}): SearchDocument[] {
  const repoRoot = dirname(contentDir);
  const files = collectMarkdown(contentDir).sort();
  return files.map((file) => {
    const repoPath = file.slice(repoRoot.length + 1).split(sep).join(posix.sep);
    const rawText = readFileSync(file, 'utf-8');
    return extractDoc(repoPath, rawText, options);
  });
}
