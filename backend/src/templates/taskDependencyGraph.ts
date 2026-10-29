import type { TaskDefinition } from '../types';

/**
 * Pure graph rules for Template Task dependencies, shared by the authored
 * YAML validator and the runtime Template writers so both reject the same
 * definitions.
 */

type DependencyDefinition = Pick<TaskDefinition, 'refId' | 'dependsOn' | 'optionalGroup' | 'repeat'>;

/** Describe every way a set of definitions breaks the dependency rules. */
export function templateDependencyIssues(definitions: readonly DependencyDefinition[]): string[] {
  const issues: string[] = [];
  const byRef = new Map(definitions.map((definition) => [definition.refId, definition]));
  for (const definition of definitions) {
    const seen = new Set<string>();
    for (const ref of definition.dependsOn || []) {
      if (typeof ref !== 'string' || ref.length === 0) {
        issues.push(`task '${definition.refId}' depends_on must list task ids`);
        continue;
      }
      if (seen.has(ref)) issues.push(`task '${definition.refId}' lists dependency '${ref}' more than once`);
      seen.add(ref);
      if (ref === definition.refId) {
        issues.push(`task '${definition.refId}' cannot depend on itself`);
        continue;
      }
      const target = byRef.get(ref);
      if (!target) {
        issues.push(`task '${definition.refId}' depends on unknown task '${ref}'`);
        continue;
      }
      // An unselected optional group is never instantiated, so a Task outside
      // the group would wait forever on a prerequisite that does not exist.
      if (target.optionalGroup && target.optionalGroup !== definition.optionalGroup) {
        issues.push(
          `task '${definition.refId}' depends on '${ref}' from optional group '${target.optionalGroup}'; `
          + 'a task may only depend on ungrouped tasks or tasks in its own group',
        );
      }
      // Instance n of a repeated Task depends on instance n of its repeated
      // prerequisite; any other Task has no single instance to wait for.
      if (target.repeat && target.repeat.countField !== definition.repeat?.countField) {
        issues.push(
          `task '${definition.refId}' depends on repeated task '${ref}'; `
          + `only a task repeated by '${target.repeat.countField}' may depend on it`,
        );
      }
    }
  }
  const cycle = findCycle(definitions);
  if (cycle) issues.push(`task dependencies form a cycle: ${cycle.join(' -> ')}`);
  return issues;
}

/** The first dependency cycle as a closed ref path, or null when the graph is acyclic. */
function findCycle(definitions: readonly DependencyDefinition[]): string[] | null {
  const edges = new Map(definitions.map((definition) => [definition.refId, definition.dependsOn || []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (ref: string): string[] | null => {
    if (state.get(ref) === 'done') return null;
    if (state.get(ref) === 'visiting') return [...path.slice(path.indexOf(ref)), ref];
    state.set(ref, 'visiting');
    path.push(ref);
    for (const next of edges.get(ref) || []) {
      if (!edges.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(ref, 'done');
    return null;
  };
  for (const ref of edges.keys()) {
    const cycle = visit(ref);
    if (cycle) return cycle;
  }
  return null;
}

/** Definitions reordered so every prerequisite precedes its dependents. */
export function prerequisitesFirst<T extends DependencyDefinition>(definitions: readonly T[]): T[] {
  const byRef = new Map(definitions.map((definition) => [definition.refId, definition]));
  const placed = new Set<string>();
  const ordered: T[] = [];
  const place = (definition: T) => {
    if (placed.has(definition.refId)) return;
    placed.add(definition.refId);
    for (const ref of definition.dependsOn || []) {
      const target = byRef.get(ref);
      if (target) place(target);
    }
    ordered.push(definition);
  };
  definitions.forEach(place);
  return ordered;
}
