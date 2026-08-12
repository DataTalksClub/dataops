import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

export const FRONTEND_ALLOWLIST = Object.freeze([
  'dist/frontend/index.html',
  'dist/frontend/src/app.js',
  'dist/frontend/src/styles.css',
]);

const SOURCE_BY_CANONICAL = Object.freeze({
  'dist/frontend/index.html': 'index.html',
  'dist/frontend/src/app.js': 'src/app.js',
  'dist/frontend/src/styles.css': 'src/styles.css',
});
const RESERVED_UI_NAMES = new Set(['index.html', 'app.js', 'styles.css']);
const FORBIDDEN_UI_ROOTS = new Set(['pages', 'public', 'static', 'assets', 'ui']);

function usage(message) {
  throw new Error(`${message}\nUsage: node backend/scripts/verify-frontend-artifact.mjs --source <frontend-root> --artifact <artifact-root>`);
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--source' && option !== '--artifact') usage(`Unknown argument: ${option}`);
    if (Object.hasOwn(values, option)) usage(`Duplicate argument: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${option}`);
    values[option] = value;
    index += 1;
  }
  if (!values['--source']) usage('Missing required --source argument');
  if (!values['--artifact']) usage('Missing required --artifact argument');
  return { sourceRoot: resolve(values['--source']), artifactRoot: resolve(values['--artifact']) };
}

function requireDirectory(root, label) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new Error(`${label} root is missing or unreadable: ${root}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} root must be a real directory: ${root}`);
  try {
    realpathSync(root);
    readdirSync(root);
  } catch {
    throw new Error(`${label} root is unreadable: ${root}`);
  }
}

function posixRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function inventory(root) {
  const entries = [];
  const visit = (directory) => {
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = resolve(directory, child.name);
      const path = posixRelative(root, absolute);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) entries.push({ path, kind: 'symlink', absolute });
      else if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory', absolute });
        visit(absolute);
      } else if (stat.isFile()) entries.push({ path, kind: 'file', absolute, bytes: readFileSync(absolute) });
      else entries.push({ path, kind: 'non-file', absolute });
    }
  };
  visit(root);
  return entries;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function layoutFor(entries) {
  const paths = new Set(entries.map((entry) => entry.path));
  const backendPresent = paths.has('handler.js') || paths.has('frontend');
  const samPresent = paths.has('dist/handler.js') || paths.has('dist/frontend');
  if (backendPresent && samPresent) throw new Error('Frontend artifact verification failed:\n- ambiguous artifact layout: both backend and SAM roots are present');
  if (!backendPresent && !samPresent) throw new Error('Frontend artifact verification failed:\n- unrecognized artifact layout: expected handler.js/frontend or dist/handler.js/dist/frontend');
  if (backendPresent && !(paths.has('handler.js') && paths.has('frontend'))) {
    throw new Error('Frontend artifact verification failed:\n- incomplete backend artifact layout: handler.js and frontend are both required');
  }
  if (samPresent && !(paths.has('dist/handler.js') && paths.has('dist/frontend'))) {
    throw new Error('Frontend artifact verification failed:\n- incomplete SAM artifact layout: dist/handler.js and dist/frontend are both required');
  }
  return backendPresent
    ? { name: 'backend', codeRoot: '', handler: 'handler.js', uiRoot: 'frontend' }
    : { name: 'sam', codeRoot: 'dist', handler: 'dist/handler.js', uiRoot: 'dist/frontend' };
}

function isDependency(path) {
  return path === 'node_modules' || path.startsWith('node_modules/');
}

function isApplicationEntry(path) {
  return !isDependency(path);
}

export function verifyFrontendArtifact({ sourceRoot, artifactRoot }) {
  requireDirectory(sourceRoot, 'Source');
  requireDirectory(artifactRoot, 'Artifact');
  const errors = [];
  const sourceBytes = new Map();
  for (const canonical of FRONTEND_ALLOWLIST) {
    const sourcePath = SOURCE_BY_CANONICAL[canonical];
    const absolute = resolve(sourceRoot, sourcePath);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) errors.push(`source entry must be a regular file: ${sourcePath}`);
      else sourceBytes.set(canonical, readFileSync(absolute));
    } catch {
      errors.push(`missing or unreadable source file: ${sourcePath}`);
    }
  }

  const entries = inventory(artifactRoot);
  const layout = layoutFor(entries);
  const allowedActual = new Map(FRONTEND_ALLOWLIST.map((canonical) => [
    canonical,
    layout.name === 'backend' ? canonical.replace(/^dist\//, '') : canonical,
  ]));
  const actualAllowed = new Set(allowedActual.values());
  const allowedDirectories = new Set([layout.uiRoot, `${layout.uiRoot}/src`]);
  const fileByPath = new Map(entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]));
  if (!fileByPath.has(layout.handler)) errors.push(`artifact handler must be a regular file: ${layout.handler}`);

  for (const entry of entries.filter((candidate) => candidate.path === layout.uiRoot || candidate.path.startsWith(`${layout.uiRoot}/`))) {
    if (entry.kind === 'directory' && allowedDirectories.has(entry.path)) continue;
    if (entry.kind !== 'file') errors.push(`deployable UI entry must be a regular file: ${entry.path} (${entry.kind})`);
    else if (!actualAllowed.has(entry.path)) errors.push(`extra frontend artifact: ${entry.path}`);
  }

  for (const canonical of FRONTEND_ALLOWLIST) {
    const actual = allowedActual.get(canonical);
    const entry = fileByPath.get(actual);
    if (!entry) {
      errors.push(`missing artifact file: ${canonical}`);
      continue;
    }
    const expected = sourceBytes.get(canonical);
    if (expected && !entry.bytes.equals(expected)) errors.push(`byte drift: ${canonical}`);
  }

  const allowedHashes = new Map([...sourceBytes.entries()].map(([path, bytes]) => [sha256(bytes), path]));
  for (const entry of entries) {
    if (!isApplicationEntry(entry.path) || actualAllowed.has(entry.path)) continue;
    const relativeToCode = layout.codeRoot && entry.path.startsWith(`${layout.codeRoot}/`)
      ? entry.path.slice(layout.codeRoot.length + 1)
      : entry.path;
    const segments = relativeToCode.split('/');
    const namespaceSegments = (entry.kind === 'directory' ? segments : segments.slice(0, -1)).map((segment) => segment.toLowerCase());
    const forbiddenNamespace = namespaceSegments.find((segment) => FORBIDDEN_UI_ROOTS.has(segment));
    const alternateFrontendNamespace = namespaceSegments.find((segment) => segment.startsWith('frontend'));
    const lower = entry.path.toLowerCase();
    if (entry.kind === 'directory') {
      if (!allowedDirectories.has(entry.path) && forbiddenNamespace) errors.push(`forbidden alternate UI tree: ${entry.path}`);
      if (!allowedDirectories.has(entry.path) && alternateFrontendNamespace) errors.push(`forbidden alternate frontend tree: ${entry.path}`);
      continue;
    }
    if (entry.kind === 'file') {
      if (lower.endsWith('.html')) errors.push(`alternate HTML entrypoint: ${entry.path}`);
      if (forbiddenNamespace) errors.push(`forbidden alternate UI tree: ${entry.path}`);
      if (alternateFrontendNamespace) errors.push(`forbidden alternate frontend tree: ${entry.path}`);
      if (RESERVED_UI_NAMES.has(basename(entry.path).toLowerCase())) errors.push(`duplicate frontend filename: ${entry.path}`);
      const duplicate = allowedHashes.get(sha256(entry.bytes));
      if (duplicate) errors.push(`duplicate frontend content: ${entry.path} duplicates ${duplicate}`);
    } else if (entry.kind === 'symlink' || entry.kind === 'non-file') {
      if (entry.path === layout.uiRoot || entry.path.startsWith(`${layout.uiRoot}/`) || forbiddenNamespace || alternateFrontendNamespace) {
        errors.push(`application UI candidate is not a regular file or directory: ${entry.path} (${entry.kind})`);
      }
    }
  }

  if (errors.length) throw new Error(`Frontend artifact verification failed:\n- ${[...new Set(errors)].sort().join('\n- ')}`);

  const dependencyEntries = entries.filter((entry) => isDependency(entry.path));
  return {
    layout: layout.name,
    files: FRONTEND_ALLOWLIST.map((canonical) => {
      const entry = fileByPath.get(allowedActual.get(canonical));
      return { path: canonical, bytes: entry.bytes.length, sha256: sha256(entry.bytes) };
    }),
    dependencyInventory: {
      entries: dependencyEntries.length,
      files: dependencyEntries.filter((entry) => entry.kind === 'file').length,
      directories: dependencyEntries.filter((entry) => entry.kind === 'directory').length,
      symlinks: dependencyEntries.filter((entry) => entry.kind === 'symlink').length,
      nonFiles: dependencyEntries.filter((entry) => entry.kind === 'non-file').length,
      htmlFiles: dependencyEntries.filter((entry) => entry.kind === 'file' && entry.path.toLowerCase().endsWith('.html')).length,
    },
  };
}

function main() {
  try {
    const roots = parseArguments(process.argv.slice(2));
    const manifest = verifyFrontendArtifact(roots);
    console.log(JSON.stringify({ source: roots.sourceRoot, artifact: roots.artifactRoot, ...manifest }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
