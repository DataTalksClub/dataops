/**
 * GitHub content store.
 *
 * Ports `lambda-functions/src/lambda_functions/github_store.py` to TypeScript.
 * GitHub markdown remains the source of truth for content
 * (`_docs/TARGET_ARCHITECTURE.md`); this store reads the repo tree/files through
 * the GitHub Contents/Git Data API, keeps a `/tmp` working copy as a cache, and
 * commits on save/delete through the Contents API.
 *
 * Difference from the Python original: hydration uses the recursive Git Trees
 * API plus per-blob fetches (cached to `/tmp`) instead of a single tarball
 * download, so the store has no third-party tar dependency. The cache location,
 * source-of-truth semantics, and commit-on-save behavior are unchanged. (A
 * batch tarball download is a possible future perf optimization.)
 */

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Image extensions hydrated from `content/images/` into the cache. */
export const CONTENT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

/** Raised when a GitHub API request fails. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Configuration for a {@link GithubStore}. */
export interface GithubStoreConfig {
  /** Repository owner / org, e.g. `DataTalksClub`. */
  owner: string;
  /** Repository name, e.g. `dataops`. */
  repo: string;
  /** Branch to read/commit against. Defaults to the repo default branch. */
  branch?: string;
  /** GitHub token; resolved from Secrets Manager / env by the implementation. */
  token?: string;
  /** Name of the Secrets Manager secret holding the token (lazy resolution). */
  tokenSecretName?: string;
  /** Local cache directory for the markdown working copy. Defaults to `/tmp`. */
  cacheDir?: string;
  /** Injectable `fetch` (defaults to global `fetch`); used to mock GitHub in tests. */
  fetchImpl?: typeof fetch;
}

/** One entry in the repository tree. */
export interface GithubTreeEntry {
  /** Repo-relative path, e.g. `content/sops/foo.md`. */
  path: string;
  /** Git blob/tree SHA. */
  sha: string;
  /** Entry kind. */
  type: 'blob' | 'tree';
  /** Blob size in bytes, when known. */
  size?: number;
}

/** A commit touching a given path, used for history views. */
export interface GithubCommitInfo {
  sha: string;
  message: string;
  author: string;
  /** ISO-8601 (or `YYYY-MM-DD`) commit date. */
  date: string;
}

/**
 * Read/write access to the content repository.
 *
 * Reads are served from a `/tmp` cache hydrated from GitHub; writes commit
 * directly through the GitHub Contents API and refresh the cache.
 */
export interface GithubStore {
  /** Map of repo-relative path -> tree entry. Served from the `/tmp` cache. */
  tree(): Promise<Record<string, GithubTreeEntry>>;

  /** Force-refresh the cached tree from GitHub. */
  refreshTree(): Promise<void>;

  /** Hydrate / sync the markdown working copy into the `/tmp` cache. */
  sync(): Promise<void>;

  /** Read a file's UTF-8 text by repo path. */
  readFile(repoPath: string): Promise<string>;

  /** Read a file's raw bytes by repo path. */
  readBytes(repoPath: string): Promise<Uint8Array>;

  /** Commit-on-save: create/update a file via the Contents API. */
  writeFile(repoPath: string, content: string | Uint8Array, message: string): Promise<void>;

  /** Commit-on-delete: remove a file via the Contents API. */
  deleteFile(repoPath: string, message: string): Promise<void>;

  /** Current blob SHA for a path (needed for Contents API updates). */
  currentSha(repoPath: string): Promise<string>;

  /** Commit history for a path. */
  commitsForPath(repoPath: string): Promise<GithubCommitInfo[]>;

  /** Clear any in-memory/`/tmp` cache state. */
  reset(): void;
}

const DEFAULT_CACHE_DIR = '/tmp/dataops';
const GITHUB_API = 'https://api.github.com';

/** Normalize a repo-relative path; reject traversal and absolute paths. */
export function normalizeRepoPath(path: string): string {
  const clean = path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').includes('..')) {
    throw new Error('Invalid repository path');
  }
  return clean;
}

/** Percent-encode a path while keeping `/` separators (Python `quote_path`). */
export function quotePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** True when a tree/tarball path should be hydrated into the cache. */
export function shouldHydratePath(path: string): boolean {
  let repoPath: string;
  try {
    repoPath = normalizeRepoPath(path);
  } catch {
    return false;
  }
  if (!repoPath.startsWith('content/')) return false;
  if (repoPath.endsWith('.md')) return true;
  if (!repoPath.startsWith('content/images/')) return false;
  const dot = repoPath.lastIndexOf('.');
  const ext = dot >= 0 ? repoPath.slice(dot).toLowerCase() : '';
  return CONTENT_IMAGE_EXTENSIONS.has(ext);
}

/**
 * GitHub content store backed by the Contents / Git Data API with a `/tmp`
 * working-copy cache. Implements {@link GithubStore} and exposes a few extra
 * filesystem helpers used by the content API (cache paths + commit helpers).
 */
export class ContentsApiGithubStore implements GithubStore {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly root: string;
  readonly contentRoot: string;

  private readonly fetchImpl: typeof fetch;
  private readonly configToken?: string;
  private readonly tokenSecretName?: string;
  private resolvedToken: string | null = null;
  private treeCache: Record<string, GithubTreeEntry> | null = null;
  private hydrated = false;
  private secretsClient: SecretsManagerClient | null = null;

  constructor(config: GithubStoreConfig) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.branch = config.branch || 'main';
    this.root = resolve(config.cacheDir || DEFAULT_CACHE_DIR);
    this.contentRoot = resolve(this.root, 'content');
    this.fetchImpl = config.fetchImpl || fetch;
    this.configToken = config.token;
    this.tokenSecretName = config.tokenSecretName;
  }

  get githubUrl(): string {
    return `https://github.com/${this.owner}/${this.repo}`;
  }

  reset(): void {
    this.treeCache = null;
    this.hydrated = false;
    if (existsSync(this.root)) {
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  /** Map a repo path to an absolute path inside the cache, guarding traversal. */
  localPath(repoPath: string): string {
    const clean = normalizeRepoPath(repoPath);
    const target = resolve(this.root, clean);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('Path escapes GitHub cache root');
    }
    return target;
  }

  async sync(): Promise<void> {
    if (this.hydrated) return;
    // Offline/local dev: content is already present under contentRoot (e.g. the
    // repo's own content/), so skip GitHub hydration entirely.
    if (process.env.DTC_OFFLINE === '1') {
      this.hydrated = true;
      return;
    }
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.contentRoot, { recursive: true });
    const tree = await this.tree();
    for (const entry of Object.values(tree)) {
      if (entry.type !== 'blob' || !shouldHydratePath(entry.path)) continue;
      if (existsSync(this.localPath(entry.path))) continue;
      this.writeRepoFile(entry.path, await this.blobBytes(entry.sha));
    }
    this.hydrated = true;
  }

  /** Ensure a single file is present in the cache, hydrating it if needed. */
  async ensureFile(repoPath: string): Promise<string> {
    const clean = normalizeRepoPath(repoPath);
    const local = this.localPath(clean);
    if (existsSync(local)) return local;
    // Offline/local dev: never reach for GitHub — a missing file is just ENOENT.
    if (process.env.DTC_OFFLINE === '1') {
      const err = new Error(clean) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    const entry = (await this.tree())[clean];
    if (!entry || entry.type !== 'blob') {
      const err = new Error(clean) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    this.writeRepoFile(clean, await this.blobBytes(entry.sha));
    return local;
  }

  async readFile(repoPath: string): Promise<string> {
    const local = await this.ensureFile(repoPath);
    return readFileSync(local, 'utf-8');
  }

  async readBytes(repoPath: string): Promise<Uint8Array> {
    const local = await this.ensureFile(repoPath);
    return new Uint8Array(readFileSync(local));
  }

  async writeFile(repoPath: string, content: string | Uint8Array, message: string): Promise<void> {
    const clean = normalizeRepoPath(repoPath);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    this.writeRepoFile(clean, bytes);
    await this.commitLocalFile(clean, message);
  }

  async deleteFile(repoPath: string, message: string): Promise<void> {
    const clean = normalizeRepoPath(repoPath);
    const local = this.localPath(clean);
    if (existsSync(local)) rmSync(local, { force: true });
    await this.deleteRepoFile(clean, message);
  }

  /** Commit the current cached bytes of a path through the Contents API. */
  async commitLocalFile(repoPath: string, message: string): Promise<void> {
    const clean = normalizeRepoPath(repoPath);
    const content = readFileSync(this.localPath(clean));
    const currentSha = await this.currentSha(clean);
    const body: Record<string, unknown> = {
      message,
      content: content.toString('base64'),
      branch: this.branch,
    };
    if (currentSha) body.sha = currentSha;
    await this.request('PUT', `/repos/${this.owner}/${this.repo}/contents/${quotePath(clean)}`, body);
    await this.refreshTree();
  }

  /** Delete a path from the repo through the Contents API. */
  async deleteRepoFile(repoPath: string, message: string): Promise<void> {
    const clean = normalizeRepoPath(repoPath);
    const currentSha = await this.currentSha(clean);
    if (!currentSha) return;
    await this.request('DELETE', `/repos/${this.owner}/${this.repo}/contents/${quotePath(clean)}`, {
      message,
      sha: currentSha,
      branch: this.branch,
    });
    await this.refreshTree();
  }

  async currentSha(repoPath: string): Promise<string> {
    const entry = (await this.tree())[normalizeRepoPath(repoPath)];
    if (!entry || entry.type !== 'blob') return '';
    return entry.sha || '';
  }

  async tree(): Promise<Record<string, GithubTreeEntry>> {
    if (this.treeCache === null) {
      const data = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/git/trees/${quotePath(this.branch)}?recursive=1`,
      );
      const tree: Record<string, GithubTreeEntry> = {};
      const items = Array.isArray((data as { tree?: unknown }).tree) ? (data as { tree: unknown[] }).tree : [];
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.path !== 'string') continue;
        tree[item.path] = {
          path: item.path,
          sha: String(item.sha || ''),
          type: item.type === 'tree' ? 'tree' : 'blob',
          size: typeof item.size === 'number' ? item.size : undefined,
        };
      }
      this.treeCache = tree;
    }
    return this.treeCache;
  }

  async refreshTree(): Promise<void> {
    this.treeCache = null;
  }

  async blobBytes(sha: string): Promise<Buffer> {
    const data = await this.request('GET', `/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    const content = String((data as { content?: unknown }).content || '');
    return Buffer.from(content, 'base64');
  }

  async commitsForPath(repoPath: string): Promise<GithubCommitInfo[]> {
    const clean = normalizeRepoPath(repoPath);
    const query = new URLSearchParams({ sha: this.branch, path: clean, per_page: '10' });
    const data = await this.request('GET', `/repos/${this.owner}/${this.repo}/commits?${query.toString()}`);
    if (!Array.isArray(data)) return [];
    return data.map((raw): GithubCommitInfo => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const commit = (item.commit && typeof item.commit === 'object' ? item.commit : {}) as Record<string, unknown>;
      const author = (commit.author && typeof commit.author === 'object' ? commit.author : {}) as Record<string, unknown>;
      return {
        sha: String(item.sha || '').slice(0, 7),
        date: String(author.date || '').slice(0, 10),
        author: String(author.name || ''),
        message: String(commit.message || '').split('\n')[0],
      };
    });
  }

  /** Issue a GitHub API request, returning the parsed JSON (or `{}`). */
  async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const token = await this.token();
    if (!token) throw new GitHubError('GITHUB_TOKEN is not configured');
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'dataops-backend',
      'x-github-api-version': '2022-11-28',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${GITHUB_API}${path}`, { method, headers, body: payload });
    } catch (err) {
      throw new GitHubError(`GitHub ${method} ${path} failed: ${(err as Error).message}`);
    }
    const raw = await resp.text();
    if (!resp.ok) {
      throw new GitHubError(`GitHub ${method} ${path} failed: HTTP ${resp.status}: ${raw}`);
    }
    if (!raw) return {};
    return JSON.parse(raw);
  }

  private writeRepoFile(repoPath: string, content: Buffer): void {
    const local = this.localPath(repoPath);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, content);
  }

  /** Resolve the GitHub token from config, env, or Secrets Manager (cached). */
  private async token(): Promise<string> {
    if (this.resolvedToken !== null) return this.resolvedToken;
    const configured = this.configToken || process.env.GITHUB_TOKEN || '';
    const secretName = this.tokenSecretName || process.env.GITHUB_TOKEN_SECRET_NAME || '';
    if (configured || !secretName) {
      this.resolvedToken = configured;
      return configured;
    }
    this.secretsClient ||= new SecretsManagerClient({});
    try {
      const result = await this.secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      const secret =
        result.SecretString ||
        (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
      this.resolvedToken = secret;
      return secret;
    } catch (err) {
      throw new GitHubError(`Could not load secret ${secretName}: ${(err as Error).message}`);
    }
  }

  /** Last-modified time (epoch seconds) of a cached file; 0 if absent. */
  updatedAt(repoPath: string): number {
    const local = this.localPath(repoPath);
    if (!existsSync(local)) return 0;
    return Math.floor(statSync(local).mtimeMs / 1000);
  }
}

/** Build a {@link GithubStoreConfig} from environment variables. */
export function githubStoreConfigFromEnv(overrides: Partial<GithubStoreConfig> = {}): GithubStoreConfig {
  return {
    owner: process.env.GITHUB_OWNER || 'DataTalksClub',
    repo: process.env.GITHUB_REPO || 'dataops',
    branch: process.env.GITHUB_BRANCH || 'main',
    cacheDir: process.env.DTC_CACHE_ROOT || DEFAULT_CACHE_DIR,
    ...overrides,
  };
}

/** Construct a GitHub content store. */
export function createGithubStore(config: GithubStoreConfig): ContentsApiGithubStore {
  return new ContentsApiGithubStore(config);
}
