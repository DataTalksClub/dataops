#!/usr/bin/env node

/**
 * Validates internal DataOps document references.
 *
 * Checks that every `related_docs` entry, wiki reference, markdown link, and
 * image target in the documentation corpus resolves, that every task template
 * is registered with the right doc type, and that the doc IDs referenced by
 * `seed-templates.ts` exist.
 *
 * Usage:
 *   npx tsx scripts/validate-docs-links.ts [--repo-root <path>] [--content-root <path>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, dirname } from 'node:path';

import {
  DocumentRegistryError,
  LookupError,
  buildRegistry,
  normalizeReference,
  resolveReference,
  type DocumentRegistry,
} from '../src/docs/docRegistry';
import { parseFrontmatter, splitFrontmatter } from '../src/docs/sop';

const PROCESS_MARKDOWN_DIRS = ['docs', 'templates'];
const PROCESS_MARKDOWN_FILES = ['.goal-v1.md', 'PROJECT_PLAN.md', 'PORTAL_ANALYSIS.md', 'README.md'];

const MARKDOWN_LINK_RE = /(!)?\[[^\]]*\]\(([^)]+)\)/g;
const WIKI_REF_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SOURCE_DOC_IDS_RE = /sourceDocIds\s*:\s*\[([\s\S]*?)\]/g;
const INSTRUCTION_DOC_ID_RE = /instructionDocId\s*:\s*['"]([^'"]+)['"]/g;
const STRING_LITERAL_RE = /['"]([^'"]+)['"]/g;
const SOURCE_DOC_IDS_CONST_RE = /const\s+([A-Z0-9_]*SOURCE_DOC_IDS)\s*=\s*\[([\s\S]*?)\];/g;
const EXTERNAL_DOC_OBJECT_RE = /\{\s*id:\s*['"]([^'"]+)['"]\s*,\s*path:\s*['"]([^'"]+)['"]\s*,\s*reason:\s*['"]([^'"]+)['"]\s*,?\s*\}/g;

interface MarkdownReference {
  sourcePath: string;
  target: string;
  isImage: boolean;
}

export function validate(repoRoot: string, contentRoot = 'content'): string[] {
  const root = resolve(repoRoot);
  const content = resolve(isAbsolute(contentRoot) ? contentRoot : join(root, contentRoot));

  const violations: string[] = [];
  let registry: DocumentRegistry;
  try {
    registry = buildRegistry(content);
  } catch (error) {
    if (!(error instanceof DocumentRegistryError)) throw error;
    violations.push(...error.violations.map((violation) => `content registry: ${violation}`));
    registry = buildRegistry(content, false);
  }

  const markdownFiles = docsMarkdownFiles(root, content);
  violations.push(...validateRelatedDocs(root, markdownFiles, registry));
  violations.push(...validateWikiRefs(root, markdownFiles, registry));
  violations.push(...validateMarkdownRefs(root, markdownFiles, registry));
  violations.push(...validateTaskTemplateDocs(root, registry));
  violations.push(...validateBackendSeedDocIds(root, registry));
  return violations;
}

function collectMarkdown(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectMarkdown(path, out);
    else if (path.endsWith('.md')) out.push(path);
  }
  return out;
}

function docsMarkdownFiles(repoRoot: string, contentRoot: string): string[] {
  const files = new Set<string>(collectMarkdown(contentRoot).map((path) => resolve(path)));
  for (const dir of PROCESS_MARKDOWN_DIRS) {
    for (const path of collectMarkdown(join(repoRoot, dir))) files.add(resolve(path));
  }
  for (const name of PROCESS_MARKDOWN_FILES) {
    const path = join(repoRoot, name);
    if (existsSync(path)) files.add(resolve(path));
  }
  return [...files].sort();
}

function validateRelatedDocs(repoRoot: string, markdownFiles: string[], registry: DocumentRegistry): string[] {
  const violations: string[] = [];
  for (const path of markdownFiles) {
    const [raw] = splitFrontmatter(readFileSync(path, 'utf8'));
    const metadata = raw ? parseFrontmatter(raw) : {};
    for (const related of asStrings((metadata as Record<string, unknown>).related_docs)) {
      if (isExternalOrAnchor(related)) continue;
      if (registryResolves(registry, related)) continue;
      if (referenceCandidates(repoRoot, path, related).some((candidate) => existsSync(candidate))) continue;
      violations.push(`${repoPath(repoRoot, path)}: related_docs reference not found: '${related}'`);
    }
  }
  return violations;
}

function validateWikiRefs(repoRoot: string, markdownFiles: string[], registry: DocumentRegistry): string[] {
  const violations: string[] = [];
  for (const path of markdownFiles) {
    const text = stripCodeBlocks(readFileSync(path, 'utf8'));
    for (const match of text.matchAll(WIKI_REF_RE)) {
      const target = match[1].trim();
      if (!registryResolves(registry, target)) {
        violations.push(`${repoPath(repoRoot, path)}: wiki reference not found: '${target}'`);
      }
    }
  }
  return violations;
}

function validateMarkdownRefs(repoRoot: string, markdownFiles: string[], registry: DocumentRegistry): string[] {
  const violations: string[] = [];
  for (const ref of iterMarkdownRefs(markdownFiles)) {
    const source = repoPath(repoRoot, ref.sourcePath);
    const target = stripMarkdownTitle(ref.target);
    if (isExternalOrAnchor(target)) continue;
    if (target.startsWith('doc:')) {
      const [docRef] = splitLinkTarget(target);
      if (!registryResolves(registry, docRef)) {
        violations.push(`${source}: doc reference not found: '${target}'`);
      }
      continue;
    }
    const [pathPart] = splitLinkTarget(target);
    if (!pathPart) continue;
    if (!existsSync(resolveLocalLink(repoRoot, ref.sourcePath, pathPart))) {
      violations.push(`${source}: ${ref.isImage ? 'image target' : 'link target'} not found: '${target}'`);
    }
  }
  return violations;
}

function iterMarkdownRefs(markdownFiles: string[]): MarkdownReference[] {
  const refs: MarkdownReference[] = [];
  for (const path of markdownFiles) {
    const text = stripCodeBlocks(readFileSync(path, 'utf8'));
    for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
      refs.push({ sourcePath: path, target: match[2], isImage: Boolean(match[1]) });
    }
  }
  return refs;
}

function validateTaskTemplateDocs(repoRoot: string, registry: DocumentRegistry): string[] {
  const violations: string[] = [];
  const templatesDir = join(repoRoot, 'content', 'tasks', 'templates');
  if (!existsSync(templatesDir)) return violations;
  for (const name of readdirSync(templatesDir).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = repoPath(repoRoot, join(templatesDir, name));
    const record = registry.byPath.get(path);
    if (!record) violations.push(`${path}: task template is missing from document registry`);
    else if (record.doc_type !== 'task-template') {
      violations.push(`${path}: task template doc_type must be task-template, got '${record.doc_type}'`);
    }
  }
  return violations;
}

function validateBackendSeedDocIds(repoRoot: string, registry: DocumentRegistry): string[] {
  const seedPath = join(repoRoot, 'backend', 'scripts', 'seed-templates.ts');
  if (!existsSync(seedPath)) return ['backend/scripts/seed-templates.ts: seed template source is required'];

  const text = readFileSync(seedPath, 'utf8');
  const source = repoPath(repoRoot, seedPath);
  const externalDocs = externalSeedDocs(text);
  const violations: string[] = [];

  for (const [docId, info] of externalDocs) {
    if (registryResolves(registry, docId)) continue;
    if (info.path.startsWith('content/')) {
      violations.push(`${source}: external sourceDocId '${docId}' points into content/: ${info.path}`);
    }
    if (!existsSync(join(repoRoot, info.path))) {
      violations.push(`${source}: external sourceDocId '${docId}' path not found: ${info.path}`);
    }
    if (!info.reason.trim()) {
      violations.push(`${source}: external sourceDocId '${docId}' needs a reason`);
    }
  }

  for (const docId of [...sourceDocIds(text)].sort()) {
    if (externalDocs.has(docId)) continue;
    if (!registryResolves(registry, docId)) {
      violations.push(`${source}: sourceDocIds reference not found: '${docId}'`);
    }
  }

  const instructionIds = new Set([...text.matchAll(INSTRUCTION_DOC_ID_RE)].map((match) => match[1]));
  for (const docId of [...instructionIds].sort()) {
    if (!registryResolves(registry, docId)) {
      violations.push(`${source}: instructionDocId reference not found: '${docId}'`);
    }
  }

  return violations;
}

function sourceDocIds(seedText: string): Set<string> {
  const docIds = new Set<string>();
  for (const match of seedText.matchAll(SOURCE_DOC_IDS_RE)) {
    for (const literal of match[1].matchAll(STRING_LITERAL_RE)) docIds.add(literal[1]);
  }
  for (const match of seedText.matchAll(SOURCE_DOC_IDS_CONST_RE)) {
    if (match[1].includes('EXTERNAL_SOURCE_DOC_IDS')) continue;
    for (const literal of match[2].matchAll(STRING_LITERAL_RE)) docIds.add(literal[1]);
  }
  return docIds;
}

function externalSeedDocs(seedText: string): Map<string, { path: string; reason: string }> {
  const docs = new Map<string, { path: string; reason: string }>();
  for (const match of seedText.matchAll(EXTERNAL_DOC_OBJECT_RE)) {
    docs.set(match[1], { path: match[2], reason: match[3] });
  }
  return docs;
}

function stripCodeBlocks(markdown: string): string {
  return markdown.replace(CODE_BLOCK_RE, '').replace(INLINE_CODE_RE, '');
}

function stripMarkdownTitle(target: string): string {
  const value = target.trim();
  if (value.startsWith('<') && value.includes('>')) return value.slice(1, value.indexOf('>')).trim();
  if (value.includes(' ')) return value.split(/\s+/)[0].trim();
  return value;
}

function isExternalOrAnchor(target: string): boolean {
  return (
    !target
    || target.startsWith('#')
    || target.startsWith('//')
    || target.includes('...')
    || target.startsWith('path/to/')
    || (SCHEME_RE.test(target) && !target.startsWith('doc:'))
  );
}

function splitLinkTarget(target: string): [string, string] {
  let value = decodeURIComponent(target.trim());
  let anchor = '';
  const hash = value.indexOf('#');
  if (hash !== -1) {
    anchor = value.slice(hash + 1);
    value = value.slice(0, hash);
  }
  const query = value.indexOf('?');
  if (query !== -1) value = value.slice(0, query);
  return [value, anchor];
}

function resolveLocalLink(repoRoot: string, markdownPath: string, target: string): string {
  const value = target.replace(/\\/g, '/');
  if (value.startsWith('/')) return resolve(join(repoRoot, value.replace(/^\/+/, '')));
  return resolve(join(dirname(markdownPath), value));
}

function referenceCandidates(repoRoot: string, markdownPath: string, target: string): string[] {
  const [rawPath] = splitLinkTarget(normalizeReference(target));
  const pathPart = rawPath.replace(/\\/g, '/').trim();
  if (!pathPart) return [];
  return [
    resolveLocalLink(repoRoot, markdownPath, pathPart),
    resolve(join(repoRoot, pathPart.replace(/^\/+/, ''))),
  ];
}

function registryResolves(registry: DocumentRegistry, reference: string): boolean {
  try {
    resolveReference(registry, reference);
    return true;
  } catch (error) {
    if (error instanceof LookupError || error instanceof TypeError) return false;
    throw error;
  }
}

function asStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => String(item).trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item.length > 0);
}

function repoPath(repoRoot: string, path: string): string {
  return relative(repoRoot, resolve(path)).split(/[\\/]/).join('/');
}

function readFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

if (require.main === module) {
  const repoRoot = readFlag('--repo-root', process.cwd());
  const contentRoot = readFlag('--content-root', 'content');
  const violations = validate(repoRoot, contentRoot);
  if (violations.length > 0) {
    console.error('Docs link validation failed:');
    violations.forEach((violation) => console.error(`- ${violation}`));
    process.exit(1);
  }
  console.log('Docs link validation passed.');
  console.log('Anchor validation: deferred; local targets are validated without checking heading anchors.');
}
