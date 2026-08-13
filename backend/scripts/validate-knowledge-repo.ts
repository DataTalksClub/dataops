#!/usr/bin/env node

/**
 * Validates the dataops-knowledge migration scaffold: the required directory
 * layout, the workflow-template JSON Schema shape, and the migration manifest
 * that maps each current Markdown task template to its future YAML target.
 *
 * Usage:
 *   npx tsx scripts/validate-knowledge-repo.ts [--repo-root <path>] [--scaffold-root <path>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { parseFrontmatter, splitFrontmatter } from '../src/docs/sop';

const REQUIRED_SCAFFOLD_DIRS = [
  'content', 'workflow-templates', 'assistant-prompts', 'assistant-process',
  'examples', 'images', 'indexes', 'schemas', 'scripts', 'tests',
];
const EXPECTED_TEMPLATE_SLUGS = [
  'book-of-the-week', 'course', 'maven-ll', 'newsletter', 'office-hours',
  'oss', 'podcast', 'social-media', 'tax-report', 'webinar', 'workshop',
];
const WORKFLOW_SCHEMA_REQUIRED_FIELDS = [
  'id', 'type', 'name', 'schema_version', 'trigger', 'card_links', 'phases',
  'tasks', 'default_assignee', 'source_document_ids',
];
const TASK_REQUIRED_FIELDS = [
  'id', 'name', 'phase_id', 'stage', 'schedule', 'default_assignee',
  'required_proofs', 'required_links', 'instruction_doc_id',
];
const TARGET_PATH_RE = /^workflow-templates\/[a-z0-9][a-z0-9-]*\.yaml$/;
const STABLE_ID_RE = /^task-template\.tasks\.[a-z0-9][a-z0-9-]*$/;
const RUNTIME_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function validate(repoRoot: string, scaffoldRoot = 'templates/dataops-knowledge'): string[] {
  const root = resolve(repoRoot);
  const scaffold = resolve(isAbsolute(scaffoldRoot) ? scaffoldRoot : join(root, scaffoldRoot));
  const violations: string[] = [];

  violations.push(...validateScaffoldDirs(root, scaffold));

  const schemaPath = join(scaffold, 'schemas', 'workflow-template.schema.json');
  const schema = loadJson(schemaPath, root, violations, 'workflow-template schema');
  if (isObject(schema)) violations.push(...validateWorkflowSchemaShape(schema, root, schemaPath));

  const manifestPath = join(scaffold, 'indexes', 'workflow-template-migration-manifest.json');
  const manifest = loadJson(manifestPath, root, violations, 'workflow-template migration manifest');
  if (isObject(manifest)) violations.push(...validateManifest(root, manifestPath, manifest));

  return violations;
}

function validateScaffoldDirs(repoRoot: string, scaffoldRoot: string): string[] {
  if (!existsSync(scaffoldRoot)) {
    return [`${repoPath(repoRoot, scaffoldRoot)}: scaffold directory is required`];
  }
  const violations: string[] = [];
  for (const dir of REQUIRED_SCAFFOLD_DIRS) {
    const path = join(scaffoldRoot, dir);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      violations.push(`${repoPath(repoRoot, path)}: required scaffold directory is missing`);
    }
  }
  return violations;
}

function validateWorkflowSchemaShape(schema: JsonObject, repoRoot: string, schemaPath: string): string[] {
  const source = repoPath(repoRoot, schemaPath);
  const violations: string[] = [];
  if (schema.type !== 'object') violations.push(`${source}: schema root type must be object`);
  if (schema.additionalProperties !== false) {
    violations.push(`${source}: schema root must set additionalProperties to false`);
  }

  const required = new Set(asStrings(schema.required));
  for (const field of [...WORKFLOW_SCHEMA_REQUIRED_FIELDS].filter((f) => !required.has(f)).sort()) {
    violations.push(`${source}: schema required fields missing '${field}'`);
  }

  if (!isObject(schema.properties)) {
    violations.push(`${source}: schema properties must be an object`);
    return violations;
  }
  const properties = schema.properties;
  for (const field of [...WORKFLOW_SCHEMA_REQUIRED_FIELDS].sort()) {
    if (!(field in properties)) violations.push(`${source}: schema properties missing '${field}'`);
  }

  if (!isObject(schema.$defs)) {
    violations.push(`${source}: schema $defs must be an object`);
    return violations;
  }
  const taskSchema = schema.$defs.task;
  if (!isObject(taskSchema)) {
    violations.push(`${source}: schema $defs.task is required`);
    return violations;
  }
  const taskRequired = new Set(asStrings(taskSchema.required));
  for (const field of [...TASK_REQUIRED_FIELDS].filter((f) => !taskRequired.has(f)).sort()) {
    violations.push(`${source}: task schema required fields missing '${field}'`);
  }
  return violations;
}

function validateManifest(repoRoot: string, manifestPath: string, manifest: JsonObject): string[] {
  const source = repoPath(repoRoot, manifestPath);
  const violations: string[] = [];
  if (manifest.schema_version !== 1) violations.push(`${source}: schema_version must be 1`);
  if (manifest.source_root !== 'content/tasks/templates') {
    violations.push(`${source}: source_root must be 'content/tasks/templates'`);
  }
  if (manifest.target_root !== 'workflow-templates') {
    violations.push(`${source}: target_root must be 'workflow-templates'`);
  }

  const entries = manifest.templates;
  if (!Array.isArray(entries)) {
    violations.push(`${source}: templates must be a list`);
    return violations;
  }

  const templatesDir = join(repoRoot, 'content', 'tasks', 'templates');
  const currentSources = new Set(
    (existsSync(templatesDir) ? readdirSync(templatesDir) : [])
      .filter((name) => name.endsWith('.md'))
      .map((name) => repoPath(repoRoot, join(templatesDir, name))),
  );
  const expectedSources = new Set(EXPECTED_TEMPLATE_SLUGS.map((slug) => `content/tasks/templates/${slug}.md`));
  if (!setsEqual(currentSources, expectedSources)) {
    for (const path of difference(expectedSources, currentSources)) {
      violations.push(`${path}: expected current Markdown template file is missing`);
    }
    for (const path of difference(currentSources, expectedSources)) {
      violations.push(`${path}: unexpected current Markdown template file is present`);
    }
  }

  const seenIds = new Map<string, number>();
  const seenSources = new Map<string, number>();
  const seenTargets = new Map<string, number>();
  const mappedSources = new Set<string>();

  entries.forEach((entry, index) => {
    const label = `${source}: templates[${index}]`;
    if (!isObject(entry)) {
      violations.push(`${label}: entry must be an object`);
      return;
    }

    const stableId = requiredString(entry, 'stable_id', label, violations);
    const runtimeType = requiredString(entry, 'runtime_type', label, violations);
    const sourcePath = requiredString(entry, 'source_path', label, violations);
    const targetPath = requiredString(entry, 'target_path', label, violations);
    if (!stableId || !runtimeType || !sourcePath || !targetPath) return;

    if (!STABLE_ID_RE.test(stableId)) {
      violations.push(`${label}: stable_id must match task-template.tasks.<slug>, got '${stableId}'`);
    }
    if (!RUNTIME_TYPE_RE.test(runtimeType)) {
      violations.push(`${label}: runtime_type must be a slug, got '${runtimeType}'`);
    }
    if (!expectedSources.has(sourcePath)) {
      violations.push(`${label}: source_path must be one of the current task templates, got '${sourcePath}'`);
    }
    if (!TARGET_PATH_RE.test(targetPath)) {
      violations.push(`${label}: target_path must match workflow-templates/*.yaml, got '${targetPath}'`);
    }

    recordDuplicate(seenIds, stableId, index, label, 'stable_id', violations);
    recordDuplicate(seenSources, sourcePath, index, label, 'source_path', violations);
    recordDuplicate(seenTargets, targetPath, index, label, 'target_path', violations);
    mappedSources.add(sourcePath);

    const templatePath = join(repoRoot, sourcePath);
    if (!existsSync(templatePath) || !statSync(templatePath).isFile()) {
      violations.push(`${label}: source Markdown template is missing: ${sourcePath}`);
      return;
    }
    violations.push(...validateCurrentTemplateFrontmatter(repoRoot, templatePath, stableId, label));
  });

  for (const sourcePath of difference(expectedSources, mappedSources)) {
    violations.push(`${source}: missing migration mapping for ${sourcePath}`);
  }
  for (const sourcePath of difference(mappedSources, expectedSources)) {
    violations.push(`${source}: unexpected migration mapping for ${sourcePath}`);
  }
  if (entries.length !== EXPECTED_TEMPLATE_SLUGS.length) {
    violations.push(`${source}: expected ${EXPECTED_TEMPLATE_SLUGS.length} template mappings, found ${entries.length}`);
  }

  return violations;
}

function validateCurrentTemplateFrontmatter(
  repoRoot: string,
  templatePath: string,
  expectedId: string,
  label: string,
): string[] {
  const violations: string[] = [];
  const [raw] = splitFrontmatter(readFileSync(templatePath, 'utf8'));
  const metadata = (raw ? parseFrontmatter(raw) : {}) as Record<string, unknown>;
  const path = repoPath(repoRoot, templatePath);
  const actualId = String(metadata.id ?? '').trim();
  if (!actualId) violations.push(`${label}: ${path} frontmatter id is required`);
  else if (actualId !== expectedId) {
    violations.push(`${label}: ${path} frontmatter id '${actualId}' does not match stable_id '${expectedId}'`);
  }
  if (metadata.doc_type !== 'task-template') {
    const actual = metadata.doc_type === undefined ? 'None' : `'${String(metadata.doc_type)}'`;
    violations.push(`${label}: ${path} frontmatter doc_type must be task-template, got ${actual}`);
  }
  return violations;
}

function loadJson(path: string, repoRoot: string, violations: string[], label: string): Json {
  if (!existsSync(path) || !statSync(path).isFile()) {
    violations.push(`${repoPath(repoRoot, path)}: ${label} file is required`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    violations.push(`${repoPath(repoRoot, path)}: invalid JSON: ${(error as Error).message}`);
    return null;
  }
}

function recordDuplicate(
  seen: Map<string, number>,
  value: string,
  index: number,
  label: string,
  field: string,
  violations: string[],
): void {
  const first = seen.get(value);
  if (first !== undefined) {
    violations.push(`${label}: duplicate ${field} '${value}'; first seen at templates[${first}]`);
  } else {
    seen.set(value, index);
  }
}

function requiredString(entry: JsonObject, key: string, label: string, violations: string[]): string {
  const value = entry[key];
  if (typeof value !== 'string' || !value.trim()) {
    violations.push(`${label}: ${key} is required`);
    return '';
  }
  return value.trim();
}

function asStrings(value: Json): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((item) => !b.has(item)).sort();
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function repoPath(repoRoot: string, path: string): string {
  const rel = relative(repoRoot, resolve(path));
  if (rel.startsWith('..')) return resolve(path).split(/[\\/]/).join('/');
  return rel.split(/[\\/]/).join('/');
}

function readFlag(name: string, fallback: string): string {
  // Last occurrence wins, so `npm run <script> -- --flag value` overrides the
  // value baked into the npm script rather than being silently ignored.
  const index = process.argv.lastIndexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

if (require.main === module) {
  const violations = validate(readFlag('--repo-root', process.cwd()), readFlag('--scaffold-root', 'templates/dataops-knowledge'));
  if (violations.length > 0) {
    console.error('Knowledge repository scaffold validation failed:');
    violations.forEach((violation) => console.error(`- ${violation}`));
    process.exit(1);
  }
  console.log('Knowledge repository scaffold validation passed.');
}
