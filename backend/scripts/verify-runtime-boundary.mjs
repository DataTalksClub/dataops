import fs from 'node:fs';
import path from 'node:path';

const artifact = path.resolve(process.argv[2] || 'dist');
const bundleManifestPath = path.join(artifact, '.dataops-sam-bundle.json');
const forbiddenFiles = [path.join(artifact, 'db', 'setup.js')];
const forbiddenCode = [
  ['CreateTableCommand', 'DynamoDB table creation'],
  ['DeleteTableCommand', 'DynamoDB table deletion'],
  ['dynalite', 'embedded dynalite runtime'],
];

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

const failures = [];
let bundledOutputs = new Set();
if (fs.existsSync(bundleManifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.format !== 'dataops-sam-esbuild') {
      failures.push('invalid SAM esbuild manifest');
    } else {
      bundledOutputs = new Set(manifest.bundledOutputs || []);
      const inputs = new Set(manifest.inputs || []);
      for (const forbiddenInput of ['backend/src/db/setup.ts', 'backend/scripts/local-dynamodb.ts']) {
        if (inputs.has(forbiddenInput)) failures.push(`removed runtime module is bundled: ${forbiddenInput}`);
      }
      for (const input of inputs) {
        if (input === 'dynalite' || input.includes('/dynalite/')) {
          failures.push(`embedded dynalite runtime is bundled from ${input}`);
        }
      }
    }
  } catch {
    failures.push('unreadable SAM esbuild manifest');
  }
}
for (const file of forbiddenFiles) {
  if (fs.existsSync(file)) failures.push(`removed runtime module is present: ${path.relative(artifact, file)}`);
}
for (const file of javascriptFiles(artifact)) {
  if (bundledOutputs.has(path.relative(artifact, file).split(path.sep).join('/'))) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const [token, description] of forbiddenCode) {
    if (source.includes(token)) failures.push(`${description} is present in ${path.relative(artifact, file)}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Runtime infrastructure boundary failed:\n- ${failures.join('\n- ')}`);
}

console.log(`Runtime infrastructure boundary verified in ${artifact}.`);
