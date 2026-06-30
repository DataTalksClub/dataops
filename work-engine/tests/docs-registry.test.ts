import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRegistry,
  resolveReference,
  normalizeReference,
  generatedId,
  recordToDict,
  DocumentRegistryError,
  LookupError,
} from '../src/docs/docRegistry';
import { sopStructuredText } from '../src/docs/search/sopExtract';
import { extractDoc } from '../src/docs/search/extract';

function writeDoc(contentRoot: string, relPath: string, text: string): void {
  const full = join(contentRoot, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

describe('docRegistry - build + resolve (port of doc_registry.py)', () => {
  let root: string;
  let contentRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'registry-'));
    contentRoot = join(root, 'content');
    mkdirSync(contentRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('generates a stable id by stripping type dirs and dot-joining', () => {
    assert.strictEqual(
      generatedId('content/media/podcast/sops/create-a-doc.md', 'sop'),
      'sop.media.podcast.create-a-doc',
    );
    // underscores become dashes
    assert.strictEqual(generatedId('content/a/b_c.md', 'doc'), 'doc.a.b-c');
  });

  it('infers id/doc_type/domain from the path when frontmatter is absent', () => {
    writeDoc(contentRoot, 'media/podcast/sops/intro.md', '---\ntitle: Intro\n---\n\n# Intro\n');
    const registry = buildRegistry(contentRoot);
    const record = registry.byPath.get('content/media/podcast/sops/intro.md');
    assert.ok(record);
    assert.strictEqual(record!.id, 'sop.media.podcast.intro');
    assert.strictEqual(record!.doc_type, 'sop');
    assert.strictEqual(record!.domain, 'media');
    assert.strictEqual(record!.id_source, 'generated');
    assert.strictEqual(recordToDict(record!).stable_id, false);
  });

  it('honors explicit frontmatter id and marks it stable', () => {
    writeDoc(contentRoot, 'ref/thing.md', '---\nid: my.custom.id\ndoc_type: reference\ntitle: Ref\n---\n\nbody\n');
    const registry = buildRegistry(contentRoot);
    const record = registry.byId.get('my.custom.id');
    assert.ok(record);
    assert.strictEqual(record!.id_source, 'frontmatter');
    assert.strictEqual(recordToDict(record!).stable_id, true);
  });

  it('resolves doc:, wiki, alias, and path references to the same record', () => {
    writeDoc(
      contentRoot,
      'ops/sops/deploy.md',
      '---\nid: sop.deploy\naliases: [deploy-guide]\ntitle: Deploy\ndoc_type: sop\n---\n\n# Deploy\n',
    );
    const registry = buildRegistry(contentRoot);
    const byId = resolveReference(registry, 'sop.deploy');
    assert.strictEqual(resolveReference(registry, 'doc:sop.deploy').path, byId.path);
    assert.strictEqual(resolveReference(registry, '[[sop.deploy]]').path, byId.path);
    assert.strictEqual(resolveReference(registry, 'deploy-guide').path, byId.path);
    assert.strictEqual(resolveReference(registry, 'content/ops/sops/deploy.md').path, byId.path);
    assert.strictEqual(resolveReference(registry, 'ops/sops/deploy.md').path, byId.path);
  });

  it('throws LookupError for an unknown reference', () => {
    writeDoc(contentRoot, 'a.md', '---\ntitle: A\n---\n\nbody\n');
    const registry = buildRegistry(contentRoot);
    assert.throws(() => resolveReference(registry, 'does.not.exist'), LookupError);
  });

  it('validates related_docs and raises on a dangling reference', () => {
    writeDoc(
      contentRoot,
      'a.md',
      '---\nid: doc.a\ntitle: A\nrelated_docs: [doc.missing]\n---\n\nbody\n',
    );
    assert.throws(() => buildRegistry(contentRoot), DocumentRegistryError);
    // validate=false collects records without throwing
    const registry = buildRegistry(contentRoot, false);
    assert.strictEqual(registry.documents.length, 1);
  });

  it('detects duplicate ids', () => {
    writeDoc(contentRoot, 'a.md', '---\nid: dup.id\ntitle: A\n---\n\nbody\n');
    writeDoc(contentRoot, 'b.md', '---\nid: dup.id\ntitle: B\n---\n\nbody\n');
    assert.throws(() => buildRegistry(contentRoot), /duplicate id 'dup.id'/);
  });

  it('normalizeReference strips doc: and wiki wrappers', () => {
    assert.strictEqual(normalizeReference('doc:sop.x'), 'sop.x');
    assert.strictEqual(normalizeReference('[[sop.x|Label]]'), 'sop.x');
    assert.strictEqual(normalizeReference('  plain  '), 'plain');
  });
});

const STRUCTURED_SOP = [
  '---',
  'title: Reset a password',
  'doc_type: sop',
  'schema_version: 1',
  '---',
  '',
  '# Reset a password',
  '',
  '<!-- sop-section-start: summary -->',
  '## Summary',
  '',
  'Reset the account password safely.',
  '<!-- sop-section-end -->',
  '',
  '<!-- sop-section-start: procedure -->',
  '## Procedure',
  '',
  '<!-- sop-step-start id=1 -->',
  '1. Open the admin console and find the user.',
  '<!-- sop-step-end -->',
  '',
  '<!-- sop-step-start id=2 -->',
  '2. Click reset and confirm the change.',
  '<!-- sop-step-end -->',
  '',
  '<!-- sop-section-end -->',
].join('\n');

describe('sopExtract - structured search text (#86 hook)', () => {
  it('flattens SOP step bodies and drops marker noise', () => {
    const text = sopStructuredText(STRUCTURED_SOP);
    assert.ok(text, 'returns structured text for a schema_version: 1 SOP');
    assert.match(text!, /Open the admin console/);
    assert.match(text!, /Click reset and confirm/);
    assert.doesNotMatch(text!, /sop-step-start/);
    assert.doesNotMatch(text!, /sop-section-start/);
  });

  it('returns null for non schema_version 1 docs', () => {
    const plain = ['---', 'title: Plain', '---', '', '# Plain', 'body'].join('\n');
    assert.strictEqual(sopStructuredText(plain), null);
  });

  it('wires into extractDoc so the indexed body uses structured text', () => {
    const doc = extractDoc('content/ops/sops/reset.md', STRUCTURED_SOP, {
      structuredText: sopStructuredText,
    });
    assert.match(String(doc.body), /Open the admin console/);
    assert.doesNotMatch(String(doc.body), /sop-step-start/);
  });
});
