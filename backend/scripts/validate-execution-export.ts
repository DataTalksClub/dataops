import { validatePortableExport } from '../src/export/portable';

async function main(): Promise<void> {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error('Usage: npm run validate:export -- <export-dir>');
    process.exit(2);
  }

  const result = await validatePortableExport(exportDir);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
