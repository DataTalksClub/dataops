import { templateParser } from './templatePlaceholders';
import { dump as dumpYaml } from 'js-yaml';
import { DOCX_CONTENT_TYPE, markdownToDocx } from './docxExport';
import { repairFrontmatterScalars } from './derivedDocuments';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
/**
 * Docs content API.
 *
 * Documents are plain markdown with YAML frontmatter: the body is stored,
 * rendered, and searched as-is, with no structured parsing or linting.
 * Served only when {@link isDocsDomainEnabled}.
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
  KnowledgeStore,
  ContentRootUnavailableError,
  createKnowledgeStore,
  contentRootUnavailableMessage,
  knowledgeStoreConfigFromEnv,
  KnowledgeError,
  normalizeRepoPath,
  isManagedKnowledgePath,
  MANAGED_KNOWLEDGE_ROOTS,
  RevisionConflict,
  KnowledgeVersionNotFound,
  type Mutation,
  type RecentDocChanges,
} from './knowledgeStore';
import { listTemplates } from '../db/templates';
import type { Template } from '../types';
import {
  DerivedDocumentNotFound,
  regenerateDerivedDocuments,
} from './derivedDocuments';
import {
  buildRegistry,
  recordToDict,
  registryToDict,
  resolveReference,
  LookupError,
  type DocumentRecord,
} from './docRegistry';
import { createSearchIndex, type SearchIndex } from './searchIndex';
import { generatedId, iterContentDocs } from './search/extract';
import { splitFrontmatter, parseFrontmatter } from './frontmatter';
import { newDocContent } from './docScaffolds';
import { DEFAULT_HEADERS, jsonResponse, method, queryParam } from './http';
import { search } from './contentSearch';
import { recordRequestError } from '../requestErrorLog';

const CONTENT_PREFIX = 'content/';
const DOC_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.md$/;
const FOLDER_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Path prefixes owned by the docs content API. A request path matches a route
 * when it equals the prefix or continues with `/`.
 */
export const DOCS_ROUTE_PREFIXES = [
  '/docs',
  '/images',
  '/folders',
  '/health',
  '/search',
  '/knowledge',
] as const;

export type DocsRoutePrefix = (typeof DOCS_ROUTE_PREFIXES)[number];

/** True when `path` belongs to the docs content API. */
export function isDocsRoute(path: string): boolean {
  return DOCS_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Feature flag: serve the docs routes and single-origin portal layer only when
 * explicitly enabled. Infra and compose set it; tests leave it off to exercise
 * the API-only router.
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

/**
 * The configured content root is absent. Every docs endpoint that reads the
 * corpus depends on it, so this is a configuration/hydration fault, not a
 * missing document: report it loudly and name the path instead of letting a
 * `readdirSync` ENOENT degrade a collection listing into "Document not found".
 */
class ContentRootUnavailable extends HttpError {
  constructor(contentRoot: string) {
    super(503, contentRootUnavailableMessage(contentRoot));
  }
}

// ── Runtime (store + search index) ────────────────────────────────────────────

/** Holds the per-process docs store and search index. */
export class DocsRuntime {
  index: SearchIndex | null = null;
  private searchReady = false;

  constructor(readonly store: KnowledgeStore) {}

  get contentRoot(): string {
    return this.store.contentRoot;
  }

  get repoRoot(): string {
    return this.store.root;
  }

  /**
   * Sync the content cache and assert the corpus is readable.
   *
   * Online, `sync()` hydrates the cache and creates the root. Offline (local
   * dev, e2e) nothing creates it, so an unconfigured or wrongly pointed
   * `DTC_CACHE_ROOT` would otherwise surface as an ENOENT from the first
   * directory walk. The root is never created here — the app does not
   * provision storage it does not manage.
   */
  async ensureSynced(): Promise<void> {
    await this.store.sync();
    const root = this.contentRoot;
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new ContentRootUnavailable(root);
    }
  }

  async ensureSearch(): Promise<void> {
    await this.ensureSynced();
    const key = this.publicationKey();
    if (key && sharedSearch?.key === key) {
      this.index = sharedSearch.index;
      this.searchReady = true;
      return;
    }
    if (!this.searchReady || this.index === null) {
      this.rebuildSearch();
    }
  }

  /** Rebuild the in-process search index from the content cache. */
  rebuildSearch(): void {
    const docs = iterContentDocs(this.contentRoot);
    const index = createSearchIndex();
    index.fit(docs);
    this.index = index;
    this.searchReady = true;
    const key = this.publicationKey();
    if (key) sharedSearch = { key, index };
  }

  /**
   * A published revision is immutable, so its index can outlive the request
   * that built it: every request pins the active publication, and a new
   * publication (an edit, a restore, an import) changes the key and forces a
   * rebuild. The offline cache is a mutable working directory, so it has no
   * stable key and is never shared.
   */
  private publicationKey(): string {
    return this.store.offline ? '' : this.store.root;
  }
}

/**
 * The search index for the most recently searched publication, shared across
 * requests in this process. Building it reads and tokenizes the whole corpus,
 * which costs seconds; reusing it costs nothing.
 */
let sharedSearch: { key: string; index: SearchIndex } | null = null;

/** Recently changed documents for the active publication, like the search index. */
let sharedRecent: { key: string; value: RecentDocChanges } | null = null;

/** Display names for publication actors (user ids); unknown ids are omitted. */
export type ActorNameResolver = (ids: string[]) => Promise<Record<string, string>>;

const RECENT_DEFAULT_LIMIT = 30;
const RECENT_MAX_LIMIT = 100;

let runtime: DocsRuntime | null = null;

/** Inject a runtime (tests / explicit wiring). */
export function configureDocsRuntime(store: KnowledgeStore): DocsRuntime {
  runtime = new DocsRuntime(store);
  return runtime;
}

/** Clear the cached runtime (tests). */
export function resetDocsRuntime(): void {
  runtime = null;
  sharedSearch = null;
  sharedRecent = null;
}

interface KnowledgePlan {
  mutations: Mutation[];
  regenerated: string[];
}

function isAuthoredTemplatePath(path: string): boolean {
  return /^workflow-templates\/[^/]+\.ya?ml$/i.test(path);
}

async function authoredTemplatePathsAfterMutations(
  rt: DocsRuntime,
  mutations: Mutation[],
): Promise<Set<string>> {
  const tree = await rt.store.tree();
  const paths = new Set(Object.values(tree)
    .filter((entry) => entry.type === 'blob' && isAuthoredTemplatePath(entry.path))
    .map((entry) => entry.path));
  for (const mutation of mutations) {
    const path = normalizeRepoPath(mutation.path);
    if (!isAuthoredTemplatePath(path)) continue;
    if (mutation.bytes !== undefined || mutation.sourcePath !== undefined || mutation.restoreRevision !== undefined) {
      paths.add(path);
    } else {
      paths.delete(path);
    }
  }
  return paths;
}

function readMarkdownCorpus(rt: DocsRuntime): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const repoPath = relative(rt.repoRoot, file).split(sep).join('/');
        files.set(repoPath, readFileSync(file, 'utf8'));
      }
    }
  };
  if (existsSync(rt.contentRoot)) visit(rt.contentRoot);
  return files;
}

async function templatesFor(client?: DynamoDBDocumentClient): Promise<Template[]> {
  return client ? listTemplates(client) : [];
}

async function applyMutationsToCorpus(rt: DocsRuntime, files: Map<string, string>, mutations: Mutation[]): Promise<Map<string, string>> {
  const candidate = new Map(files);
  for (const mutation of mutations) {
    const path = normalizeRepoPath(mutation.path);
    if (!path.startsWith(CONTENT_PREFIX) || !path.endsWith('.md')) continue;
    if (mutation.sourcePath) {
      const source = normalizeRepoPath(mutation.sourcePath);
      const content = candidate.get(source);
      if (content !== undefined) {
        candidate.set(path, content);
        candidate.delete(source);
      }
    } else if (mutation.restoreRevision) {
      candidate.set(path, (await rt.store.versionBytes(path, mutation.restoreRevision)).toString('utf8'));
    } else if (mutation.bytes !== undefined) {
      candidate.set(path, typeof mutation.bytes === 'string' ? mutation.bytes : Buffer.from(mutation.bytes).toString('utf8'));
    } else {
      candidate.delete(path);
    }
  }
  return candidate;
}

async function prepareKnowledgePlan(
  rt: DocsRuntime,
  sourceMutations: Mutation[],
  templates: Template[],
  selection: { all?: boolean; id?: string } = { all: true },
): Promise<KnowledgePlan> {
  await rt.ensureSynced();
  const current = readMarkdownCorpus(rt);
  const candidate = await applyMutationsToCorpus(rt, current, sourceMutations);
  const authoredPaths = await authoredTemplatePathsAfterMutations(rt, sourceMutations);
  const publishableTemplates = templates.filter((template) =>
    template.origin !== 'git'
    || typeof template.sourcePath !== 'string'
    || authoredPaths.has(template.sourcePath));
  const generated = regenerateDerivedDocuments(candidate, publishableTemplates, selection);
  const mutations = sourceMutations.map((mutation) => ({ ...mutation }));
  const regenerated: string[] = [];

  for (const [path, content] of generated) {
    if (candidate.get(path) === content) continue;
    regenerated.push(path);
    let existingMutation = -1;
    for (let index = mutations.length - 1; index >= 0; index--) {
      if (mutations[index].path === path) {
        existingMutation = index;
        break;
      }
    }
    if (existingMutation >= 0) {
      const mutation = { ...mutations[existingMutation], bytes: content };
      delete mutation.restoreRevision;
      mutations[existingMutation] = mutation;
      continue;
    }
    const createdBefore = mutations.some((mutation) => mutation.path === path
      && (mutation.sourcePath !== undefined || mutation.bytes !== undefined || mutation.restoreRevision !== undefined));
    mutations.push({ path, bytes: content, ...(!current.has(path) && !createdBefore ? { absent: true } : {}) });
  }
  return { mutations, regenerated };
}

async function publishKnowledgeWithDerivedDocuments(
  rt: DocsRuntime,
  sourceMutations: Mutation[],
  expectedRevision: string,
  actor: string,
  message: string,
  templates: Template[],
): Promise<{ revision: string; regenerated: string[] }> {
  const plan = await prepareKnowledgePlan(rt, sourceMutations, templates);
  if (!plan.mutations.length) return { revision: rt.store.revision, regenerated: plan.regenerated };
  const publication = await rt.store.publish(plan.mutations, expectedRevision, actor, message);
  return { revision: publication.revision, regenerated: plan.regenerated };
}

async function publishRegeneratedKnowledge(
  rt: DocsRuntime,
  templates: Template[],
  actor: string,
  selection: { all?: boolean; id?: string } = { all: true },
  retries = 0,
): Promise<{ revision: string; regenerated: string[] }> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await rt.store.refreshTree();
    await rt.ensureSynced();
    const plan = await prepareKnowledgePlan(rt, [], templates, selection);
    if (!plan.mutations.length) return { revision: rt.store.revision, regenerated: [] };
    try {
      const publication = await rt.store.publish(plan.mutations, rt.store.revision, actor, 'Regenerate derived knowledge documents');
      await rt.ensureSynced();
      rt.rebuildSearch();
      return { revision: publication.revision, regenerated: plan.regenerated };
    } catch (error) {
      if (!(error instanceof RevisionConflict) || attempt >= retries) throw error;
    }
  }
}

/** Regenerate generated KB pages after a runtime Template changes or syncs from Git. */
export async function regenerateKnowledgeForTemplates(
  templates: Template[],
  actor = 'template-update',
): Promise<{ revision: string; regenerated: string[] }> {
  const rt = runtime || new DocsRuntime(createKnowledgeStore(knowledgeStoreConfigFromEnv()));
  return publishRegeneratedKnowledge(rt, templates, actor, { all: true }, 2);
}

// ── Response helpers ──────────────────────────────────────────────────────────

function editableKnowledgePath(path:string):string {
  const clean=normalizeRepoPath(path);
  if(!isManagedKnowledgePath(clean)) throw new BadRequest('Path is outside editable knowledge directories');
  return clean;
}

function requiredPath(event:LambdaEvent):string {
  const path=queryParam(event,'path');if(!path) throw new BadRequest('Missing path');return editableKnowledgePath(path);
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
/**
 * `publishMessage` is set only for a service principal whose publication
 * message is derived from verified credential claims rather than the body.
 */
export async function handleDocsRoutes(
  event: LambdaEvent,
  actor = process.env.DTC_OFFLINE === '1' ? 'local-operator' : '',
  publishMessage?: string,
  actorNames?: ActorNameResolver,
  client?: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const path = event.path || '/';
  if (!isDocsRoute(path)) return null;

  if (method(event) === 'OPTIONS') {
    return { statusCode: 204, headers: { ...DEFAULT_HEADERS }, body: '' };
  }

  try {
    return await dispatch(event, path, actor, publishMessage, actorNames, client);
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message });
    if (err instanceof DerivedDocumentNotFound) return jsonResponse(404, { error: err.message });
    if (err instanceof ContentRootUnavailableError) {
      return jsonResponse(503, { error: contentRootUnavailableMessage(err.contentRoot) });
    }
    if (err instanceof KnowledgeVersionNotFound) return jsonResponse(404,{error:err.message});
    if (err instanceof RevisionConflict) return jsonResponse(409, { error: err.message });
    if (err instanceof KnowledgeError) return jsonResponse(400, { error: err.message });
    recordRequestError(err);
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

/**
 * Git publications carry `git:<repo>@<sha>`; they read as "Git <sha7>". Other
 * actors are user ids, named by the resolver when it knows them.
 */
export function publicationActorName(actor: string, names: Record<string, string> = {}): string {
  const git = /^git:[^@]+@([0-9a-f]{7,40})$/i.exec(actor);
  if (git) return `Git ${git[1].slice(0, 7)}`;
  return names[actor] || actor;
}

async function recentDocChanges(rt: DocsRuntime, event: LambdaEvent, actorNames?: ActorNameResolver): Promise<LambdaResponse> {
  const raw = queryParam(event, 'limit');
  const limit = raw === null ? RECENT_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_MAX_LIMIT) {
    throw new BadRequest(`limit must be an integer from 1 to ${RECENT_MAX_LIMIT}`);
  }
  // The offline cache is a working directory with no publication history.
  if (rt.store.offline) return jsonResponse(200, { revision: rt.store.revision, complete: true, scanned: 0, changes: [] });
  const head = await rt.store.pin();
  const key = `${head.revision}:${limit}`;
  if (sharedRecent?.key !== key) sharedRecent = { key, value: await rt.store.recentDocChanges(limit) };
  const recent = sharedRecent.value;
  const userIds = [...new Set(recent.changes.map((change) => change.actor).filter((id) => !id.startsWith('git:')))];
  const names = actorNames && userIds.length ? await actorNames(userIds) : {};
  return jsonResponse(200, {
    ...recent,
    changes: recent.changes.map((change) => ({ ...change, actorName: publicationActorName(change.actor, names) })),
  });
}

/** A caller-supplied publication message: one short line, or the generic default. */
function publicationMessage(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'Publish knowledge files';
  if (typeof raw !== 'string' || raw.length > 200 || /[\x00-\x1f\x7f]/.test(raw) || !raw.trim()) {
    throw new BadRequest('message must be one line of at most 200 characters');
  }
  return raw.trim();
}

async function dispatch(
  event: LambdaEvent,
  path: string,
  actor: string,
  publishMessage?: string,
  actorNames?: ActorNameResolver,
  client?: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const m = method(event);
  const rt = runtime || new DocsRuntime(createKnowledgeStore(knowledgeStoreConfigFromEnv()));

  if (rt.store.offline && path.startsWith('/knowledge/')) await rt.ensureSynced();
  if (path === '/health') return jsonResponse(200, { ok: true });
  if (path === '/search') return search(rt, event);
  if (path === '/knowledge/publish' && m === 'POST') {
    const body=jsonBody(event);
    if(!Array.isArray(body.mutations)||!body.mutations.length) throw new BadRequest('mutations are required');
    const mutations=body.mutations.map(raw=>{
      if(!raw||typeof raw!=='object') throw new BadRequest('Invalid mutation');
      const item=raw as Record<string,unknown>;
      if(typeof item.path!=='string') throw new BadRequest('Mutation path is required');
      return {path:editableKnowledgePath(item.path),...(typeof item.content==='string'?{bytes:item.content}:{}),...(typeof item.base64==='string'?{bytes:Buffer.from(item.base64,'base64')}:{}),...(typeof item.sourcePath==='string'?{sourcePath:editableKnowledgePath(item.sourcePath)}:{}),absent:item.absent===true};
    });
    const publication=await publishKnowledgeWithDerivedDocuments(
      rt, mutations, String(body.expectedRevision||''), actor,
      publishMessage ?? publicationMessage(body.message), await templatesFor(client),
    );
    await rt.ensureSynced();
    rt.rebuildSearch();
    return jsonResponse(200,{revision:publication.revision,regenerated:publication.regenerated});
  }
  if (path === '/knowledge/manifest' && m === 'GET') {
    const publication=await rt.store.pin();
    const entries=Object.fromEntries(Object.values(publication.entries).filter(entry=>isManagedKnowledgePath(entry.path))
      .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(entry=>[entry.path,{sha256:entry.sha,size:entry.size}]));
    return jsonResponse(200,{revision:publication.revision,roots:MANAGED_KNOWLEDGE_ROOTS,entries});
  }
  if (path === '/knowledge/recent' && m === 'GET') return recentDocChanges(rt, event, actorNames);
  if (path === '/knowledge/history' && m === 'GET') return jsonResponse(200, await rt.store.history(requiredPath(event), queryParam(event, 'cursor') || undefined));
  if (path === '/knowledge/download' && m === 'GET') {
    const location=await rt.store.versionDownload(requiredPath(event),queryParam(event,'revision')||'');
    return {statusCode:200,headers:{...DEFAULT_HEADERS,'cache-control':'no-store'},body:JSON.stringify({url:location,expiresIn:300})};
  }
  if (path === '/knowledge/version' && m === 'GET') {
    const entry=await rt.store.versionEntry(requiredPath(event),queryParam(event,'revision')||'');
    if(entry.size>4_000_000 || !/\.(md|csv|json|ya?ml|txt)$/.test(entry.path)) throw new BadRequest('Use the authenticated knowledge download endpoint for this version');
    const bytes = await rt.store.versionBytes(requiredPath(event), queryParam(event, 'revision') || '');
    return {statusCode:200, headers:{'content-type':'application/octet-stream','cache-control':'no-store'}, body:Buffer.from(bytes).toString('base64'), isBase64Encoded:true};
  }
  if (path === '/knowledge/restore' && m === 'POST') {
    const body=jsonBody(event);
    const publication=await publishKnowledgeWithDerivedDocuments(
      rt, [{path:editableKnowledgePath(requiredPath(event)), restoreRevision:String(body.version || '')}],
      String(body.expectedRevision || ''), actor, 'Restore file', await templatesFor(client),
    );
    await rt.ensureSynced();
    rt.rebuildSearch();
    return jsonResponse(200,{revision:publication.revision,regenerated:publication.regenerated});
  }
  if (path === '/knowledge/status' && m === 'GET') {
    await rt.store.pin();
    let backup:Record<string,unknown>|null;
    try {backup=(await rt.store.json<Record<string,unknown>>('jobs/knowledge-backup/success.json')).value;}
    catch(error){if(['NoSuchKey','NotFound'].includes((error as Error).name)) backup=null;else throw error;}
    return jsonResponse(200,{revision:rt.store.revision,backup,backupLag:backup?.revision!==rt.store.revision});
  }
  if (path === '/knowledge/publication' && m === 'GET') {await rt.store.pin();return jsonResponse(200,{revision:rt.store.revision});}
  if (path === '/docs/regenerate' && m === 'POST') {
    const body = jsonBody(event);
    if (body.all !== true && (typeof body.id !== 'string' || !body.id.trim())) {
      throw new BadRequest('Choose all: true or a generated document id');
    }
    const selection = body.all === true ? { all: true } : { id: String(body.id).trim() };
    const result = await publishRegeneratedKnowledge(rt, await templatesFor(client), actor, selection, 2);
    return jsonResponse(200, { revision: result.revision, regenerated: result.regenerated });
  }
  if (path === '/docs/preview-write' && m === 'POST') return previewWrite(rt, jsonBody(event), await templatesFor(client));
  if (path === '/docs/status' && m === 'POST') return updateDocStatus(rt, jsonBody(event), actor, await templatesFor(client));
  if (path === '/docs/process-quality' && m === 'GET') return processQuality(rt);
  if (path === '/docs/registry' && m === 'GET') return getDocRegistry(rt);
  if (path === '/docs/resolve' && m === 'GET') return resolveDoc(rt, queryParam(event, 'ref'));
  if (path === '/docs/export' && m === 'GET') {
    const ref = queryParam(event, 'ref');
    if (!ref) throw new BadRequest('ref is required');
    const format = queryParam(event, 'format') || 'md';
    if (!['md', 'docx', 'txt'].includes(format)) throw new BadRequest('format must be md, docx, or txt');
    await rt.ensureSynced();
    let record: DocumentRecord;
    try { record = resolveReference(buildRegistry(rt.contentRoot), ref); }
    catch (error) { if (error instanceof LookupError) throw new NotFound(error.message); throw error; }
    const content = await rt.store.readFile(record.path);
    const body = format === 'docx' ? (await markdownToDocx(splitFrontmatter(content)[1])).toString('base64') : content;
    return {
      statusCode: 200,
      headers: {
        'Content-Type': format === 'docx' ? DOCX_CONTENT_TYPE : format === 'txt' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="document.${format}"`,
        'Cache-Control': 'no-store',
      },
      body,
      ...(format === 'docx' ? { isBase64Encoded: true } : {}),
    };
  }
  if (path === '/docs/backlinks' && m === 'GET') return listBacklinks(rt, queryParam(event, 'path'));
  if (path === '/docs/rename' && m === 'POST') return renameDoc(rt, jsonBody(event), actor, await templatesFor(client));
  if (path === '/docs/move' && m === 'POST') return moveDoc(rt, jsonBody(event), actor, await templatesFor(client));

  if (path === '/docs' && m === 'GET') {
    const docPath = queryParam(event, 'path');
    return docPath ? getDoc(rt, docPath) : listDocs(rt);
  }
  if (path === '/docs' && m === 'PUT') return saveDoc(rt, queryParam(event, 'path'), jsonBody(event), actor, await templatesFor(client));
  if (path === '/docs' && m === 'POST') return createDoc(rt, jsonBody(event), actor, await templatesFor(client));
  if (path === '/docs' && m === 'DELETE') return deleteDoc(rt, queryParam(event, 'path'), jsonBody(event), actor, await templatesFor(client));

  if (path === '/folders' && m === 'DELETE') return deleteFolder(rt, queryParam(event, 'path'), jsonBody(event), actor, await templatesFor(client));
  if (path === '/folders/rename' && m === 'POST') return renameFolder(rt, jsonBody(event), actor, await templatesFor(client));

  if (path === '/images' && m === 'POST') return uploadImage(rt, jsonBody(event), actor);

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
  // Only a single-document read maps a filesystem miss to 404: `?path=` names one
  // document, so "not found" is the honest answer when it is absent.
  let content: string;
  try {
    content = await rt.store.readFile(repoPath); // reads the pinned publication
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new NotFound('Document not found');
    throw err;
  }
  const body: Record<string, unknown> = {
    path: repoPath,
    content,
    updated: rt.store.updatedAt(repoPath),
    revision: rt.store.revision,
  };
  await applyDocType(body, rt, repoPath, content);
  return jsonResponse(200, body);
}

/**
 * Attach the doc_type to a doc payload from the registry (falling back to
 * the document's own frontmatter when the path is not registered).
 */
async function applyDocType(
  body: Record<string, unknown>,
  rt: DocsRuntime,
  repoPath: string,
  content: string,
): Promise<void> {
  body.doc_type = frontmatterValue(content, 'doc_type');
  await rt.ensureSynced();
  const registry = buildRegistry(rt.contentRoot);
  const record = registry.byPath.get(repoPath);
  if (record) {
    body.doc_type = record.doc_type;
  }
}

// ── Docs mutation endpoints (commit-on-save + search refresh) ─────────────────

async function previewWrite(rt: DocsRuntime, body: Record<string, unknown>, templates: Template[]): Promise<LambdaResponse> {
  if (typeof body.path !== 'string' || !body.path.trim()) throw new BadRequest('Request body must include string field: path');
  if (typeof body.content !== 'string') throw new BadRequest('Request body must include string field: content');
  const path = normalizeDocPath(body.path);
  validateDocPath(path);
  await rt.ensureSynced();
  const current = readMarkdownCorpus(rt);
  const exists = current.has(path);
  if (body.create === true && exists) throw new BadRequest('Document already exists');
  if (body.create !== true && !exists) throw new NotFound('Document not found. Pass --create to add it.');

  const { isTemplateDocument, parseTemplatePlaceholders, documentType } = await templateParser();
  const oldContent = current.get(path) || '';
  const doc = { path, doc_type: typeof body.doc_type === 'string' ? body.doc_type : undefined };
  const isTemplate = isTemplateDocument(body.content, doc)
    || (!documentType(body.content) && isTemplateDocument(oldContent, { path }));
  if (isTemplate) {
    const { issues } = parseTemplatePlaceholders(body.content);
    if (issues.length) throw new BadRequest(`${path}: ${issues.map((issue) => issue.message).join(' ')}`);
  }

  const source: Mutation = { path, bytes: body.content, ...(body.create === true ? { absent: true } : {}) };
  const plan = await prepareKnowledgePlan(rt, [source], templates);
  return jsonResponse(200, {
    dryRun: true,
    revision: rt.store.revision,
    changes: [...new Set(plan.mutations.map((mutation) => mutation.path))].sort(),
    regenerated: plan.regenerated,
  });
}

async function updateDocStatus(rt: DocsRuntime, body: Record<string, unknown>, actor: string, templates: Template[]): Promise<LambdaResponse> {
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!ref) throw new BadRequest('ref is required');
  if (status !== 'deprecated' && status !== 'archived') throw new BadRequest('status must be deprecated or archived');
  if (body.replaced_by !== undefined && typeof body.replaced_by !== 'string') throw new BadRequest('replaced_by must be a document ID');
  await rt.ensureSynced();
  const registry = buildRegistry(rt.contentRoot);
  let document: DocumentRecord;
  try { document = resolveReference(registry, ref); }
  catch (error) { if (error instanceof LookupError) throw new NotFound(error.message); throw error; }
  const content = await rt.store.readFile(document.path);
  const [raw, markdown] = splitFrontmatter(content);
  const metadata: Record<string, unknown> = repairFrontmatterScalars(raw ? { ...parseFrontmatter(raw) } : {});
  metadata.status = status;
  if (typeof body.replaced_by === 'string' && body.replaced_by.trim()) metadata.replaced_by = body.replaced_by.trim();
  const updated = `---\n${dumpYaml(metadata, { lineWidth: -1 })}---\n${markdown}`;
  const publication = await publishKnowledgeWithDerivedDocuments(
    rt, [{ path: document.path, bytes: updated }], rt.store.revision, actor, `Set ${document.path} status to ${status}`, templates,
  );
  await rt.ensureSynced();
  rt.rebuildSearch();
  return jsonResponse(200, { id: document.id, path: document.path, status, revision: publication.revision, regenerated: publication.regenerated });
}

async function saveDoc(
  rt: DocsRuntime,
  rawPath: string | null,
  body: Record<string, unknown>,
  actor: string,
  templates: Template[],
): Promise<LambdaResponse> {
  if (!rawPath) throw new BadRequest('Missing required query parameter: path');
  const content = body.content;
  if (typeof content !== 'string') throw new BadRequest('Request body must include string field: content');

  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  mkdirSync(dirname(filePath), { recursive: true });
  const publication = await publishKnowledgeWithDerivedDocuments(
    rt, [{path:repoPath, bytes:content}], String(body.expectedRevision || ''), actor, `Update ${repoPath}`, templates,
  );
  await rt.ensureSynced();

  const warnings: string[] = [];
  rt.rebuildSearch();
  return jsonResponse(200, { path: repoPath, updated: rt.store.updatedAt(repoPath), warnings, revision:publication.revision, regenerated:publication.regenerated });
}

async function createDoc(rt: DocsRuntime, body: Record<string, unknown>, actor:string, templates: Template[]): Promise<LambdaResponse> {
  const rawPath = body.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new BadRequest('Request body must include string field: path');
  }
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  if (existsSync(filePath)) throw new BadRequest('Document already exists');

  if (body.from !== undefined) {
    if (typeof body.from !== 'string' || !body.from.trim()) throw new BadRequest('from must be a document ID');
    if (body.content !== undefined) throw new BadRequest('from and content cannot be combined');
    let source: DocumentRecord;
    try { source = resolveReference(buildRegistry(rt.contentRoot), body.from); }
    catch (error) { if (error instanceof LookupError) throw new NotFound(error.message); throw error; }
    const sourceContent = await rt.store.readFile(source.path);
    const [raw, text] = splitFrontmatter(sourceContent);
    const metadata: Record<string, unknown> = raw ? { ...parseFrontmatter(raw) } : {};
    // A copy has its own identity. Never steal aliases, hierarchy, or reviews
    // from the source document. Preserve the authored document and its type.
    for (const key of ['id', 'aliases', 'parent', 'last_reviewed_at', 'next_review_at', 'updated_at']) delete metadata[key];
    metadata.title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : source.title;
    metadata.doc_type = source.doc_type;
    metadata.id = generatedId(repoPath, source.doc_type);
    metadata.aliases = [];
    metadata.status = 'proposed';
    metadata.last_reviewed_at = null;
    metadata.next_review_at = null;
    if (body.doc_type !== undefined && body.doc_type !== source.doc_type) throw new BadRequest('A copy must use the source document type');
    let copiedText = typeof body.title === 'string' && body.title.trim()
      ? text.replace(/^# [^\r\n]+/m, () => `# ${body.title!.toString().trim()}`)
      : text;
    if (posix.dirname(source.path) !== posix.dirname(repoPath)) {
      const relocate = (destination: string): string => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|content\/)/i.test(destination)) return destination;
        const split = destination.search(/[?#]/);
        const file = split < 0 ? destination : destination.slice(0, split);
        const suffix = split < 0 ? '' : destination.slice(split);
        return posix.relative(posix.dirname(repoPath), posix.normalize(posix.join(posix.dirname(source.path), file))) + suffix;
      };
      let fence: string | null = null;
      copiedText = copiedText.split('\n').map(line => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line);
        if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length)) {
          fence = fence ? null : marker[1];
          return line;
        }
        if (fence) return line;
        return line.replace(/(\]\()(<[^>]+>|[^\s)]+)/g, (_match, prefix: string, destination: string) =>
          prefix + (destination.startsWith('<') ? `<${relocate(destination.slice(1, -1))}>` : relocate(destination)))
          .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_match, prefix: string, destination: string) => prefix + relocate(destination));
      }).join('\n');
    }
    body.content = `---\n${dumpYaml(metadata, { lineWidth: -1 })}---\n${copiedText}`;
    body.doc_type = source.doc_type;
  }

  const stem = baseStem(repoPath);
  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim() : titleCase(stem.replace(/-/g, ' '));
  const docType =
    typeof body.doc_type === 'string' && body.doc_type.trim() ? body.doc_type.trim() : inferDocType(repoPath);
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  const scaffold = body.scaffold === 'minimal' ? 'minimal' : 'full';
  const parent = typeof body.parent === 'string' && body.parent.trim() ? body.parent.trim() : undefined;

  const content = typeof body.content === 'string' ? body.content : newDocContent(title, docType, summary, scaffold, parent);
  if (docType === 'template') {
    const {issues} = (await templateParser()).parseTemplatePlaceholders(content);
    if (issues.length) throw new BadRequest(`${repoPath}: ${issues.map(issue => issue.message).join(' ')}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  if(body.absent !== true) throw new BadRequest('Creation requires absent: true');
  const publication = await publishKnowledgeWithDerivedDocuments(
    rt, [{path:repoPath,bytes:content,absent:true}], String(body.expectedRevision || ''), actor, `Create ${repoPath}`, templates,
  );
  await rt.ensureSynced();
  rt.rebuildSearch();

  return jsonResponse(201, { path: repoPath, content, updated: rt.store.updatedAt(repoPath), revision:publication.revision, regenerated:publication.regenerated });
}

async function deleteDoc(rt: DocsRuntime, rawPath: string | null, body:Record<string,unknown>, actor:string, templates: Template[]): Promise<LambdaResponse> {
  if (!rawPath) throw new BadRequest('Missing required query parameter: path');
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);
  await rt.ensureSynced();

  const filePath = localPath(rt, repoPath);
  if (!existsSync(filePath)) throw new NotFound('Document not found');
  const publication = await publishKnowledgeWithDerivedDocuments(rt, [{path:repoPath}], String(body.expectedRevision || ''), actor, `Delete ${repoPath}`, templates);
  await rt.ensureSynced();
  rt.rebuildSearch();
  return jsonResponse(200, { deleted: repoPath, revision:publication.revision, regenerated:publication.regenerated });
}

async function renameDoc(rt: DocsRuntime, body: Record<string, unknown>, actor:string, templates: Template[]): Promise<LambdaResponse> {
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
  const publication = await publishKnowledgeWithDerivedDocuments(rt, [{path:newPath,sourcePath:oldPath,absent:true}], String(body.expectedRevision || ''), actor, `Rename ${oldPath} to ${newPath}`, templates);
  await rt.ensureSynced();
  rt.rebuildSearch();
  return jsonResponse(200, { old_path: oldPath, new_path: newPath, revision:publication.revision, regenerated:publication.regenerated });
}

async function moveDoc(rt: DocsRuntime, body: Record<string, unknown>, actor: string, templates: Template[]): Promise<LambdaResponse> {
  const rawPath = body.path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new BadRequest('Request body must include string field: path');
  }
  const repoPath = normalizeDocPath(rawPath);
  validateDocPath(repoPath);

  await rt.ensureSynced();
  const registry = buildRegistry(rt.contentRoot);
  const docRecord = registry.byPath.get(repoPath);
  if (!docRecord) throw new NotFound('Document not found');

  const rawNewParent = body.new_parent;
  let targetParent: DocumentRecord | null = null;

  if (rawNewParent !== null && rawNewParent !== undefined && typeof rawNewParent === 'string' && rawNewParent.trim() !== '') {
    const parentRef = rawNewParent.trim();
    try {
      targetParent = resolveReference(registry, parentRef);
    } catch {
      throw new BadRequest(`Target parent document not found: ${parentRef}`);
    }

    if (targetParent.id === docRecord.id) {
      throw new BadRequest('Cannot set document as its own parent');
    }

    let current: string | undefined = targetParent.parent_id;
    const visited = new Set<string>();
    while (current) {
      if (current === docRecord.id) {
        throw new BadRequest(`Cannot move document under its own descendant: ${targetParent.id}`);
      }
      if (visited.has(current)) break;
      visited.add(current);
      const ancestor = registry.byId.get(current);
      current = ancestor?.parent_id;
    }
  } else if (rawNewParent !== null && rawNewParent !== undefined && typeof rawNewParent !== 'string') {
    throw new BadRequest('new_parent must be a string or null');
  }

  const content = await rt.store.readFile(repoPath);
  const updatedContent = updateFrontmatterParent(content, targetParent ? targetParent.id : null);

  const actionMsg = targetParent ? `Move ${repoPath} under ${targetParent.id}` : `Move ${repoPath} to root`;
  const publication = await publishKnowledgeWithDerivedDocuments(
    rt, [{ path: repoPath, bytes: updatedContent }], String(body.expectedRevision || ''), actor, actionMsg, templates,
  );
  await rt.ensureSynced();
  rt.rebuildSearch();

  return jsonResponse(200, {
    path: repoPath,
    parent: targetParent ? targetParent.id : null,
    revision: publication.revision,
    regenerated: publication.regenerated,
  });
}

export function updateFrontmatterParent(content: string, parentId: string | null): string {
  const bom = content.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const text = bom ? content.slice(1) : content;
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    if (parentId) {
      return `${bom}---\nparent: "${parentId}"\n---\n\n${text}`;
    }
    return content;
  }

  const isCrlf = text.startsWith('---\r\n');
  const newline = isCrlf ? '\r\n' : '\n';
  const startIdx = isCrlf ? 5 : 4;
  const closingPattern = `${newline}---`;
  const endIdx = text.indexOf(closingPattern, startIdx);
  if (endIdx === -1) {
    if (parentId) {
      return `${bom}---\nparent: "${parentId}"\n---\n\n${text}`;
    }
    return content;
  }

  const rawFm = text.slice(startIdx, endIdx);
  const rest = text.slice(endIdx + closingPattern.length);
  const lines = rawFm.split(/\r?\n/);
  const parentLineIdx = lines.findIndex((l) => /^parent\s*:/.test(l));

  if (parentId) {
    const newParentLine = `parent: "${parentId}"`;
    if (parentLineIdx !== -1) {
      lines[parentLineIdx] = newParentLine;
    } else {
      if (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.splice(lines.length - 1, 0, newParentLine);
      } else {
        lines.push(newParentLine);
      }
    }
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^parent\s*:/.test(lines[i])) {
        lines.splice(i, 1);
      }
    }
  }

  const newFm = lines.join(newline);
  return `${bom}---${newline}${newFm}${closingPattern}${rest}`;
}

// ── Process quality (registry validation only) ────────────────────────────────

async function processQuality(rt: DocsRuntime): Promise<LambdaResponse> {
  await rt.ensureSynced();
  // Registry violations (colliding aliases, unresolved references) are
  // reported here, one per entry; the docs endpoints keep serving.
  const validationErrors = buildRegistry(rt.contentRoot).violations;
  return jsonResponse(200, {
    ok: validationErrors.length === 0,
    findings: [],
    summary: { total: 0, blocking: 0, warning: 0, info: 0, byCategory: {} },
    validationErrors,
  });
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

async function uploadImage(rt: DocsRuntime, body: Record<string, unknown>, actor:string): Promise<LambdaResponse> {
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
  const inventory=await rt.store.tree();
  let target=join(imageDir,safeName);let suffix=1;
  while(inventory[repoRelative(rt.repoRoot,target)]) target=join(imageDir,`${baseStem(safeName)}-${suffix++}${ext}`);

  const repoRelativePath = repoRelative(rt.repoRoot, target);
  await rt.store.publish([{path:repoRelativePath,bytes:imageBytes,absent:true}],String(body.expectedRevision || ''),actor,`Upload ${repoRelativePath}`);
  await rt.ensureSynced();
  rt.rebuildSearch();

  const docRelative = relativePath(dirname(docFile), target);
  return jsonResponse(201, { path: docRelative, absolute_path: repoRelativePath, bytes: imageBytes.length, revision:rt.store.revision });
}

// ── Folders ───────────────────────────────────────────────────────────────────

async function deleteFolder(rt: DocsRuntime, rawPath: string | null, body:Record<string,unknown>, actor:string, templates: Template[]): Promise<LambdaResponse> {
  await rt.ensureSynced();
  const folder = resolveFolderPath(rt, rawPath, false);
  const prefix=repoRelative(rt.repoRoot,folder)+'/';
  const repoPaths=Object.keys(await rt.store.tree()).filter(path=>path.startsWith(prefix));
  if(!repoPaths.length)throw new NotFound('Folder not found');
  const publication = await publishKnowledgeWithDerivedDocuments(rt, repoPaths.map(path=>({path})), String(body.expectedRevision || ''), actor, 'Delete folder', templates);
  await rt.ensureSynced();
  rt.rebuildSearch();
  return jsonResponse(200, { deleted: repoRelative(rt.repoRoot, folder), files: repoPaths.length, revision: publication.revision, regenerated: publication.regenerated });
}

async function renameFolder(rt: DocsRuntime, body: Record<string, unknown>, actor:string, templates: Template[]): Promise<LambdaResponse> {
  const oldRaw = body.old_path;
  const newRaw = body.new_path;
  if (typeof oldRaw !== 'string' || !oldRaw.trim()) throw new BadRequest('Request body must include string field: old_path');
  if (typeof newRaw !== 'string' || !newRaw.trim()) throw new BadRequest('Request body must include string field: new_path');
  await rt.ensureSynced();

  const src = resolveFolderPath(rt, oldRaw, false);
  const dst = resolveFolderPath(rt, newRaw, false);
  if(dst.startsWith(src+sep))throw new BadRequest('Cannot rename a folder into itself');
  const inventory=Object.keys(await rt.store.tree());
  const sourcePrefix=repoRelative(rt.repoRoot,src)+'/';const destPrefix=repoRelative(rt.repoRoot,dst)+'/';
  if(inventory.some(path=>path.startsWith(destPrefix)))throw new BadRequest('Target folder already exists');
  const oldRepoPaths=inventory.filter(path=>path.startsWith(sourcePrefix));
  if(!oldRepoPaths.length)throw new NotFound('Folder not found');

  const srcRepo=repoRelative(rt.repoRoot,src);
  const dstRepo=repoRelative(rt.repoRoot,dst);
  const publication = await publishKnowledgeWithDerivedDocuments(
    rt, oldRepoPaths.map(path=>({path:dstRepo+path.slice(srcRepo.length),sourcePath:path,absent:true})),
    String(body.expectedRevision || ''), actor, 'Rename folder', templates,
  );
  await rt.ensureSynced();
  rt.rebuildSearch();
  return jsonResponse(200, { old_path: srcRepo, new_path: dstRepo, revision: publication.revision, regenerated: publication.regenerated });
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
  const [raw] = splitFrontmatter(markdown);
  const prefix = `${key}:`;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.slice(line.indexOf(':') + 1).trim().replace(/^"|"$/g, '');
    }
  }
  return '';
}

function inferDocType(repoPath: string): string {
  const parts = new Set(repoPath.split('/'));
  if (parts.has('sops')) return 'sop';
  if (parts.has('code-views')) return 'code-view';
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

