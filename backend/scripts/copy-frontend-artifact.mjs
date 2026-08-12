import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { readFrontendAssetManifest, resolveManifestFile } from './frontend-assets.mjs';

function usage(message) {
  throw new Error(`${message}\nUsage: node backend/scripts/copy-frontend-artifact.mjs --source <frontend-root> --artifact <artifact-root>`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--source' && option !== '--artifact') usage(`Unknown argument: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${option}`);
    values[option] = value;
    index += 1;
  }
  if (!values['--source'] || !values['--artifact']) usage('Source and artifact arguments are required');
  return { sourceRoot: resolve(values['--source']), artifactRoot: resolve(values['--artifact']) };
}

export function copyFrontendArtifact({ sourceRoot, artifactRoot }) {
  const manifest = readFrontendAssetManifest();
  const destinationRoot = resolve(artifactRoot, 'frontend');
  const sources = manifest.files.map((relativePath) => ({
    relativePath,
    source: resolveManifestFile(sourceRoot, relativePath, 'Frontend source entry'),
  }));
  rmSync(destinationRoot, { recursive: true, force: true });
  for (const { relativePath, source } of sources) {
    const destination = resolve(destinationRoot, ...relativePath.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return manifest.files;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const files = copyFrontendArtifact(parseArguments(process.argv.slice(2)));
    console.log(`Copied ${files.length} canonical frontend assets.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
