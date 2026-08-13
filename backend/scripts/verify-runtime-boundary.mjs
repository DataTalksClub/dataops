import fs from 'node:fs';
import path from 'node:path';

const artifact = path.resolve(process.argv[2] || 'dist');
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
for (const file of forbiddenFiles) {
  if (fs.existsSync(file)) failures.push(`removed runtime module is present: ${path.relative(artifact, file)}`);
}
for (const file of javascriptFiles(artifact)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [token, description] of forbiddenCode) {
    if (source.includes(token)) failures.push(`${description} is present in ${path.relative(artifact, file)}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Runtime infrastructure boundary failed:\n- ${failures.join('\n- ')}`);
}

console.log(`Runtime infrastructure boundary verified in ${artifact}.`);
