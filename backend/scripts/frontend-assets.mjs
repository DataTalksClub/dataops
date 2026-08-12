import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND_ASSET_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'docs',
  'frontend-assets.json',
);

const ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js']);
const REQUIRED_FILES = ['index.html', 'src/app.js', 'src/styles.css'];

export function readFrontendAssetManifest(path = FRONTEND_ASSET_MANIFEST_PATH) {
  let payload;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('manifest must be a regular non-symlink file');
    }
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Frontend asset manifest is missing or invalid JSON: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || payload.version !== 1) {
    throw new Error('Frontend asset manifest version must be 1');
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'files' || keys[1] !== 'version') {
    throw new Error('Frontend asset manifest schema only permits version and files');
  }
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error('Frontend asset manifest files must be a non-empty array');
  }

  const files = [];
  const seen = new Set();
  for (const raw of payload.files) {
    if (typeof raw !== 'string' || !raw || raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\')) {
      throw new Error(`Invalid frontend asset path: ${String(raw)}`);
    }
    const normalized = posix.normalize(raw);
    const parts = raw.split('/');
    if (normalized !== raw || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Frontend asset path must be normalized: ${raw}`);
    }
    if (raw !== 'index.html' && !raw.startsWith('src/')) {
      throw new Error(`Frontend asset must be index.html or live under src/: ${raw}`);
    }
    if (!ALLOWED_EXTENSIONS.has(extname(raw).toLowerCase())) {
      throw new Error(`Unsupported frontend asset extension: ${raw}`);
    }
    if (seen.has(raw)) throw new Error(`Duplicate frontend asset path: ${raw}`);
    seen.add(raw);
    files.push(raw);
  }
  for (const required of REQUIRED_FILES) {
    if (!seen.has(required)) throw new Error(`Frontend asset manifest is missing required file: ${required}`);
  }
  return Object.freeze({ version: 1, files: Object.freeze(files) });
}

export function resolveManifestFile(root, relativePath, label) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...relativePath.split('/'));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  let current = absoluteRoot;
  const rootStat = lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a real directory: ${absoluteRoot}`);
  }
  realpathSync(absoluteRoot);
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symlinks: ${relativePath}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`${label} must resolve to a regular file: ${relativePath}`);
    }
  }
  return absolute;
}

export function manifestDirectories(files, prefix = '') {
  const directories = new Set();
  for (const file of files) {
    let directory = posix.dirname(file);
    while (directory && directory !== '.') {
      directories.add(prefix ? `${prefix}/${directory}` : directory);
      directory = posix.dirname(directory);
    }
  }
  return directories;
}
