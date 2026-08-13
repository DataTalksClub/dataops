import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import yaml from 'js-yaml';

import { ContentsApiGithubStore, githubStoreConfigFromEnv } from '../docs/githubStore';
import { createTemplate, listTemplates, replaceTemplate } from '../db/templates';
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
  'name',
  'type',
  'emoji',
  'tags',
  'defaultAssigneeId',
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
 */
export function parseAuthoredTemplateFiles(files: AuthoredTemplateFile[]): AuthoredTemplateDefinition[] {
  if (files.length === 0) throw new Error('No authored workflow template files found');

  const definitions: AuthoredTemplateDefinition[] = [];
  const seenTypes = new Set<string>();
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    let document: unknown;
    try {
      document = yaml.load(file.content);
    } catch {
      throw new Error(`${file.path}: invalid authored workflow template YAML`);
    }
    if (!isDict(document)) throw new Error(`${file.path}: authored workflow template must be an object`);

    const issues = validateAuthoredTemplate(document);
    if (issues.length > 0) {
      throw new Error(`${file.path}: authored workflow template validation failed (${issues.length} issues)`);
    }

    const type = String(document.type);
    if (authoredTypeFromPath(file.path) !== type) {
      throw new Error(`${file.path}: filename must match the authored template type`);
    }
    if (seenTypes.has(type)) throw new Error(`${file.path}: duplicate authored workflow template type`);
    seenTypes.add(type);

    const runtime = templateFromYaml(document);
    if (!isDeepStrictEqual(templateToYaml(runtime), document)) {
      throw new Error(`${file.path}: authored workflow template mapping is not lossless`);
    }
    definitions.push({
      ...runtime,
      type,
      name: String(document.name),
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
  return parseAuthoredTemplateFiles(files);
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
export async function loadAuthoredTemplatesFromGithub(
  store = new ContentsApiGithubStore(githubStoreConfigFromEnv()),
): Promise<AuthoredTemplateDefinition[]> {
  const tree = await store.tree();
  const entries = Object.values(tree)
    .filter((entry) => entry.type === 'blob' && /^workflow-templates\/[^/]+\.ya?ml$/i.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const files = await Promise.all(entries.map(async (entry) => ({
    path: entry.path,
    revision: entry.sha,
    content: (await store.blobBytes(entry.sha)).toString('utf8'),
  })));
  return parseAuthoredTemplateFiles(files);
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

/**
 * Reconcile Git definitions into their DynamoDB projection. The full runtime
 * definition is replaced, not patched, so removed YAML fields cannot survive
 * as stale database authority.
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

  const runtimeOnlyTypes = [...byType.keys()]
    .filter((type) => !authoredTypes.has(type))
    .map((type) => type || '(missing)')
    .sort();
  if (runtimeOnlyTypes.length > 0) {
    throw new Error(`Runtime workflow template types are absent from Git: ${runtimeOnlyTypes.join(', ')}`);
  }

  const result: TemplateReconciliationResult = {
    total: authored.length,
    created: 0,
    updated: 0,
    unchanged: 0,
  };
  for (const definition of authored) {
    const current = byType.get(definition.type)?.[0];
    const fields = definitionFields(definition);
    if (!current) {
      await createTemplate(client, fields);
      result.created += 1;
      continue;
    }
    if (isDeepStrictEqual(definitionFields(current as unknown as Dict), fields)) {
      result.unchanged += 1;
      continue;
    }
    await replaceTemplate(client, current.id, fields, current.version);
    result.updated += 1;
  }
  return result;
}
