import manifest from './frontend-assets.json';

const ALLOWED_EXTENSIONS = new Set(['.css', '.html', '.js']);
const REQUIRED_FILES = ['index.html', 'src/app.js', 'src/styles.css'];

function extensionOf(path: string): string {
  const filename = path.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function validFrontendPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (path !== 'index.html' && !path.startsWith('src/')) return false;
  return ALLOWED_EXTENSIONS.has(extensionOf(path));
}

function deployedFrontendFiles(): readonly string[] {
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Invalid canonical frontend asset manifest');
  }
  const files = manifest.files.map(String);
  if (files.some((path) => !validFrontendPath(path))) {
    throw new Error('Invalid canonical frontend asset path');
  }
  if (new Set(files).size !== files.length) {
    throw new Error('Duplicate canonical frontend asset path');
  }
  if (REQUIRED_FILES.some((path) => !files.includes(path))) {
    throw new Error('Canonical frontend asset manifest is incomplete');
  }
  return Object.freeze(files);
}

export const DEPLOYED_FRONTEND_FILE_LIST = deployedFrontendFiles();
export const DEPLOYED_FRONTEND_FILES = new Set(DEPLOYED_FRONTEND_FILE_LIST);
