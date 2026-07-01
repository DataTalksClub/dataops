/**
 * Docs content API.
 *
 * TypeScript port of `lambda-functions/src/lambda_functions/api_handler.py` and
 * the docs half of `search_handler.py`, wired onto the docs-domain seam. Routes
 * (`/docs`, `/images`, `/folders`, `/lint`, `/parse`, `/health`, `/search`) read
 * and write content through {@link ContentsApiGithubStore} (GitHub source of
 * truth + `/tmp` cache + commit-on-save), lint/parse through the SOP engine
 * (`./sop`), and search through {@link ZeroSearchIndex} (#85). After a content
 * mutation the in-process search index is refreshed.
 *
 * Registration is opt-in via {@link isDocsDomainEnabled}.
 */

import { Buffer } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import type { LambdaEvent, LambdaResponse } from '../types';
import {
  ContentsApiGithubStore,
  createGithubStore,
  githubStoreConfigFromEnv,
  GitHubError,
} from './githubStore';
import {
  buildRegistry,
  recordToDict,
  registryToDict,
  resolveReference,
  DocumentRegistryError,
  LookupError,
  type DocumentRecord,
} from './docRegistry';
import { createSearchIndex, type SearchIndex, type SearchResult } from './searchIndex';
import { iterContentDocs } from './search/extract';
import { sopStructuredText } from './search/sopExtract';
import { parse, ParseError, lintText } from './sop';

const DEFAULT_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-user-email',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

const CONTENT_PREFIX = 'content/';
const DOC_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.md$/;
const FOLDER_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/**
 * Path prefixes owned by the docs content API. A request path matches a route
 * when it equals the prefix or continues with `/`.
 */
export const DOCS_ROUTE_PREFIXES = [
  '/docs',
  '/images',
  '/folders',
  '/lint',
  '/parse',
  '/health',
  '/search',
] as const;

export type DocsRoutePrefix = (typeof DOCS_ROUTE_PREFIXES)[number];

/** True when `path` belongs to the docs content API. */
export function isDocsRoute(path: string): boolean {
  return DOCS_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Feature flag: only register/serve docs routes when explicitly enabled. Off by
 * default so existing work-engine behavior is unaffected until the docs domain
 * is turned on (#87/#88).
 */
export function isDocsDomainEnabled(): boolean {
  const value = process.env.DATAOPS_DOCS_DOMAIN;
  return value === 'true' || value === '1';
}

// ── Errors used for HTTP status mapping ───────────────────────────────────────

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
class BadRequest extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}
class NotFound extends HttpError {
  constructor(message: string) {
    super(404, message);
  }
}

// ── Runtime (store + search index) ────────────────────────────────────────────

/** Holds the per-process docs store and search index. */
export class DocsRuntime {
  index: SearchIndex | null = null;
  private searchReady = false;

  constructor(readonly store: ContentsApiGithubStore) {}

  get contentRoot(): string {
    return this.store.contentRoot;
  }

  get repoRoot(): string {
    return this.store.root;
  }

  async ensureSynced(): Promise<void> {
    await this.store.sync();
  }

  async ensureSearch(): Promise<void> {
    await this.ensureSynced();
    if (!this.searchReady || this.index === null) {
      this.rebuildSearch();
    }
  }

  /** Rebuild the in-process search index from the content cache. */
  rebuildSearch(): void {
    const docs = iterContentDocs(this.contentRoot, { structuredText: sopStructuredText });
    const index = createSearchIndex();
    index.fit(docs);
    this.index = index;
    this.searchReady = true;
  }
}

let runtime: DocsRuntime | null = null;

/** Lazily build the runtime from environment (production path). */
function getRuntime(): DocsRuntime {
  if (runtime === null) {
    runtime = new DocsRuntime(createGithubStore(githubStoreConfigFromEnv()));
  }
  return runtime;
}

/** Inject a runtime (tests / explicit wiring). */
export function configureDocsRuntime(store: ContentsApiGithubStore): DocsRuntime {
  runtime = new DocsRuntime(store);
  return runtime;
}

/** Clear the cached runtime (tests). */
export function resetDocsRuntime(): void {
  runtime = null;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): LambdaResponse {
  return { statusCode: status, headers: { ...DEFAULT_HEADERS }, body: JSON.stringify(body) };
}

function method(event: LambdaEvent): string {
  return (event.httpMethod || 'GET').toUpperCase();
}

function queryParam(event: LambdaEvent, name: string): string | null {
  const value = event.queryStringParameters?.[name];
  return value !== undefined && value !== null ? String(value) : null;
}

function jsonBody(event: LambdaEvent): Record<string, unknown> {
  const raw = event.body || '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    throw new BadRequest('Request body must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ── Top-level dispatch ────────────────────────────────────────────────────────

/**
 * Dispatch a docs-domain request. Returns `null` when the path is not a docs
 * route so the caller can fall through to other handlers.
 */
export async function handleDocsRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const path = event.path || '/';
  if (!isDocsRoute(path)) return null;

  if (method(event) === 'OPTIONS') {
    return { statusCode: 204, headers: { ...DEFAULT_HEADERS }, body: '' };
  }

  try {
    return await dispatch(event, path);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message });
    if (err instanceof DocumentRegistryError) return jsonResponse(400, { error: err.message });
    if (err instanceof GitHubError) {
      return jsonResponse(502, { error: 'GitHub request failed', detail: err.message });
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return jsonResponse(404, { error: 'Document not found' });
    }
    console.error('Docs content API error:', err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

async function dispatch(event: LambdaEvent, path: string): Promise<LambdaResponse> {
  const m = method(event);
  const rt = getRuntime();

  if (path === '/health') return jsonResponse(200, { ok: true });
  if (path === '/search') return search(rt, event);

  if (path === '/docs/registry' && m === 'GET') return getDocRegistry(rt);
  if (path === '/docs/resolve' && m === 'GET') return resolveDoc(rt, queryParam(event, 'ref'));
  if (path === '/docs/backlinks' && m === 'GET') return listBacklinks(rt, queryParam(event, 'path'));
  if (path === '/docs/rename' && m === 'POST') return renameDoc(rt, jsonBody(event));

  if (path === '/docs' && m === 'GET') {
    const docPath = queryParam(event, 'path');
    return docPath ? getDoc(rt, docPath) : listDocs(rt);
  }
  if (path === '/docs' && m === 'PUT') return saveDoc(rt, queryParam(event, 'path'), jsonBody(event));
  if (path === '/docs' && m === 'POST') return createDoc(rt, jsonBody(event));
  if (path === '/docs' && m === 'DELETE') return deleteDoc(rt, queryParam(event, 'path'));

  if (path === '/folders' && m === 'DELETE') return deleteFolder(rt, queryParam(event, 'path'));
  if (path === '/folders/rename' && m === 'POST') return renameFolder(rt, jsonBody(event));

  if (path === '/lint' && m === 'GET') return runCorpusLint(rt);
  if (path === '/parse' && m === 'POST') return parseContent(jsonBody(event));
  if (path === '/images' && m === 'POST') return uploadImage(rt, jsonBody(event));

  return jsonResponse(404, { error: 'Not found' });
}

// ── Docs read endpoints ───────────────────────────────────────────────────────

async function listDocs(rt: DocsRuntime): Promise<LambdaResponse> {
  await rt.ensureSynced();
  const registry = buildRegistry(rt.contentRoot);
  const docs = registry.documents.map((record) => {
    const item = recordToDict(record) as unknown as Record<string, unknown>;
    item.updated = item.updated_at;
    return item;
  });
  return jsonResponse(200, { documents: docs });
}

async function getDocRegistry(rt: DocsRuntime): Promise<LambdaResponse> {
  await rt.ensureSynced();
  return jsonResponse(200, registryToDict(buildRegistry(rt.contentRoot)));
}

async function resolveDoc(rt: DocsRuntime, ref: string | null): Promise<LambdaResponse> {
  if (!ref) throw new BadRequest('Missing required query parameter: ref');
  await rt.ensureSynced();
  const registry = buildRegistry(rt.contentRoot);
  let record: DocumentRecord;
  try {
    record = resolveReference(registry, ref);
  } catch (err) {
    if (err instanceof LookupError) return jsonResponse(404, { error: err.message });
    throw err;
  }
  return jsonResponse(200, { document: recordToDict(record) });
}

async function getDoc(rt: DocsRuntime, rawPath: string): Promise<LambdaResponse> {
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  const content = await rt.store.readFile(repoPath); // hydrates from GitHub if needed
  const body: Record<string, unknown> = {
    path: repoPath,
    content,
    updated: rt.store.updatedAt(repoPath),
  };
  try {
    body.parsed = parse(content);
  } catch (err) {
    if (err instanceof ParseError) {
      body.parsed = null;
      body.parse_error = err.message;
    } else {
      throw err;
    }
  }
  return jsonResponse(200, body);
}

// ── Docs mutation endpoints (commit-on-save + search refresh) ─────────────────

async function saveDoc(
  rt: DocsRuntime,
  rawPath: string | null,
  body: Record<string, unknown>,
): Promise<LambdaResponse> {
  if (!rawPath) throw new BadRequest('Missing required query parameter: path');
  const content = body.content;
  if (typeof content !== 'string') throw new BadRequest('Request body must include string field: content');

  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  await rt.store.commitLocalFile(repoPath, `Update ${repoPath}`);

  let warnings: string[] = [];
  try {
    warnings = lintText(content);
  } catch {
    warnings = [];
  }
  rt.rebuildSearch();
  return jsonResponse(200, { path: repoPath, updated: rt.store.updatedAt(repoPath), warnings });
}

async function createDoc(rt: DocsRuntime, body: Record<string, unknown>): Promise<LambdaResponse> {
  const rawPath = body.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new BadRequest('Request body must include string field: path');
  }
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  if (existsSync(filePath)) throw new BadRequest('Document already exists');

  const stem = baseStem(repoPath);
  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim() : titleCase(stem.replace(/-/g, ' '));
  const docType =
    typeof body.doc_type === 'string' && body.doc_type.trim() ? body.doc_type.trim() : inferDocType(repoPath);
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const scaffold = body.scaffold === 'minimal' ? 'minimal' : 'full';

  const content = newDocContent(title, docType, summary, scaffold);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  await rt.store.commitLocalFile(repoPath, `Create ${repoPath}`);
  rt.rebuildSearch();

  return jsonResponse(201, { path: repoPath, content, updated: rt.store.updatedAt(repoPath) });
}

async function deleteDoc(rt: DocsRuntime, rawPath: string | null): Promise<LambdaResponse> {
  if (!rawPath) throw new BadRequest('Missing required query parameter: path');
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  if (!existsSync(filePath)) throw new NotFound('Document not found');
  rmSync(filePath, { force: true });
  pruneEmptyDirs(dirname(filePath), rt.contentRoot);
  await rt.store.deleteRepoFile(repoPath, `Delete ${repoPath}`);
  rt.rebuildSearch();
  return jsonResponse(200, { deleted: repoPath });
}

async function renameDoc(rt: DocsRuntime, body: Record<string, unknown>): Promise<LambdaResponse> {
  const oldRaw = body.old_path;
  const newRaw = body.new_path;
  if (typeof oldRaw !== 'string' || !oldRaw.trim()) throw new BadRequest('Request body must include string field: old_path');
  if (typeof newRaw !== 'string' || !newRaw.trim()) throw new BadRequest('Request body must include string field: new_path');
  const oldPath = normalizeDocPath(oldRaw);
  const newPath = normalizeDocPath(newRaw);
  validateDocPath(oldPath);
  validateDocPath(newPath);
  await rt.ensureSynced();

  const oldFile = localPath(rt, oldPath);
  const newFile = localPath(rt, newPath);
  if (!existsSync(oldFile)) throw new NotFound('Document not found');
  if (existsSync(newFile)) throw new BadRequest('Target path already exists');
  mkdirSync(dirname(newFile), { recursive: true });
  renameSync(oldFile, newFile);
  pruneEmptyDirs(dirname(oldFile), rt.contentRoot);

  await rt.store.commitLocalFile(newPath, `Rename ${oldPath} to ${newPath}`);
  await rt.store.deleteRepoFile(oldPath, `Remove renamed ${oldPath}`);
  rt.rebuildSearch();
  return jsonResponse(200, { old_path: oldPath, new_path: newPath });
}

// ── Lint / parse ──────────────────────────────────────────────────────────────

async function runCorpusLint(rt: DocsRuntime): Promise<LambdaResponse> {
  await rt.ensureSynced();
  const results: { path: string; violations: string[] }[] = [];
  for (const file of collectMarkdown(rt.contentRoot).sort()) {
    const text = readFileSync(file, 'utf-8');
    // Only report schema_version=1 docs (the spec) to avoid noise from legacy docs.
    if (!text.includes('schema_version: 1')) continue;
    let violations: string[];
    try {
      violations = lintText(text);
    } catch (err) {
      violations = [`lint failed: ${(err as Error).message}`];
    }
    if (violations.length) results.push({ path: repoRelative(rt.repoRoot, file), violations });
  }
  const totalViolations = results.reduce((sum, doc) => sum + doc.violations.length, 0);
  return jsonResponse(200, { docs: results, total_violations: totalViolations });
}

function parseContent(body: Record<string, unknown>): LambdaResponse {
  const text = body.content;
  if (typeof text !== 'string') throw new BadRequest('Request body must include string field: content');
  try {
    return jsonResponse(200, { parsed: parse(text) });
  } catch (err) {
    if (err instanceof ParseError) return jsonResponse(200, { parsed: null, error: err.message });
    throw err;
  }
}

// ── Backlinks ─────────────────────────────────────────────────────────────────

const BACKLINK_LINK_RE = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;

async function listBacklinks(rt: DocsRuntime, rawPath: string | null): Promise<LambdaResponse> {
  if (!rawPath) throw new BadRequest('Missing required query parameter: path');
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const target = localPath(rt, repoPath);
  const targetBasename = baseName(target);
  const results: { path: string; title: string }[] = [];
  for (const file of collectMarkdown(rt.contentRoot).sort()) {
    if (resolve(file) === resolve(target)) continue;
    const text = readFileSync(file, 'utf-8');
    if (!text.includes(targetBasename)) continue;
    if (!referencesTarget(file, text, target)) continue;
    results.push({
      path: repoRelative(rt.repoRoot, file),
      title: frontmatterValue(text, 'title') || titleCase(baseStem(file).replace(/-/g, ' ')),
    });
  }
  return jsonResponse(200, { path: repoPath, backlinks: results });
}

function referencesTarget(source: string, text: string, target: string): boolean {
  const sourceDir = dirname(source);
  for (const match of text.matchAll(BACKLINK_LINK_RE)) {
    const link = match[1];
    if (/^(https?:\/\/|#|mailto:)/.test(link)) continue;
    let resolved: string;
    try {
      resolved = resolve(sourceDir, link);
    } catch {
      continue;
    }
    if (resolved === resolve(target)) return true;
  }
  return false;
}

// ── Images ────────────────────────────────────────────────────────────────────

async function uploadImage(rt: DocsRuntime, body: Record<string, unknown>): Promise<LambdaResponse> {
  const docPathRaw = body.doc_path;
  if (typeof docPathRaw !== 'string' || !docPathRaw.trim()) {
    throw new BadRequest('Request body must include string field: doc_path');
  }
  const docRepoPath = normalizeDocPath(docPathRaw);
  validateDocPath(docRepoPath);
  await rt.ensureSynced();
  const docFile = localPath(rt, docRepoPath);

  const filename = body.filename;
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new BadRequest('Request body must include string field: filename');
  }
  const safeName = sanitizeImageFilename(filename);
  if (!safeName) throw new BadRequest('filename is empty after sanitization');
  const ext = extname(safeName);
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new BadRequest(`Unsupported image extension. Allowed: ${[...IMAGE_EXTENSIONS].sort().join(', ')}`);
  }

  const rawData = body.data;
  if (typeof rawData !== 'string') throw new BadRequest('Request body must include base64 string field: data');
  const imageBytes = Buffer.from(rawData, 'base64');
  if (imageBytes.length === 0) throw new BadRequest('image is empty');
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    throw new BadRequest(`image exceeds ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`);
  }

  const slug = baseStem(docRepoPath);
  const imageDir = join(rt.contentRoot, 'images', slug);
  mkdirSync(imageDir, { recursive: true });
  const target = uniqueImagePath(join(imageDir, safeName));
  writeFileSync(target, imageBytes);

  const repoRelativePath = repoRelative(rt.repoRoot, target);
  await rt.store.commitLocalFile(repoRelativePath, `Upload ${repoRelativePath}`);
  rt.rebuildSearch();

  const docRelative = relativePath(dirname(docFile), target);
  return jsonResponse(201, { path: docRelative, absolute_path: repoRelativePath, bytes: imageBytes.length });
}

// ── Folders ───────────────────────────────────────────────────────────────────

async function deleteFolder(rt: DocsRuntime, rawPath: string | null): Promise<LambdaResponse> {
  await rt.ensureSynced();
  const folder = resolveFolderPath(rt, rawPath);
  const files = collectAllFiles(folder);
  const repoPaths = files.map((file) => repoRelative(rt.repoRoot, file));
  rmSync(folder, { recursive: true, force: true });
  for (const repoPath of repoPaths) {
    await rt.store.deleteRepoFile(repoPath, `Delete ${repoPath}`);
  }
  rt.rebuildSearch();
  return jsonResponse(200, { deleted: repoRelative(rt.repoRoot, folder), files: files.length });
}

async function renameFolder(rt: DocsRuntime, body: Record<string, unknown>): Promise<LambdaResponse> {
  const oldRaw = body.old_path;
  const newRaw = body.new_path;
  if (typeof oldRaw !== 'string' || !oldRaw.trim()) throw new BadRequest('Request body must include string field: old_path');
  if (typeof newRaw !== 'string' || !newRaw.trim()) throw new BadRequest('Request body must include string field: new_path');
  await rt.ensureSynced();

  const src = resolveFolderPath(rt, oldRaw);
  const dst = resolveFolderPath(rt, newRaw, false);
  if (existsSync(dst)) throw new BadRequest('Target folder already exists');
  const oldRepoPaths = collectAllFiles(src).map((file) => repoRelative(rt.repoRoot, file));

  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);

  const srcRepo = repoRelative(rt.repoRoot, src);
  const dstRepo = repoRelative(rt.repoRoot, dst);
  for (const file of collectAllFiles(dst).sort()) {
    const repoPath = repoRelative(rt.repoRoot, file);
    await rt.store.commitLocalFile(repoPath, `Rename folder ${srcRepo} to ${dstRepo}`);
  }
  for (const repoPath of oldRepoPaths) {
    await rt.store.deleteRepoFile(repoPath, `Remove renamed ${repoPath}`);
  }
  rt.rebuildSearch();
  return jsonResponse(200, { old_path: srcRepo, new_path: dstRepo });
}

// ── Search (docs source over the SearchIndex) ─────────────────────────────────

async function search(rt: DocsRuntime, event: LambdaEvent): Promise<LambdaResponse> {
  const params = event.queryStringParameters || {};
  const query = (queryParam(event, 'q') || '').trim();
  if (!query) return jsonResponse(400, { error: 'Missing required query parameter: q' });

  const limit = Math.min(
    parseInt(params.limit || String(DEFAULT_SEARCH_LIMIT), 10) || DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const filters: Record<string, string> = {};
  for (const field of ['domain', 'doc_type']) {
    const value = (params[field] || '').trim();
    if (value) filters[field] = value;
  }

  const results: Record<string, unknown>[] = [];
  const sources: Record<string, unknown>[] = [];

  if (sourceEnabled(params, 'docs')) {
    await rt.ensureSearch();
    const matches = rt.index!.search(query, { filter: filters, numResults: limit });
    let docResults = matches.map(formatDocResult);
    docResults = docResults.filter((result) => resultMatchesFilters(result, params));
    results.push(...docResults);
    sources.push({ source: 'docs', status: 'ok', count: docResults.length });
  }

  if (sourceEnabled(params, 'work')) {
    // Live work-source merge runs as a separate concern; not wired in this port.
    sources.push({
      source: 'work-engine',
      status: 'unavailable',
      error: 'Work search is not wired into the docs search endpoint yet',
    });
  }

  const sorted = sortResults(results).slice(0, limit);
  return jsonResponse(200, { query, results: sorted, sources });
}

function formatDocResult(match: SearchResult): Record<string, unknown> {
  const summary = String(match.summary || '');
  const description = String(match.description || summary);
  return {
    type: 'doc',
    source: 'docs',
    source_label: `Process ${match.doc_type || 'doc'}`,
    action_label: 'Open process doc',
    path: match.path,
    id: match.id,
    title: match.title,
    domain: match.domain,
    doc_type: match.doc_type,
    summary,
    context: description || summary || match.path || '',
    description,
    purpose: match.purpose || '',
    tags: listValues(match.tags),
    systems: listValues(match.systems),
    route: { kind: 'doc', path: match.path, docId: match.id },
    fields: {
      doc_type: match.doc_type || '',
      domain: match.domain || '',
      tags: listValues(match.tags),
      systems: listValues(match.systems),
    },
  };
}

function sourceEnabled(params: Record<string, string>, source: 'docs' | 'work'): boolean {
  const requested = (params.source || params.sources || '').trim().toLowerCase();
  if (!requested) return true;
  const values = new Set(requested.replace(/,/g, ' ').split(/\s+/).filter(Boolean));
  if (source === 'docs') return ['docs', 'doc', 'process', 'process-docs'].some((v) => values.has(v));
  return ['work', 'work-engine', 'tasks', 'task', 'workflow', 'workflows', 'runtime'].some((v) => values.has(v));
}

function resultMatchesFilters(result: Record<string, unknown>, params: Record<string, string>): boolean {
  const requestedType = (params.type || params.result_type || '').trim().toLowerCase();
  if (
    requestedType &&
    ![String(result.type || '').toLowerCase(), String(result.doc_type || '').toLowerCase()].includes(requestedType)
  ) {
    return false;
  }
  const tag = (params.tag || '').trim().toLowerCase();
  if (tag && !metadataFilterMatches(result, 'tags', tag)) return false;
  const system = (params.system || '').trim().toLowerCase();
  if (system && !metadataFilterMatches(result, 'systems', system)) return false;
  return true;
}

function metadataFilterMatches(result: Record<string, unknown>, field: string, requested: string): boolean {
  const fields = (result.fields as Record<string, unknown>) || {};
  const values = new Set(listValues(result[field] ?? fields[field]).map((v) => v.toLowerCase()));
  return values.has(requested);
}

function sortResults(results: Record<string, unknown>[]): Record<string, unknown>[] {
  const order: Record<string, number> = {
    task: 0,
    workflow: 1,
    template: 2,
    doc: 3,
    artifact: 4,
    file: 5,
    'assistant-job': 6,
  };
  return [...results].sort((a, b) => {
    const oa = order[String(a.type)] ?? 9;
    const ob = order[String(b.type)] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase());
  });
}

function listValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .replace(/,/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [String(value)];
}

// ── Path / filesystem helpers (ported from api_handler.py) ────────────────────

function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeDocPath(rawPath: string): string {
  let path = unquote(rawPath).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path.startsWith(CONTENT_PREFIX)) path = `${CONTENT_PREFIX}${path}`;
  return path;
}

function validateDocPath(repoPath: string): void {
  const relativePathStr = repoPath.startsWith(CONTENT_PREFIX) ? repoPath.slice(CONTENT_PREFIX.length) : repoPath;
  if (!DOC_PATH_RE.test(relativePathStr)) {
    throw new BadRequest('Document path may only contain letters, numbers, slash, dash, underscore, and .md');
  }
}

function localPath(rt: DocsRuntime, repoPath: string): string {
  const relativeStr = repoPath.startsWith(CONTENT_PREFIX) ? repoPath.slice(CONTENT_PREFIX.length) : repoPath;
  const target = resolve(rt.contentRoot, relativeStr);
  if (target !== rt.contentRoot && !target.startsWith(rt.contentRoot + sep)) {
    throw new BadRequest('Document path escapes content root');
  }
  return target;
}

function resolveFolderPath(rt: DocsRuntime, rawPath: string | null, mustExist = true): string {
  if (!rawPath) throw new BadRequest('Missing required parameter: path');
  let norm = unquote(rawPath).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm.startsWith(CONTENT_PREFIX)) norm = `${CONTENT_PREFIX}${norm}`;
  const relativeStr = norm.slice(CONTENT_PREFIX.length).replace(/\/+$/, '');
  if (!relativeStr) throw new BadRequest('Cannot operate on the content/ root itself');
  if (!FOLDER_PATH_RE.test(relativeStr)) {
    throw new BadRequest('Folder path may only contain letters, numbers, slash, dash, underscore');
  }
  const folder = resolve(rt.contentRoot, relativeStr);
  if (folder !== rt.contentRoot && !folder.startsWith(rt.contentRoot + sep)) {
    throw new BadRequest('Folder escapes content root');
  }
  if (mustExist && (!existsSync(folder) || !statSync(folder).isDirectory())) {
    throw new NotFound(norm);
  }
  return folder;
}

function pruneEmptyDirs(start: string, contentRoot: string): void {
  let parent = start;
  while (parent !== contentRoot && existsSync(parent) && statSync(parent).isDirectory()) {
    if (readdirSync(parent).length > 0) break;
    rmSync(parent, { recursive: true, force: true });
    parent = dirname(parent);
  }
}

function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function collectAllFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectAllFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function repoRelative(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join(posix.sep);
}

function sanitizeImageFilename(filename: string): string {
  let name = filename.trim().replace(/\\/g, '/').split('/').pop() || '';
  name = name.replace(/ /g, '-').toLowerCase();
  return name.replace(/[^a-z0-9._-]+/g, '');
}

function uniqueImagePath(target: string): string {
  if (!existsSync(target)) return target;
  const ext = extname(target);
  const stem = baseStem(target);
  const dir = dirname(target);
  let i = 1;
  for (;;) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
    i += 1;
  }
}

function relativePath(fromDir: string, toFile: string): string {
  return relative(resolve(fromDir), resolve(toFile)).split(sep).join(posix.sep) || '.';
}

function frontmatterValue(markdown: string, key: string): string {
  if (!markdown.startsWith('---\n')) return '';
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return '';
  const prefix = `${key}:`;
  for (const line of markdown.slice(4, end).split('\n')) {
    if (line.startsWith(prefix)) {
      return line.slice(line.indexOf(':') + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return '';
}

function inferDocType(repoPath: string): string {
  const parts = new Set(repoPath.split('/'));
  if (parts.has('sops')) return 'sop';
  if (parts.has('templates')) return 'template';
  if (parts.has('reference')) return 'reference';
  if (parts.has('playbooks')) return 'playbook';
  if (parts.has('prompts')) return 'prompt';
  return 'doc';
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function baseStem(p: string): string {
  return baseName(p).replace(/\.[^.]+$/, '');
}

function extname(p: string): string {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function titleCase(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
}

// ── New-document scaffolds (ported from api_handler.py) ───────────────────────

function newDocContent(title: string, docType: string, summary: string, scaffold: 'full' | 'minimal'): string {
  if (docType === 'sop' || docType === 'checklist') {
    return scaffold === 'minimal'
      ? minimalSopTemplate(title, docType, summary)
      : fullSopTemplate(title, docType, summary);
  }
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
tags: []
systems: []
related_docs: []
---

# ${title}

## Summary

## Content

`;
}

function fullSopTemplate(title: string, docType: string, summary: string): string {
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
tags: []
systems: []
related_docs: []
---

# ${title}

<!-- sop-section-start: summary -->
## Summary

- Purpose:
- Outcome:
- Trigger:
- Frequency:
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites

- Access:
- Tools:
- Inputs:
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.  Describe the first step.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation

- How to confirm the work is done correctly.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting

- Common issue:
- Fix:
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References

-
<!-- sop-section-end -->
`;
}

function minimalSopTemplate(title: string, docType: string, summary: string): string {
  return `---
title: "${title}"
summary: "${summary}"
doc_type: ${docType}
schema_version: 1
tags: []
systems: []
related_docs: []
---

# ${title}

<!-- sop-section-start: summary -->
## Summary
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
<!-- sop-section-end -->
`;
}
