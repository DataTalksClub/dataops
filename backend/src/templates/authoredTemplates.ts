import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import yaml from 'js-yaml';

import { KnowledgeStore, knowledgeStoreConfigFromEnv } from '../docs/knowledgeStore';
import { expandTemplateIncludes, parseBlockFiles, type AuthoredBlockFile } from './blocks';
import { invalidateTemplateTypeMap } from '../cards/createCard';
import {
  createTemplateWithGuard,
  ensureTypeGuard,
  listTemplates,
  replaceSeedTemplate,
  writeSeedTemplateFields,
  TemplateDuplicateTypeError,
  TemplateVersionConflictError,
} from '../db/templates';
import type { Template } from '../types';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from './yamlTemplates';

type Dict = Record<string, unknown>;

export interface AuthoredTemplateFile {
  path: string;
  revision: string;
  content: string;
}

export interface AuthoredTemplateDefinition extends Dict {
  type: string;
  name: string;
  sourcePath: string;
  sourceRevision: string;
}

export interface TemplateReconciliationResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
}

const AUTHORITATIVE_FIELDS = [
  'authoredId',
  'schemaVersion',
  'department',
  'businessSystem',
  'ownerRole',
  'status',
  'criticality',
  'outcome',
  'tools',
  'reviewCycleDays',
  'lastReviewedAt',
  'nextReviewAt',
  'externalSourceDocuments',
  'name',
  'type',
  'icon',
  'cardTitle',
  'tags',
  'phases',
  'sourceDocIds',
  'references',
  'cardLinkDefinitions',
  'triggerType',
  'triggerSchedule',
  'triggerLeadDays',
  'triggerEnabled',
  'taskDefinitions',
  'sourcePath',
  'sourceRevision',
] as const;

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function definitionFields(value: Dict): Dict {
  const definition: Dict = {};
  for (const field of AUTHORITATIVE_FIELDS) {
    if (value[field] !== undefined) definition[field] = value[field];
  }
  return definition;
}

function authoredTypeFromPath(path: string): string {
  return basename(path).replace(/\.ya?ml$/i, '');
}

/**
 * Parse a complete authored-template file set without leaking template bodies
 * into failures. Detailed schema diagnostics belong to the private repository's
 * validation workflow; deployment errors identify only the safe source path.
 *
 * Blocks listed in `workflow-templates/blocks/*.yaml` expand before
 * validation: includes splice block tasks into the task list, so the expanded
 * tasks are what validation and the lossless mapping check see.
 */
export function parseAuthoredTemplateFiles(
  files: AuthoredTemplateFile[],
  blockFiles: AuthoredBlockFile[] = [],
): AuthoredTemplateDefinition[] {
  if (files.length === 0) throw new Error('No authored workflow template files found');
  const blocks = parseBlockFiles(blockFiles);

  const definitions: AuthoredTemplateDefinition[] = [];
  const seenTypes = new Set<string>();
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    let document: unknown;
    try {
      // Authored review dates are date strings, not JavaScript Date objects.
      document = yaml.load(file.content, { schema: yaml.JSON_SCHEMA });
    } catch {
      throw new Error(`${file.path}: invalid authored workflow template YAML`);
    }
    if (!isDict(document)) throw new Error(`${file.path}: authored workflow template must be an object`);
    let expanded: Dict;
    try {
      expanded = expandTemplateIncludes(document, file.path, blocks);
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error(`${file.path}: invalid authored workflow template structure`);
    }
    document = expanded;

    let issues: ReturnType<typeof validateAuthoredTemplate>;
    try {
      issues = validateAuthoredTemplate(expanded);
    } catch {
      throw new Error(`${file.path}: invalid authored workflow template structure`);
    }
    if (issues.length > 0) {
      throw new Error(`${file.path}: authored workflow template validation failed (${issues.length} issues)`);
    }

    const type = String(expanded.type);
    if (authoredTypeFromPath(file.path) !== type) {
      throw new Error(`${file.path}: filename must match the authored template type`);
    }
    if (seenTypes.has(type)) throw new Error(`${file.path}: duplicate authored workflow template type`);
    seenTypes.add(type);

    let runtime: Dict;
    try {
      runtime = templateFromYaml(expanded);
    } catch {
      throw new Error(`${file.path}: invalid authored workflow template structure`);
    }
    if (!isDeepStrictEqual(templateToYaml(runtime), expanded)) {
      throw new Error(`${file.path}: authored workflow template mapping is not lossless`);
    }
    definitions.push({
      ...runtime,
      type,
      name: String(expanded.name),
      sourcePath: file.path,
      sourceRevision: file.revision,
    } as AuthoredTemplateDefinition);
  }
  return definitions.sort((left, right) => left.type.localeCompare(right.type));
}

function localRevision(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Load authored templates from a private-repository checkout. */
export function loadAuthoredTemplatesFromDirectory(root: string): AuthoredTemplateDefinition[] {
  const directory = resolve(root);
  if (!existsSync(directory)) throw new Error('Authored workflow template directory not found');
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => {
      const content = readFileSync(join(directory, entry.name), 'utf8');
      return {
        path: `workflow-templates/${entry.name}`,
        revision: localRevision(content),
        content,
      };
    });
  const blocksDirectory = join(directory, 'blocks');
  const blockFiles: AuthoredBlockFile[] = existsSync(blocksDirectory)
    ? readdirSync(blocksDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => {
        const content = readFileSync(join(blocksDirectory, entry.name), 'utf8');
        return {
          path: `workflow-templates/blocks/${entry.name}`,
          revision: localRevision(content),
          content,
        };
      })
    : [];
  return parseAuthoredTemplateFiles(files, blockFiles);
}

/** Locate a local private-repository checkout without adding a public fallback. */
export function findAuthoredTemplatesRoot(repoRoot: string): string {
  const configured = process.env.DATAOPS_WORKFLOW_TEMPLATES_ROOT;
  const candidates = [
    ...(configured ? [isAbsolute(configured) ? configured : resolve(configured)] : []),
    join(repoRoot, '.knowledge', 'workflow-templates'),
    join(repoRoot, '..', 'dataops-knowledge', 'workflow-templates'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Authored workflow templates not found. Set DATAOPS_WORKFLOW_TEMPLATES_ROOT '
      + 'to the private dataops-knowledge workflow-templates checkout.',
    );
  }
  return found;
}

/**
 * Load the exact branch tree from the private repository. Blob reads use the
 * tree's content SHA, so a warm Lambda cannot serve a stale `/tmp` copy.
 */
export async function loadAuthoredTemplatesFromKnowledge(
  store = new KnowledgeStore(knowledgeStoreConfigFromEnv()),
): Promise<AuthoredTemplateDefinition[]> {
  const tree = await store.tree();
  const entries = Object.values(tree)
    .filter((entry) => entry.type === 'blob' && /^workflow-templates\/[^/]+\.ya?ml$/i.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const blockEntries = Object.values(tree)
    .filter((entry) => entry.type === 'blob' && /^workflow-templates\/blocks\/[^/]+\.ya?ml$/i.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const files = await Promise.all(entries.map(async (entry) => ({
    path: entry.path,
    revision: entry.sha,
    content: (await store.blobBytes(entry.sha)).toString('utf8'),
  })));
  const blockFiles: AuthoredBlockFile[] = await Promise.all(blockEntries.map(async (entry) => ({
    path: entry.path,
    revision: entry.sha,
    content: (await store.blobBytes(entry.sha)).toString('utf8'),
  })));
  return parseAuthoredTemplateFiles(files, blockFiles);
}

function runtimeTypes(templates: Template[]): Map<string, Template[]> {
  const byType = new Map<string, Template[]>();
  for (const template of templates) {
    const type = String(template.type || '');
    const matches = byType.get(type) || [];
    matches.push(template);
    byType.set(type, matches);
  }
  return byType;
}

/** A Git-origin row the seed may reconcile: full canonical shape. */
function isCanonicalGitRow(template: Template): boolean {
  return template.origin === 'git'
    && typeof template.revision === 'string'
    && template.revision.length > 0
    && typeof template.pinned === 'boolean'
    && isDict(template.base);
}

/**
 * Reconcile Git definitions into their DynamoDB projection.
 *
 * Classification is pure and runs before any write. Canonical `git` rows
 * follow the normal update path; malformed `git` rows, explicit `custom`
 * rows colliding with an authored type, and any unclassified rows fail
 * closed before writes. No silent adoption, no silent deletion, no per-row
 * fallbacks.
 */
export async function reconcileAuthoredTemplates(
  client: DynamoDBDocumentClient,
  authored: AuthoredTemplateDefinition[],
): Promise<TemplateReconciliationResult> {
  if (authored.length === 0) throw new Error('No authored workflow templates to reconcile');
  const authoredTypes = new Set(authored.map((template) => template.type));
  if (authoredTypes.size !== authored.length) throw new Error('Duplicate authored workflow template types');

  const existing = await listTemplates(client);
  const byType = runtimeTypes(existing);
  const duplicateRuntimeTypes = [...byType.entries()]
    .filter(([, templates]) => templates.length > 1)
    .map(([type]) => type || '(missing)')
    .sort();
  if (duplicateRuntimeTypes.length > 0) {
    throw new Error(`Duplicate runtime workflow template types: ${duplicateRuntimeTypes.join(', ')}`);
  }

  // Classification preflight: every stored row must be canonical-git or
  // explicit-custom, or it stops the seed before any write.
  for (const template of existing) {
    const type = String(template.type || '');
    const origin = template.origin;
    if (origin === 'git') {
      if (!type || !authoredTypes.has(type)) {
        throw new Error(`Runtime workflow template types are absent from Git: ${type || '(missing)'}`);
      }
      if (!isCanonicalGitRow(template)) {
        throw new Error(`Malformed canonical Git workflow template ${template.id}: missing revision, pinned, or base`);
      }
      continue;
    }
    if (origin === 'custom') {
      if (type && authoredTypes.has(type)) {
        throw new Error(`collides with custom template: ${type}`);
      }
      continue;
    }
    throw new Error(`Unclassified runtime workflow template ${template.id}: missing or invalid canonical origin`);
  }

  // Claim or verify TEMPLATE_TYPE# guards before any create.
  // A guard owned by another row is a real duplicate the seed must not silently merge.
  for (const template of existing) {
    if (template.type) await ensureTypeGuard(client, template.type, template.id);
  }

  const result: TemplateReconciliationResult = {
    total: authored.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };
  for (const definition of authored) {
    const fields = definitionFields(definition);
    const base = { ...fields };
    const current = byType.get(definition.type)?.[0];
    if (!current) {
      try {
        await createTemplateWithGuard(client, {
          ...fields,
          origin: 'git',
          pinned: false,
          base,
          baseSourceRevision: (fields.sourceRevision as string | undefined) ?? null,
        }, definition.type);
      } catch (error) {
        if (error instanceof TemplateDuplicateTypeError || error instanceof TemplateVersionConflictError) {
          throw new Error(`Runtime workflow template type '${definition.type}' collided during seed`);
        }
        throw error;
      }
      invalidateTemplateTypeMap();
      result.created += 1;
      continue;
    }
    if (current.origin === 'custom') {
      // Belt and braces: the preflight already rejects this shape.
      throw new Error(`collides with custom template: ${definition.type}`);
    }
    if (!isCanonicalGitRow(current)) {
      throw new Error(`Malformed canonical Git workflow template ${current.id}: missing revision, pinned, or base`);
    }
    const pinned = current.pinned === true && isDict(current.base);
    if (!pinned) {
      if (isDeepStrictEqual(definitionFields(current as unknown as Dict), fields)) {
        result.unchanged += 1;
        continue;
      }
      await replaceSeedTemplate(client, current.id, fields, current.version);
      result.updated += 1;
      continue;
    }
    if (isDeepStrictEqual(current.base as Dict, base)) {
      result.unchanged += 1;
      continue;
    }
    await writeSeedTemplateFields(client, current.id, {
      origin: 'git',
      pinned: true,
      base,
      baseSourceRevision: (fields.sourceRevision as string | undefined) ?? null,
    }, current.version);
    result.updated += 1;
  }
  return result;
}
