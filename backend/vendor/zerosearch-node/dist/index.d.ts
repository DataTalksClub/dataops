/**
 * zerosearch-node: a tiny, zero-dependency BM25-lite in-memory text search index.
 *
 * A TypeScript/Node port of the Python `zerosearch` library. Documents are plain
 * objects. Text fields are tokenized once when the index is built and kept as an
 * inverted index, so a query only scores the documents that actually contain a
 * query term.
 *
 * Ranking is BM25-lite: each query term contributes
 * `boost * idf * (term_frequency / sqrt(field_length))` per field, where IDF and
 * document frequencies are computed over the filtered candidate set. A term that
 * appears more than once in the query is weighted by its query-term frequency.
 *
 * Cross-language compatibility: `load` reads a native Python `zerosearch.save()`
 * artifact directly (Python `marshal` format), and `save`/`load` also support a
 * portable, language-neutral JSON format (`json-1`, see FORMAT.md). `load`
 * auto-detects which format a file is in.
 */
export declare const VERSION = "0.4.0";
/**
 * Token pattern. A token starts with a letter or digit and may then contain
 * `_ + . # -`, so technical terms such as `c++`, `node.js` and `f-string`
 * survive intact (a leading `.` in `.env` is therefore dropped).
 *
 * Mirrors the Python `re.compile(r"[a-z0-9][a-z0-9_+.#-]*", re.IGNORECASE)`.
 */
export declare const TOKEN_RE: RegExp;
export declare const DEFAULT_STOP_WORDS: ReadonlySet<string>;
export type Doc = Record<string, unknown>;
export type SearchResult = Doc & {
    score: number;
};
export type Tokenizer = (text: string) => string[];
/** A `filter_dict` value: scalar = exact match, array = IN (any of). */
export type FilterValue = unknown | unknown[];
/**
 * Lowercase word/number tokens, dropping 1-char tokens and stop words.
 *
 * The token pattern keeps `+ . # _ -` inside a token so technical terms such as
 * `c++`, `node.js` and `f-string` survive intact (a token must start with a
 * letter or digit, so a leading `.` in `.env` is dropped).
 */
export declare function tokenize(text: string, stopWords?: Iterable<string>): string[];
/** The serialized, language-neutral index state. */
export interface PortableIndex {
    magic: string;
    format: string;
    text_fields: string[];
    keyword_fields: string[];
    stop_words: string[];
    n_fields: number;
    docs: Doc[];
    vocab: string[];
    post_off: number[];
    post_doc: number[];
    post_field: number[];
    post_tf: number[];
    doc_freq: number[];
    lengths: number[];
    keyword_index: Record<string, Record<string, number[]>>;
}
export interface LoadOptions {
    /** Pass the same tokenizer the index was built with, if it was custom. */
    tokenizer?: Tokenizer;
}
/**
 * In-memory search over a fixed list of documents.
 */
export declare class Index {
    readonly textFields: string[];
    readonly keywordFields: string[];
    private readonly stopWords;
    private readonly tokenizeFn;
    docs: Doc[];
    private nFields;
    private vocab;
    private termToId;
    private postOff;
    private postDoc;
    private postField;
    private postTf;
    private docFreq;
    private lengths;
    private keywordIndex;
    constructor(textFields: string[], keywordFields?: string[] | null, options?: {
        stopWords?: Iterable<string>;
        tokenizer?: Tokenizer;
    });
    /** Build the inverted index from `docs`. Returns `this`. */
    fit(docs: Doc[]): this;
    /** Compact the build scaffolding into the flat runtime arrays. */
    private pack;
    /**
     * Return up to `numResults` docs (copies, with a `score` key).
     *
     * A `filterDict` value may be a scalar (exact match) or an array (match any
     * of the values, i.e. IN). Different fields combine with AND.
     */
    search(query: string, filterDict?: Record<string, FilterValue> | null, boostDict?: Record<string, number> | null, numResults?: number): SearchResult[];
    private accumulateScores;
    /**
     * Intersect keyword indexes for each filter. `null` means "all docs".
     *
     * A scalar filter value matches that value exactly. An array value matches
     * any of the listed values (IN / OR within the field). Filters on different
     * fields are combined with AND.
     */
    private candidateIds;
    /** Serialize the packed index to the portable JSON state object. */
    toJSON(): PortableIndex;
    /** Serialize the packed index to a JSON string. */
    dumps(): string;
    /** Write the packed index to `path` as portable JSON. */
    save(path: string): void;
    /** Build an Index from already-decoded packed state (no format checks). */
    private static reconstruct;
    /** Reconstruct an index from a portable `json-1` state object. */
    static fromJSON(state: PortableIndex, options?: LoadOptions): Index;
    /** Reconstruct an index from `dumps()` JSON string (the `json-1` format). */
    static loads(data: string, options?: LoadOptions): Index;
    /**
     * Reconstruct an index from a native Python `zerosearch.save()` artifact
     * (Python `marshal` bytes). Assumes a little-endian build with the array
     * item sizes the Python library records (validated below).
     */
    static loadsMarshal(bytes: Uint8Array, options?: LoadOptions): Index;
    /** Load an index file, auto-detecting `json-1` JSON vs native marshal. */
    static load(path: string, options?: LoadOptions): Index;
    /** Load from raw bytes, auto-detecting `json-1` JSON vs native marshal. */
    static loadBytes(bytes: Uint8Array, options?: LoadOptions): Index;
}
