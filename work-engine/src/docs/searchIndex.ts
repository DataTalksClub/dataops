/**
 * Docs search index seam.
 *
 * Defines the `SearchIndex` interface (build/fit, query, save/load) and the
 * docs field configuration ported as data from
 * `lambda-functions/src/lambda_functions/docs_index.py`.
 *
 * The stub implementation throws {@link NotImplementedError}. Issue #85 will
 * implement this on top of `zerosearch-node` (BM25-lite, portable index format
 * compatible with the Python `zerosearch`). Per `_docs/TARGET_ARCHITECTURE.md`
 * the field config below carries over unchanged from `minsearch`.
 */

import { NotImplementedError } from './errors';

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

// ── Stub implementation (issue #85 implements on zerosearch-node) ──────────────

const UNIMPLEMENTED_ISSUE = '#85';

/**
 * Placeholder search index. Every method throws {@link NotImplementedError}
 * until issue #85 swaps in `zerosearch-node`.
 */
export class ZeroSearchIndex implements SearchIndex {
  constructor(_config: SearchIndexConfig = DOCS_SEARCH_CONFIG) {
    // Config is retained by the real implementation; the stub does nothing.
  }

  fit(_docs: SearchDocument[]): SearchIndex {
    throw new NotImplementedError('SearchIndex.fit', UNIMPLEMENTED_ISSUE);
  }

  search(_query: string, _options?: SearchQueryOptions): SearchResult[] {
    throw new NotImplementedError('SearchIndex.search', UNIMPLEMENTED_ISSUE);
  }

  save(_path: string): Promise<void> {
    throw new NotImplementedError('SearchIndex.save', UNIMPLEMENTED_ISSUE);
  }

  load(_path: string): Promise<SearchIndex> {
    throw new NotImplementedError('SearchIndex.load', UNIMPLEMENTED_ISSUE);
  }
}

/** Construct an empty docs search index. Stub until issue #85. */
export function createSearchIndex(config: SearchIndexConfig = DOCS_SEARCH_CONFIG): SearchIndex {
  return new ZeroSearchIndex(config);
}

/** Load a docs search index from a saved portable index file. Stub until #85. */
export function loadSearchIndex(_path: string): Promise<SearchIndex> {
  throw new NotImplementedError('loadSearchIndex', UNIMPLEMENTED_ISSUE);
}
