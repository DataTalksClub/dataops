#!/usr/bin/env node

/**
 * One-time migration: turn the TypeScript template array into authored YAML.
 *
 * After this runs, the YAML files are the source and this script has no further
 * purpose. It refuses to write anything that would not round-trip back to the
 * template it came from, so the migration cannot quietly drop a field.
 *
 * Usage:
 *   npx tsx scripts/export-templates-to-yaml.ts --out <dir> [--check]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert';
import yaml from 'js-yaml';

import { buildRegistry } from '../src/docs/docRegistry';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import { DEFAULT_TEMPLATES } from './seed-templates';

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

const HEADER = `# Authored workflow template.
#
# This file is the source of truth for the process. Editing it changes the
# template; nothing regenerates it. Every instruction_doc_id must resolve to a
# process document in the knowledge repository, which the loader enforces.
`;

function readFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const outDir = resolve(readFlag('--out', join(__dirname, '..', '..', '.tmp', 'workflow-templates')));
const checkOnly = process.argv.includes('--check');

const registry = buildRegistry(findContentRoot(resolve(join(__dirname, '..', '..'))), false);
const knownDocIds = new Set(registry.documents.map((doc) => doc.id));

if (!checkOnly) mkdirSync(outDir, { recursive: true });

let written = 0;
const problems: string[] = [];

for (const template of DEFAULT_TEMPLATES as Record<string, unknown>[]) {
  const type = String(template.type);
  const authored = templateToYaml(template);

  // Refuse to emit anything lossy: the file must rebuild its own template.
  try {
    assert.deepStrictEqual(templateFromYaml(authored), template);
  } catch {
    problems.push(`${type}: does not round-trip, refusing to write`);
    continue;
  }

  for (const issue of validateAuthoredTemplate(authored, knownDocIds)) {
    problems.push(`${type}: ${issue.message}`);
  }

  const body = HEADER + yaml.dump(authored, { lineWidth: 100, noRefs: true, quotingType: '"' });
  const path = join(outDir, `${type}.yaml`);

  if (checkOnly) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== body) {
      problems.push(`${type}: ${path} is out of date`);
    }
    continue;
  }

  writeFileSync(path, body, 'utf8');
  written += 1;
}

if (problems.length > 0) {
  console.error('Template export failed:');
  problems.forEach((problem) => console.error(`- ${problem}`));
  process.exit(1);
}

console.log(checkOnly ? 'Authored templates are up to date.' : `Wrote ${written} templates to ${outDir}`);
