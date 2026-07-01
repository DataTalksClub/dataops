# zerosearch portable index format (`json-1`)

This document defines the **language-neutral** on-disk format that
`zerosearch-node` reads and writes with `Index.save` / `Index.load` (and the
in-memory `dumps` / `loads`). It exists so an index built in one language can be
loaded and searched in another.

## Why a new format

The upstream Python `zerosearch` library serializes with
[`marshal`](https://docs.python.org/3/library/marshal.html). `marshal` is:

- **Python-only** — there is no Node/JS reader for it.
- **Version-pinned** — the Python loader refuses to load a blob written by a
  different `major.minor` interpreter.
- **Platform-pinned** — it records and verifies the C `array` item sizes.

So the existing `.zsx` artifact is not portable across languages (or even across
Python versions). To meet the cross-language requirement, `zerosearch-node`
defines this `json-1` format, which captures the **same logical index state** in
plain JSON.

## File contents

A single JSON object (UTF-8). All fields are required.

| key             | type                                  | meaning |
|-----------------|---------------------------------------|---------|
| `magic`         | `"zerosearch"`                        | identifies the artifact |
| `format`        | `"json-1"`                            | format version tag |
| `text_fields`   | `string[]`                            | ranked fields, in field order |
| `keyword_fields`| `string[]`                            | exact-match filter fields |
| `stop_words`    | `string[]` (sorted)                   | stop words used at build time |
| `n_fields`      | `number`                              | `text_fields.length` |
| `docs`          | `object[]`                            | the original documents, in doc-id order (doc id = array index) |
| `vocab`         | `string[]` (sorted)                   | term `i` has term-id `i` |
| `post_off`      | `number[]` (length `vocab.length+1`)  | CSR offsets: term `t`'s postings are `[post_off[t], post_off[t+1])` |
| `post_doc`      | `number[]`                            | postings: document id |
| `post_field`    | `number[]`                            | postings: text-field index |
| `post_tf`       | `number[]`                            | postings: term frequency in that doc+field |
| `doc_freq`      | `number[]` (length `vocab.length`)    | document frequency per term |
| `lengths`       | `number[]` (length `docs.length * n_fields`) | field length at `doc_id * n_fields + field_index` |
| `keyword_index` | `{ [field]: { [value]: number[] } }`  | per keyword field, value -> sorted doc ids |

### Postings (CSR layout)

The three parallel arrays `post_doc` / `post_field` / `post_tf` form a
compressed-sparse-row postings list. For term id `t`, iterate
`j` from `post_off[t]` to `post_off[t+1]`; each `j` is a posting
`(post_doc[j], post_field[j], post_tf[j])`. Within a term, postings are sorted
by `(doc_id, field_index, tf)` so that tied scores fall back to document order.

### Invariants

- `docs` order **is** the doc-id space: document `k` is `docs[k]`.
- `vocab` is sorted ascending (by code point); a term's id is its position.
- `keyword_index[field][value]` lists are sorted ascending.
- Field values are string-coerced before indexing/filtering (the equivalent of
  Python `str(value)` / JS `String(value)`), and a missing field is `""`.

## Scoring reproduced from this state

Ranking is BM25-lite (identical in both languages):

```
idf(term)          = log(1 + (N - df + 0.5) / (df + 0.5))
contribution(d,f)  = boost[f] * idf(term) * qtf(term) * (tf / sqrt(field_length))
score(d)           = sum of contributions over query terms and text fields
```

where `N` is the candidate-document count (the whole corpus, or the filtered
subset), `df` is the document frequency over that candidate set, `qtf` is the
query-term frequency, and `boost[f]` defaults to `1.0`. Results are ranked by
`(score desc, doc_id asc)`. There is no `k1`/`b` term-saturation — that is what
"BM25-lite" means here: BM25's IDF combined with a Lucene-style
`tf / sqrt(field_length)` normalization.

## Reading native Python `marshal` artifacts directly

`zerosearch-node` **also reads a native Python `zerosearch.save()` file
directly** — no change to the published Python library required. `Index.load`
auto-detects the format: a UTF-8 `json-1` document, or a binary Python `marshal`
blob (both happen to start with `{`, so detection peeks at the next byte —
`"` for JSON, a marshal type byte otherwise).

The marshal reader (`src/marshal.ts`) is intentionally minimal: it implements
only the opcodes `zerosearch`'s `dumps()` emits — dict, list, tuple
(incl. small-tuple), int (and int64/long), binary float, the str variants
(ascii / short-ascii / unicode, plus their interned forms), bytes, bool, None,
and the `FLAG_REF` / `TYPE_REF` back-reference mechanism. Any other opcode
throws. The posting byte blobs (`array.tobytes()`) are decoded with the item
sizes recorded in the artifact's `itemsizes` field.

### Assumptions and validation (marshal path)

The Python loader pins an artifact to a specific interpreter and platform. The
Node reader makes the matching assumptions and validates them up front, failing
clearly on mismatch (acceptable because the index is rebuilt at deploy time on
Linux x86-64):

- `magic` must be `"zerosearch"` and `format` must be `2` (the Python
  `_FORMAT_VERSION`).
- `itemsizes` must be `[4, 4, 4, 1, 4]` — the `(I, I, I, B, I)` typecodes the
  Python library uses. A different platform's array sizes are rejected.
- Byte blobs are decoded **little-endian**. `array.tobytes()` uses native byte
  order, so a big-endian-built artifact is not supported (caught in practice by
  the `itemsizes` check and the rebuild-on-deploy policy).
- marshal integers and framing are always little-endian (CPython writes them
  that way regardless of platform), so no extra assumption is needed there.

## Interop status

- `zerosearch-node` reads and writes `json-1` natively, **and** reads native
  Python `marshal` `.save()` artifacts directly (read path) — so a Python-built
  index loads in Node with no Python-side change.
- The Python `zerosearch` library still only reads/writes its own `marshal`
  format. For Node to *hand an index back to Python*, ship `json-1` and add a
  `json-1` reader on the Python side (Node currently only *reads* marshal, it
  does not write it). `scripts/gen_fixture.py` documents the read-only mapping
  between the Python index's internal arrays and `json-1`.
