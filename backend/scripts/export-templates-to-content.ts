import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_TEMPLATES, PODCAST_EXTERNAL_SOURCE_DOC_IDS } from './seed-templates';

type Link = {
  name?: string;
  url?: string;
};

type TaskDefinition = {
  refId: string;
  description: string;
  offsetDays: number;
  instructionsUrl?: string;
  instructionDocId?: string;
  instructionStepId?: string;
  isMilestone?: boolean;
  stageOnComplete?: string;
  assigneeId?: string;
  requiredLinkName?: string;
  requiresFile?: boolean;
  phase?: string;
  systems?: string[];
  proofRequirement?: {
    type?: string;
    label?: string;
    required?: boolean;
  };
  validation?: string | Record<string, unknown>;
};

type WorkflowPhase = {
  id: string;
  name: string;
  stage?: string;
};

type TaskTemplate = {
  name: string;
  type: string;
  emoji?: string;
  tags?: string[];
  defaultAssigneeId?: string;
  triggerType?: string;
  triggerSchedule?: string;
  triggerLeadDays?: number;
  phases?: WorkflowPhase[];
  sourceDocIds?: string[];
  references?: Link[];
  bundleLinkDefinitions?: Link[];
  taskDefinitions: TaskDefinition[];
};

const repoRoot = resolve(__dirname, '..', '..');
const outputDir = join(repoRoot, 'content', 'tasks', 'templates');
const externalSourceDocIds = new Set(PODCAST_EXTERNAL_SOURCE_DOC_IDS.map((doc) => doc.id));
const assistantLocalReferencePaths = new Set([
  ...PODCAST_EXTERNAL_SOURCE_DOC_IDS.map((doc) => doc.path),
  'assistants/podcast/README.md',
]);

mkdirSync(outputDir, { recursive: true });

for (const template of DEFAULT_TEMPLATES as TaskTemplate[]) {
  const path = join(outputDir, `${template.type}.md`);
  writeFileSync(path, renderTemplate(template), 'utf8');
}

console.log(`Exported ${DEFAULT_TEMPLATES.length} task templates to ${outputDir}`);

function renderTemplate(template: TaskTemplate): string {
  const title = `${template.name} Task Template`;
  const summary = `Git-backed DataTasks template for the ${template.name} operational workflow.`;
  const tags = unique([...(template.tags || []), 'task-template', template.type]);
  const relatedDocs = (template.sourceDocIds || []).filter((docId) => (
    docId !== templateDocId(template) && !externalSourceDocIds.has(docId)
  ));

  const parts = [
    '---',
    `id: ${templateDocId(template)}`,
    'aliases: []',
    `title: ${quoteYaml(title)}`,
    `summary: ${quoteYaml(summary)}`,
    'doc_type: task-template',
    'schema_version: 1',
    'source: "backend/scripts/seed-templates.ts"',
    'systems:',
    '  - dataops',
    '  - datatasks',
    'tags:',
    ...tags.map((tag) => `  - ${quoteYaml(tag)}`),
    renderRelatedDocs(relatedDocs),
    '---',
    '',
    `# ${escapeMarkdown(title)}`,
    '',
    '<!-- sop-section-start: summary -->',
    '## Summary',
    '',
    `- Template type: \`${template.type}\``,
    `- Trigger: ${template.triggerType || 'manual'}`,
    `- Task count: ${template.taskDefinitions.length}`,
    template.triggerSchedule ? `- Trigger schedule: \`${template.triggerSchedule}\`` : '',
    typeof template.triggerLeadDays === 'number' ? `- Trigger lead days: ${template.triggerLeadDays}` : '',
    template.defaultAssigneeId ? `- Default assignee ID: \`${template.defaultAssigneeId}\`` : '',
    '<!-- sop-section-end -->',
    '',
    '<!-- sop-section-start: purpose -->',
    '## Purpose',
    '',
    'Preserve the canonical task template in Git so the operational process can be reviewed, searched, and restored independently of the runtime task database.',
    '<!-- sop-section-end -->',
    '',
    renderLinks('References', contentSafeLinks(template.references || [])),
    renderLinks('Required Bundle Links', template.bundleLinkDefinitions || []),
    renderWorkflowDefinition(template),
    renderTasks(template.taskDefinitions),
  ].filter((line) => line !== null);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function contentSafeLinks(links: Link[]): Link[] {
  return links.filter((link) => {
    if (!link.url) {
      return true;
    }
    return !assistantLocalReferencePaths.has(link.url);
  });
}

function renderRelatedDocs(relatedDocs: string[]): string {
  if (relatedDocs.length === 0) {
    return 'related_docs: []';
  }
  return ['related_docs:', ...relatedDocs.map((docId) => `  - ${docId}`)].join('\n');
}

function renderLinks(title: string, links: Link[]): string {
  const lines = [
    '<!-- sop-section-start: ' + slug(title) + ' -->',
    `## ${title}`,
    '',
  ];
  if (links.length === 0) {
    lines.push('- None configured.');
  } else {
    for (const link of links) {
      const name = escapeMarkdown(link.name || link.url || 'Link');
      lines.push(link.url ? `- [${name}](${link.url})` : `- ${name}`);
    }
  }
  lines.push('<!-- sop-section-end -->', '');
  return lines.join('\n');
}

function renderTasks(tasks: TaskDefinition[]): string {
  if (usesOperatorWorkflowTable(tasks)) {
    return renderOperatorTasks(tasks);
  }

  const lines = [
    '<!-- sop-section-start: task-definitions -->',
    '## Task Definitions',
    '',
    '| # | Ref ID | Offset | Task | Requirements | Instructions |',
    '| - | - | -: | - | - | - |',
  ];

  tasks.forEach((task, index) => {
    const requirements = [
      task.isMilestone ? 'milestone' : '',
      task.stageOnComplete ? `stage: ${task.stageOnComplete}` : '',
      task.assigneeId ? `assignee: ${task.assigneeId}` : '',
      task.requiredLinkName ? `link: ${task.requiredLinkName}` : '',
      task.requiresFile ? 'file required' : '',
    ].filter(Boolean).join('<br>');
    const instructions = task.instructionsUrl ? `[open](${task.instructionsUrl})` : '';
    lines.push([
      String(index + 1),
      code(task.refId),
      String(task.offsetDays),
      escapeTable(task.description),
      requirements || '',
      instructions,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  });

  lines.push('<!-- sop-section-end -->', '');
  return lines.join('\n');
}

function renderOperatorTasks(tasks: TaskDefinition[]): string {
  const lines = [
    '<!-- sop-section-start: task-definitions -->',
    '## Task Definitions',
    '',
    '| # | Ref ID | Phase | Offset | Owner | Operator action | Context | Proof / closure | Waiting / follow-up |',
    '| - | - | - | -: | - | - | - | - | - |',
  ];

  tasks.forEach((task, index) => {
    const proof = renderProofClosure(task);
    lines.push([
      String(index + 1),
      code(task.refId),
      escapeTable(task.phase || ''),
      String(task.offsetDays),
      escapeTable(task.assigneeId || ''),
      escapeTable(task.description),
      escapeTable(renderTaskContext(task)),
      escapeTable(proof),
      escapeTable(renderWaitingFollowUp(task)),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  });

  lines.push('<!-- sop-section-end -->', '');
  return lines.join('\n');
}

function renderWorkflowDefinition(template: TaskTemplate): string {
  if (!template.phases || template.phases.length === 0) {
    return '';
  }

  const trigger = [
    template.triggerType || 'manual',
    template.triggerSchedule ? `\`${template.triggerSchedule}\`` : '',
    typeof template.triggerLeadDays === 'number' ? `${template.triggerLeadDays} lead days` : '',
  ].filter(Boolean).join(', ');
  const lines = [
    '<!-- sop-section-start: workflow-definition -->',
    '## Workflow Definition',
    '',
    `- Template ID: \`${templateDocId(template)}\``,
    `- Runtime type: \`${template.type}\``,
    `- Trigger: ${trigger}.`,
    template.defaultAssigneeId ? `- Default owner: \`${template.defaultAssigneeId}\`.` : '',
    '',
    'Stages:',
    '',
    '| Phase ID | Phase | Stage |',
    '| - | - | - |',
  ].filter((line) => line !== null);

  for (const phase of template.phases) {
    lines.push([
      code(phase.id),
      escapeTable(phase.name),
      phase.stage ? code(phase.stage) : '',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('<!-- sop-section-end -->', '');
  return lines.join('\n');
}

function usesOperatorWorkflowTable(tasks: TaskDefinition[]): boolean {
  return tasks.some((task) => (
    Boolean(task.phase)
    || Boolean(task.instructionDocId)
    || Boolean(task.proofRequirement)
    || (typeof task.validation === 'object' && task.validation !== null)
  ));
}

function renderTaskContext(task: TaskDefinition): string {
  const context = [
    task.instructionDocId || '',
    task.instructionStepId ? `step ${task.instructionStepId}` : '',
  ].filter(Boolean).join('<br>');
  if (context) {
    return context;
  }
  return task.instructionsUrl ? `[open](${task.instructionsUrl})` : '';
}

function renderProofClosure(task: TaskDefinition): string {
  const acceptanceNote = renderAcceptanceNote(task);
  if (task.proofRequirement && task.proofRequirement.required !== false) {
    const type = task.proofRequirement.type || 'proof';
    const label = task.proofRequirement.label || 'Required proof';
    return withAcceptanceNote(`${type}: ${label}`, acceptanceNote);
  }
  if (task.requiredLinkName) {
    return withAcceptanceNote(`url: ${task.requiredLinkName}`, acceptanceNote);
  }
  if (task.requiresFile) {
    return withAcceptanceNote('file: Required file', acceptanceNote);
  }
  if (task.stageOnComplete) {
    return withAcceptanceNote(`stage: ${task.stageOnComplete}`, acceptanceNote);
  }
  return acceptanceNote || 'none';
}

function renderAcceptanceNote(task: TaskDefinition): string {
  if (typeof task.validation !== 'object' || task.validation === null) {
    return '';
  }
  const acceptanceNote = task.validation.acceptanceNote;
  return typeof acceptanceNote === 'string' ? acceptanceNote : '';
}

function withAcceptanceNote(proof: string, acceptanceNote: string): string {
  return acceptanceNote ? `${proof}<br>${acceptanceNote}` : proof;
}

function renderWaitingFollowUp(task: TaskDefinition): string {
  if (typeof task.validation !== 'object' || task.validation === null) {
    return '';
  }
  const waitingSemantics = task.validation.waitingSemantics;
  if (typeof waitingSemantics !== 'object' || waitingSemantics === null || Array.isArray(waitingSemantics)) {
    return '';
  }
  const waitingFor = (waitingSemantics as Record<string, unknown>).waitingFor;
  return typeof waitingFor === 'string' ? waitingFor : '';
}

function templateDocId(template: TaskTemplate): string {
  return `task-template.tasks.${template.type}`;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function escapeTable(value: string): string {
  return escapeMarkdown(value).replace(/\n/g, ' ');
}

function code(value: string): string {
  return '`' + value.replace(/`/g, '\\`') + '`';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
