#!/usr/bin/env node

/**
 * Renders the committed Google Doc -> internal SOP mapping process doc.
 *
 * Sources, merged in this order:
 *   1. Git-authored task definitions that already carry both an
 *      `instructionsUrl` (Google Doc) and an `instructionDocId`.
 *   2. Curated entries in `google-doc-sop-map.ts`.
 *
 * Every internal doc ID is checked against the content registry. An unresolvable
 * ID fails the build rather than shipping a mapping doc that lies.
 *
 * Usage:
 *   npx tsx scripts/build-google-doc-map.ts [--check]
 *
 *   --check  Verify the committed doc is up to date without writing it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildRegistry } from '../src/docs/docRegistry';
import {
  findAuthoredTemplatesRoot,
  loadAuthoredTemplatesFromDirectory,
} from '../src/templates/authoredTemplates';
import { GOOGLE_DOC_SOPS, TASK_INSTRUCTION_DOCS } from './google-doc-sop-map';

/**
 * Locate the process document corpus. It lives in the private knowledge
 * repository, so DATAOPS_CONTENT_ROOT points at a checkout; a sibling checkout
 * or a local copy is found automatically.
 */
function findContentRoot(repoRoot: string): string {
  const configured = process.env.DATAOPS_CONTENT_ROOT;
  const candidates = [
    ...(configured ? [resolve(configured)] : []),
    join(repoRoot, 'content'),
    join(repoRoot, '.knowledge', 'content'),
    join(repoRoot, '..', 'dataops-knowledge', 'content'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Process document corpus not found. Set DATAOPS_CONTENT_ROOT to a checkout of '
      + 'DataTalksClub/dataops-knowledge, or check it out beside this repository.',
    );
  }
  return found;
}

const repoRoot = resolve(__dirname, '..', '..');
const contentRoot = findContentRoot(repoRoot);
const authoredTemplates = loadAuthoredTemplatesFromDirectory(findAuthoredTemplatesRoot(repoRoot));
const outputPath = join(
  contentRoot,
  'internal-admin',
  'documentation',
  'reference',
  'google-doc-to-internal-sop-map.md',
);
const CHECK_ONLY = process.argv.includes('--check');

interface Entry {
  gdocId: string;
  url: string;
  label: string;
  docIds: string[];
  usedBy: string[];
}

function googleDocId(url: string): string | null {
  const match = url.match(/\/d\/([^/?#]+)/);
  return match ? match[1] : null;
}

function collect(): Entry[] {
  const entries = new Map<string, Entry>();

  const upsert = (url: string, label: string): Entry => {
    const gdocId = googleDocId(url) as string;
    let entry = entries.get(gdocId);
    if (!entry) {
      entry = { gdocId, url, label, docIds: [], usedBy: [] };
      entries.set(gdocId, entry);
    }
    return entry;
  };

  for (const template of authoredTemplates as any[]) {
    for (const reference of template.references || []) {
      if (!isGoogleDoc(reference.url)) continue;
      const entry = upsert(reference.url, reference.name);
      entry.usedBy.push(`${template.type} (reference)`);
    }
    for (const task of template.taskDefinitions || []) {
      if (!isGoogleDoc(task.instructionsUrl)) continue;
      const entry = upsert(task.instructionsUrl, task.description);
      const taskKey = `${template.type}/${task.refId}`;
      entry.usedBy.push(taskKey);
      const docId = task.instructionDocId || TASK_INSTRUCTION_DOCS[taskKey];
      if (docId && !entry.docIds.includes(docId)) {
        entry.docIds.push(docId);
      }
    }
  }

  // The curated map is the durable record. Templates drop their Google Doc URLs
  // as they migrate, so entries must survive even with no remaining reference.
  for (const [gdocId, curated] of Object.entries(GOOGLE_DOC_SOPS)) {
    let entry = entries.get(gdocId);
    if (!entry) {
      entry = {
        gdocId,
        url: `https://docs.google.com/document/d/${gdocId}/edit`,
        label: curated.label,
        docIds: [],
        usedBy: [],
      };
      entries.set(gdocId, entry);
    }
    entry.label = curated.label;
    for (const docId of curated.docIds) {
      if (!entry.docIds.includes(docId)) entry.docIds.push(docId);
    }
  }

  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function isGoogleDoc(url: unknown): url is string {
  return typeof url === 'string' && /docs\.google\.com/.test(url) && googleDocId(url) !== null;
}

function validate(entries: Entry[]): void {
  const registry = buildRegistry(contentRoot, false);
  const knownIds = new Set(registry.documents.map((doc: any) => doc.id));

  const unknown: string[] = [];
  for (const entry of entries) {
    for (const docId of entry.docIds) {
      if (!knownIds.has(docId)) unknown.push(`${entry.gdocId} -> ${docId}`);
    }
  }
  for (const [taskKey, docId] of Object.entries(TASK_INSTRUCTION_DOCS)) {
    if (!knownIds.has(docId)) unknown.push(`${taskKey} -> ${docId}`);
  }

  if (unknown.length > 0) {
    console.error('Unresolvable internal doc IDs:');
    unknown.forEach((line) => console.error(`  ${line}`));
    process.exit(1);
  }
}

function render(entries: Entry[]): string {
  const mapped = entries.filter((entry) => entry.docIds.length > 0);
  const split = mapped.filter((entry) => entry.docIds.length > 1);
  const unmapped = entries.filter((entry) => entry.docIds.length === 0);

  const lines = [
    '---',
    'title: "Google Doc to internal SOP map"',
    'summary: Migration record mapping the Google Docs referenced by DataTasks templates to the internal process docs that replaced them.',
    'doc_type: reference',
    'schema_version: 1',
    'source: "backend/scripts/google-doc-sop-map.ts"',
    'tags:',
    '  - migration',
    '  - process-docs',
    'systems:',
    '  - dataops',
    '  - datatasks',
    'related_docs:',
    '  - reference.internal-admin.documentation.process-documents-overview',
    '---',
    '',
    '# Google Doc to internal SOP map',
    '',
    '<!-- sop-section-start: summary -->',
    '## Summary',
    '',
    `- Google Docs referenced by task templates: ${entries.length}`,
    `- Mapped to an internal process doc: ${mapped.length}`,
    `- Split across more than one internal doc: ${split.length}`,
    `- Still unmapped: ${unmapped.length}`,
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: purpose -->',
    '## Purpose',
    '',
    'DataTasks templates originally linked every task to a Google Doc inherited from',
    'the Trello board. Internal process docs under `content/` are now canonical and',
    'are what operators open from a task. This document keeps the trail back to the',
    'original Google Doc so a process can be audited or a gap in the internal doc can',
    'be checked against its source.',
    '',
    'Google Doc links are migration provenance only. They are not the operative',
    'instruction link and must not be reintroduced into template task definitions.',
    '',
    'This file is generated. Edit `backend/scripts/google-doc-sop-map.ts` and re-run',
    '`npx tsx scripts/build-google-doc-map.ts` from `backend/` instead of editing it',
    'by hand.',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: split-documents -->',
    '## Google Docs split across several internal docs',
    '',
    'These Google Docs each became more than one internal process doc. A task that',
    'used one of them cannot be resolved from the Google Doc ID alone; the correct',
    'internal doc is chosen per task in `TASK_INSTRUCTION_DOCS`.',
    '',
  ];

  if (split.length === 0) {
    lines.push('- None.');
  } else {
    lines.push('| Original document | Internal docs | Used by |', '| - | - | - |');
    for (const entry of split) {
      lines.push([
        escapeCell(entry.label),
        entry.docIds.map(code).join('<br>'),
        entry.usedBy.map(escapeCell).join('<br>'),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
  }

  lines.push('<!-- sop-section-end -->', '');

  lines.push(
    '<!-- sop-section-start: mapping -->',
    '## Full mapping',
    '',
    '| Original document | Google Doc ID | Internal doc | Used by |',
    '| - | - | - | - |',
  );
  for (const entry of mapped) {
    lines.push([
      escapeCell(entry.label),
      code(entry.gdocId),
      entry.docIds.map(code).join('<br>'),
      entry.usedBy.map(escapeCell).join('<br>'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('<!-- sop-section-end -->', '');

  lines.push(
    '<!-- sop-section-start: unmapped -->',
    '## Unmapped documents',
    '',
  );
  if (unmapped.length === 0) {
    lines.push('- None. Every Google Doc referenced by a task template resolves to an internal process doc.');
  } else {
    lines.push('| Original document | Google Doc ID | Used by |', '| - | - | - |');
    for (const entry of unmapped) {
      lines.push([
        escapeCell(entry.label),
        code(entry.gdocId),
        entry.usedBy.map(escapeCell).join('<br>'),
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
  }
  lines.push('<!-- sop-section-end -->', '');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function escapeCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function code(value: string): string {
  return '`' + value + '`';
}

const entries = collect();
validate(entries);
const rendered = render(entries);

if (CHECK_ONLY) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== rendered) {
    console.error(`${outputPath} is out of date. Run: npx tsx scripts/build-google-doc-map.ts`);
    process.exit(1);
  }
  console.log('Google Doc map is up to date.');
} else {
  writeFileSync(outputPath, rendered, 'utf8');
  const mapped = entries.filter((entry) => entry.docIds.length > 0).length;
  console.log(`Wrote ${outputPath}`);
  console.log(`  ${entries.length} Google Docs, ${mapped} mapped, ${entries.length - mapped} unmapped`);
}
