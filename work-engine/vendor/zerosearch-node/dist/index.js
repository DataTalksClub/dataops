"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Index = exports.DEFAULT_STOP_WORDS = exports.TOKEN_RE = exports.VERSION = void 0;
exports.tokenize = tokenize;
const node_fs_1 = require("node:fs");
const marshal_js_1 = require("./marshal.js");
exports.VERSION = "0.4.0";
/**
 * Token pattern. A token starts with a letter or digit and may then contain
 * `_ + . # -`, so technical terms such as `c++`, `node.js` and `f-string`
 * survive intact (a leading `.` in `.env` is therefore dropped).
 *
 * Mirrors the Python `re.compile(r"[a-z0-9][a-z0-9_+.#-]*", re.IGNORECASE)`.
 */
exports.TOKEN_RE = /[a-z0-9][a-z0-9_+.#-]*/gi;
exports.DEFAULT_STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from",
    "how", "i", "in", "is", "it", "of", "on", "or", "the", "to", "with",
]);
/**
 * Lowercase word/number tokens, dropping 1-char tokens and stop words.
 *
 * The token pattern keeps `+ . # _ -` inside a token so technical terms such as
 * `c++`, `node.js` and `f-string` survive intact (a token must start with a
 * letter or digit, so a leading `.` in `.env` is dropped).
 */
function tokenize(text, stopWords = exports.DEFAULT_STOP_WORDS) {
    const stops = stopWords instanceof Set ? stopWords : new Set(stopWords);
    const out = [];
    // matchAll requires the global flag (TOKEN_RE has it) and is non-mutating.
    for (const match of text.matchAll(exports.TOKEN_RE)) {
        const token = match[0].toLowerCase();
        if (token.length > 1 && !stops.has(token))
            out.push(token);
    }
    return out;
}
/** Coerce a field value the way Python's `str(doc.get(field, ""))` does. */
function fieldToString(value) {
    return String(value ?? "");
}
/** Count occurrences of each token (Python `Counter`). */
function countTokens(tokens) {
    const counts = new Map();
    for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
}
const MAGIC = "zerosearch";
/** Portable JSON on-disk format tag (see FORMAT.md). */
const JSON_FORMAT = "json-1";
const MAX_TEXT_FIELDS = 256;
/**
 * In-memory search over a fixed list of documents.
 */
class Index {
    textFields;
    keywordFields;
    stopWords;
    tokenizeFn;
    docs = [];
    // Packed runtime state (populated by `fit` or `load`).
    nFields;
    vocab = [];
    termToId = new Map();
    postOff = [0]; // term id -> [start, end) into the postings
    postDoc = [];
    postField = [];
    postTf = [];
    docFreq = [];
    lengths = []; // flat doc_id * n_fields + field_index -> field length
    keywordIndex = new Map();
    constructor(textFields, keywordFields = null, options = {}) {
        this.textFields = [...textFields];
        this.keywordFields = [...(keywordFields ?? [])];
        this.stopWords = new Set(options.stopWords ?? exports.DEFAULT_STOP_WORDS);
        this.tokenizeFn =
            options.tokenizer ?? ((text) => tokenize(text, this.stopWords));
        this.nFields = this.textFields.length;
    }
    // -- building -----------------------------------------------------------
    /** Build the inverted index from `docs`. Returns `this`. */
    fit(docs) {
        if (this.textFields.length > MAX_TEXT_FIELDS) {
            throw new Error(`at most ${MAX_TEXT_FIELDS} text fields are supported`);
        }
        this.docs = [...docs]; // copy the list, keep the same doc references
        const nDocs = this.docs.length;
        const nFields = this.textFields.length;
        this.nFields = nFields;
        // Scaffolding: term -> list of [doc_id, field_index, term_frequency].
        const postings = new Map();
        const lengths = new Array(nDocs * nFields).fill(0);
        const keywordIndex = new Map();
        for (const field of this.keywordFields)
            keywordIndex.set(field, new Map());
        for (let docId = 0; docId < nDocs; docId++) {
            const doc = this.docs[docId];
            const base = docId * nFields;
            for (let fieldIndex = 0; fieldIndex < nFields; fieldIndex++) {
                const field = this.textFields[fieldIndex];
                const counts = countTokens(this.tokenizeFn(fieldToString(doc[field])));
                let fieldLength = 0;
                for (const tf of counts.values())
                    fieldLength += tf;
                lengths[base + fieldIndex] = fieldLength;
                for (const [term, termFrequency] of counts) {
                    let bucket = postings.get(term);
                    if (bucket === undefined) {
                        bucket = [];
                        postings.set(term, bucket);
                    }
                    bucket.push([docId, fieldIndex, termFrequency]);
                }
            }
            for (const field of this.keywordFields) {
                const value = fieldToString(doc[field]);
                const byValue = keywordIndex.get(field);
                let ids = byValue.get(value);
                if (ids === undefined) {
                    ids = new Set();
                    byValue.set(value, ids);
                }
                ids.add(docId);
            }
        }
        this.pack(postings, lengths, keywordIndex);
        return this;
    }
    /** Compact the build scaffolding into the flat runtime arrays. */
    pack(postings, lengths, keywordIndex) {
        const vocab = [...postings.keys()].sort(); // sorted; a term's id is its position
        const postOff = [];
        const postDoc = [];
        const postField = [];
        const postTf = [];
        const docFreq = [];
        let offset = 0;
        for (const term of vocab) {
            postOff.push(offset);
            // Sorted by (doc, field, tf) so tied scores fall back to document order.
            const entries = postings.get(term).slice().sort(comparePostings);
            let lastDocId = -1;
            let termDocumentFrequency = 0;
            for (const [docId, fieldIndex, termFrequency] of entries) {
                if (docId !== lastDocId) {
                    termDocumentFrequency += 1;
                    lastDocId = docId;
                }
                postDoc.push(docId);
                postField.push(fieldIndex);
                postTf.push(termFrequency);
                offset += 1;
            }
            docFreq.push(termDocumentFrequency);
        }
        postOff.push(offset);
        this.vocab = vocab;
        this.termToId = new Map(vocab.map((term, id) => [term, id]));
        this.postOff = postOff;
        this.postDoc = postDoc;
        this.postField = postField;
        this.postTf = postTf;
        this.docFreq = docFreq;
        this.lengths = lengths;
        this.keywordIndex = keywordIndex;
    }
    // -- querying -----------------------------------------------------------
    /**
     * Return up to `numResults` docs (copies, with a `score` key).
     *
     * A `filterDict` value may be a scalar (exact match) or an array (match any
     * of the values, i.e. IN). Different fields combine with AND.
     */
    search(query, filterDict = null, boostDict = null, numResults = 10) {
        if (numResults <= 0)
            return [];
        const queryTermFrequencies = countTokens(this.tokenizeFn(query));
        if (queryTermFrequencies.size === 0)
            return [];
        const filters = filterDict ?? {};
        const boosts = boostDict ?? {};
        const candidates = this.candidateIds(filters);
        if (candidates !== null && candidates.size === 0)
            return [];
        const documentCount = candidates === null ? this.docs.length : candidates.size;
        // Locate each distinct query term's posting slice in the sorted vocab.
        const located = [];
        for (const term of queryTermFrequencies.keys()) {
            const termId = this.termToId.get(term);
            if (termId === undefined)
                continue;
            const start = this.postOff[termId];
            const end = this.postOff[termId + 1];
            if (end > start)
                located.push({ termId, term, start, end });
        }
        if (located.length === 0)
            return [];
        // Document frequency = distinct candidate docs containing the term.
        const documentFrequencies = new Map();
        if (candidates === null) {
            for (const { termId } of located) {
                const df = this.docFreq[termId];
                if (df)
                    documentFrequencies.set(termId, df);
            }
        }
        else {
            for (const { termId, start, end } of located) {
                let df = 0;
                let lastCounted = -1;
                for (let j = start; j < end; j++) {
                    const docId = this.postDoc[j];
                    if (docId !== lastCounted && candidates.has(docId)) {
                        df += 1;
                        lastCounted = docId;
                    }
                }
                if (df)
                    documentFrequencies.set(termId, df);
            }
        }
        if (documentFrequencies.size === 0)
            return [];
        const idf = new Map();
        for (const [termId, df] of documentFrequencies) {
            idf.set(termId, Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)));
        }
        const scores = this.accumulateScores(located, idf, queryTermFrequencies, candidates, boosts);
        if (scores.size === 0)
            return [];
        // Rank by (score desc, doc_id asc); take the top numResults.
        const ranked = [...scores.keys()].sort((a, b) => {
            const diff = scores.get(b) - scores.get(a);
            return diff !== 0 ? diff : a - b;
        });
        const topIds = ranked.slice(0, numResults);
        return topIds.map((docId) => ({
            ...this.docs[docId],
            score: scores.get(docId),
        }));
    }
    accumulateScores(located, idf, queryTermFrequencies, candidates, boosts) {
        const scores = new Map();
        const nFields = this.nFields;
        const textFields = this.textFields;
        const postDoc = this.postDoc;
        const postField = this.postField;
        const postTf = this.postTf;
        const lengths = this.lengths;
        for (const { termId, term, start, end } of located) {
            const termIdf = idf.get(termId);
            if (termIdf === undefined)
                continue;
            const weight = termIdf * queryTermFrequencies.get(term);
            for (let j = start; j < end; j++) {
                const docId = postDoc[j];
                if (candidates !== null && !candidates.has(docId))
                    continue;
                const fieldIndex = postField[j];
                const fieldLength = lengths[docId * nFields + fieldIndex];
                if (!fieldLength)
                    continue; // guards corrupt loads; postings imply length>0
                const boostRaw = boosts[textFields[fieldIndex]];
                const boost = boostRaw === undefined ? 1.0 : Number(boostRaw);
                const contribution = boost * weight * (postTf[j] / Math.sqrt(fieldLength));
                scores.set(docId, (scores.get(docId) ?? 0) + contribution);
            }
        }
        return scores;
    }
    /**
     * Intersect keyword indexes for each filter. `null` means "all docs".
     *
     * A scalar filter value matches that value exactly. An array value matches
     * any of the listed values (IN / OR within the field). Filters on different
     * fields are combined with AND.
     */
    candidateIds(filterDict) {
        const fields = Object.keys(filterDict);
        if (fields.length === 0)
            return null;
        let candidates = null;
        for (const field of fields) {
            const value = filterDict[field];
            const byValue = this.keywordIndex.get(field) ?? new Map();
            const matched = new Set();
            if (Array.isArray(value)) {
                for (const item of value) {
                    const ids = byValue.get(fieldToString(item));
                    if (ids)
                        for (const id of ids)
                            matched.add(id);
                }
            }
            else {
                const ids = byValue.get(fieldToString(value));
                if (ids)
                    for (const id of ids)
                        matched.add(id);
            }
            if (candidates === null) {
                candidates = matched;
            }
            else {
                const next = new Set();
                for (const id of candidates)
                    if (matched.has(id))
                        next.add(id);
                candidates = next;
            }
            if (candidates.size === 0)
                return new Set();
        }
        return candidates;
    }
    // -- serialization ------------------------------------------------------
    /** Serialize the packed index to the portable JSON state object. */
    toJSON() {
        const keywordIndex = {};
        for (const [field, byValue] of this.keywordIndex) {
            const out = {};
            for (const [value, ids] of byValue) {
                out[value] = [...ids].sort((a, b) => a - b);
            }
            keywordIndex[field] = out;
        }
        return {
            magic: MAGIC,
            format: JSON_FORMAT,
            text_fields: this.textFields,
            keyword_fields: this.keywordFields,
            stop_words: [...this.stopWords].sort(),
            n_fields: this.nFields,
            docs: this.docs,
            vocab: this.vocab,
            post_off: this.postOff,
            post_doc: this.postDoc,
            post_field: this.postField,
            post_tf: this.postTf,
            doc_freq: this.docFreq,
            lengths: this.lengths,
            keyword_index: keywordIndex,
        };
    }
    /** Serialize the packed index to a JSON string. */
    dumps() {
        return JSON.stringify(this.toJSON());
    }
    /** Write the packed index to `path` as portable JSON. */
    save(path) {
        (0, node_fs_1.writeFileSync)(path, this.dumps());
    }
    /** Build an Index from already-decoded packed state (no format checks). */
    static reconstruct(state, options) {
        const index = new Index(state.text_fields, state.keyword_fields, {
            stopWords: state.stop_words,
            tokenizer: options.tokenizer,
        });
        index.docs = state.docs;
        index.nFields = state.n_fields;
        index.vocab = state.vocab;
        index.termToId = new Map(state.vocab.map((term, id) => [term, id]));
        index.postOff = state.post_off;
        index.postDoc = state.post_doc;
        index.postField = state.post_field;
        index.postTf = state.post_tf;
        index.docFreq = state.doc_freq;
        index.lengths = state.lengths;
        const keywordIndex = new Map();
        for (const [field, byValue] of Object.entries(state.keyword_index)) {
            const inner = new Map();
            for (const [value, ids] of Object.entries(byValue)) {
                inner.set(value, new Set(ids));
            }
            keywordIndex.set(field, inner);
        }
        index.keywordIndex = keywordIndex;
        return index;
    }
    /** Reconstruct an index from a portable `json-1` state object. */
    static fromJSON(state, options = {}) {
        if (state == null || state.magic !== MAGIC) {
            throw new Error("not a zerosearch index");
        }
        if (state.format !== JSON_FORMAT) {
            throw new Error(`unsupported zerosearch index format ${JSON.stringify(state.format)} ` +
                `(this build expects ${JSON.stringify(JSON_FORMAT)})`);
        }
        return Index.reconstruct(state, options);
    }
    /** Reconstruct an index from `dumps()` JSON string (the `json-1` format). */
    static loads(data, options = {}) {
        return Index.fromJSON(JSON.parse(data), options);
    }
    /**
     * Reconstruct an index from a native Python `zerosearch.save()` artifact
     * (Python `marshal` bytes). Assumes a little-endian build with the array
     * item sizes the Python library records (validated below).
     */
    static loadsMarshal(bytes, options = {}) {
        const state = (0, marshal_js_1.readMarshal)(bytes);
        return Index.reconstruct(marshalToPortable(state), options);
    }
    /** Load an index file, auto-detecting `json-1` JSON vs native marshal. */
    static load(path, options = {}) {
        return Index.loadBytes((0, node_fs_1.readFileSync)(path), options);
    }
    /** Load from raw bytes, auto-detecting `json-1` JSON vs native marshal. */
    static loadBytes(bytes, options = {}) {
        if (looksLikeJson(bytes)) {
            return Index.loads(Buffer.from(bytes).toString("utf8"), options);
        }
        return Index.loadsMarshal(bytes, options);
    }
}
exports.Index = Index;
/** Lexicographic compare of [docId, fieldIndex, tf] tuples (Python `sorted`). */
function comparePostings(a, b) {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
// -- native Python marshal interop ----------------------------------------
/** The Python `_FORMAT_VERSION` of artifacts we can read natively. */
const MARSHAL_FORMAT_VERSION = 2;
/**
 * Expected array item sizes, in the order the Python library records them:
 * (_OFFSET_TC, _DOC_TC, _TF_TC, _FIELD_TC, _LENGTH_TC) = (I, I, I, B, I).
 * We only support this little-endian, 32-bit layout (our index is rebuilt at
 * deploy on Linux), so a different platform's artifact fails clearly.
 */
const EXPECTED_ITEMSIZES = [4, 4, 4, 1, 4];
/** Does this buffer look like our UTF-8 `json-1` text (vs binary marshal)? */
function looksLikeJson(bytes) {
    let i = 0;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
        i++;
    }
    if (bytes[i] !== 0x7b)
        return false; // both JSON and marshal start with '{'
    // In json-1 the next non-space byte is a quote (the "magic" key). A marshal
    // dict instead has a type byte (e.g. 0xda for a short interned+ref string).
    let j = i + 1;
    while (j < bytes.length && (bytes[j] === 0x20 || bytes[j] === 0x09 || bytes[j] === 0x0a || bytes[j] === 0x0d)) {
        j++;
    }
    return bytes[j] === 0x22; // '"'
}
/** Decode a little-endian byte blob of `itemSize`-byte unsigned ints. */
function decodeUintArray(blob, itemSize) {
    if (!(blob instanceof Uint8Array)) {
        throw new Error("marshal: expected bytes for a packed posting array");
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const count = Math.floor(blob.byteLength / itemSize);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        const offset = i * itemSize;
        out[i] =
            itemSize === 1
                ? view.getUint8(offset)
                : itemSize === 2
                    ? view.getUint16(offset, true)
                    : view.getUint32(offset, true);
    }
    return out;
}
function asStringArray(value, label) {
    if (!Array.isArray(value))
        throw new Error(`marshal: ${label} is not a list`);
    return value.map((v) => String(v));
}
/** Map a decoded Python marshal index dict into the portable `json-1` shape. */
function marshalToPortable(state) {
    if (state === null || typeof state !== "object" || Array.isArray(state) || state instanceof Uint8Array) {
        throw new Error("not a zerosearch index");
    }
    const dict = state;
    if (dict.magic !== MAGIC)
        throw new Error("not a zerosearch index");
    if (dict.format !== MARSHAL_FORMAT_VERSION) {
        throw new Error(`unsupported zerosearch marshal format ${JSON.stringify(dict.format)} ` +
            `(this build expects ${MARSHAL_FORMAT_VERSION})`);
    }
    const itemsizes = Array.isArray(dict.itemsizes) ? dict.itemsizes.map(Number) : [];
    if (itemsizes.length !== EXPECTED_ITEMSIZES.length ||
        itemsizes.some((size, i) => size !== EXPECTED_ITEMSIZES[i])) {
        throw new Error(`zerosearch marshal index was built on an incompatible platform ` +
            `(item sizes ${JSON.stringify(itemsizes)}, expected ${JSON.stringify(EXPECTED_ITEMSIZES)})`);
    }
    const [offsetSize, docSize, tfSize, fieldSize, lengthSize] = itemsizes;
    const keywordIndexRaw = dict.keyword_index && typeof dict.keyword_index === "object" && !Array.isArray(dict.keyword_index)
        ? dict.keyword_index
        : {};
    const keyword_index = {};
    for (const [field, values] of Object.entries(keywordIndexRaw)) {
        const inner = {};
        const valuesDict = values;
        for (const [value, blob] of Object.entries(valuesDict)) {
            inner[value] = decodeUintArray(blob, docSize);
        }
        keyword_index[field] = inner;
    }
    return {
        magic: MAGIC,
        format: JSON_FORMAT,
        text_fields: asStringArray(dict.text_fields, "text_fields"),
        keyword_fields: asStringArray(dict.keyword_fields, "keyword_fields"),
        stop_words: asStringArray(dict.stop_words, "stop_words"),
        n_fields: Number(dict.n_fields),
        docs: Array.isArray(dict.docs) ? dict.docs : [],
        vocab: asStringArray(dict.vocab, "vocab"),
        post_off: decodeUintArray(dict.post_off, offsetSize),
        post_doc: decodeUintArray(dict.post_doc, docSize),
        post_field: decodeUintArray(dict.post_field, fieldSize),
        post_tf: decodeUintArray(dict.post_tf, tfSize),
        doc_freq: decodeUintArray(dict.doc_freq, docSize),
        lengths: decodeUintArray(dict.lengths, lengthSize),
        keyword_index,
    };
}
