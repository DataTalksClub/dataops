/**
 * Reusable workflow-template blocks.
 *
 * A block defines a task group once (e.g. the sponsor performance stats
 * group) and templates splice it in with a single task-list entry:
 *
 *   tasks:
 *     - { include: blocks/sponsor-performance.yaml, slot: primary-slot }
 *
 * or, equivalently, one list item in mapping form:
 *
 *   tasks:
 *     - include: blocks/sponsor-performance.yaml
 *       prefix: secondary-
 *       slot: secondary-slot
 *       name_prefix: "Secondary slot: "
 *       only: [send-performance-to-sponsor]
 *
 * Include parameters (all optional):
 * - `prefix` (string, default ""): prepended to every emitted task id.
 *   A `depends_on` entry that names another task emitted by the same include
 *   tracks the prefix; references to tasks outside the block (the anchor, or
 *   shared tasks skipped via `only`) are left as-is.
 * - `slot` (slug|null, default null): sets `optional_group` on the block's
 *   `slot_tasks`. A null or empty slot removes `optional_group` from them.
 * - `anchor` (slug, default block `anchor_from`): the task the block's
 *   anchor-dependents wait on. Every `depends_on` entry equal to the block's
 *   `anchor_from` is rewritten to this value.
 * - `offset_days` (integer, default 0): added to each emitted task's own
 *   `schedule.offset_days`. A task without its own offset starts from the
 *   block's `params.offset_days`.
 * - `name_prefix` (string, default ""): prepended to every emitted name.
 * - `only` (list of unprefixed block task ids, default all): emit a subset,
 *   e.g. only the send task for a secondary slot that reuses shared collect
 *   tasks.
 *
 * Block file shape (`workflow-templates/blocks/<name>.yaml`):
 *
 *   params:         # defaults for the include parameters above
 *     prefix: ""
 *     slot: null
 *     anchor: schedule-email-newsletter
 *     offset_days: 7
 *     name_prefix: ""
 *   anchor_from: schedule-email-newsletter
 *   slot_tasks:
 *     - send-performance-to-sponsor
 *   tasks:
 *     - <full task definitions with concrete ids>
 *
 * Blocks are one level only: a block task must not itself be an include.
 * Expansion runs before authored-template validation, so the expanded tasks
 * are what the validators and the lossless mapping check see.
 */

import yaml from 'js-yaml';

type Dict = Record<string, unknown>;

export interface AuthoredBlockFile {
  path: string;
  revision: string;
  content: string;
}

export interface ParsedBlock {
  path: string;
  params: {
    prefix: string;
    slot: string | null;
    anchor: string;
    offsetDays: number;
    namePrefix: string;
  };
  anchorFrom: string;
  slotTasks: Set<string>;
  tasks: Dict[];
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const INCLUDE_PARAMS = new Set(['include', 'prefix', 'slot', 'anchor', 'offset_days', 'name_prefix', 'only']);

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function isIncludeEntry(task: unknown): task is Dict {
  return isDict(task) && typeof task.include === 'string' && typeof (task as Dict).id !== 'string';
}

/** Block paths are always relative to workflow-templates/, inside blocks/. */
export function blockKeyFor(include: string): string {
  return include.startsWith('workflow-templates/') ? include : `workflow-templates/${include}`;
}

function fail(path: string, message: string): Error {
  return new Error(`${path}: ${message}`);
}

/** Parse one block file; throws with the block path on any structural problem. */
export function parseBlockFile(file: AuthoredBlockFile): ParsedBlock {
  let document: unknown;
  try {
    document = yaml.load(file.content, { schema: yaml.JSON_SCHEMA });
  } catch {
    throw fail(file.path, 'invalid block YAML');
  }
  if (!isDict(document)) throw fail(file.path, 'block must be an object');
  const rawTasks: unknown = document.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw fail(file.path, 'block must define a non-empty tasks list');
  }
  const blockTasks = rawTasks as unknown[];
  for (const candidate of blockTasks) {
    if (!isDict(candidate)) throw fail(file.path, 'block tasks must be objects');
    const task = candidate;
    if (typeof task.include === 'string') throw fail(file.path, 'blocks cannot include other blocks');
    if (typeof task.id !== 'string' || !SLUG.test(task.id)) {
      throw fail(file.path, `block task has invalid id '${String(task.id)}'`);
    }
  }
  const tasks = blockTasks as Dict[];
  const ids = tasks.map((task) => String(task.id));
  if (new Set(ids).size !== ids.length) throw fail(file.path, 'block task ids must be unique');

  const rawParams: Dict = isDict(document.params) ? document.params : {};
  const prefixRaw: unknown = rawParams.prefix ?? '';
  const slotRaw: unknown = rawParams.slot ?? null;
  const anchorRaw: unknown = rawParams.anchor ?? document.anchor_from ?? 'schedule-email-newsletter';
  const offsetDaysRaw: unknown = rawParams.offset_days ?? 7;
  const namePrefixRaw: unknown = rawParams.name_prefix ?? '';
  if (typeof prefixRaw !== 'string') throw fail(file.path, 'block params.prefix must be a string');
  if (slotRaw !== null && (typeof slotRaw !== 'string' || !SLUG.test(slotRaw))) {
    throw fail(file.path, 'block params.slot must be a slug or null');
  }
  if (typeof anchorRaw !== 'string' || !SLUG.test(anchorRaw)) {
    throw fail(file.path, 'block params.anchor must be a slug');
  }
  if (typeof offsetDaysRaw !== 'number' || !Number.isInteger(offsetDaysRaw)) {
    throw fail(file.path, 'block params.offset_days must be an integer');
  }
  if (typeof namePrefixRaw !== 'string') throw fail(file.path, 'block params.name_prefix must be a string');
  const prefix: string = prefixRaw;
  const slot: string | null = slotRaw;
  const anchor: string = anchorRaw;
  const offsetDays: number = offsetDaysRaw;
  const namePrefix: string = namePrefixRaw;

  const anchorFromRaw: unknown = document.anchor_from ?? anchor;
  if (typeof anchorFromRaw !== 'string' || !SLUG.test(anchorFromRaw)) {
    throw fail(file.path, 'block anchor_from must be a slug');
  }
  const anchorFrom: string = anchorFromRaw;
  const slotTasksRaw: unknown = document.slot_tasks ?? [];
  if (!Array.isArray(slotTasksRaw) || slotTasksRaw.some((id: unknown) => typeof id !== 'string')) {
    throw fail(file.path, 'block slot_tasks must be a string list');
  }
  const slotTasks = slotTasksRaw as string[];
  for (const id of slotTasks) {
    if (!ids.includes(id)) throw fail(file.path, `block slot_tasks references unknown task '${id}'`);
  }
  return {
    path: file.path,
    params: { prefix, slot, anchor, offsetDays, namePrefix },
    anchorFrom,
    slotTasks: new Set(slotTasks),
    tasks: tasks.map(deepClone),
  };
}

export function parseBlockFiles(files: AuthoredBlockFile[]): Map<string, ParsedBlock> {
  const blocks = new Map<string, ParsedBlock>();
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const key = file.path.startsWith('workflow-templates/') ? file.path : `workflow-templates/${file.path}`;
    if (blocks.has(key)) throw fail(file.path, 'duplicate block path');
    blocks.set(key, parseBlockFile(file));
  }
  return blocks;
}

interface ResolvedInclude {
  block: ParsedBlock;
  prefix: string;
  slot: string | null;
  anchor: string;
  offsetDays: number;
  namePrefix: string;
  only: string[] | null;
}

function resolveInclude(entry: Dict, templatePath: string, blocks: Map<string, ParsedBlock>): ResolvedInclude {
  for (const key of Object.keys(entry)) {
    if (!INCLUDE_PARAMS.has(key)) throw fail(templatePath, `include entry has unknown parameter '${key}'`);
  }
  const target = entry.include;
  if (typeof target !== 'string' || !/^blocks\/[a-z0-9][a-z0-9-]*\.ya?ml$/.test(target)) {
    throw fail(templatePath, `include must name a blocks/*.yaml file, got '${String(target)}'`);
  }
  const block = blocks.get(blockKeyFor(target));
  if (!block) throw fail(templatePath, `include refers to unknown block '${target}'`);

  const prefixRaw: unknown = entry.prefix ?? block.params.prefix;
  const slotRaw: unknown = entry.slot ?? block.params.slot;
  const anchorRaw: unknown = entry.anchor ?? block.params.anchor;
  const offsetDaysRaw: unknown = entry.offset_days ?? 0;
  const namePrefixRaw: unknown = entry.name_prefix ?? block.params.namePrefix;
  const onlyRaw: unknown = entry.only ?? null;
  if (typeof prefixRaw !== 'string') throw fail(templatePath, 'include prefix must be a string');
  if (slotRaw !== null && (typeof slotRaw !== 'string' || !SLUG.test(slotRaw))) {
    throw fail(templatePath, 'include slot must be a slug or null');
  }
  if (typeof anchorRaw !== 'string' || !SLUG.test(anchorRaw)) {
    throw fail(templatePath, 'include anchor must be a slug');
  }
  if (typeof offsetDaysRaw !== 'number' || !Number.isInteger(offsetDaysRaw)) {
    throw fail(templatePath, 'include offset_days must be an integer');
  }
  if (typeof namePrefixRaw !== 'string') throw fail(templatePath, 'include name_prefix must be a string');
  if (onlyRaw !== null && (!Array.isArray(onlyRaw) || onlyRaw.some((id: unknown) => typeof id !== 'string'))) {
    throw fail(templatePath, 'include only must be a string list');
  }
  const only = onlyRaw as string[] | null;
  if (only !== null) {
    for (const id of only) {
      if (!block.tasks.some((task) => String(task.id) === id)) {
        throw fail(templatePath, `include only references unknown block task '${id}'`);
      }
    }
  }
  const prefix: string = prefixRaw;
  const slot: string | null = slotRaw;
  const anchor: string = anchorRaw;
  const offsetDays: number = offsetDaysRaw;
  const namePrefix: string = namePrefixRaw;
  return { block, prefix, slot, anchor, offsetDays, namePrefix, only };
}

/**
 * Expand every include entry in a template document's task list, splicing the
 * block tasks in place. Returns a new document; the input is not mutated.
 */
export function expandTemplateIncludes(document: Dict, templatePath: string, blocks: Map<string, ParsedBlock>): Dict {
  const rawTasks: unknown = document.tasks;
  if (!Array.isArray(rawTasks) || !rawTasks.some(isIncludeEntry)) return document;
  const tasks = rawTasks as Dict[];
  const expanded: Dict[] = [];
  for (const task of tasks) {
    if (!isIncludeEntry(task)) {
      expanded.push(task);
      continue;
    }
    const include = resolveInclude(task, templatePath, blocks);
    const { block } = include;
    const wanted = include.only === null
      ? block.tasks
      : block.tasks.filter((candidate) => (include.only as string[]).includes(String(candidate.id)));
    const idMap = new Map<string, string>();
    for (const candidate of wanted) {
      const unprefixed = String(candidate.id);
      const prefixed = `${include.prefix}${unprefixed}`;
      if (!SLUG.test(prefixed)) throw fail(templatePath, `include prefix yields invalid task id '${prefixed}'`);
      idMap.set(unprefixed, prefixed);
    }
    for (const candidate of wanted) {
      const unprefixed = String(candidate.id);
      const next = deepClone(candidate);
      next.id = idMap.get(unprefixed);
      if (include.namePrefix) next.name = `${include.namePrefix}${String(candidate.name)}`;
      const schedule = next.schedule;
      if (isDict(schedule) && typeof schedule.offset_days === 'number') {
        schedule.offset_days += include.offsetDays;
      } else if (isDict(schedule)) {
        schedule.offset_days = block.params.offsetDays + include.offsetDays;
      } else {
        next.schedule = { offset_days: block.params.offsetDays + include.offsetDays };
      }
      if (block.slotTasks.has(unprefixed)) {
        if (include.slot) next.optional_group = include.slot;
        else delete next.optional_group;
      }
      if (Array.isArray(next.depends_on)) {
        next.depends_on = (next.depends_on as unknown[]).map((dep) => {
          if (dep === block.anchorFrom) return include.anchor;
          if (typeof dep === 'string' && idMap.has(dep)) return idMap.get(dep);
          return dep;
        });
      }
      expanded.push(next);
    }
  }
  const seen = new Set<string>();
  for (const task of expanded) {
    const id = String((task as Dict).id || '');
    if (!id) throw fail(templatePath, 'an include produced a task without an id');
    if (seen.has(id)) throw fail(templatePath, `duplicate task id '${id}' after block expansion`);
    seen.add(id);
  }
  return { ...document, tasks: expanded };
}
