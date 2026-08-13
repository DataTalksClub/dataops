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
    emoji: template.emoji,
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
    emoji: snapshot.emoji,
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
  return withoutUndefined({
    description: definition.description,
    date: dateFromTemplateOffset(anchorDate, offsetDays),
    templateOffsetDays: offsetDays,
    templateTaskOrder: order,
    isMilestone: definition.isMilestone,
    stageOnComplete: definition.stageOnComplete,
    assigneeId: definition.assigneeId || template.defaultAssigneeId,
    instructionsUrl: definition.instructionsUrl,
    instructionDocId: definition.instructionDocId,
    instructionStepId: definition.instructionStepId,
    phase: definition.phase,
    systems: definition.systems ? copy(definition.systems) : undefined,
    validation: definition.validation ? copy(definition.validation) : undefined,
    requiredLinkName: definition.requiredLinkName,
    requiresFile: definition.requiresFile,
    proofRequirement: definition.proofRequirement ? copy(definition.proofRequirement) : undefined,
    tags: template.tags?.length ? copy(template.tags) : undefined,
    sourceDocIds: template.sourceDocIds?.length ? copy(template.sourceDocIds) : undefined,
  });
}

export function templateTaskProjection(
  template: Template,
  definition: TaskDefinition,
  order: number,
  anchorDate: string,
  cardId: string,
): Dict {
  const snapshot = templateTaskDefinitionSnapshot(template, definition, order, anchorDate);
  return {
    ...copy(snapshot),
    cardId,
    templateId: template.id,
    source: 'template',
    templateTaskRef: definition.refId,
    templateVersion: template.version,
    ...(template.sourceRevision ? { templateSourceRevision: template.sourceRevision } : {}),
    templateDefinitionSnapshot: snapshot,
    status: 'todo',
    ...(definition.artifactRefs?.length ? { artifactRefs: copy(definition.artifactRefs) } : {}),
    ...(definition.assistantJobRefs?.length ? { assistantJobRefs: copy(definition.assistantJobRefs) } : {}),
    ...(definition.auditEventRefs?.length ? { auditEventRefs: copy(definition.auditEventRefs) } : {}),
    ...(definition.intakeRefs?.length ? { intakeRefs: copy(definition.intakeRefs) } : {}),
  };
}
