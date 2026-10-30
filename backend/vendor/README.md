# Vendored dependencies

## `zerosearch-node`

`zerosearch-node` (the BM25-lite search engine used for docs search, issue #85)
is **not published to npm**. It lives in a separate local project at
`~/git/zerosearch-node`.

It is consumed here by **vendoring a CommonJS build of its source** (plus
`package.json`, `README.md`, `FORMAT.md`) into
`backend/vendor/zerosearch-node/` and referencing it from
`backend/package.json` as a relative `file:` dependency:

```json
"zerosearch-node": "file:vendor/zerosearch-node"
```

### Why a CommonJS build (not the upstream ESM `dist/`)

The backend compiles to CommonJS (`tsconfig.json` `module: commonjs`) and
deploys as a CommonJS Lambda. Upstream `zerosearch-node` publishes an
**ESM-only** `dist/` (`"type": "module"`, `exports.import` only), which a
CommonJS `require()` cannot load (`ERR_PACKAGE_PATH_NOT_EXPORTED`). To keep the
backend a single CommonJS runtime, the vendored copy is **recompiled from the
upstream `src/` to CommonJS** (`module: commonjs`) and its `package.json`
exposes a CJS entry. `zerosearch-node` is zero-dependency, so this is a clean
two-file recompile (`index.ts` + `marshal.ts`). The portable `json-1` index
format is identical regardless of JS module format.

### Why vendoring (not `file:` to `~/git/...` or a git dep)

- An absolute `file:~/git/zerosearch-node` path does not exist on CI runners,
  so `npm ci` would fail.
- A git dependency requires the source repo to be published/reachable; it is
  currently a local-only project.
- Vendoring the prebuilt `dist/` makes `npm ci` and Lambda packaging fully
  deterministic and network-free. `zerosearch-node` has **zero runtime
  dependencies**, so nothing transitive is pulled in.

### Refreshing the vendored build

Refresh the vendored copy with:

```bash
# Recompile the upstream source to CommonJS (module: commonjs) and replace dist/.
# e.g. tsc with --module commonjs over ~/git/zerosearch-node/src/{index,marshal}.ts
rm -rf backend/vendor/zerosearch-node/dist
# ...emit CJS index.js/marshal.js (+ .d.ts) into backend/vendor/zerosearch-node/dist
```
