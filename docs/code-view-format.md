# Code view format

An alternate, code-only view of a SOP. One canonical representation per SOP:
a separate knowledge document linked to the SOP — never a copy of its body and
never independent instructions that can drift from it.

The parser lives in `backend/src/docs/sop/codeView.ts`; the registry enforces
the linkage; the docs UI renders the view Gist-style (named files, author
order, copyable, with the prose interleaved).

## Document

A markdown file, conventionally at `content/<domain>/code-views/<slug>.md`
(the folder infers `doc_type: code-view`):

```yaml
---
title: Local podcast production — code view
summary: Runnable commands behind the local-podcast SOP
doc_type: code-view
schema_version: 1
sop: content/podcast/sops/local-podcast-production.md
---
```

`sop:` is required and must resolve through the document registry. An SOP may
have at most one code view; a code view cannot target itself. Violations are
reported as registry validation errors.

## Body

An author-ordered sequence of two block kinds:

1. **File blocks** — a fenced code block whose info string carries
   `file=<name>`:

   ````markdown
   ```bash file=normalize-audio.sh
   #!/usr/bin/env bash
   set -euo pipefail
   ```
   ````

   - `name` must be a bare filename: `[A-Za-z0-9][A-Za-z0-9._-]*` — no
     directories, no `..`. It is a display label and anchor, not a write path.
   - The language is the fence token (`bash`, `powershell`, `python`, …).
   - Code bytes are preserved verbatim: the fenced lines joined with `\n`.
     Comments inside the file carry prerequisites, typed inputs, host checks,
     approvals, verification, and explicit stop conditions.
2. **Markdown blocks** — prose between file blocks, rendered as markdown.
   A heading in the first line names the section; its slug becomes the anchor.

Plain fenced blocks without `file=` belong to the surrounding prose, so
examples inside explanations stay possible.

Authoring rules (enforced by review, not the parser): files must be runnable
in the order shown, start read-only/dry-run where the step can, and stop
explicitly before browser-only or human-only steps — those are named in prose
or comments, never implied to be automated. Nothing in a code view is executed
by the portal.

## Parse result

`parseCodeView(text)` returns `{ schema_version, frontmatter, blocks, files }`
where `blocks` is the ordered mix of `{kind:'file', name, language, code,
anchor}` and `{kind:'markdown', anchor, heading, body_md}`, and `files` is the
file-block navigation index in author order. Anchors are slugged
(`file-normalize-audio-sh`, `section-2-stop-conditions`) and unique.

Structural faults raise `CodeViewParseError` naming the line: unclosed fence,
`file=` missing, unsafe or duplicate filename, or a body with no file blocks.

## Lint

`doc_type: code-view` documents are linted by `lintCodeView` (frontmatter,
schema, parseability) instead of the SOP lint. The API's `/lint`,
`/docs/process-quality`, and save-warnings all route by `doc_type`.

## API surface

- `GET /docs?path=…` — every document carries `doc_type` and
  `code_view: {path, title} | null` (the view linked to it). A code-view
  document carries `parsed_code_view` (or `parse_code_error`) and the
  `sop_doc: {path, title}` back-link.
- `POST /parse` — `{content, kind: "sop" | "code-view"}` (default `"sop"`).
- Search indexes a code view's filenames, languages, prose, and code.
- CLI: `dataops kb code <ref>` prints the linked or own code view.
