import { templateDependencyIssues } from './taskDependencyGraph';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from './yamlTemplates';

/**
 * Whole-definition edits to the effective Template, shared by the API
 * routes (and therefore the CLI, which speaks the same shape).
 *
 * A definition arrives either in runtime shape (`taskDefinitions`, exactly
 * what GET returns) or in authored YAML shape (`tasks`, what
 * `workflow-templates/*.yaml` files and `--file` uploads use). Both are
 * canonicalized to runtime definition fields and validated with the same
 * validators the private repository's workflow enforces, so YAML, writers,
 * and the API reject the same inputs.
 */

type Dict = Record<string, unknown>;

/** Definition fields an operator edit may set. Identity and seed metadata are server-owned. */
export const DEFINITION_FIELDS = [
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
  // Seed-managed Git provenance. Operator payloads carrying these are
  // rejected before normalization; the seed restores them on every write.
  'sourcePath',
  'sourceRevision',
] as const;

/** Server-owned fields a client definition must never carry. */
export const SERVER_OWNED_TEMPLATE_FIELDS = [
  'id',
  'version',
  'revision',
  'origin',
  'pinned',
  'base',
  'baseSourceRevision',
  'sourcePath',
  'sourceRevision',
  'createdAt',
  'updatedAt',
  'PK',
  'SK',
] as const;

export class TemplateDefinitionInvalidError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Template definition is invalid: ${issues.join('; ')}`);
    this.name = 'TemplateDefinitionInvalidError';
    this.issues = issues;
  }
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function templateTypeIssues(type: unknown): string[] {
  if (typeof type !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(type)) {
    return ['type must be a slug'];
  }
  return [];
}

/**
 * Canonicalize a client-supplied definition to runtime definition fields.
 * Throws `TemplateDefinitionInvalidError` when the shape is unusable or the
 * shared validators reject it.
 */
export function normalizeTemplateDefinition(input: unknown): Dict {
  if (!isDict(input)) {
    throw new TemplateDefinitionInvalidError(['definition must be an object']);
  }
  let runtime: Dict;
  if (Array.isArray(input.taskDefinitions)) {
    runtime = {};
    for (const field of DEFINITION_FIELDS) {
      if (input[field] !== undefined) runtime[field] = input[field];
    }
  } else if (Array.isArray(input.tasks)) {
    try {
      runtime = templateFromYaml(input);
    } catch {
      throw new TemplateDefinitionInvalidError(['definition is not a valid authored template document']);
    }
    const picked: Dict = {};
    for (const field of DEFINITION_FIELDS) {
      if (runtime[field] !== undefined) picked[field] = runtime[field];
    }
    runtime = picked;
  } else {
    throw new TemplateDefinitionInvalidError(['definition must include taskDefinitions or tasks']);
  }
  const issues = validateEffectiveDefinition(runtime);
  if (issues.length > 0) throw new TemplateDefinitionInvalidError(issues);
  return runtime;
}

/** Every way a candidate effective definition breaks the shared rules. */
export function validateEffectiveDefinition(definition: Dict): string[] {
  const issues = templateTypeIssues(definition.type);
  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    issues.push('name is required');
  }
  let authored: Dict;
  try {
    authored = templateToYaml(definition);
  } catch {
    return [...issues, 'definition cannot be represented as an authored template'];
  }
  for (const issue of validateAuthoredTemplate(authored)) {
    issues.push(issue.message);
  }
  // Belt and braces: the dependency validator also runs directly on the
  // runtime task definitions, so a mapping slip cannot silence it.
  const taskDefinitions = Array.isArray(definition.taskDefinitions)
    ? (definition.taskDefinitions as Dict[])
    : [];
  if (taskDefinitions.length > 0) {
    for (const message of templateDependencyIssues(taskDefinitions.map((task) => ({
      refId: String(task.refId || ''),
      dependsOn: Array.isArray(task.dependsOn)
        ? (task.dependsOn as unknown[]).filter((ref): ref is string => typeof ref === 'string')
        : undefined,
      optionalGroup: typeof task.optionalGroup === 'string' ? task.optionalGroup : undefined,
    })))) {
      if (!issues.includes(message)) issues.push(message);
    }
  }
  return issues;
}
