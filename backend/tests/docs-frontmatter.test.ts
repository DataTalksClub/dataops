/**
 * Frontmatter reading and registry robustness over real-shaped (synthetic)
 * process docs: knowledge-repo docs write block lists unindented, and one bad
 * alias must never take down the whole docs API.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FrontmatterParseError, parseFrontmatter, splitFrontmatter, stripBom } from '../src/docs/frontmatter';
import { buildRegistry, resolveReference } from '../src/docs/docRegistry';
import { configureDocsRuntime, handleDocsRoutes, resetDocsRuntime, updateFrontmatterParent } from '../src/docs/contentApi';
import { syntheticKnowledge } from './helpers/knowledge';
import type { LambdaEvent } from '../src/types';

const UNINDENTED = [
  'id: sop.example.fill-in-the-sponsored-block',
  'aliases:',
  '- content/example/sops/old-name.md',
  'title: Complete the Sponsored Block',
  'summary: Fill the sponsored block with approved copy, image, and',
  '  CTA link.',
  'doc_type: sop',
  'schema_version: 1',
  'review_cycle_days: 90',
  'last_reviewed_at: null',
  'tags:',
  '- newsletter',
  '- sponsored',
  'training_assets:',
  '- https://www.loom.com/share/0000000000000000000000000000aaaa',
  'related_docs:',
  '- reference.example.newsletter-sponsorship',
].join('\n');

describe('parseFrontmatter', () => {
  it('reads unindented block lists', () => {
    const fm = parseFrontmatter(UNINDENTED);
    assert.deepEqual(fm.aliases, ['content/example/sops/old-name.md']);
    assert.deepEqual(fm.tags, ['newsletter', 'sponsored']);
    assert.deepEqual(fm.training_assets, ['https://www.loom.com/share/0000000000000000000000000000aaaa']);
    assert.deepEqual(fm.related_docs, ['reference.example.newsletter-sponsorship']);
  });

  it('reads indented block lists', () => {
    const fm = parseFrontmatter('title: T\ntags:\n  - one\n  - "two"\nsystems:\n    - deep\n');
    assert.deepEqual(fm.tags, ['one', 'two']);
    assert.deepEqual(fm.systems, ['deep']);
  });

  it('reads empty and inline lists', () => {
    const fm = parseFrontmatter('aliases: []\ntags: [a, "b c", \'d\']\ntools:\n');
    assert.deepEqual(fm.aliases, []);
    assert.deepEqual(fm.tags, ['a', 'b c', 'd']);
    assert.equal(fm.tools, '');
  });

  it('keeps scalars as written strings and joins folded lines', () => {
    const fm = parseFrontmatter(UNINDENTED);
    assert.equal(fm.schema_version, '1');
    assert.equal(fm.review_cycle_days, '90');
    assert.equal(fm.last_reviewed_at, 'null');
    assert.equal(fm.summary, 'Fill the sponsored block with approved copy, image, and CTA link.');
    assert.equal(parseFrontmatter("title: '[Archived] Old: name'").title, '[Archived] Old: name');
    assert.equal(parseFrontmatter('updated: 2026-10-15').updated, '2026-10-15');
  });

  it('raises FrontmatterParseError at the document line of malformed YAML', () => {
    assert.throws(
      () => parseFrontmatter('title: ok\ntags: [unclosed\n'),
      (error: unknown) => error instanceof FrontmatterParseError && error.line >= 2,
    );
  });

  it('exposes the lists through split frontmatter', () => {
    const [raw] = splitFrontmatter(`---\n${UNINDENTED}\n---\n\n# Complete the Sponsored Block\n`);
    assert.deepEqual(parseFrontmatter(raw).training_assets, [
      'https://www.loom.com/share/0000000000000000000000000000aaaa',
    ]);
  });
});

function writeDoc(contentRoot: string, relPath: string, text: string): void {
  const full = join(contentRoot, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

const ARCHIVE = '---\nid: archive.example.old-name\naliases: []\ntitle: Old name\ndoc_type: archive\n---\n\n# Old\n';
const CANONICAL = [
  '---',
  'id: sop.example.new-name',
  'aliases:',
  '- content/example/sops/old-name.md',
  '- sop.example.previous-id',
  'title: New name',
  'doc_type: sop',
  'tags:',
  '- example',
  '---',
  '',
  '# New name',
].join('\n');

describe('document registry with colliding aliases', () => {
  let root: string;
  let contentRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'frontmatter-registry-'));
    contentRoot = join(root, 'content');
    writeDoc(contentRoot, 'example/sops/old-name.md', ARCHIVE);
    writeDoc(contentRoot, 'example/sops/new-name.md', CANONICAL);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports an alias naming another document path, drops it, and keeps both resolvable', () => {
    const registry = buildRegistry(contentRoot);
    assert.deepEqual(registry.violations, [
      "alias 'content/example/sops/old-name.md' from content/example/sops/new-name.md " +
        'conflicts with path from content/example/sops/old-name.md',
    ]);
    assert.equal(resolveReference(registry, 'content/example/sops/old-name.md').id, 'archive.example.old-name');
    assert.equal(resolveReference(registry, 'sop.example.previous-id').id, 'sop.example.new-name');
    assert.deepEqual(registry.byId.get('sop.example.new-name')?.tags, ['example']);
  });

  it('reports an alias naming another document id', () => {
    writeDoc(contentRoot, 'example/sops/third.md', '---\nid: sop.example.third\naliases:\n- archive.example.old-name\n---\n');
    const registry = buildRegistry(contentRoot);
    assert.ok(registry.violations.some((v) => v.includes("alias 'archive.example.old-name' from content/example/sops/third.md conflicts with id")));
    assert.equal(resolveReference(registry, 'archive.example.old-name').path, 'content/example/sops/old-name.md');
  });

  it('reports malformed frontmatter and invalid aliases without failing the build', () => {
    writeDoc(contentRoot, 'example/broken.md', '---\ntitle: [unclosed\n---\n\nbody\n');
    writeDoc(contentRoot, 'example/bad-alias.md', '---\nid: doc.bad-alias\naliases:\n- content/not-markdown.txt\n- Not An Id\n---\n');
    const registry = buildRegistry(contentRoot);
    const all = registry.violations.join('\n');
    assert.match(all, /content\/example\/broken\.md: line \d+: invalid frontmatter YAML/);
    assert.match(all, /invalid path alias 'content\/not-markdown\.txt'/);
    assert.match(all, /invalid alias 'Not An Id'/);
    assert.equal(registry.documents.length, 4);
  });
});

function ev(httpMethod: string, path: string, query: Record<string, string> | null = null): LambdaEvent {
  return { httpMethod, path, headers: {}, queryStringParameters: query, body: null };
}

async function call(event: LambdaEvent): Promise<{ status: number; body: any }> {
  const response = await handleDocsRoutes(event, 'authenticated-test-user');
  assert.ok(response);
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

describe('docs API with a colliding alias in one document', () => {
  let dir: string;
  beforeEach(() => {
    mkdirSync(resolve('../.tmp'), { recursive: true });
    dir = mkdtempSync(resolve('../.tmp/frontmatter-api-'));
    const fixture = syntheticKnowledge(
      {
        'content/example/sops/old-name.md': ARCHIVE,
        'content/example/sops/new-name.md': CANONICAL,
        'content/example/reference/unrelated.md': '---\nid: reference.example.unrelated\ntitle: Unrelated\ndoc_type: reference\n---\n\nText.\n',
      },
      dir,
    );
    configureDocsRuntime(fixture.store);
  });
  afterEach(() => {
    resetDocsRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps serving docs and reports the conflict in process-quality', async () => {
    for (const route of ['/docs', '/docs/registry']) assert.equal((await call(ev('GET', route))).status, 200);
    const listed = await call(ev('GET', '/docs'));
    const canonical = listed.body.documents.find((doc: any) => doc.id === 'sop.example.new-name');
    assert.deepEqual(canonical.tags, ['example']);
    assert.deepEqual(canonical.aliases, ['content/example/sops/old-name.md', 'sop.example.previous-id']);

    const resolved = await call(ev('GET', '/docs/resolve', { ref: 'content/example/sops/old-name.md' }));
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.document.id, 'archive.example.old-name');

    const unrelated = await call(ev('GET', '/docs', { path: 'content/example/reference/unrelated.md' }));
    assert.equal(unrelated.status, 200);
    assert.equal(unrelated.body.doc_type, 'reference');

    const quality = await call(ev('GET', '/docs/process-quality'));
    assert.equal(quality.status, 200);
    assert.equal(quality.body.ok, false);
    assert.deepEqual(quality.body.validationErrors, [
      "alias 'content/example/sops/old-name.md' from content/example/sops/new-name.md " +
        'conflicts with path from content/example/sops/old-name.md',
    ]);
  });
});

describe('UTF-8 BOM normalization before frontmatter parsing', () => {
  const BOM = '\ufeff';
  const DOC = '---\nid: sop.example.bom-parity\ntitle: BOM parity\ndoc_type: sop\n---\n\n# BOM parity\n';
  const MALFORMED = '---\ntitle: [unclosed\n---\n\nbody\n';

  it('strips only a single leading BOM', () => {
    assert.equal(stripBom(`${BOM}---\n`), '---\n');
    assert.equal(stripBom(DOC), DOC);
    assert.equal(stripBom('a' + BOM + 'b'), 'a' + BOM + 'b');
  });

  it('parses BOM-prefixed frontmatter identically to the plain form', () => {
    assert.deepEqual(splitFrontmatter(`${BOM}${DOC}`), splitFrontmatter(DOC));
    const [raw] = splitFrontmatter(`${BOM}${DOC}`);
    assert.equal(parseFrontmatter(raw).id, 'sop.example.bom-parity');
  });

  it('returns BOM-prefixed bodies without frontmatter untouched', () => {
    assert.deepEqual(splitFrontmatter(`${BOM}# Just a heading\n`), ['', `${BOM}# Just a heading\n`]);
    assert.deepEqual(splitFrontmatter(''), ['', '']);
  });

  it('rejects malformed frontmatter consistently with and without a BOM', () => {
    const read = (text: string) => {
      const [raw] = splitFrontmatter(text);
      return parseFrontmatter(raw);
    };
    const without = (() => {
      try {
        read(MALFORMED);
      } catch (error) {
        return error;
      }
      return null;
    })();
    const withBom = (() => {
      try {
        read(`${BOM}${MALFORMED}`);
      } catch (error) {
        return error;
      }
      return null;
    })();
    assert.ok(without instanceof FrontmatterParseError);
    assert.ok(withBom instanceof FrontmatterParseError);
    assert.equal(withBom.toString(), without.toString());
  });

  it('keeps the stable frontmatter id for BOM-prefixed registry documents', () => {
    const root = mkdtempSync(join(tmpdir(), 'frontmatter-bom-'));
    try {
      const contentRoot = join(root, 'content');
      const plainDoc = DOC.replace('sop.example.bom-parity', 'sop.example.plain-doc');
      writeDoc(contentRoot, 'example/sops/plain.md', plainDoc);
      writeDoc(contentRoot, 'example/sops/bom.md', `${BOM}${DOC}`);
      const registry = buildRegistry(contentRoot);
      const plain = registry.byPath.get('content/example/sops/plain.md');
      const bom = registry.byPath.get('content/example/sops/bom.md');
      assert.ok(plain && bom);
      assert.equal(plain.id, 'sop.example.plain-doc');
      assert.equal(bom.id, 'sop.example.bom-parity');
      assert.equal(bom.id_source, 'frontmatter');
      assert.equal(plain.id_source, 'frontmatter');
      assert.equal(bom.title, plain.title);
      assert.deepEqual(bom.tags, plain.tags);
      assert.deepEqual(registry.violations, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates the parent of BOM-prefixed documents without dropping the BOM', () => {
    const updated = updateFrontmatterParent(`${BOM}${DOC}`, 'sop.example.parent');
    assert.ok(updated.startsWith(BOM));
    assert.match(updated, /^parent: "sop\.example\.parent"$/m);
    assert.equal(parseFrontmatter(splitFrontmatter(updated)[0]).id, 'sop.example.bom-parity');
    const cleared = updateFrontmatterParent(updated, null);
    assert.ok(cleared.startsWith(BOM));
    assert.doesNotMatch(cleared, /^parent:/m);
  });
});
