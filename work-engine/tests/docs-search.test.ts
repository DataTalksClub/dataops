import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createSearchIndex,
  loadSearchIndex,
  DOCS_TEXT_FIELDS,
  DOCS_KEYWORD_FIELDS,
  DOCS_BOOSTS,
  type SearchDocument,
  type SearchResult,
} from '../src/docs/searchIndex';
import { extractDoc, iterContentDocs } from '../src/docs/search/extract';

const CONTENT_DIR = resolve(__dirname, '..', '..', 'content');
const paths = (results: SearchResult[]): string[] => results.map((r) => String(r.path));

describe('docs search - field config (parity with docs_index.py)', () => {
  it('carries the minsearch text fields, keyword fields, and boosts verbatim', () => {
    assert.deepStrictEqual(
      [...DOCS_TEXT_FIELDS],
      ['title', 'summary', 'description', 'purpose', 'headings', 'body', 'tags', 'systems'],
    );
    assert.deepStrictEqual([...DOCS_KEYWORD_FIELDS], ['path', 'id', 'domain', 'doc_type']);
    assert.deepStrictEqual(DOCS_BOOSTS, {
      title: 4.0,
      summary: 3.0,
      description: 3.0,
      purpose: 3.0,
      headings: 2.0,
      body: 1.0,
    });
  });
});

describe('docs search - extraction (port of iter_docs)', () => {
  it('derives id/domain/doc_type and strips markdown noise from body', () => {
    const raw = [
      '---',
      'title: Create a podcast document',
      'summary: How to create the podcast doc',
      'tags: [podcast, media]',
      'systems: [Google Docs]',
      '---',
      '',
      '# Create a podcast document',
      '',
      'Open the ![logo](logo.png) [Google Doc](https://docs.example) and `paste` text.',
      '',
      '```bash',
      'echo secret-code-block',
      '```',
      '',
      '## Step one',
      'Do the thing.',
    ].join('\n');

    const doc = extractDoc('content/media/podcast/sops/create-a-podcast-document.md', raw);

    assert.strictEqual(doc.domain, 'media');
    assert.strictEqual(doc.doc_type, 'sop');
    // generated id: drop "sops" segment, dot-join, doc_type prefix
    assert.strictEqual(doc.id, 'sop.media.podcast.create-a-podcast-document');
    assert.strictEqual(doc.title, 'Create a podcast document');
    assert.strictEqual(doc.tags, 'podcast, media');
    assert.strictEqual(doc.systems, 'Google Docs');
    // description falls back to summary when absent
    assert.strictEqual(doc.description, 'How to create the podcast doc');
    // headings joined, body cleaned (no code block, no image, link text kept)
    assert.match(String(doc.headings), /Create a podcast document/);
    assert.match(String(doc.headings), /Step one/);
    assert.doesNotMatch(String(doc.body), /secret-code-block/);
    assert.doesNotMatch(String(doc.body), /logo\.png/);
    assert.match(String(doc.body), /Google Doc/);
    assert.match(String(doc.body), /paste text/);
  });

  it('uses explicit frontmatter id and doc_type when present', () => {
    const raw = ['---', 'id: my.custom.id', 'doc_type: reference', 'title: Ref', '---', '', 'body'].join('\n');
    const doc = extractDoc('content/courses/reference/thing.md', raw);
    assert.strictEqual(doc.id, 'my.custom.id');
    assert.strictEqual(doc.doc_type, 'reference');
  });
});

describe('docs search - keyword filter + boost (synthetic corpus)', () => {
  const corpus: SearchDocument[] = [
    { path: 'content/de/a.md', id: 'a', domain: 'de', doc_type: 'sop', title: 'Docker compose setup', body: 'start services with docker' },
    { path: 'content/de/b.md', id: 'b', domain: 'de', doc_type: 'reference', title: 'Networking', body: 'how to run docker compose containers' },
    { path: 'content/ml/c.md', id: 'c', domain: 'ml', doc_type: 'sop', title: 'Docker compose for ML', body: 'docker compose for training' },
  ];

  it('returns only docs matching a domain filter', () => {
    const index = createSearchIndex().fit(corpus);
    const results = index.search('docker compose', { filter: { domain: 'de' } });
    assert.deepStrictEqual(new Set(paths(results)), new Set(['content/de/a.md', 'content/de/b.md']));
  });

  it('exact-matches keyword fields (doc_type)', () => {
    const index = createSearchIndex().fit(corpus);
    const results = index.search('docker', { filter: { doc_type: 'sop' } });
    assert.deepStrictEqual(new Set(paths(results)), new Set(['content/de/a.md', 'content/ml/c.md']));
  });

  it('ranks title matches higher when title is boosted', () => {
    const index = createSearchIndex().fit(corpus);
    // doc b has the phrase in body only; a and c have it in the title.
    const boosted = index.search('docker compose', { filter: { domain: 'de' }, boost: { title: 50 } });
    assert.strictEqual(boosted[0].path, 'content/de/a.md', 'title-match should rank first under a title boost');
  });
});

describe('docs search - save/load round-trip (json-1)', () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'docs-search-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces identical results after save + loadSearchIndex', async () => {
    const corpus: SearchDocument[] = [
      { path: 'content/x/1.md', id: '1', domain: 'x', doc_type: 'sop', title: 'Alpha', body: 'alpha beta gamma' },
      { path: 'content/x/2.md', id: '2', domain: 'x', doc_type: 'doc', title: 'Beta', body: 'beta gamma delta' },
    ];
    const built = createSearchIndex().fit(corpus);
    const before = built.search('beta gamma');

    const file = join(dir, 'index.json');
    await built.save(file);
    const loaded = await loadSearchIndex(file);
    const after = loaded.search('beta gamma');

    assert.deepStrictEqual(paths(after), paths(before));
    assert.deepStrictEqual(
      after.map((r) => r._score),
      before.map((r) => r._score),
    );
  });
});

// Smoke fixtures updated for TF-IDF (minsearch) -> BM25-lite (zerosearch).
// Captured against a minsearch top-k baseline: top-1 is identical for every
// query below; ordering shifts inside the relevant set, recall stays on par
// (see issue #85 notes). Each fixture asserts the BM25-lite top-1 plus a doc
// that must remain in the top-5 (recall guard).
const SMOKE: { query: string; top1: string; recall: string }[] = [
  {
    query: 'podcast intake',
    top1: 'content/media/podcast/templates/podcast-share-the-podcast-page-template.md',
    recall: 'content/tasks/templates/podcast.md',
  },
  {
    query: 'newsletter sponsor',
    top1: 'content/overview/reference/newsletter.md',
    recall: 'content/newsletter/sponsorship/sops/creating-a-document-for-sponsored-content-for-a-newsletter.md',
  },
  {
    query: 'course certificate',
    top1: 'content/tasks/templates/course.md',
    recall: 'content/courses/reference/course-guide.md',
  },
  {
    query: 'youtube upload',
    top1: 'content/media/open-source-spotlight/reference/for-update-download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube.md',
    recall: 'content/media/video-youtube/sops/downloading-and-uploading-videos-from-loom-to-youtube.md',
  },
];

describe('docs search - smoke query relevance over content/ (BM25-lite)', () => {
  let index: ReturnType<typeof createSearchIndex>;
  before(() => {
    const docs = iterContentDocs(CONTENT_DIR);
    index = createSearchIndex().fit(docs);
  });

  for (const { query, top1, recall } of SMOKE) {
    it(`ranks the expected doc first and keeps recall for "${query}"`, () => {
      const results = index.search(query, { numResults: 5 });
      assert.ok(results.length > 0, 'expected at least one result');
      assert.strictEqual(results[0].path, top1, `top-1 for "${query}"`);
      assert.ok(paths(results).includes(recall), `"${recall}" should be in top-5 for "${query}"`);
    });
  }
});
