/**
 * Git-authored workflow templates.
 *
 * A template is a process definition, so it is authored as YAML and reviewed
 * like the process documents it links to, rather than edited as a TypeScript
 * array and rendered into read-only Markdown afterwards.
 *
 * The mapping is deliberately lossless in both directions: `templateToYaml` and
 * `templateFromYaml` round-trip every field the runtime model carries. A
 * template that survives the round-trip unchanged is the property the tests
 * assert, because a lossy export is exactly how the generated Markdown drifted
 * from its source in the first place.
 *
 * YAML uses snake_case, matching the document frontmatter convention used
 * throughout the content corpus and the workflow-template JSON Schema.
 */

const TEMPLATE_FIELDS = [
  ['emoji', 'emoji'],
  ['tags', 'tags'],
  ['defaultAssigneeId', 'default_assignee_id'],
  ['sourceDocIds', 'source_document_ids'],
] as const;

const TASK_FIELDS = [
  ['isMilestone', 'milestone'],
  ['stageOnComplete', 'stage_on_complete'],
  ['assigneeId', 'assignee_id'],
  ['instructionsUrl', 'instructions_url'],
  ['instructionDocId', 'instruction_doc_id'],
  ['instructionStepId', 'instruction_step_id'],
  ['phase', 'phase_id'],
  ['systems', 'systems'],
  ['validation', 'validation'],
  ['requiredLinkName', 'required_link'],
  ['requiresFile', 'requires_file'],
  ['proofRequirement', 'proof'],
  ['artifactRefs', 'artifact_refs'],
  ['assistantJobRefs', 'assistant_job_refs'],
  ['intakeRefs', 'intake_refs'],
  ['auditEventRefs', 'audit_event_refs'],
] as const;

type Dict = Record<string, unknown>;

function assign(target: Dict, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value) && value.length === 0) return;
  target[key] = value;
}

/** Render one runtime template as the authored YAML document shape. */
export function templateToYaml(template: Dict): Dict {
  const doc: Dict = { type: template.type, name: template.name };
  for (const [runtime, authored] of TEMPLATE_FIELDS) assign(doc, authored, template[runtime]);

  const trigger: Dict = { mode: template.triggerType || 'manual' };
  assign(trigger, 'schedule', template.triggerSchedule);
  assign(trigger, 'lead_days', template.triggerLeadDays);
  assign(trigger, 'enabled', template.triggerEnabled);
  doc.trigger = trigger;

  const references = (template.references as Dict[] | undefined) || [];
  if (references.length > 0) doc.references = references.map((ref) => ({ name: ref.name, url: ref.url }));

  const cardLinks = (template.cardLinkDefinitions as Dict[] | undefined) || [];
  if (cardLinks.length > 0) doc.card_links = cardLinks.map((link) => ({ name: link.name }));

  const phases = (template.phases as Dict[] | undefined) || [];
  if (phases.length > 0) {
    doc.phases = phases.map((phase) => {
      const out: Dict = { id: phase.id, name: phase.name };
      assign(out, 'stage', phase.stage);
      return out;
    });
  }

  doc.tasks = ((template.taskDefinitions as Dict[] | undefined) || []).map((task) => {
    const out: Dict = { id: task.refId, name: task.description };
    out.schedule = { offset_days: task.offsetDays };
    for (const [runtime, authored] of TASK_FIELDS) assign(out, authored, task[runtime]);
    return out;
  });

  return doc;
}

/** Rebuild the runtime template from an authored YAML document. */
export function templateFromYaml(doc: Dict): Dict {
  const template: Dict = { type: doc.type, name: doc.name };
  for (const [runtime, authored] of TEMPLATE_FIELDS) assign(template, runtime, doc[authored]);

  const trigger = (doc.trigger as Dict | undefined) || {};
  assign(template, 'triggerType', trigger.mode);
  assign(template, 'triggerSchedule', trigger.schedule);
  assign(template, 'triggerLeadDays', trigger.lead_days);
  assign(template, 'triggerEnabled', trigger.enabled);

  const phases = (doc.phases as Dict[] | undefined) || [];
  if (phases.length > 0) {
    template.phases = phases.map((phase) => {
      const out: Dict = { id: phase.id, name: phase.name };
      assign(out, 'stage', phase.stage);
      return out;
    });
  }

  // References and card links are always present on the runtime template, even
  // when empty, because the seeding path and the admin API both expect the keys.
  template.references = ((doc.references as Dict[] | undefined) || [])
    .map((ref) => ({ name: ref.name, url: ref.url }));
  template.cardLinkDefinitions = ((doc.card_links as Dict[] | undefined) || [])
    .map((link) => ({ name: link.name }));

  template.taskDefinitions = ((doc.tasks as Dict[] | undefined) || []).map((task) => {
    const schedule = (task.schedule as Dict | undefined) || {};
    const out: Dict = {
      refId: task.id,
      description: task.name,
      offsetDays: schedule.offset_days,
    };
    for (const [runtime, authored] of TASK_FIELDS) assign(out, runtime, task[authored]);
    return out;
  });

  return template;
}

export interface TemplateValidationIssue {
  template: string;
  message: string;
}

/**
 * Validates an authored template. Instruction documents are checked against the
 * document registry so a template can never point at a process document that
 * does not exist; that is the failure the Google Doc migration was about.
 */
export function validateAuthoredTemplate(doc: Dict, knownDocIds: Set<string> | null = null): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const type = String(doc.type || '(untyped)');
  const fail = (message: string) => issues.push({ template: type, message });

  if (!doc.type || !/^[a-z0-9][a-z0-9-]*$/.test(String(doc.type))) fail('type must be a slug');
  if (!doc.name) fail('name is required');

  const trigger = (doc.trigger as Dict | undefined) || {};
  if (!trigger.mode) fail('trigger.mode is required');

  const tasks = (doc.tasks as Dict[] | undefined) || [];
  if (tasks.length === 0) fail('at least one task is required');

  const phaseIds = new Set(((doc.phases as Dict[] | undefined) || []).map((phase) => String(phase.id)));
  const linkNames = new Set(((doc.card_links as Dict[] | undefined) || []).map((link) => String(link.name)));
  const seen = new Set<string>();

  for (const task of tasks) {
    const id = String(task.id || '');
    if (!id) { fail('a task is missing an id'); continue; }
    if (seen.has(id)) fail(`duplicate task id '${id}'`);
    seen.add(id);

    const schedule = (task.schedule as Dict | undefined) || {};
    if (typeof schedule.offset_days !== 'number') fail(`task '${id}' needs schedule.offset_days`);

    const docId = task.instruction_doc_id;
    if (typeof docId === 'string' && knownDocIds && !knownDocIds.has(docId)) {
      fail(`task '${id}' points at unknown process document '${docId}'`);
    }
    if (!docId && typeof task.instructions_url === 'string' && /docs\.google\.com/.test(task.instructions_url)) {
      fail(`task '${id}' has a Google Docs link without an internal process document`);
    }

    const phaseId = task.phase_id;
    if (typeof phaseId === 'string' && phaseIds.size > 0 && !phaseIds.has(phaseId)) {
      fail(`task '${id}' references unknown phase '${phaseId}'`);
    }
    const link = task.required_link;
    if (typeof link === 'string' && linkNames.size > 0 && !linkNames.has(link)) {
      fail(`task '${id}' requires card link '${link}' which the template does not define`);
    }
  }

  return issues;
}
