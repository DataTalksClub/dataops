/**
 * Build the docs search index over `content/` using `zerosearch-node`.
 *
 * Node replacement for the Python `python -m lambda_functions.build_search_index`
 * (`build_search_index.py` + `docs_index.py`). Walks the markdown tree, extracts
 * the same text/keyword fields, fits a `zerosearch-node` index, and writes the
 * portable `json-1` artifact.
 *
 * Usage:
 *   npm --prefix work-engine run build:search-index            # defaults
 *   npm --prefix work-engine run build:search-index -- \
 *       --content-dir /abs/content --output /abs/docs.index
 *
 * The default output goes to `work-engine/.tmp/search/docs.index` (gitignored).
 * The deployed/runtime index location is finalized by the content port (#87);
 * this builder is the documented refresh command in the meantime.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createSearchIndex } from '../src/docs/searchIndex';
import { iterContentDocs } from '../src/docs/search/extract';

const repoRoot = resolve(__dirname, '..', '..');
const DEFAULT_CONTENT_DIR = resolve(repoRoot, 'content');
const DEFAULT_OUTPUT = resolve(repoRoot, 'work-engine', '.tmp', 'search', 'docs.index');

interface Args {
  contentDir: string;
  output: string;
}

function parseArgs(argv: string[]): Args {
  let contentDir = DEFAULT_CONTENT_DIR;
  let output = DEFAULT_OUTPUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--content-dir') contentDir = resolve(argv[++i]);
    else if (arg === '--output') output = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { contentDir, output };
}

async function main(): Promise<void> {
  const { contentDir, output } = parseArgs(process.argv.slice(2));

  // TODO(#86): pass a `structuredText` extractor that routes schema_version: 1
  // SOPs through `sopEngine.parse()`; until #87 wires it, index the raw body.
  const docs = iterContentDocs(contentDir);

  mkdirSync(dirname(output), { recursive: true });
  const index = createSearchIndex();
  index.fit(docs);
  await index.save(output);

  console.log(`Indexed ${docs.length} documents into ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
