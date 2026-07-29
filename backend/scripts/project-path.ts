import path from 'path';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');

function resolveProjectPath(value: string): string {
  if (path.isAbsolute(value) || value.startsWith('file://') || value.startsWith('s3://')) return value;
  return path.resolve(REPOSITORY_ROOT, value);
}

export { REPOSITORY_ROOT, resolveProjectPath };
