/**
 * GitHub content store seam.
 *
 * Defines the `GithubStore` interface: read the repo tree/files, commit-on-save
 * via the GitHub Contents API, with a `/tmp` cache — ported from
 * `lambda-functions/src/lambda_functions/github_store.py`. GitHub markdown
 * remains the source of truth for content (`_docs/TARGET_ARCHITECTURE.md`).
 *
 * The stub implementation throws {@link NotImplementedError}. Issue #87
 * implements it (likely with `gray-matter` for frontmatter).
 */

import { NotImplementedError } from './errors';

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
  /** Local cache directory for the markdown working copy. Defaults to `/tmp`. */
  cacheDir?: string;
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
  /** ISO-8601 commit date. */
  date: string;
}

/**
 * Read/write access to the content repository.
 *
 * Reads are served from a `/tmp` cache hydrated from a tarball; writes commit
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

// ── Stub implementation (issue #87 implements) ────────────────────────────────

const UNIMPLEMENTED_ISSUE = '#87';

/**
 * Placeholder GitHub store. Every method throws {@link NotImplementedError}
 * until issue #87 ports the content backend.
 */
export class ContentsApiGithubStore implements GithubStore {
  constructor(_config: GithubStoreConfig) {
    // Config is retained by the real implementation; the stub does nothing.
  }

  tree(): Promise<Record<string, GithubTreeEntry>> {
    throw new NotImplementedError('GithubStore.tree', UNIMPLEMENTED_ISSUE);
  }

  refreshTree(): Promise<void> {
    throw new NotImplementedError('GithubStore.refreshTree', UNIMPLEMENTED_ISSUE);
  }

  sync(): Promise<void> {
    throw new NotImplementedError('GithubStore.sync', UNIMPLEMENTED_ISSUE);
  }

  readFile(_repoPath: string): Promise<string> {
    throw new NotImplementedError('GithubStore.readFile', UNIMPLEMENTED_ISSUE);
  }

  readBytes(_repoPath: string): Promise<Uint8Array> {
    throw new NotImplementedError('GithubStore.readBytes', UNIMPLEMENTED_ISSUE);
  }

  writeFile(_repoPath: string, _content: string | Uint8Array, _message: string): Promise<void> {
    throw new NotImplementedError('GithubStore.writeFile', UNIMPLEMENTED_ISSUE);
  }

  deleteFile(_repoPath: string, _message: string): Promise<void> {
    throw new NotImplementedError('GithubStore.deleteFile', UNIMPLEMENTED_ISSUE);
  }

  currentSha(_repoPath: string): Promise<string> {
    throw new NotImplementedError('GithubStore.currentSha', UNIMPLEMENTED_ISSUE);
  }

  commitsForPath(_repoPath: string): Promise<GithubCommitInfo[]> {
    throw new NotImplementedError('GithubStore.commitsForPath', UNIMPLEMENTED_ISSUE);
  }

  reset(): void {
    throw new NotImplementedError('GithubStore.reset', UNIMPLEMENTED_ISSUE);
  }
}

/** Construct a GitHub content store. Stub until issue #87. */
export function createGithubStore(config: GithubStoreConfig): GithubStore {
  return new ContentsApiGithubStore(config);
}
