import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  parseCodeView,
  CodeViewParseError,
  lintCodeView,
  lintDocument,
  lintText,
} from '../src/docs/sop/index';
import { buildRegistry, DocumentRegistryError } from '../src/docs/docRegistry';
import { newDocContent } from '../src/docs/docScaffolds';
import {
  handleDocsRoutes,
  configureDocsRuntime,
  resetDocsRuntime,
} from '../src/docs/contentApi';
import { syntheticKnowledge } from './helpers/knowledge';
import { createSearchIndex } from '../src/docs/searchIndex';
import type { LambdaEvent } from '../src/types';

const SOP = [
  '---',
  'title: Reset a password',
  'summary: How to reset a user password',
  'doc_type: sop',
  'schema_version: 1',
  '---',
  '',
  '# Reset a password',
  '',
  '<!-- sop-section-start: procedure -->',
  '## Procedure',
  '<!-- sop-step-start id=1 -->',
  '1. Open the admin console and reset the password.',
  '<!-- sop-step-end -->',
  '<!-- sop-section-end -->',
].join('\n');

const CODE_VIEW = [
  '---',
  'title: Reset a password — code view',
  'summary: CLI-only alternate view',
  'doc_type: code-view',
  'schema_version: 1',
  'sop: content/accounts/sops/reset-password.md',
  '---',
  '',
  '# Reset a password — code view',
  '',
  '## Before you start',
  '',
  'Dry-run first. Stop if the console step is required: it is browser-only.',
  '',
  '```bash file=reset-password.sh',
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'echo "dry-run"',
  '```',
  '',
  'Then verify.',
  '',
  '```python file=verify_reset.py',
  'print("ok")',
  '```',
].join('\n');

const SCRATCH_BASE = resolve('../.tmp', 'docs-code-view-tests');

function scratch(label: string): string {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SCRATCH_BASE, `${label}-`));
}

function writeDoc(root: string, relPath: string, text: string): void {
  const file = join(root, 'content', relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function ev(
  httpMethod: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): LambdaEvent {
  return {
    httpMethod,
    path,
    headers: {},
    queryStringParameters: opts.query || null,
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  };
}

async function call(event: LambdaEvent): Promise<{ status: number; body: any }> {
  const response = await handleDocsRoutes(event, 'code-view-test-user');
  assert.ok(response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

describe('code view parser', () => {
  it('reports source document line numbers including frontmatter and title', () => {
    const source = CODE_VIEW.replace('file=verify_reset.py', 'file=../invalid.py').replace(/\n/g, '\r\n');
    const expectedLine = source.split('\r\n').findIndex((line) => line.includes('file=../invalid.py')) + 1;
    assert.throws(() => parseCodeView(source), (error: unknown) => {
      assert.ok(error instanceof CodeViewParseError);
      assert.equal(error.line, expectedLine);
      return true;
    });
  });
  it('keeps author order, code bytes, languages and interleaved markdown', () => {
    const parsed = parseCodeView(CODE_VIEW);
    assert.deepEqual(
      parsed.files.map((f) => [f.name, f.language]),
      [
        ['reset-password.sh', 'bash'],
        ['verify_reset.py', 'python'],
      ],
    );
    assert.deepEqual(
      parsed.blocks.map((b) => b.kind),
      ['markdown', 'file', 'markdown', 'file'],
    );
    const first = parsed.blocks[1];
    assert.ok(first.kind === 'file');
    if (first.kind === 'file') {
      assert.equal(
        first.code,
        ['#!/usr/bin/env bash', 'set -euo pipefail', 'echo "dry-run"'].join('\n'),
      );
      assert.equal(first.anchor, 'file-reset-password-sh');
    }
    assert.ok(parsed.blocks[0].kind === 'markdown');
    if (parsed.blocks[0].kind === 'markdown') {
      assert.equal(parsed.blocks[0].heading, 'Before you start');
      assert.ok(parsed.blocks[0].body_md.includes('browser-only'));
    }
    assert.equal(parsed.frontmatter.sop, 'content/accounts/sops/reset-password.md');
    assert.equal(parsed.schema_version, '1');
  });

  it('keeps plain fenced blocks inside the prose', () => {
    const text = [
      '---',
      'doc_type: code-view',
      'sop: content/x/sops/a.md',
      '---',
      '',
      'Example:',
      '',
      '```',
      'not a file block',
      '```',
      '',
      '```bash file=run.sh',
      'echo hi',
      '```',
    ].join('\n');
    const parsed = parseCodeView(text);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.blocks.length, 2);
    assert.ok(parsed.blocks[0].kind === 'markdown');
    if (parsed.blocks[0].kind === 'markdown') {
      assert.ok(parsed.blocks[0].body_md.includes('not a file block'));
    }
  });

  it('anchors markdown sections after file blocks with stable slugs', () => {
    const parsed = parseCodeView(CODE_VIEW);
    assert.deepEqual(
      parsed.blocks.filter((b) => b.kind === 'markdown').map((b) => b.anchor),
      ['section-1-before-you-start', 'section-2-notes'],
    );
  });

  it('rejects structural faults with line numbers', () => {
    const cases: [string, RegExp][] = [
      [
        '---\ndoc_type: code-view\nsop: x\n---\n\n```bash file=a.sh\necho hi\n',
        /never closed/,
      ],
      ['---\ndoc_type: code-view\nsop: x\n---\n\n```\necho hi\n```\n', /at least one/],
      [
        '---\ndoc_type: code-view\nsop: x\n---\n\n```bash file=../evil.sh\necho hi\n```\n',
        /bare filename/,
      ],
      [
        '---\ndoc_type: code-view\nsop: x\n---\n\n```bash file=a.sh\necho\n```\n\n```sh file=a.sh\necho\n```\n',
        /duplicate file block/,
      ],
    ];
    for (const [text, pattern] of cases) {
      assert.throws(
        () => parseCodeView(text),
        (err: unknown) => {
          assert.ok(err instanceof CodeViewParseError);
          assert.match((err as CodeViewParseError).message, pattern);
          assert.ok(Number.isInteger((err as CodeViewParseError).line));
          return true;
        },
      );
    }
  });

  it('preserves shell syntax byte-exactly inside a file block', () => {
    const code = 'if [ "${DRY_RUN:-1}" = "0" ]; then\n  emit --force\nfi';
    const text = `---\ndoc_type: code-view\nsop: x\n---\n\n\`\`\`bash file=a.sh\n${code}\n\`\`\`\n`;
    const parsed = parseCodeView(text);
    assert.ok(parsed.blocks[0].kind === 'file');
    if (parsed.blocks[0].kind === 'file') assert.equal(parsed.blocks[0].code, code);
  });
});

describe('code view lint and doc-type routing', () => {
  it('lints a clean code view to no violations', () => {
    assert.deepEqual(lintCodeView(CODE_VIEW), []);
  });

  it('requires doc_type, title and the sop back-reference', () => {
    const violations = lintCodeView(
      '---\ntitle: x\ndoc_type: sop\n---\n\n```bash file=a.sh\necho\n```\n',
    );
    assert.deepEqual(violations, [
      "doc_type must be 'code-view' (got 'sop')",
      'frontmatter is missing `sop` (the canonical SOP this view codes)',
    ]);
  });

  it('reports parse faults as one violation', () => {
    const violations = lintCodeView(
      '---\ntitle: x\ndoc_type: code-view\nsop: a\nschema_version: 1\n---\n\nprose only\n',
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0], /^parse error: line \d+: /);
  });

  it('routes by doc_type: SOPs get SOP lint, code views code-view lint, others none', () => {
    assert.deepEqual(lintDocument(CODE_VIEW), []);
    const sopText = '---\ntitle: x\ndoc_type: sop\nschema_version: 1\n---\n\nbody\n';
    const routed = lintDocument(sopText);
    assert.ok(routed.some((v) => v.startsWith('missing required section:')));
    assert.deepEqual(routed, lintText(sopText));
    assert.deepEqual(lintDocument('---\ntitle: x\ndoc_type: reference\n---\n\nbody\n'), []);
  });
});

describe('code view registry linkage', () => {
  it('infers doc_type from the code-views folder and links both directions', () => {
    const root = scratch('registry-ok');
    writeDoc(root, 'accounts/sops/reset-password.md', SOP);
    writeDoc(root, 'accounts/code-views/reset-password-code.md', CODE_VIEW);
    try {
      const registry = buildRegistry(join(root, 'content'));
      const view = registry.byPath.get('content/accounts/code-views/reset-password-code.md');
      assert.equal(view?.doc_type, 'code-view');
      assert.equal(view?.sop, 'content/accounts/sops/reset-password.md');
      assert.equal(view?.id, 'code-view.accounts.reset-password-code');
      const sop = registry.byPath.get('content/accounts/sops/reset-password.md');
      assert.equal(registry.codeViewBySop.get(sop!.id)?.path, view!.path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, unresolvable, self-targeted and duplicate sop references', () => {
    const root = scratch('registry-bad');
    const body = (sop: string) =>
      `---\ntitle: v\ndoc_type: code-view\nsop: "${sop}"\n---\n\n\`\`\`bash file=a.sh\necho\n\`\`\`\n`;
    writeDoc(root, 'x/code-views/a.md', body('content/x/sops/missing.md'));
    writeDoc(root, 'x/code-views/b.md', body(''));
    writeDoc(root, 'x/code-views/self.md', body('content/x/code-views/self.md'));
    writeDoc(root, 'x/sops/dup.md', SOP.replace('Reset a password', 'Dup target'));
    writeDoc(root, 'x/code-views/dup-1.md', body('content/x/sops/dup.md'));
    writeDoc(root, 'x/code-views/dup-2.md', body('content/x/sops/dup.md'));
    writeDoc(root, 'x/reference/facts.md', '---\ntitle: Facts\ndoc_type: reference\n---\nFacts\n');
    writeDoc(root, 'x/code-views/not-a-sop.md', body('content/x/reference/facts.md'));
    try {
      assert.throws(
        () => buildRegistry(join(root, 'content')),
        (err: unknown) => {
          assert.ok(err instanceof DocumentRegistryError);
          const all = err.violations.join('\n');
          assert.match(all, /code-views\/a\.md: sop reference not found/);
          assert.match(all, /code-views\/b\.md: code view is missing frontmatter `sop`/);
          assert.match(all, /code-views\/self\.md: code view cannot target itself/);
          assert.match(all, /sop reference must target a SOP, got 'reference'/);
          assert.match(all, /code-views\/dup-2\.md: second code view for 'content\/x\/sops\/dup\.md'/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('docs content API code view surface', () => {
  let dir: string;
  beforeEach(() => {
    dir = scratch('api');
    const fixture = syntheticKnowledge(
      {
        'content/accounts/sops/reset-password.md': SOP,
        'content/accounts/code-views/reset-password-code.md': CODE_VIEW,
      },
      dir,
    );
    configureDocsRuntime(fixture.store);
  });
  afterEach(() => {
    resetDocsRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureWith(files: Record<string, string>): void {
    resetDocsRuntime();
    configureDocsRuntime(syntheticKnowledge(files, join(dir, 'api-case')).store);
  }

  it('keeps executable code searchable in the portable build artifact', async () => {
    const contentRoot = join(dir, 'builder-content');
    mkdirSync(contentRoot, { recursive: true });
    writeFileSync(join(contentRoot, 'recipe.md'), CODE_VIEW.replace('echo "dry-run"', 'echo "portableindexuniquetoken"'));
    const output = join(dir, 'portable.index');
    execFileSync(process.execPath, [
      '--import', 'tsx', resolve(__dirname, '../scripts/build-search-index.ts'),
      '--content-dir', contentRoot, '--output', output,
    ], { cwd: resolve(__dirname, '../..'), encoding: 'utf8' });
    const index = await createSearchIndex().load(output);
    assert.equal(index.search('portableindexuniquetoken').length, 1);
  });

  it('links the alternate view from the SOP and back from the view', async () => {
    const sop = await call(ev('GET', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.equal(sop.status, 200);
    assert.equal(sop.body.doc_type, 'sop');
    assert.deepEqual(sop.body.code_view, {
      path: 'content/accounts/code-views/reset-password-code.md',
      title: 'Reset a password — code view',
    });
    assert.equal(sop.body.parsed_code_view, undefined);
    assert.equal(sop.body.sop_doc, undefined);

    const view = await call(ev('GET', '/docs', { query: { path: 'content/accounts/code-views/reset-password-code.md' } }));
    assert.equal(view.status, 200);
    assert.equal(view.body.doc_type, 'code-view');
    assert.deepEqual(view.body.sop_doc, {
      path: 'content/accounts/sops/reset-password.md',
      title: 'Reset a password',
    });
    assert.equal(view.body.code_view, null);
    assert.equal(view.body.parsed_code_view.files.length, 2);
    assert.deepEqual(
      view.body.parsed_code_view.files.map((f: any) => f.name),
      ['reset-password.sh', 'verify_reset.py'],
    );
  });

  it('answers null for an SOP without a code view instead of failing', async () => {
    fixtureWith({ 'content/accounts/sops/other.md': SOP.replace('Reset a password', 'Other flow') });
    const sop = await call(ev('GET', '/docs', { query: { path: 'content/accounts/sops/other.md' } }));
    assert.equal(sop.status, 200);
    assert.equal(sop.body.code_view, null);
    assert.equal(sop.body.code_view_error, null);
  });

  it('distinguishes invalid linkage from an absent code alternative', async () => {
    fixtureWith({
      'content/accounts/sops/reset-password.md': SOP,
      'content/accounts/code-views/broken-link.md': CODE_VIEW.replace(
        'sop: content/accounts/sops/reset-password.md',
        'sop: content/accounts/sops/missing.md',
      ),
    });
    const doc = await call(ev('GET', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.equal(doc.status, 200);
    assert.equal(doc.body.content, SOP);
    assert.equal(doc.body.code_view, null);
    assert.match(doc.body.code_view_error, /sop reference not found/);
  });

  it('does not turn a corpus storage failure into a missing alternate view', async () => {
    resetDocsRuntime();
    const viewPath = 'content/accounts/code-views/reset-password-code.md';
    const fixture = syntheticKnowledge({
      'content/accounts/sops/reset-password.md': SOP,
      [viewPath]: CODE_VIEW,
    }, join(dir, 'unavailable-corpus'));
    fixture.s3.failKey = `objects/${fixture.publication.entries[viewPath].sha}`;
    configureDocsRuntime(fixture.store);
    const doc = await call(ev('GET', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.equal(doc.status, 500);
    assert.equal(doc.body.error, 'Internal server error');
  });

  it('surfaces a broken code view body as parse_code_error without losing content', async () => {
    const broken = CODE_VIEW.replace('file=verify_reset.py', 'file=../escape.sh');
    fixtureWith({
      'content/accounts/sops/reset-password.md': SOP,
      'content/accounts/code-views/broken.md': broken,
    });
    const doc = await call(ev('GET', '/docs', { query: { path: 'content/accounts/code-views/broken.md' } }));
    assert.equal(doc.status, 200);
    assert.equal(doc.body.parsed_code_view, null);
    assert.match(doc.body.parse_code_error, /bare filename/);
    assert.equal(doc.body.content, broken);
  });

  it('parses code-view drafts through POST /parse with kind', async () => {
    const ok = await call(ev('POST', '/parse', { body: { content: CODE_VIEW, kind: 'code-view' } }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.parsed_code_view.files.length, 2);
    const bad = await call(ev('POST', '/parse', { body: { content: 'no fences', kind: 'code-view' } }));
    assert.equal(bad.body.parsed_code_view, null);
    assert.match(bad.body.error, /at least one/);
    const sopParse = await call(ev('POST', '/parse', { body: { content: SOP } }));
    assert.equal(sopParse.body.parsed.sections.procedure.flat_steps.length, 1);
  });

  it('routes save warnings and corpus lint through the code-view rules', async () => {
    const current = await call(ev('GET', '/docs', { query: { path: 'content/accounts/code-views/reset-password-code.md' } }));
    const saved = await call(
      ev('PUT', '/docs', {
        query: { path: 'content/accounts/code-views/reset-password-code.md' },
        body: {
          content: '---\ntitle: v\ndoc_type: code-view\nschema_version: 1\n---\n\nprose only\n',
          expectedRevision: current.body.revision,
        },
      }),
    );
    assert.equal(saved.status, 200);
    assert.ok(saved.body.warnings.some((w: string) => w.startsWith('parse error:')));

    const lint = await call(ev('GET', '/lint'));
    assert.equal(lint.status, 200);
    assert.ok(
      lint.body.docs.some((d: any) => d.path.includes('code-views/') && d.violations.length),
      'the broken saved view must appear in corpus lint',
    );

    const quality = await call(ev('GET', '/docs/process-quality'));
    assert.equal(quality.status, 200);
    assert.ok(quality.body.findings.some((f: any) => String(f.summary).startsWith('parse error: line')));
  });

  it('indexes code view filenames and code for search', async () => {
    const search = await call(ev('GET', '/search', { query: { q: 'pipefail' } }));
    assert.equal(search.status, 200);
    assert.ok(
      search.body.results.some(
        (r: any) => r.path === 'content/accounts/code-views/reset-password-code.md',
      ),
      'search must find the code view by code inside a file block',
    );
    const byFile = await call(ev('GET', '/search', { query: { q: 'reset-password.sh' } }));
    assert.ok(
      byFile.body.results.some(
        (r: any) => r.path === 'content/accounts/code-views/reset-password-code.md',
      ),
      'search must find the code view by its file name',
    );
  });

  it('scaffolds new code-view documents with a file block and sop slot', async () => {
    assert.match(newDocContent('Fresh view', 'code-view', 'scaffold', 'full'), /sop: ""/);
    const publication = await call(ev('GET', '/knowledge/publication'));
    const created = await call(
      ev('POST', '/docs', {
        body: {
          path: 'content/accounts/code-views/fresh.md',
          title: 'Fresh view',
          doc_type: 'code-view',
          summary: 'scaffold',
          absent: true,
          expectedRevision: publication.body.revision,
        },
      }),
    );
    assert.equal(created.status, 201);
    assert.match(created.body.content, /doc_type: code-view/);
    assert.match(created.body.content, /```bash file=run.sh/);
  });
});
