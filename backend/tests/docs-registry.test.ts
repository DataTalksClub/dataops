import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRegistry,
  resolveReference,
  normalizeReference,
  recordToDict,
  DocumentRegistryError,
  LookupError,
} from '../src/docs/docRegistry';
import { generatedId } from '../src/docs/search/extract';
import { sopStructuredText } from '../src/docs/search/sopExtract';
import { extractDoc } from '../src/docs/search/extract';

function writeDoc(contentRoot: string, relPath: string, text: string): void {
  const full = join(contentRoot, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
}

describe('docRegistry - build + resolve (port of doc_registry.py)', () => {
  it('accepts canonical operating-model document types', () => {
    writeDoc(contentRoot, 'model/system-overview.md', '---\nid: system.example\ndoc_type: system-overview\ntitle: Example\n---\n');
    writeDoc(contentRoot, 'model/process.md', '---\nid: process.example\ndoc_type: process\ntitle: Process\n---\n');
    const registry = buildRegistry(contentRoot);
    assert.deepStrictEqual(registry.documents.map((doc) => doc.doc_type).sort(), ['process', 'system-overview']);
  });
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

  it('resolves explicit parent by id, alias, and path', () => {
    writeDoc(
      contentRoot,
      'ops/parent.md',
      '---\nid: doc.parent\naliases: [parent-alias]\ntitle: Parent\n---\n\n# Parent\n',
    );
    writeDoc(
      contentRoot,
      'ops/child1.md',
      '---\nid: doc.child1\ntitle: Child 1\nparent: doc.parent\n---\n\n# Child 1\n',
    );
    writeDoc(
      contentRoot,
      'ops/child2.md',
      '---\nid: doc.child2\ntitle: Child 2\nparent: parent-alias\n---\n\n# Child 2\n',
    );
    writeDoc(
      contentRoot,
      'ops/child3.md',
      '---\nid: doc.child3\ntitle: Child 3\nparent: content/ops/parent.md\n---\n\n# Child 3\n',
    );

    const registry = buildRegistry(contentRoot);
    const child1 = registry.byId.get('doc.child1');
    assert.ok(child1);
    assert.strictEqual(child1.parent, 'doc.parent');
    assert.strictEqual(child1.parent_id, 'doc.parent');
    const child1Dict = recordToDict(child1);
    assert.strictEqual(child1Dict.parent, 'doc.parent');
    assert.strictEqual(child1Dict.parent_id, 'doc.parent');

    const child2 = registry.byId.get('doc.child2');
    assert.ok(child2);
    assert.strictEqual(child2.parent, 'parent-alias');
    assert.strictEqual(child2.parent_id, 'doc.parent');

    const child3 = registry.byId.get('doc.child3');
    assert.ok(child3);
    assert.strictEqual(child3.parent, 'content/ops/parent.md');
    assert.strictEqual(child3.parent_id, 'doc.parent');
  });

  it('infers parent from directory structure when stem.md matches parent directory', () => {
    writeDoc(
      contentRoot,
      'topics/backend.md',
      '---\nid: doc.backend\ntitle: Backend\n---\n\n# Backend\n',
    );
    writeDoc(
      contentRoot,
      'topics/backend/database.md',
      '---\nid: doc.database\ntitle: Database\n---\n\n# Database\n',
    );
    writeDoc(
      contentRoot,
      'topics/backend/database/postgres.md',
      '---\nid: doc.postgres\ntitle: Postgres\n---\n\n# Postgres\n',
    );
    writeDoc(
      contentRoot,
      'topics/other/standalone.md',
      '---\nid: doc.standalone\ntitle: Standalone\n---\n\n# Standalone\n',
    );

    const registry = buildRegistry(contentRoot);
    const db = registry.byId.get('doc.database');
    assert.ok(db);
    assert.strictEqual(db.parent, 'doc.backend');
    assert.strictEqual(db.parent_id, 'doc.backend');

    const pg = registry.byId.get('doc.postgres');
    assert.ok(pg);
    assert.strictEqual(pg.parent, 'doc.database');
    assert.strictEqual(pg.parent_id, 'doc.database');

    const standalone = registry.byId.get('doc.standalone');
    assert.ok(standalone);
    assert.strictEqual(standalone.parent, undefined);
    assert.strictEqual(standalone.parent_id, undefined);
    const standaloneDict = recordToDict(standalone);
    assert.strictEqual(standaloneDict.parent, '');
    assert.strictEqual(standaloneDict.parent_id, '');
  });

  it('detects cycles in parent hierarchy and raises DocumentRegistryError', () => {
    writeDoc(
      contentRoot,
      'a.md',
      '---\nid: doc.a\ntitle: A\nparent: doc.b\n---\n\n# A\n',
    );
    writeDoc(
      contentRoot,
      'b.md',
      '---\nid: doc.b\ntitle: B\nparent: doc.a\n---\n\n# B\n',
    );

    assert.throws(
      () => buildRegistry(contentRoot),
      (err: unknown) => {
        assert.ok(err instanceof DocumentRegistryError);
        assert.ok(
          err.violations.some(
            (v) =>
              v.includes("cycle detected in parent hierarchy involving 'doc.a'") ||
              v.includes("cycle detected in parent hierarchy involving 'doc.b'"),
          ),
        );
        return true;
      },
    );
  });

  it('reports error on dangling parent reference and skips on validate=false', () => {
    writeDoc(
      contentRoot,
      'leaf.md',
      '---\nid: doc.leaf\ntitle: Leaf\nparent: doc.missing-parent\n---\n\n# Leaf\n',
    );

    assert.throws(
      () => buildRegistry(contentRoot),
      (err: unknown) => {
        assert.ok(err instanceof DocumentRegistryError);
        assert.ok(
          err.violations.some((v) => v.includes("parent reference not found: 'doc.missing-parent'")),
        );
        return true;
      },
    );

    const registry = buildRegistry(contentRoot, false);
    assert.strictEqual(registry.documents.length, 1);
    const leaf = registry.byId.get('doc.leaf');
    assert.ok(leaf);
    assert.strictEqual(leaf.parent_id, undefined);
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
