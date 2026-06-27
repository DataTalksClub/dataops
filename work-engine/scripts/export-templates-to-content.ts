import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_TEMPLATES } from './seed-templates';

type Link = {
  name?: string;
  url?: string;
};

type TaskDefinition = {
  refId: string;
  description: string;
  offsetDays: number;
  instructionsUrl?: string;
  isMilestone?: boolean;
  stageOnComplete?: string;
  assigneeId?: string;
  requiredLinkName?: string;
  requiresFile?: boolean;
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
  references?: Link[];
  bundleLinkDefinitions?: Link[];
  taskDefinitions: TaskDefinition[];
};

const repoRoot = resolve(__dirname, '..', '..');
const outputDir = join(repoRoot, 'content', 'tasks', 'templates');

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

  const parts = [
    '---',
    `title: ${quoteYaml(title)}`,
    `summary: ${quoteYaml(summary)}`,
    'doc_type: task-template',
    'schema_version: 1',
    'source: "work-engine/scripts/seed-templates.ts"',
    'systems:',
    '  - dataops',
    '  - datatasks',
    'tags:',
    ...tags.map((tag) => `  - ${quoteYaml(tag)}`),
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
    renderLinks('References', template.references || []),
    renderLinks('Required Bundle Links', template.bundleLinkDefinitions || []),
    renderTasks(template.taskDefinitions),
  ].filter((line) => line !== null);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
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
