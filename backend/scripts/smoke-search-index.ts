import { createSearchIndex } from "../src/docs/searchIndex";

async function main() {
  // tsx passes args after --; find the index path (last non-flag arg)
  const indexPath = process.argv[process.argv.length - 1];
  if (!indexPath || indexPath.endsWith(".ts")) {
    console.error("Usage: tsx scripts/smoke-search-index.ts <index-path>");
    process.exit(1);
  }
  const idx = createSearchIndex();
  await idx.load(indexPath);
  const results = idx.search("invoice", { numResults: 1 });
  if (!results.length) {
    console.error("No search results for invoice");
    process.exit(1);
  }
  const first = results[0];
  if (!first.id || !first.path || !first.title) {
    console.error("Bad result shape", first);
    process.exit(1);
  }
  console.log("Search smoke OK:", first.title);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
