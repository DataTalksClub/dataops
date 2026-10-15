import type {
  CardLink,
  TaskDefinition,
  Template,
  TemplateCardDefinitionSnapshot,
  TemplateTaskDefinitionSnapshot,
} from '../types';

type Dict = Record<string, unknown>;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function withoutUndefined<T extends Dict>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

export function dateFromTemplateOffset(anchorDate: string, offsetDays: number): string {
  const anchor = new Date(`${anchorDate}T00:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);
  return anchor.toISOString().split('T')[0];
}

export function templateCardDefinitionSnapshot(template: Template): TemplateCardDefinitionSnapshot {
  return withoutUndefined({
    tags: copy(template.tags || []),
    sourceDocIds: copy(template.sourceDocIds || []),
    references: copy(template.references || []),
    cardLinkDefinitions: copy(template.cardLinkDefinitions || []),
  });
}

export function templateCardProjection(template: Template): Dict {
  const snapshot = templateCardDefinitionSnapshot(template);
  const cardLinks: CardLink[] = snapshot.cardLinkDefinitions.map(({ name }) => ({ name, url: '' }));
  return withoutUndefined({
    tags: copy(snapshot.tags),
    sourceDocIds: copy(snapshot.sourceDocIds),
    references: copy(snapshot.references),
    cardLinks,
    templateVersion: template.version,
    templateSourceRevision: template.sourceRevision,
    templateDefinitionSnapshot: snapshot,
  });
}

export function templateTaskDefinitionSnapshot(
  template: Template,
  definition: TaskDefinition,
  order: number,
  anchorDate: string,
): TemplateTaskDefinitionSnapshot {
  if (
    definition.stageOnComplete !== undefined
    && !['preparation', 'announced', 'after-event'].includes(definition.stageOnComplete)
  ) {
    throw new Error(`Template Task ${definition.refId} has invalid stageOnComplete`);
  }
  const offsetDays = definition.offsetDays || 0;
  // Trello-imported definitions bake the checklist name into the description
  // as "[Checklist] Task". Split it off so instantiated Tasks store the tag
  // in `tags` and keep a clean description.
  const leadingTag = /^\[([^\[\]]{1,40})\]\s*/.exec(definition.description || '');
  const cleanDescription = leadingTag && definition.description.slice(leadingTag[0].length).trim()
    ? definition.description.slice(leadingTag[0].length).trim()
    : definition.description;
  const combinedTags = [
    ...(template.tags || []),
    ...((definition as { tags?: string[] }).tags || []),
    ...(leadingTag ? [leadingTag[1].trim()] : []),
  ];
  return withoutUndefined({
    description: cleanDescription,
    date: dateFromTemplateOffset(anchorDate, offsetDays),
    templateOffsetDays: offsetDays,
    templateTaskOrder: order,
    isMilestone: definition.isMilestone,
    stageOnComplete: definition.stageOnComplete,
    assigneeId: definition.assigneeId,
    instructionsUrl: definition.instructionsUrl,
    instructionDocId: definition.instructionDocId,
    instructionStepId: definition.instructionStepId,
    phase: definition.phase,
    requires: definition.requires ? copy(definition.requires) : undefined,
    dependsOnRefs: definition.dependsOn?.length ? [...definition.dependsOn] : undefined,
    validation: definition.validation ? copy(definition.validation) : undefined,
    requiredLinkName: definition.requiredLinkName,
    requiresFile: definition.requiresFile,
    proofRequirement: definition.proofRequirement ? copy(definition.proofRequirement) : undefined,
    tags: combinedTags.length ? combinedTags : undefined,
    sourceDocIds: template.sourceDocIds?.length ? copy(template.sourceDocIds) : undefined,
  });
}

/**
 * Template dependencies name `refId`s; a Task stores the ids of the Tasks that
 * carry those refs on its own Card. A ref with no Task is a definition the
 * Card did not instantiate, which Template validation rules out.
 */
export function resolveDependencyIds(
  taskRef: string,
  dependsOnRefs: readonly string[] | undefined,
  taskIdsByRef: ReadonlyMap<string, string>,
): string[] {
  return (dependsOnRefs || []).map((ref) => {
    const id = taskIdsByRef.get(ref);
    if (!id) throw new Error(`Template Task ${taskRef} depends on ${ref}, which this Card has no Task for`);
    return id;
  });
}

export function templateTaskProjection(
  template: Template,
  definition: TaskDefinition,
  order: number,
  anchorDate: string,
  cardId: string,
  defaultAssigneeId: string | null,
  taskIdsByRef: ReadonlyMap<string, string>,
): Dict {
  const snapshot = templateTaskDefinitionSnapshot(template, definition, order, anchorDate);
  const { dependsOnRefs, ...definitionFields } = snapshot;
  const dependsOn = resolveDependencyIds(definition.refId, dependsOnRefs, taskIdsByRef);
  // The snapshot keeps only a person the Template itself names for this Task;
  // anything else goes to the workspace default assignee of the day.
  const assigneeId = snapshot.assigneeId || defaultAssigneeId || undefined;
  return {
    ...copy(definitionFields),
    ...(assigneeId ? { assigneeId } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    cardId,
    templateId: template.id,
    source: 'template',
    templateTaskRef: definition.refId,
    templateVersion: template.version,
    ...(template.sourceRevision ? { templateSourceRevision: template.sourceRevision } : {}),
    templateDefinitionSnapshot: snapshot,
    status: 'todo',
    ...(definition.artifactRefs?.length ? { artifactRefs: copy(definition.artifactRefs) } : {}),
    ...(definition.auditEventRefs?.length ? { auditEventRefs: copy(definition.auditEventRefs) } : {}),
    ...(definition.intakeRefs?.length ? { intakeRefs: copy(definition.intakeRefs) } : {}),
  };
}
