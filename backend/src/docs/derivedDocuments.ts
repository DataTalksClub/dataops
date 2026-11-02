import { CORE_SCHEMA, dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { posix } from 'node:path';

import type { Template } from '../types';
import { splitFrontmatter } from './sop';

export const DOCUMENT_INDEX_ID = 'reference.indexes.document-index';
export const DOCUMENT_INDEX_PATH = 'content/07-internal-operations/manage-systems-library/reference/document-index.md';
export const TASK_TEMPLATE_PREFIX = 'task-template.tasks.';
export const GENERATED_SYSTEM_PAGE_MARKER = '<!-- This system page is seeded from the audit register.';

export interface KnowledgeDocument {
  path: string;
  content: string;
  body: string;
  metadata: Record<string, unknown>;
  id: string;
  title: string;
  docType: string;
  status: string;
  department: string;
  businessSystem: string;
}

export interface RegenerationSelection {
  all?: boolean;
  id?: string;
}

export class DerivedDocumentNotFound extends Error {}

const INTEGER_KEYS = ['schema_version', 'review_cycle_days'];
const NULLABLE_DATE_KEYS = ['last_reviewed_at', 'next_review_at'];

/** Undo earlier stringification ('null', '1', '90') of the keys whose type is fixed by the schema. */
function repairScalars(metadata: Record<string, unknown>): Record<string, unknown> {
  const repaired = { ...metadata };
  for (const key of INTEGER_KEYS) {
    const value = repaired[key];
    if (typeof value === 'string' && /^\d+$/.test(value)) repaired[key] = Number(value);
    else if (value === 'null' || value === '') repaired[key] = null;
  }
  for (const key of NULLABLE_DATE_KEYS) {
    if (repaired[key] === 'null' || repaired[key] === '') repaired[key] = null;
  }
  return repaired;
}

function yamlFrontmatter(metadata: Record<string, unknown>): string {
  return dumpYaml(repairScalars(metadata), { lineWidth: -1, noRefs: true }).trimEnd();
}

/** Typed frontmatter read: null, integers and booleans keep their YAML types so a rewrite never stringifies them. */
function parseTypedFrontmatter(raw: string): Record<string, unknown> {
  const loaded = loadYaml(raw, { schema: CORE_SCHEMA });
  if (loaded === null || loaded === undefined) return {};
  if (typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('frontmatter must be a YAML mapping');
  return loaded as Record<string, unknown>;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && Boolean(item));
  return typeof value === 'string' && value ? [value] : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);
}

function cell(value: unknown, fallback = '—'): string {
  const rendered = text(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  return rendered || fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readDocument(path: string, content: string): KnowledgeDocument | null {
  const [raw, body] = splitFrontmatter(content);
  if (!raw) return null;
  let metadata: Record<string, unknown>;
  try {
    metadata = parseTypedFrontmatter(raw);
  } catch {
    return null;
  }
  const stem = posix.basename(path).replace(/\.md$/, '');
  const title = text(metadata.title) || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || stem.replace(/-/g, ' ');
  return {
    path,
    content,
    body,
    metadata,
    id: text(metadata.id),
    title,
    docType: text(metadata.doc_type),
    status: text(metadata.status, 'proposed') || 'proposed',
    department: text(metadata.department),
    businessSystem: text(metadata.business_system),
  };
}

export function knowledgeDocuments(files: Map<string, string>): KnowledgeDocument[] {
  return [...files.entries()]
    .filter(([path]) => path.startsWith('content/') && path.endsWith('.md'))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, content]) => {
      const document = readDocument(path, content);
      return document ? [document] : [];
    });
}

function documentLinks(documents: KnowledgeDocument[]): Map<string, KnowledgeDocument> {
  return new Map(documents.filter((document) => document.id).map((document) => [document.id, document]));
}

function renderDocumentIndex(files: Map<string, string>, documents: KnowledgeDocument[]): string {
  const current = readDocument(DOCUMENT_INDEX_PATH, files.get(DOCUMENT_INDEX_PATH) || '');
  const metadata = current?.metadata || {
    id: DOCUMENT_INDEX_ID,
    aliases: ['content/indexes/reference/document-index.md'],
    title: 'Document index',
    summary: 'Generated index of governed operations documents, templates, and references.',
    doc_type: 'reference',
    schema_version: 1,
    source: 'Generated from tracked content frontmatter',
    department: '07-internal-operations',
    business_system: 'manage-systems-library',
    owner_role: 'systems-champion',
    status: 'active',
    criticality: 'supporting',
    confidentiality: 'internal',
    review_cycle_days: 180,
    last_reviewed_at: null,
    next_review_at: null,
    tags: ['index', 'manage-systems-library'],
    tools: [],
    related_docs: [
      'system.start-here.business-system-map',
      'system.start-here.navigate-operating-reference',
      'system.internal-operations.manage-systems-library',
    ],
  };

  const statusOrder: Record<string, number> = {
    active: 0, proposed: 1, draft: 2, blocked: 3, 'review-due': 4, deprecated: 5, archived: 6,
  };
  const sorted = [...documents].sort((a, b) =>
    (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99)
    || a.department.localeCompare(b.department)
    || a.businessSystem.localeCompare(b.businessSystem)
    || a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase())
    || a.id.localeCompare(b.id));
  const systemPages = new Map<string, string>();
  for (const document of sorted) {
    if (document.docType === 'system-overview') {
      systemPages.set(`${document.department}\0${document.businessSystem}`, document.path);
    }
  }
  const operating = sorted.filter((document) => document.status !== 'archived' && document.status !== 'deprecated');
  const archived = sorted.filter((document) => document.status === 'archived' || document.status === 'deprecated');
  const link = (target: string) => posix.relative(posix.dirname(DOCUMENT_INDEX_PATH), target) || '.';
  const rows = (items: KnowledgeDocument[], includeReplacement: boolean): string[] => items.map((document) => {
    const systemPath = systemPages.get(`${document.department}\0${document.businessSystem}`);
    const system = systemPath
      ? `[${cell(document.businessSystem)}](${link(systemPath)})`
      : cell(document.businessSystem);
    const title = `[${cell(document.title, posix.basename(document.path, '.md').replace(/-/g, ' '))}](${link(document.path)})`;
    const pathFromContent = document.path.startsWith('content/') ? document.path.slice('content/'.length) : document.path;
    const columns = [
      cell(document.department),
      includeReplacement ? cell(document.businessSystem) : system,
      cell(document.docType),
      title,
      `\`${cell(document.id)}\``,
    ];
    if (includeReplacement) columns.push(`\`${cell(document.metadata.replaced_by)}\``);
    else columns.push(`\`${cell(document.metadata.owner_role)}\``);
    columns.push(`\`${cell(document.status)}\``, `[${pathFromContent}](${link(document.path)})`);
    return `| ${columns.join(' | ')} |`;
  });

  const frontmatter = yamlFrontmatter(metadata);
  return [
    '---', frontmatter, '---', '',
    '# Document Index', '',
    '<!-- Generated from the current knowledge frontmatter; edit source documents instead. -->', '',
    'This page is generated from governed Markdown frontmatter. Use the business-system map for outcome-first navigation, then open the system page or workflow before selecting a task instruction.', '',
    '## Inventory', '',
    `- ${sorted.length} governed documents are indexed.`,
    `- ${operating.length} are in the non-archived operating view; ${archived.length} are archived or deprecated.`,
    '- IDs, lifecycle, owner roles, systems, and document links are read from each document’s metadata.', '',
    '## Non-archived operating documents', '',
    '| Department | Business system | Type | Title | ID | Owner role | Status | Document |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows(operating, false), '',
    '## Archived and deprecated documents', '',
    'These documents remain searchable for provenance and migration history but are excluded from default operating navigation.', '',
    '| Department | Business system | Type | Title | ID | Replacement | Status | Document |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows(archived, true), '',
    '## Maintenance', '',
    '- Change a document’s frontmatter when its owner, lifecycle, system, or links change.',
    '- This index is regenerated whenever the knowledge publication changes.',
    '- Treat a missing or conflicting entry as a metadata defect; do not patch this generated table by hand.', '',
    '## References', '',
    '- Owning system: `system.internal-operations.manage-systems-library`',
    '- Source provenance: current published Markdown frontmatter.',
    '- Navigation: `system.start-here.business-system-map` and `system.start-here.navigate-operating-reference`.', '',
  ].join('\n');
}

function renderSystemOverview(document: KnowledgeDocument, documents: KnowledgeDocument[]): string | null {
  if (document.docType !== 'system-overview' || !document.body.includes(GENERATED_SYSTEM_PAGE_MARKER)) return null;
  const owned = documents
    .filter((item) => item.businessSystem === document.businessSystem
      && item.id !== document.id
      && item.status !== 'archived'
      && item.status !== 'deprecated')
    .sort((a, b) => a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase()));
  const byId = documentLinks(documents);
  const oldRelated = list(document.metadata.related_docs);
  const related = oldRelated.filter((id) => {
    const linked = byId.get(id);
    return !linked || linked.businessSystem !== document.businessSystem;
  });
  const metadata = { ...document.metadata, related_docs: unique([...related, ...owned.map((item) => item.id)]) };
  const supporting = owned.length
    ? owned.map((item) => `- [${item.title}](${posix.relative(posix.dirname(document.path), item.path)}) — \`${item.id || 'path-derived'}\`; ${item.docType || 'doc'}, ${item.status}.`)
    : ['- No documents are mapped yet; add or classify the relevant SOPs, templates, references, and checklists.'];
  const [raw] = splitFrontmatter(document.content);
  const frontmatter = yamlFrontmatter(metadata);
  const body = document.body.replace(
    /^## Supporting documents\s*\r?\n[\s\S]*?(?=^## Controls and evidence\s*$)/m,
    `## Supporting documents\n\n${supporting.join('\n')}\n\n`,
  );
  if (body === document.body) return null;
  return `---\n${frontmatter}\n---\n${body}`;
}

function taskTemplatePath(type: string): string {
  return `content/00-start-here/workflow-catalog/reference/${type}-workflow.md`;
}

function taskTemplateMetadata(template: Template, path: string, existing?: KnowledgeDocument): Record<string, unknown> {
  const type = String(template.type || '');
  const department = template.department || existing?.department || '';
  const systemId = department.includes('-') && template.businessSystem
    ? `system.${department.slice(department.indexOf('-') + 1)}.${template.businessSystem}`
    : '';
  const name = template.name || existing?.title || type;
  return {
    ...(existing?.metadata || {}),
    id: `${TASK_TEMPLATE_PREFIX}${type}`,
    aliases: list(existing?.metadata.aliases),
    title: `${name} Workflow View`,
    summary: `Read-only generated view of the current DataOps Template ${type}.`,
    doc_type: 'task-template',
    schema_version: 1,
    source: `Generated from the current DataOps Template version ${template.version}.`,
    department,
    business_system: template.businessSystem || existing?.businessSystem || '',
    owner_role: template.ownerRole || existing?.metadata.owner_role || '',
    status: template.status || existing?.status || 'proposed',
    criticality: 'supporting',
    confidentiality: 'internal',
    review_cycle_days: template.reviewCycleDays ?? existing?.metadata.review_cycle_days ?? null,
    last_reviewed_at: template.lastReviewedAt ?? existing?.metadata.last_reviewed_at ?? null,
    next_review_at: template.nextReviewAt ?? existing?.metadata.next_review_at ?? null,
    tags: unique(['task-template', type, posix.basename(path, '.md'), ...(template.tags || []), 'workflow', 'generated-view']),
    tools: template.tools || [],
    related_docs: unique([systemId, ...(template.sourceDocIds || [])]),
  };
}

function renderTaskTemplate(template: Template, path: string, documents: KnowledgeDocument[], existing?: KnowledgeDocument): string {
  const metadata = taskTemplateMetadata(template, path, existing);
  const byId = documentLinks(documents);
  const name = template.name || template.type || 'Workflow';
  const lines = [
    '---', yamlFrontmatter(metadata), '---', '',
    `# ${name} Workflow View`, '',
    '<!-- GENERATED FILE: this view follows the current pinned DataOps Template. -->', '',
    `- Template type: \`${template.type || ''}\``,
    `- Template version: \`${template.version}\``,
    `- Pinned: \`${template.pinned === true ? 'yes' : 'no'}\``,
    `- Status: \`${template.status || 'proposed'}\``, '',
  ];
  if (template.outcome) lines.push('## Outcome', '', template.outcome, '');
  lines.push('## Trigger and references', '', `- Mode: \`${template.triggerType || 'manual'}\``);
  if (template.triggerSchedule) lines.push(`- Schedule: \`${template.triggerSchedule}\``);
  if (template.triggerLeadDays !== undefined) lines.push(`- Lead days: \`${template.triggerLeadDays}\``);
  for (const reference of template.references || []) {
    lines.push(`- ${reference.name}: ${reference.url.startsWith('http') ? reference.url : `\`${reference.url}\``}`);
  }
  const sourceDocIds = unique(template.sourceDocIds || []);
  if (sourceDocIds.length) {
    lines.push('', 'Source documents:');
    for (const id of sourceDocIds) {
      const document = byId.get(id);
      const target = document ? posix.relative(posix.dirname(path), document.path) : '';
      lines.push(document ? `- [${document.title}](${target}) — \`${id}\`` : `- \`${id}\``);
    }
  }
  lines.push('', '## Task definitions', '', '| # | Task | Primary instruction | Offset | Owner role |', '| ---: | --- | --- | ---: | --- |');
  for (const [index, task] of (template.taskDefinitions || []).entries()) {
    const taskRefs = unique([task.instructionDocId || '']);
    const instruction = taskRefs.map((id) => {
      const document = byId.get(id);
      return document ? `[${document.title}](${posix.relative(posix.dirname(path), document.path)}) — \`${id}\`` : `\`${id}\``;
    }).join('<br>') || '—';
    lines.push(`| ${index + 1} | \`${cell(task.refId)}\` ${cell(task.description)} | ${instruction} | ${cell(task.offsetDays, '0')} | ${cell(task.ownerRole)} |`);
  }
  if (!(template.taskDefinitions || []).length) lines.push('| — | No Task definitions. | — | — | — |');
  const dependent = (template.taskDefinitions || []).filter((task) => (task.dependsOn || []).length > 0);
  if (dependent.length) {
    lines.push('', '## Task dependencies', '', 'A task can be completed only after every prerequisite is done; scheduling is not publication.', '');
    for (const task of dependent) lines.push(`- \`${task.refId}\` requires ${(task.dependsOn || []).map((ref) => `\`${ref}\``).join(', ')}.`);
  }
  lines.push('');
  return lines.join('\n');
}

function generatedTaskTemplates(
  files: Map<string, string>,
  documents: KnowledgeDocument[],
  templates: Template[],
): Map<string, string> {
  const byType = new Map(templates.filter((template) => template.type).map((template) => [String(template.type), template]));
  const generated = new Map<string, string>();
  for (const template of byType.values()) {
    const type = String(template.type);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(type)) continue;
    const id = `${TASK_TEMPLATE_PREFIX}${type}`;
    const existing = documents.find((document) => document.id === id);
    if (!existing && template.origin !== 'git') continue;
    const path = existing?.path || taskTemplatePath(type);
    const prior = existing || readDocument(path, files.get(path) || '') || undefined;
    generated.set(path, renderTaskTemplate(template, path, documents, prior));
  }
  return generated;
}

function systemOverviewPages(files: Map<string, string>, documents: KnowledgeDocument[]): Map<string, string> {
  const generated = new Map<string, string>();
  for (const document of documents) {
    const content = renderSystemOverview(document, documents);
    if (content !== null && content !== files.get(document.path)) generated.set(document.path, content);
  }
  return generated;
}

export function regenerateDerivedDocuments(
  files: Map<string, string>,
  templates: Template[],
  selection: RegenerationSelection = { all: true },
): Map<string, string> {
  const all = selection.all === true;
  const requestedId = selection.id || '';
  if (!all && !requestedId) throw new DerivedDocumentNotFound('Choose --all or a generated document ID');

  const currentDocuments = knowledgeDocuments(files);
  const output = new Map<string, string>();

  const taskId = requestedId.startsWith(TASK_TEMPLATE_PREFIX) ? requestedId : '';
  if (all || taskId) {
    const taskPages = generatedTaskTemplates(files, currentDocuments, templates);
    for (const [path, content] of taskPages) {
      const document = readDocument(path, content);
      if (all || document?.id === taskId) output.set(path, content);
    }
    if (taskId && output.size === 0) throw new DerivedDocumentNotFound(`No Template for generated document ${taskId}`);
  }

  const withTasks = new Map(files);
  for (const [path, content] of output) withTasks.set(path, content);
  const taskDocuments = knowledgeDocuments(withTasks);

  if (all) {
    const pages = systemOverviewPages(withTasks, taskDocuments);
    for (const [path, content] of pages) output.set(path, content);
  } else if (requestedId && !taskId && requestedId !== DOCUMENT_INDEX_ID) {
    const target = taskDocuments.find((document) => document.id === requestedId && document.docType === 'system-overview');
    if (!target) throw new DerivedDocumentNotFound(`No generated document with ID ${requestedId}`);
    const content = renderSystemOverview(target, taskDocuments);
    if (content === null) throw new DerivedDocumentNotFound(`Document ${requestedId} is not a generated system page`);
    output.set(target.path, content);
  }

  if (all || requestedId === DOCUMENT_INDEX_ID) {
    const withSystems = new Map(withTasks);
    for (const [path, content] of output) withSystems.set(path, content);
    output.set(DOCUMENT_INDEX_PATH, renderDocumentIndex(withSystems, knowledgeDocuments(withSystems)));
  } else if (!taskId && !requestedId) {
    throw new DerivedDocumentNotFound('Choose --all or a generated document ID');
  }

  return output;
}
