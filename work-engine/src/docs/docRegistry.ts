/**
 * Document registry.
 *
 * Ports `lambda-functions/src/lambda_functions/doc_registry.py` to TypeScript:
 * builds a registry of `content/` markdown documents with stable IDs, aliases,
 * and path lookups, and resolves `doc:` / wiki / path references. Frontmatter is
 * parsed with the SOP frontmatter reader (the same YAML subset the Python
 * registry used via `sop_parse.parse_frontmatter`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

import { parseFrontmatter, splitFrontmatter } from './sop';
import type { Frontmatter } from './sop';

const DOCUMENT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const WIKI_REF_RE = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/;
const ID_STRIP_DIRS = new Set(['sops', 'templates', 'reference', 'playbooks']);

export const VALID_DOC_TYPES = new Set([
  'sop',
  'checklist',
  'template',
  'reference',
  'playbook',
  'prompt',
  'task-template',
  'archive',
  'doc',
]);

/** Thrown when registry validation finds violations. */
export class DocumentRegistryError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(violations.join('\n'));
    this.name = 'DocumentRegistryError';
    this.violations = violations;
  }
}

export interface DocumentRecord {
  id: string;
  aliases: string[];
  path: string;
  title: string;
  doc_type: string;
  summary: string;
  tags: string[];
  systems: string[];
  related_docs: string[];
  updated_at: number;
  domain: string;
  id_source: 'frontmatter' | 'generated';
}

export interface DocumentRecordDict extends Omit<DocumentRecord, never> {
  stable_id: boolean;
}

export interface DocumentRegistry {
  documents: DocumentRecord[];
  byId: Map<string, DocumentRecord>;
  byAlias: Map<string, DocumentRecord>;
  byPath: Map<string, DocumentRecord>;
}

export function recordToDict(record: DocumentRecord): DocumentRecordDict {
  return {
    id: record.id,
    stable_id: record.id_source === 'frontmatter',
    aliases: record.aliases,
    path: record.path,
    title: record.title,
    doc_type: record.doc_type,
    summary: record.summary,
    tags: record.tags,
    systems: record.systems,
    related_docs: record.related_docs,
    updated_at: record.updated_at,
    domain: record.domain,
    id_source: record.id_source,
  };
}

export function registryToDict(registry: DocumentRegistry): { documents: DocumentRecordDict[] } {
  return { documents: registry.documents.map(recordToDict) };
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** Recursively collect `*.md` files under `dir`, sorted (posix order). */
function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Build the registry for a content root. `contentRoot` is an absolute path; repo
 * paths are computed against its parent (the repo/cache root), matching Python
 * `build_registry`.
 */
export function buildRegistry(contentRoot: string, validate = true): DocumentRegistry {
  const repoRoot = posixParent(contentRoot);
  const records: DocumentRecord[] = [];
  const violations: string[] = [];

  const files = collectMarkdown(contentRoot).sort();
  for (const file of files) {
    const text = readFileSync(file, 'utf-8');
    const [rawFm, body] = splitFrontmatter(text);
    const metadata: Frontmatter = rawFm ? parseFrontmatter(rawFm) : {};
    const repoPath = toPosixRel(file, repoRoot);
    const mtime = Math.floor(statSync(file).mtimeMs / 1000);
    const record = recordFromMetadata(repoPath, body, metadata, mtime);
    records.push(record);

    if (!DOCUMENT_ID_RE.test(record.id)) violations.push(`${repoPath}: invalid id '${record.id}'`);
    for (const alias of record.aliases) {
      if (looksLikePath(alias)) {
        try {
          normalizePathAlias(alias);
        } catch {
          violations.push(`${repoPath}: invalid path alias '${alias}'`);
        }
      } else if (!DOCUMENT_ID_RE.test(alias)) {
        violations.push(`${repoPath}: invalid alias '${alias}'`);
      }
    }
    if (!VALID_DOC_TYPES.has(record.doc_type)) {
      violations.push(`${repoPath}: unsupported doc_type '${record.doc_type}'`);
    }
  }

  const byId = new Map<string, DocumentRecord>();
  const byAlias = new Map<string, DocumentRecord>();
  const byPath = new Map<string, DocumentRecord>();

  for (const record of records) {
    addUnique(byId, record.id, record, 'id', violations);
    byPath.set(record.path, record);
    byPath.set(removePrefix(record.path, 'content/'), record);
    byPath.set('/' + removePrefix(record.path, 'content/'), record);
    for (const alias of record.aliases) {
      addUnique(byAlias, normalizeAlias(alias), record, 'alias', violations);
    }
  }

  const registry: DocumentRegistry = { documents: records, byId, byAlias, byPath };

  if (validate) {
    violations.push(...validateAliasConflicts(byAlias, byId));
    violations.push(...validateAliasPathConflicts(byAlias, byPath));
    violations.push(...validateRelatedDocs(records, registry));
    if (violations.length) throw new DocumentRegistryError(violations);
  }

  return registry;
}

export function resolveReference(registry: DocumentRegistry, ref: string): DocumentRecord {
  const normalized = normalizeReference(ref);
  const matches: DocumentRecord[] = [];
  for (const index of [registry.byId, registry.byAlias, registry.byPath]) {
    const record = index.get(normalized);
    if (record && !matches.includes(record)) matches.push(record);
  }

  if (matches.length === 0 && looksLikePath(normalized)) {
    const pathRef = normalizePathAlias(normalized);
    const record = registry.byPath.get(pathRef) || registry.byPath.get(removePrefix(pathRef, 'content/'));
    if (record) matches.push(record);
  }

  if (matches.length === 0) throw new LookupError(`Document reference not found: ${ref}`);
  if (matches.length > 1) {
    const ids = matches.map((r) => r.id).sort().join(', ');
    throw new LookupError(`Document reference is ambiguous: ${ref} (${ids})`);
  }
  return matches[0];
}

/** Mirrors Python's `LookupError` for reference resolution. */
export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupError';
  }
}

export function normalizeReference(ref: string): string {
  let value = ref.trim();
  const wiki = WIKI_REF_RE.exec(value);
  if (wiki) value = wiki[1].trim();
  if (value.startsWith('doc:')) value = value.slice('doc:'.length).trim();
  return value.trim();
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateRelatedDocs(records: DocumentRecord[], registry: DocumentRegistry): string[] {
  const violations: string[] = [];
  for (const record of records) {
    const sourceDir = posix.dirname(record.path);
    for (const related of record.related_docs) {
      const ref = normalizeReference(related);
      const candidates = relatedCandidates(ref, sourceDir);
      if (candidates.some((candidate) => canResolve(registry, candidate))) continue;
      violations.push(`${record.path}: related_docs reference not found: '${related}'`);
    }
  }
  return violations;
}

function validateAliasConflicts(
  byAlias: Map<string, DocumentRecord>,
  byId: Map<string, DocumentRecord>,
): string[] {
  const violations: string[] = [];
  for (const [alias, record] of byAlias) {
    const idRecord = byId.get(alias);
    if (idRecord && idRecord.path !== record.path) {
      violations.push(`alias '${alias}' from ${record.path} conflicts with id from ${idRecord.path}`);
    }
  }
  return violations;
}

function validateAliasPathConflicts(
  byAlias: Map<string, DocumentRecord>,
  byPath: Map<string, DocumentRecord>,
): string[] {
  const violations: string[] = [];
  for (const [alias, record] of byAlias) {
    const pathRecord = byPath.get(alias);
    if (pathRecord && pathRecord.path !== record.path) {
      violations.push(`alias '${alias}' from ${record.path} conflicts with path from ${pathRecord.path}`);
    }
  }
  return violations;
}

// ── Record construction ─────────────────────────────────────────────────────

function recordFromMetadata(
  repoPath: string,
  body: string,
  metadata: Frontmatter,
  mtime: number,
): DocumentRecord {
  const explicitId = asString(metadata.id);
  const docType = asString(metadata.doc_type) || inferDocType(repoPath);
  const docId = explicitId || generatedId(repoPath, docType);
  const stem = basename(repoPath).replace(/\.md$/, '');
  return {
    id: docId,
    aliases: asStrings(metadata.aliases),
    path: repoPath,
    title: asString(metadata.title) || firstHeading(body) || titleCase(stem.replace(/-/g, ' ')),
    doc_type: docType,
    summary: asString(metadata.summary),
    tags: asStrings(metadata.tags),
    systems: asStrings(metadata.systems),
    related_docs: asStrings(metadata.related_docs),
    updated_at: mtime,
    domain: inferDomain(repoPath),
    id_source: explicitId ? 'frontmatter' : 'generated',
  };
}

export function generatedId(repoPath: string, docType: string): string {
  const path = removeSuffix(removePrefix(repoPath, 'content/'), '.md');
  const parts = path.split('/').filter((part) => !ID_STRIP_DIRS.has(part));
  const slug = parts.join('.');
  return `${docType}.${slug}`.replace(/_/g, '-');
}

function addUnique(
  index: Map<string, DocumentRecord>,
  key: string,
  record: DocumentRecord,
  label: string,
  violations: string[],
): void {
  const existing = index.get(key);
  if (existing && existing.path !== record.path) {
    violations.push(`duplicate ${label} '${key}': ${existing.path} and ${record.path}`);
    return;
  }
  index.set(key, record);
}

// ── Reference helpers ─────────────────────────────────────────────────────────

function normalizeAlias(alias: string): string {
  if (looksLikePath(alias)) return normalizePathAlias(alias);
  return alias.trim();
}

function normalizePathAlias(alias: string): string {
  let path = alias.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path.endsWith('.md')) throw new Error(alias);
  if (!path.startsWith('content/')) path = `content/${path}`;
  return path;
}

function relatedCandidates(ref: string, sourceDir: string): string[] {
  const candidates = [ref];
  if (looksLikePath(ref)) {
    const path = ref.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path.startsWith('content/')) {
      candidates.push(`content/${path}`);
      candidates.push(posix.normalize(`${sourceDir}/${path}`));
    }
  }
  return candidates;
}

function canResolve(registry: DocumentRegistry, ref: string): boolean {
  try {
    resolveReference(registry, ref);
    return true;
  } catch {
    return false;
  }
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.endsWith('.md');
}

// ── Frontmatter value coercion ────────────────────────────────────────────────

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '';
  return String(value).trim();
}

function asStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => stripQuotes(String(item).trim()))
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [stripQuotes(trimmed)] : [];
  }
  return [String(value).trim()];
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function firstHeading(body: string): string {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return '';
}

function inferDomain(path: string): string {
  const parts = path.split('/');
  if (parts.length >= 2 && parts[0] === 'content') return parts[1];
  return 'unknown';
}

function inferDocType(path: string): string {
  const parts = new Set(path.split('/'));
  if (parts.has('sops')) return 'sop';
  if (parts.has('templates')) return 'template';
  if (parts.has('reference')) return 'reference';
  if (parts.has('playbooks')) return 'playbook';
  if (parts.has('prompts')) return 'prompt';
  if (parts.has('archive')) return 'archive';
  return 'doc';
}

// ── Small string utilities (Python str method parity) ─────────────────────────

function removePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function removeSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

function titleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function basename(repoPath: string): string {
  return repoPath.split('/').pop() || repoPath;
}

function posixParent(absDir: string): string {
  const idx = absDir.lastIndexOf(sep);
  return idx > 0 ? absDir.slice(0, idx) : absDir;
}

function toPosixRel(file: string, repoRoot: string): string {
  return file.slice(repoRoot.length + 1).split(sep).join(posix.sep);
}
