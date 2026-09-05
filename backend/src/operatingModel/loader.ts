import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

import { buildRegistry } from '../docs/docRegistry';
import { ContentsApiGithubStore, githubStoreConfigFromEnv } from '../docs/githubStore';
import type {
  BusinessUnitDefinition,
  FunctionDefinition,
  GapDefinition,
  OperatingModelSnapshot,
  RoadmapSessionDefinition,
  SystemDefinition,
} from './types';

type Row = Record<string, string>;
type Dict = Record<string, unknown>;

const FILES = {
  units: '_docs/operating-model/business-unit-registry.yaml',
  functions: '_docs/operating-model/function-registry.yaml',
  systems: '_docs/operating-model/system-function-map.csv',
  gaps: '_docs/operating-model/system-gap-register.csv',
  roadmap: '_docs/operating-model/weekly-roadmap.csv',
} as const;

function values(value: unknown): Dict[] {
  return Array.isArray(value) ? value.filter((item): item is Dict => Boolean(item && typeof item === 'object')) : [];
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function parseCsv(source: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { record.push(field); field = ''; }
    else if (char === '\n') { record.push(field.replace(/\r$/, '')); records.push(record); record = []; field = ''; }
    else field += char;
  }
  if (field || record.length) { record.push(field.replace(/\r$/, '')); records.push(record); }
  const headers = records.shift() || [];
  return records.filter((row) => row.some(Boolean)).map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index] || ''])));
}

function functionDocumentId(slug: string): string {
  return `reference.start-here.operating-model.functions.${slug}`;
}

function weekDocumentId(id: string, date: string): string {
  return `reference.start-here.roadmap.q4-2026.week-${id.slice(1).padStart(2, '0')}-${date}`;
}

export async function loadOperatingModelSnapshot(
  store = new ContentsApiGithubStore(githubStoreConfigFromEnv()),
): Promise<OperatingModelSnapshot> {
  await store.sync();
  const content = await Promise.all(Object.values(FILES).map((path) => store.readFile(path)));
  const revision = createHash('sha256')
    .update(content.join('\n--- operating-model-definition ---\n'))
    .digest('hex');
  const unitsYaml = (yaml.load(content[0]) || {}) as Dict;
  const functionsYaml = (yaml.load(content[1]) || {}) as Dict;
  const registry = buildRegistry(store.contentRoot);

  const businessUnits: BusinessUnitDefinition[] = values(unitsYaml.business_units).map((unit) => ({
    id: text(unit.id), tag: text(unit.tag), name: text(unit.name), role: text(unit.role),
    revenueModel: text(unit.revenue_model), priority: text(unit.priority), separationRule: text(unit.separation_rule),
  }));
  const functions: FunctionDefinition[] = values(functionsYaml.functions).map((fn) => ({
    id: text(fn.id), slug: text(fn.slug), name: text(fn.name), managerRoleId: text(fn.manager_role),
    managerTitle: text(fn.manager_title), outcome: text(fn.outcome), currentCoverage: text(fn.current_coverage),
    documentationCoverage: text(fn.documentation_coverage), documentId: functionDocumentId(text(fn.slug)),
  }));
  const systems: SystemDefinition[] = parseCsv(content[2]).map((row) => ({
    id: row.system_id, title: row.title, functionId: row.function_id, managerRoleId: row.recommended_manager_role,
    status: row.status, criticality: row.criticality, path: row.path,
    documentId: registry.byPath.get(row.path)?.id || row.system_id,
  }));
  const gaps: GapDefinition[] = parseCsv(content[3]).map((row) => ({
    id: row.gap_id, priority: row.priority, functionId: row.function_id, title: row.title,
    outcome: row.outcome, reason: row.reason,
    businessUnits: row.business_units.split(',').map((item) => item.trim()).filter(Boolean),
    proposedSystemId: row.proposed_system_id,
    systemDocumentId: row.skeleton_included === 'yes' ? registry.byPath.get(row.proposed_path)?.id || null : null,
    schedule: /^W\d+$/.test(row.roadmap_week)
      ? { kind: 'session', sessionId: row.roadmap_week }
      : { kind: 'deferred', label: row.roadmap_week },
    definitionStatus: row.status,
  }));
  const sessions: RoadmapSessionDefinition[] = parseCsv(content[4])
    .filter((row) => row.work_status === 'systems-day')
    .map((row) => ({
      id: row.week, title: row.title, proposedDate: row.date, goal: row.goal, deliverables: row.outputs,
      decisionsNeeded: row.human_decisions, agentWork: row.agent_work, definitionOfDone: row.definition_of_done,
      documentId: row.document_id || weekDocumentId(row.week, row.date),
      templateType: row.template_type || `operating-model-${row.week.toLowerCase()}`,
      targetPaths: row.target_paths,
    }));
  const lifecycles = registry.documents
    .filter((doc) => doc.path.includes('/operating-model/reference/lifecycles/') && doc.path.endsWith('.md') && !doc.path.endsWith('/index.md'))
    .map((doc) => ({ id: doc.id, title: doc.title, path: doc.path }));
  if (!businessUnits.length || !functions.length || !systems.length || !gaps.length || !sessions.length) {
    throw new Error('Operating model snapshot is incomplete');
  }
  return {
    revision, loadedAt: new Date().toISOString(), freshness: 'current',
    overviewDocumentId: 'system.start-here.operating-model',
    businessUnits, functions, systems, gaps, lifecycles,
    roadmap: { id: '2026-q4', sessions },
    downloads: Object.values(FILES).map((path) => ({
      id: path.split('/').pop() || path, label: path.split('/').pop() || path, href: `/knowledge-files/${path}`,
    })),
  };
}
