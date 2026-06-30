import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ContentsApiGithubStore,
  GitHubError,
  normalizeRepoPath,
  quotePath,
  shouldHydratePath,
} from '../src/docs/githubStore';

// ── A tiny in-memory GitHub the store talks to via injected fetch ──────────────
interface FakeBlob {
  sha: string;
  content: string; // utf-8
}

interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

class FakeGitHub {
  blobs = new Map<string, FakeBlob>(); // repoPath -> blob
  calls: RecordedCall[] = [];
  private shaCounter = 0;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.put(path, content);
  }

  put(path: string, content: string): string {
    const sha = `sha-${path}-${++this.shaCounter}`;
    this.blobs.set(path, { sha, content });
    return sha;
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    this.calls.push({ method, path, body });

    // git/trees/<branch>?recursive=1
    if (method === 'GET' && u.pathname.includes('/git/trees/')) {
      const tree = [...this.blobs.entries()].map(([p, b]) => ({
        path: p,
        sha: b.sha,
        type: 'blob',
        size: Buffer.byteLength(b.content),
      }));
      return jsonResponse(200, { tree });
    }
    // git/blobs/<sha>
    if (method === 'GET' && u.pathname.includes('/git/blobs/')) {
      const sha = u.pathname.split('/git/blobs/')[1];
      const found = [...this.blobs.values()].find((b) => b.sha === sha);
      if (!found) return jsonResponse(404, { message: 'Not Found' });
      return jsonResponse(200, { content: Buffer.from(found.content, 'utf-8').toString('base64') });
    }
    // commits?...
    if (method === 'GET' && u.pathname.endsWith('/commits')) {
      return jsonResponse(200, [
        { sha: 'abcdef1234567', commit: { message: 'Update foo\n\nbody', author: { name: 'Tester', date: '2024-01-02T03:04:05Z' } } },
      ]);
    }
    // contents PUT / DELETE
    if (u.pathname.includes('/contents/')) {
      const repoPath = decodeURIComponent(u.pathname.split('/contents/')[1]);
      if (method === 'PUT') {
        const content = Buffer.from(String(body?.content || ''), 'base64').toString('utf-8');
        this.put(repoPath, content);
        return jsonResponse(200, { content: { path: repoPath } });
      }
      if (method === 'DELETE') {
        this.blobs.delete(repoPath);
        return jsonResponse(200, { commit: {} });
      }
    }
    return jsonResponse(404, { message: `unhandled ${method} ${path}` });
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeStore(github: FakeGitHub, cacheDir: string): ContentsApiGithubStore {
  return new ContentsApiGithubStore({
    owner: 'DataTalksClub',
    repo: 'dataops',
    branch: 'main',
    token: 'test-token',
    cacheDir,
    fetchImpl: github.fetch as unknown as typeof fetch,
  });
}

describe('githubStore - path helpers', () => {
  it('normalizes and rejects traversal', () => {
    assert.strictEqual(normalizeRepoPath('/content/a.md'), 'content/a.md');
    assert.strictEqual(normalizeRepoPath('content\\a.md'), 'content/a.md');
    assert.throws(() => normalizeRepoPath('../etc/passwd'));
    assert.throws(() => normalizeRepoPath(''));
  });

  it('quotes path segments but keeps slashes', () => {
    assert.strictEqual(quotePath('content/a b/c.md'), 'content/a%20b/c.md');
  });

  it('hydrates markdown and content images only', () => {
    assert.ok(shouldHydratePath('content/x/a.md'));
    assert.ok(shouldHydratePath('content/images/x/pic.png'));
    assert.ok(!shouldHydratePath('content/images/x/pic.txt'));
    assert.ok(!shouldHydratePath('README.md'));
    assert.ok(!shouldHydratePath('content/x/data.json'));
  });
});

describe('githubStore - read/list/commit (GitHub mocked)', () => {
  let dir: string;
  let github: FakeGitHub;
  let store: ContentsApiGithubStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghstore-'));
    github = new FakeGitHub({
      'content/a.md': '# A\nalpha',
      'content/sub/b.md': '# B\nbeta',
      'content/images/a/pic.png': 'PNGDATA',
      'README.md': 'ignored',
    });
    store = makeStore(github, dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the repo tree from the Git Trees API', async () => {
    const tree = await store.tree();
    assert.ok(tree['content/a.md']);
    assert.strictEqual(tree['content/a.md'].type, 'blob');
    // tree is cached: a second call does not refetch
    const before = github.calls.length;
    await store.tree();
    assert.strictEqual(github.calls.length, before);
  });

  it('reads a file lazily via tree + blob and caches to /tmp', async () => {
    const text = await store.readFile('content/a.md');
    assert.strictEqual(text, '# A\nalpha');
    assert.ok(existsSync(store.localPath('content/a.md')), 'file cached on disk');
    // second read served from cache (no extra blob fetch)
    const blobCallsBefore = github.calls.filter((c) => c.path.includes('/git/blobs/')).length;
    await store.readFile('content/a.md');
    const blobCallsAfter = github.calls.filter((c) => c.path.includes('/git/blobs/')).length;
    assert.strictEqual(blobCallsBefore, blobCallsAfter);
  });

  it('throws ENOENT for a missing file', async () => {
    await assert.rejects(() => store.readFile('content/missing.md'), /missing\.md/);
  });

  it('sync hydrates only markdown + content images', async () => {
    await store.sync();
    assert.ok(existsSync(store.localPath('content/a.md')));
    assert.ok(existsSync(store.localPath('content/sub/b.md')));
    assert.ok(existsSync(store.localPath('content/images/a/pic.png')));
    assert.ok(!existsSync(store.localPath('README.md')));
  });

  it('commits on writeFile with a base64 PUT and a sha for updates', async () => {
    await store.tree(); // prime so currentSha is known for the existing file
    await store.writeFile('content/a.md', '# A\nalpha edited', 'Update content/a.md');
    const put = github.calls.find((c) => c.method === 'PUT' && c.path.includes('/contents/'));
    assert.ok(put, 'a PUT was issued');
    assert.strictEqual(put!.body!.message, 'Update content/a.md');
    assert.strictEqual(put!.body!.branch, 'main');
    assert.ok(put!.body!.sha, 'update includes the current blob sha');
    assert.strictEqual(
      Buffer.from(String(put!.body!.content), 'base64').toString('utf-8'),
      '# A\nalpha edited',
    );
    // local cache reflects the new content
    assert.strictEqual(readFileSync(store.localPath('content/a.md'), 'utf-8'), '# A\nalpha edited');
  });

  it('omits sha when creating a brand-new file', async () => {
    await store.writeFile('content/new.md', 'fresh', 'Create content/new.md');
    const put = github.calls.find((c) => c.method === 'PUT' && c.path.includes('/contents/'));
    assert.ok(put);
    assert.strictEqual(put!.body!.sha, undefined);
  });

  it('deletes via the Contents API with the current sha', async () => {
    await store.tree();
    await store.deleteFile('content/a.md', 'Delete content/a.md');
    const del = github.calls.find((c) => c.method === 'DELETE');
    assert.ok(del);
    assert.ok(del!.body!.sha);
    assert.ok(!existsSync(store.localPath('content/a.md')));
  });

  it('returns commit history for a path', async () => {
    const commits = await store.commitsForPath('content/a.md');
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].sha, 'abcdef1');
    assert.strictEqual(commits[0].message, 'Update foo');
    assert.strictEqual(commits[0].author, 'Tester');
    assert.strictEqual(commits[0].date, '2024-01-02');
  });

  it('raises GitHubError without a token', async () => {
    const noToken = new ContentsApiGithubStore({ owner: 'o', repo: 'r', cacheDir: dir, fetchImpl: github.fetch as unknown as typeof fetch });
    await assert.rejects(() => noToken.tree(), GitHubError);
  });
});
