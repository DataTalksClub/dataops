/** Private S3 knowledge: immutable blobs/manifests and one conditional publication pointer. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
/** Image extensions hydrated from `content/images/` into the cache. */
export const CONTENT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

const CONTENT_IMAGE_PREFIX = 'content/images/';
const CONTENT_RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OPERATING_MODEL_DOWNLOAD_RE = /^_docs\/operating-model\/[a-z0-9][a-z0-9-]*\.(?:csv|ya?ml)$/;


export class KnowledgeError extends Error {}
export class KnowledgeVersionNotFound extends KnowledgeError {}
export class RevisionConflict extends Error {
  constructor() { super('Knowledge changed since you opened it. Your draft is preserved. Reload before saving.'); }
}
export class ContentRootUnavailableError extends Error {
  constructor(readonly contentRoot: string) { super(`Docs content root is unavailable: ${contentRoot}`); }
}
export function contentRootUnavailableMessage(root: string): string {
  return `Docs content root is unavailable: ${root} (configure KNOWLEDGE_BUCKET or a local DTC_CACHE_ROOT)`;
}
export interface KnowledgeEntry { path: string; sha: string; size: number; type: 'blob'; }
export interface KnowledgeChange { path: string; operation: 'create'|'edit'|'delete'|'rename'|'restore'|'import'; previousPath?: string; }
export interface Publication {
  schemaVersion: 1; revision: string; parent: string|null; createdAt: string; actor: string; message: string;
  entries: Record<string, KnowledgeEntry>; changes: KnowledgeChange[];
}
export interface KnowledgeConfig {
  bucket?: string; cacheDir?: string; offline?: boolean; signer?: typeof getSignedUrl; client?: Pick<S3Client, 'send'>;
}
export interface Mutation { path: string; bytes?: Uint8Array|string; sourcePath?: string; restoreRevision?: string; absent?: boolean; }
/** Normalize a repo-relative path; reject traversal and absolute paths. */
export function normalizeRepoPath(path: string): string {
  const clean = path.trim();
  if (!clean || clean.startsWith('/') || /[\\\x00-\x1f]/.test(clean) || clean.split('/').some(s => !s || s === '..' || s === '.' || s === '.git')) {
    throw new Error('Invalid repository path');
  }
  return clean;
}

/** Operational files mirrored daily; repository tooling remains independently maintained. */
export function isManagedKnowledgePath(path:string):boolean {
  return /^(content|_docs|workflow-templates|document-templates)\//.test(normalizeRepoPath(path));
}

/** Percent-encode a path while keeping `/` separators (Python `quote_path`). */
export function quotePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Return the case-sensitive final extension, or an empty string when absent. */
function contentExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

/**
 * The repository's canonical public-safe knowledge assets: markdown anywhere
 * under content/, supported images under content/images/, and passive raster
 * images nested beside authored documents. Hidden files,
 * empty segments, traversal, and uppercase extensions are not canonical.
 */
export function isCanonicalContentAsset(path: string): boolean {
  let repoPath: string;
  try {
    repoPath = normalizeRepoPath(path);
  } catch {
    return false;
  }
  const segments = repoPath.split('/');
  if (segments[0] !== 'content' || segments.length < 2) return false;
  if (segments.some((segment) => !segment || segment.startsWith('.'))) return false;

  const extension = contentExtension(repoPath);
  if (extension === '.md') return true;
  if (CONTENT_RASTER_EXTENSIONS.has(extension)) return true;
  if (
    extension === '.ics'
    && repoPath.startsWith('content/00-start-here/operating-model/reference/roadmap/')
  ) return true;
  return repoPath.startsWith(CONTENT_IMAGE_PREFIX) && CONTENT_IMAGE_EXTENSIONS.has(extension);
}

/** Exact private definition files that may be downloaded by an authenticated operator. */
export function isOperatingModelDownload(path: string): boolean {
  let repoPath: string;
  try {
    repoPath = normalizeRepoPath(path);
  } catch {
    return false;
  }
  return OPERATING_MODEL_DOWNLOAD_RE.test(repoPath);
}

/** True when a tree/tarball path should be hydrated into the cache. */
export function shouldHydratePath(path: string): boolean {
  return isCanonicalContentAsset(path) || isOperatingModelDownload(path);
}


export async function bounded<T>(items: T[], fn: (item:T)=>Promise<void>, limit=24): Promise<void> {
  let next=0;let failed=false;let firstError:unknown;
  await Promise.allSettled(Array.from({length:Math.min(limit,items.length)}, async()=> {
    while(next<items.length && !failed) {
      try {await fn(items[next++]);}
      catch(error) {if(!failed)firstError=error;failed=true;throw error;}
    }
  }));
  if(failed)throw firstError;
}
export function checksum(bytes:Uint8Array|string): string { return createHash('sha256').update(bytes).digest('hex'); }
export class KnowledgeStore {
  readonly bucket: string;
  readonly client: Pick<S3Client,'send'>;
  private readonly cacheBase:string;
  private publication: Publication|null=null;
  private pointerEtag:string|undefined;
  private hydrated=false;
  private localOffline:boolean|undefined;
  private signer:typeof getSignedUrl;
  constructor(config:KnowledgeConfig={}) {
    this.signer=config.signer||getSignedUrl;
    this.localOffline=config.offline;
    this.bucket=config.bucket||process.env.KNOWLEDGE_BUCKET||'';
    this.client=config.client||new S3Client({});
    this.cacheBase=resolve(config.cacheDir||process.env.DTC_CACHE_ROOT||'/tmp/dataops-knowledge');
  }
  get offline():boolean { return this.localOffline ?? process.env.DTC_OFFLINE==='1'; }
  get root():string { return this.offline ? this.cacheBase : resolve(this.cacheBase,this.publication?.revision||'unpublished'); }
  get contentRoot():string { return resolve(this.root,'content'); }
  get revision():string { return this.publication?.revision||'local'; }
  localPath(path:string):string {
    const target=resolve(this.root,normalizeRepoPath(path));
    if (!target.startsWith(this.root+sep)) throw new KnowledgeError('Path escapes knowledge cache');
    return target;
  }
  reset():void { this.publication=null; this.hydrated=false; }
  async json<T>(key:string):Promise<{value:T;etag?:string}> {
    if (!this.bucket) throw new KnowledgeError('KNOWLEDGE_BUCKET is not configured');
    const out=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
    return {value:JSON.parse(await out.Body!.transformToString()) as T,etag:out.ETag};
  }
  async pin():Promise<Publication> {
    if(this.publication) return this.publication;
    const pointer=await this.json<{revision:string}>('active.json');
    this.pointerEtag=pointer.etag;
    this.publication=(await this.json<Publication>(`publications/${pointer.value.revision}.json`)).value;
    if(this.publication.revision!==pointer.value.revision) throw new KnowledgeError('Invalid knowledge publication');
    return this.publication;
  }
  async refreshTree():Promise<void> { this.reset(); }
  async tree():Promise<Record<string,KnowledgeEntry>> { return (await this.pin()).entries; }
  async blobBytes(sha:string):Promise<Buffer> {
    if(!/^[a-f0-9]{64}$/.test(sha)) throw new KnowledgeError('Invalid payload checksum');
    const out=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:`objects/${sha}`}));
    const bytes=Buffer.from(await out.Body!.transformToByteArray());
    if(checksum(bytes)!==sha) throw new KnowledgeError('Knowledge payload checksum mismatch');
    return bytes;
  }
  async sync():Promise<void> {
    if(this.hydrated) return;
    if(this.offline) {this.hydrated=true;return;}
    const publication=await this.pin();
    mkdirSync(this.contentRoot,{recursive:true});
    // Binary assets remain lazy. Text used by registry/search/model is downloaded concurrently.
    await bounded(Object.values(publication.entries).filter(e=>/\.(md|ya?ml|csv|json)$/.test(e.path)), async e=> {
      const path=this.localPath(e.path);
      if(!existsSync(path)) {mkdirSync(dirname(path),{recursive:true});writeFileSync(path,await this.blobBytes(e.sha));}
    });
    this.hydrated=true;
  }
  async ensureFile(path:string):Promise<string> {
    const clean=normalizeRepoPath(path);
    if(!this.offline) await this.pin();
    const target=this.localPath(clean);
    if(existsSync(target)) return target;
    if(this.offline && !existsSync(this.contentRoot)) throw new ContentRootUnavailableError(this.contentRoot);
    const entry=this.offline ? null : (await this.tree())[clean];
    if(!entry) { const err=new Error('File not found') as NodeJS.ErrnoException;err.code='ENOENT';throw err; }
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,await this.blobBytes(entry.sha));return target;
  }
  async readFile(path:string):Promise<string> { return readFileSync(await this.ensureFile(path),'utf8'); }
  async readBytes(path:string):Promise<Uint8Array> { return readFileSync(await this.ensureFile(path)); }
  updatedAt(path:string):number { const p=this.localPath(path);return existsSync(p)?Math.floor(statSync(p).mtimeMs/1000):0; }
  async publish(mutations:Mutation[], expectedRevision:string, actor:string, message:string):Promise<Publication> {
    if(!expectedRevision || !actor) throw new KnowledgeError('Expected revision and authenticated actor are required');
    if(this.offline) throw new KnowledgeError('Local knowledge mutations require the test/local S3 store');
    const previous=await this.pin();
    if(expectedRevision!==previous.revision) throw new RevisionConflict();
    if(!this.pointerEtag) throw new KnowledgeError('Active knowledge pointer has no concurrency token');
    const entries={...previous.entries};const changes:KnowledgeChange[]=[];
    for(const mutation of mutations) {
      const path=normalizeRepoPath(mutation.path);
      if(mutation.absent && entries[path]) throw new RevisionConflict();
      let entry:KnowledgeEntry|undefined;
      let operation:KnowledgeChange['operation']=entries[path]?'edit':'create';
      if(mutation.sourcePath) {
        const source=normalizeRepoPath(mutation.sourcePath);
        if(entries[path] || !entries[source]) throw new RevisionConflict();
        entry={...entries[source],path};delete entries[source];operation='rename';
      } else if(mutation.restoreRevision) {
        if(!/^[a-f0-9-]{36}$/.test(mutation.restoreRevision)) throw new KnowledgeError('Invalid revision');
        await this.versionBytes(path,mutation.restoreRevision);
        const older=(await this.json<Publication>(`publications/${mutation.restoreRevision}.json`)).value;
        if(!older.entries[path]) throw new KnowledgeError('Version has no payload');
        entry={...older.entries[path]};operation='restore';
      } else if(mutation.bytes!==undefined) {
        const bytes=typeof mutation.bytes==='string'?Buffer.from(mutation.bytes):mutation.bytes;
        const sha=checksum(bytes);
        try {await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:`objects/${sha}`,Body:bytes,IfNoneMatch:'*'}));}
        catch(err) {if((err as {name?:string}).name!=='PreconditionFailed') throw err;}
        entry={path,sha,size:bytes.length,type:'blob'};
      } else {if(!entries[path]) throw new RevisionConflict();operation='delete';}
      if(entry) entries[path]=entry;else delete entries[path];
      changes.push({path,operation,...(mutation.sourcePath?{previousPath:mutation.sourcePath}:{})});
    }
    const publication:Publication={schemaVersion:1,revision:randomUUID(),parent:previous.revision,createdAt:new Date().toISOString(),actor,message,entries,changes};
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:`publications/${publication.revision}.json`,Body:JSON.stringify(publication),IfNoneMatch:'*',ContentType:'application/json'}));
    try {const out=await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:'active.json',Body:JSON.stringify({revision:publication.revision}),IfMatch:this.pointerEtag,ContentType:'application/json'}));this.pointerEtag=out.ETag;}
    catch(err) {if(['PreconditionFailed','ConditionalRequestConflict'].includes((err as {name?:string}).name||'')) throw new RevisionConflict();throw err;}
    this.publication=publication;this.hydrated=false;
    return publication;
  }
  async history(path:string,cursor?:string,limit=20):Promise<{versions:Record<string,unknown>[];cursor:string|null}> {
    normalizeRepoPath(path);
    let publication=await this.pin();
    const seen=new Set<string>();
    if(cursor) {
      if(!/^[a-f0-9-]{36}$/.test(cursor)) throw new KnowledgeError('Invalid history cursor');
      // Cursors must be ancestors of the published head, never failed unpublished manifests.
      while(publication.revision!==cursor && publication.parent) {
        seen.add(publication.revision);publication=(await this.json<Publication>(`publications/${publication.parent}.json`)).value;
      }
      if(publication.revision!==cursor) throw new KnowledgeError('History cursor is not published');
    }
    const versions:Record<string,unknown>[]=[];
    let scanned=0;
    while(publication && scanned++<100) {
      if(seen.has(publication.revision)) throw new KnowledgeError('Invalid history chain');seen.add(publication.revision);
      const change=publication.changes.find(c=>c.path===path||c.previousPath===path);
      if(change) versions.push({revision:publication.revision,actor:publication.actor,time:publication.createdAt,message:publication.message,operation:change.operation,deleted:!publication.entries[path],binary:! /\.(md|csv|json|ya?ml|txt)$/.test(path)});
      const parent=publication.parent;
      if(!parent) return {versions,cursor:null};
      if(versions.length>=limit || scanned>=100) return {versions,cursor:parent};
      publication=(await this.json<Publication>(`publications/${parent}.json`)).value;
    }
    return {versions,cursor:null};
  }
  async versionEntry(path:string,revision:string):Promise<KnowledgeEntry> {
    normalizeRepoPath(path);
    let p=await this.pin();
    while(p.revision!==revision && p.parent) p=(await this.json<Publication>(`publications/${p.parent}.json`)).value;
    if(p.revision!==revision || !p.entries[path]) throw new KnowledgeVersionNotFound('Published version not found');
    return p.entries[path];
  }
  async versionBytes(path:string,revision:string):Promise<Buffer> {
    return this.blobBytes((await this.versionEntry(path,revision)).sha);
  }
  async assetUrl(path:string,contentType:string):Promise<string> {
    const entry=(await this.tree())[normalizeRepoPath(path)];
    if(!entry)throw new KnowledgeVersionNotFound('Published asset not found');
    return this.signer(new S3Client({}),new GetObjectCommand({Bucket:this.bucket,Key:`objects/${entry.sha}`,ResponseContentType:contentType,ResponseContentDisposition:'inline'}),{expiresIn:300});
  }
  async versionDownload(path:string,revision:string):Promise<string> {
    const entry=await this.versionEntry(path,revision);
    return this.signer(new S3Client({}),new GetObjectCommand({Bucket:this.bucket,Key:`objects/${entry.sha}`,ResponseContentDisposition:`attachment; filename="${encodeURIComponent(path.split('/').pop()||'download')}"`}),{expiresIn:300});
  }
}
export function knowledgeStoreConfigFromEnv(overrides:Partial<KnowledgeConfig>={}):KnowledgeConfig {
  return {bucket:process.env.KNOWLEDGE_BUCKET,cacheDir:process.env.DTC_CACHE_ROOT,...overrides};
}
export function createKnowledgeStore(config:KnowledgeConfig={}):KnowledgeStore {return new KnowledgeStore(config);}
