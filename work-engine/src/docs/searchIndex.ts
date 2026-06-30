/**
 * Docs search index seam.
 *
 * Defines the `SearchIndex` interface (build/fit, query, save/load) and the
 * docs field configuration ported as data from
 * `lambda-functions/src/lambda_functions/docs_index.py`.
 *
 * Implemented (issue #85) on top of `zerosearch-node` (BM25-lite, portable
 * `json-1` index format compatible with the Python `zerosearch`). Per
 * `_docs/TARGET_ARCHITECTURE.md` the field config below carries over unchanged
 * from `minsearch`; ranking shifts from TF-IDF (minsearch) to BM25-lite, with
 * recall on par and ordering allowed to differ.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { Index } from 'zerosearch-node';

// ── Field configuration (ported from docs_index.py) ───────────────────────────

/**
 * Free-text fields indexed for docs search, in the same order as the Python
 * `TEXT_FIELDS`. `title`/`summary`/`description`/`purpose`/`headings`/`body`
 * carry boosts (see {@link DOCS_BOOSTS}); `tags`/`systems` are unboosted.
 */
export const DOCS_TEXT_FIELDS = [
  'title',
  'summary',
  'description',
  'purpose',
  'headings',
  'body',
  'tags',
  'systems',
] as const;

/** Keyword (exact-match filter) fields, matching the Python `KEYWORD_FIELDS`. */
export const DOCS_KEYWORD_FIELDS = ['path', 'id', 'domain', 'doc_type'] as const;

/** Per-field boosts, matching the Python `BOOSTS`. Unlisted fields default to 1. */
export const DOCS_BOOSTS: Readonly<Record<string, number>> = {
  title: 4.0,
  summary: 3.0,
  description: 3.0,
  purpose: 3.0,
  headings: 2.0,
  body: 1.0,
};

export type DocsTextField = (typeof DOCS_TEXT_FIELDS)[number];
export type DocsKeywordField = (typeof DOCS_KEYWORD_FIELDS)[number];

/** Config used to construct a {@link SearchIndex}. */
export interface SearchIndexConfig {
  /** Free-text fields to index. */
  textFields: readonly string[];
  /** Exact-match keyword fields used for filtering. */
  keywordFields: readonly string[];
  /** Per-field boosts; fields absent here default to a boost of 1. */
  boosts: Readonly<Record<string, number>>;
}

/** The docs-domain search configuration ported from `docs_index.py`. */
export const DOCS_SEARCH_CONFIG: SearchIndexConfig = {
  textFields: DOCS_TEXT_FIELDS,
  keywordFields: DOCS_KEYWORD_FIELDS,
  boosts: DOCS_BOOSTS,
};

// ── Index interface ───────────────────────────────────────────────────────────

/** A document fed into the index. Field values are stringly-typed text. */
export type SearchDocument = Record<string, string | undefined>;

/** A single search hit: the stored document plus an optional relevance score. */
export type SearchResult = SearchDocument & { _score?: number };

/** Options for {@link SearchIndex.search}, mirroring `zerosearch`'s `.search`. */
export interface SearchQueryOptions {
  /** Exact-match keyword filters (`filter_dict`), e.g. `{ doc_type: 'sop' }`. */
  filter?: Record<string, string>;
  /** Per-field boost overrides (`boost_dict`) applied on top of config boosts. */
  boost?: Record<string, number>;
  /** Maximum number of results (`num_results`). */
  numResults?: number;
}

/**
 * Search index over docs content.
 *
 * Mirrors the `zerosearch`/`zerosearch-node` `Index` API: build with `fit`,
 * query with `search`, and persist with `save`/`load` over the portable
 * cross-language `state` format.
 */
export interface SearchIndex {
  /** Build (fit) the index from documents. Returns `this` for chaining. */
  fit(docs: SearchDocument[]): SearchIndex;

  /** Query the index; returns ranked results. */
  search(query: string, options?: SearchQueryOptions): SearchResult[];

  /** Serialize the index to the portable format at `path`. */
  save(path: string): Promise<void>;

  /** Replace this index's state from a saved portable index at `path`. */
  load(path: string): Promise<SearchIndex>;
}

// ── zerosearch-node implementation ────────────────────────────────────────────

/** Default result count, matching the Python search handler's `DEFAULT_LIMIT`. */
const DEFAULT_NUM_RESULTS = 10;

/**
 * Docs search index backed by `zerosearch-node`.
 *
 * Wraps a `zerosearch-node` {@link Index} configured with this domain's text
 * fields, keyword fields, and boosts. `fit` builds the inverted index; `search`
 * applies keyword filters and per-field boosts (config boosts overlaid by
 * per-query overrides); `save`/`load` use the portable `json-1` format that the
 * Python `zerosearch` library also reads.
 */
export class ZeroSearchIndex implements SearchIndex {
  private readonly config: SearchIndexConfig;
  private inner: Index | null;

  constructor(config: SearchIndexConfig = DOCS_SEARCH_CONFIG, inner: Index | null = null) {
    this.config = config;
    this.inner = inner;
  }

  fit(docs: SearchDocument[]): SearchIndex {
    const index = new Index([...this.config.textFields], [...this.config.keywordFields]);
    index.fit(docs as Record<string, unknown>[]);
    this.inner = index;
    return this;
  }

  search(query: string, options: SearchQueryOptions = {}): SearchResult[] {
    if (this.inner === null) {
      throw new Error('SearchIndex.search called before fit/load');
    }
    // Config boosts are the baseline; a per-query `boost` overrides per field.
    const boosts: Record<string, number> = { ...this.config.boosts, ...(options.boost ?? {}) };
    const numResults = options.numResults ?? DEFAULT_NUM_RESULTS;
    const matches = this.inner.search(query, options.filter ?? null, boosts, numResults);
    return matches.map(({ score, ...rest }) => ({ ...rest, _score: score }) as SearchResult);
  }

  async save(path: string): Promise<void> {
    if (this.inner === null) {
      throw new Error('SearchIndex.save called before fit/load');
    }
    await writeFile(path, this.inner.dumps());
  }

  async load(path: string): Promise<SearchIndex> {
    const bytes = await readFile(path);
    this.inner = Index.loadBytes(bytes);
    return this;
  }
}

/** Construct an empty docs search index backed by `zerosearch-node`. */
export function createSearchIndex(config: SearchIndexConfig = DOCS_SEARCH_CONFIG): SearchIndex {
  return new ZeroSearchIndex(config);
}

/** Load a docs search index from a saved portable (`json-1`) index file. */
export async function loadSearchIndex(
  path: string,
  config: SearchIndexConfig = DOCS_SEARCH_CONFIG,
): Promise<SearchIndex> {
  return new ZeroSearchIndex(config).load(path);
}
