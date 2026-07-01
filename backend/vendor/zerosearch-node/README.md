# zerosearch-node

A tiny, **zero-dependency** BM25-lite in-memory text search index for
TypeScript/Node — a faithful port of the Python
[`zerosearch`](https://github.com/alexeygrigorev/zerosearch) library.

Documents are plain objects. Text fields are tokenized once when the index is
built and kept as an inverted index, so a query only scores the documents that
actually contain a query term. The runtime has **no third-party dependencies**.

## Cross-language compatibility

This is the headline feature: `zerosearch-node` and Python `zerosearch` rank
identically (same tokenizer, same BM25-lite math, same tie-breaks), and Node
reads a Python index **two ways**:

1. **Native Python `.save()` files, directly** — `Index.load` reads the raw
   Python `marshal` artifact that `zerosearch.save()` writes. No change to the
   published Python library is needed. (See `src/marshal.ts` and the marshal
   section of [`FORMAT.md`](./FORMAT.md).)
2. **A portable, language-neutral JSON format** (`json-1`) for a text artifact
   that does not carry Python's interpreter/platform pinning.

`Index.load` auto-detects which of the two a file is.

The guarantee is enforced by parity tests against fixtures produced by the
**Python** library (`scripts/gen_fixture.py`): the Node suite loads the native
`marshal` artifact (`tests/fixtures/py-native.zsx`), the `json-1` index, and a
freshly re-fit corpus, and asserts all three reproduce Python's top-k results
(ids exact, scores within `1e-9`) across 120 query/filter/boost cases.

> Direction of travel: Node currently *reads* Python `marshal` but does not
> *write* it. To hand an index from Node back to Python, ship `json-1` (and add
> a `json-1` reader on the Python side). See [`FORMAT.md`](./FORMAT.md).

## Install

```bash
npm install zerosearch-node
```

## Usage

```ts
import { Index } from "zerosearch-node";

const docs = [
  { id: "1", title: "Docker compose basics", text: "how to start services", course: "de" },
  { id: "2", title: "Kafka consumers", text: "consumer groups explained", course: "de" },
];

const index = new Index(
  ["title", "text"],   // text fields (tokenized + ranked)
  ["id", "course"],    // keyword fields (exact-match filtering)
);
index.fit(docs);

const results = index.search(
  "how do I start docker compose",
  { course: "de" },              // filter: scalar = exact, array = IN
  { title: 3.0, text: 1.0 },     // per-field boosts
  5,                             // num results
);

for (const r of results) {
  console.log(r.score, r.title);
}
```

Each result is a shallow copy of the original document with an added `score`.

### API

- `new Index(textFields, keywordFields?, { stopWords?, tokenizer? })`
- `index.fit(docs)` → `this`
- `index.search(query, filterDict?, boostDict?, numResults = 10)` → `results`
- `tokenize(text, stopWords?)`, `DEFAULT_STOP_WORDS`, `TOKEN_RE`, `VERSION`

### Filtering

A `filterDict` value can be a scalar (exact match) or an array (IN / OR within
that field). Filters on different fields combine with AND.

```ts
index.search("docker", { course: "de" });                       // course === "de"
index.search("docker", { course: ["de", ""] });                 // course === "de" OR ""
index.search("docker", { course: ["de", "mlops"], kind: "faq" }); // (de OR mlops) AND faq
```

## Saving & loading a prebuilt index

`fit()` does the tokenization up front. Build the index once (e.g. in CI) and
ship the artifact so the consumer loads in milliseconds without re-tokenizing.

```ts
// build step
new Index(["title", "text"], ["id", "course"]).fit(docs).save("index.zsj");

// runtime
const index = Index.load("index.zsj");
const results = index.search("docker compose");
```

`dumps()` / `loads()` are the in-memory equivalents (return/accept a JSON
string). `save()` writes the portable `json-1` JSON; `load()` reads either
`json-1` **or a native Python `zerosearch.save()` `marshal` file** (auto-detected
— see [`FORMAT.md`](./FORMAT.md)):

```ts
// load an index built and saved by the Python zerosearch library, unchanged:
const index = Index.load("index.zsx");        // native Python marshal
const same = Index.load("index.zsj");          // portable json-1
const fromBytes = Index.loadBytes(buffer);     // same detection, from memory
```

If you built with a **custom tokenizer**, resupply it on load:
`Index.load("index.zsj", { tokenizer: myTokenizer })`.

## How it works

- **Tokenizer** — lowercased word/number tokens; keeps `+ . # _ -` *inside* a
  token so `c++`, `node.js`, `f-string` survive (a token must start with a
  letter/digit). Drops 1-character tokens and a small English stop-word list
  (both overridable).
- **Inverted index** — built once in `fit()` and compacted into flat CSR
  postings arrays, so search only scores documents that contain a query term.
- **Ranking** — BM25-lite: each query term contributes
  `boost * idf * (term_frequency / sqrt(field_length))` per field, with
  `idf = log(1 + (N - df + 0.5) / (df + 0.5))`. IDF and document frequencies are
  computed over the filtered candidate set. Ties break by document order. There
  is no `k1`/`b` saturation term.

## Development

```bash
npm install
npm run typecheck
npm test          # node:test, includes the cross-language parity suite
npm run build     # tsc -> dist/

# regenerate the parity fixture from the Python library:
PYTHONPATH=~/git/zerosearch python3 scripts/gen_fixture.py
```

## License

WTFPL.
