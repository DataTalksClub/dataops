import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const artifactRoot = resolve(process.argv[2] || 'dist');
const required = [
  'frontend/index.html',
  'frontend/src/app.js',
  'frontend/src/styles.css',
];
const forbidden = ['pages/index.html', 'public/app.js', 'public/api.js'];
const errors = [];

for (const relative of required) {
  if (!existsSync(resolve(artifactRoot, relative))) errors.push(`missing ${relative}`);
}
for (const relative of forbidden) {
  if (existsSync(resolve(artifactRoot, relative))) errors.push(`retired frontend asset present: ${relative}`);
}

const appPath = resolve(artifactRoot, 'frontend/src/app.js');
if (existsSync(appPath)) {
  const app = readFileSync(appPath, 'utf8');
  for (const marker of ['renderInboxSurface', 'renderAssistantJobDetail', 'renderRuntimeTemplateAdmin', 'parseWorkspaceHash']) {
    if (!app.includes(marker)) errors.push(`canonical app is missing ${marker}`);
  }
}

if (errors.length) {
  console.error(`Frontend artifact verification failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log(`Verified canonical frontend artifact at ${artifactRoot}`);
