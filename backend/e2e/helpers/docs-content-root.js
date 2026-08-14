/**
 * Spec-owned docs content roots for offline browser tests.
 *
 * `scripts/test-server.ts` builds its docs store from the environment, and
 * `githubStoreConfigFromEnv()` falls back to `/tmp/dataops` when
 * `DTC_CACHE_ROOT` is unset. Offline (`DTC_OFFLINE=1`) nothing hydrates that
 * directory, so a spec without an explicit cache root inherits whatever the
 * machine happens to have: present and empty on a developer laptop, absent on a
 * clean CI runner. Every offline spec therefore owns a content root under the
 * project-local `.tmp/`, created fresh for each run.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp');

/**
 * Create an empty-but-present docs cache for `name` and return its root.
 *
 * The returned path is what `DTC_CACHE_ROOT` must be set to; `<root>/content`
 * is created so the docs collection endpoints see a readable (possibly empty)
 * corpus instead of a missing configured content root.
 *
 * @param {string} name spec-unique directory name, relative to `<repo>/.tmp/`
 * @param {Record<string, string>} documents repo-relative `content/...` path -> markdown
 * @returns {string} absolute cache root for `DTC_CACHE_ROOT`
 */
function createDocsCacheRoot(name, documents = {}) {
  const cacheRoot = path.join(TMP_ROOT, name);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  const contentRoot = path.join(cacheRoot, 'content');
  fs.mkdirSync(contentRoot, { recursive: true });
  for (const [repoPath, markdown] of Object.entries(documents)) {
    const relative = repoPath.replace(/^content\//, '');
    const target = path.join(contentRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown);
  }
  return cacheRoot;
}

/**
 * Return a spec-owned docs cache root that deliberately does not exist.
 *
 * The path is removed rather than never named, so a leftover directory from an
 * earlier run cannot quietly turn an outage fixture into an empty corpus.
 * Offline (`DTC_OFFLINE=1`) nothing recreates it, so `<root>/content` stays
 * absent and every docs endpoint answers with the 503 that names the path.
 *
 * @param {string} name spec-unique directory name, relative to `<repo>/.tmp/`
 * @returns {string} absolute, absent cache root for `DTC_CACHE_ROOT`
 */
function missingDocsCacheRoot(name) {
  const cacheRoot = path.join(TMP_ROOT, name);
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  return cacheRoot;
}

module.exports = {
  createDocsCacheRoot,
  missingDocsCacheRoot,
  REPO_ROOT,
  TMP_ROOT,
};
