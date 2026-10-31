import { eventPolicyIssues } from '../events/policy';
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

import { cardTitlePatternIssues, recordTemplateTypes } from '../cards/cardTitlePattern';
import { EPISODE_STAGES, isEpisodeStage } from '../podcast/cardStatus';
import { requiresError } from '../resources/vocabulary';
import { browserRequirementError } from '../browserRequirement';
import { isTemplateIcon, TEMPLATE_ICONS } from './templateIcons';
import { templateDependencyIssues } from './taskDependencyGraph';
import { MAX_COUNT } from './repeatedTasks';

const TEMPLATE_FIELDS = [
  ['authoredId', 'id'],
  ['schemaVersion', 'schema_version'],
  ['department', 'department'],
  ['businessSystem', 'business_system'],
  ['ownerRole', 'owner_role'],
  ['status', 'status'],
  ['criticality', 'criticality'],
  ['outcome', 'outcome'],
  ['tools', 'tools'],
  ['reviewCycleDays', 'review_cycle_days'],
  ['lastReviewedAt', 'last_reviewed_at'],
  ['nextReviewAt', 'next_review_at'],
  ['icon', 'icon'],
  ['cardTitle', 'card_title'],
  ['eventPolicy', 'event_policy'],
  ['tags', 'tags'],
  ['sourceDocIds', 'source_document_ids'],
] as const;

const TASK_FIELDS = [
  ['taskKind', 'task_kind'],
  ['ownerRole', 'owner_role'],
  ['tools', 'tools'],
  ['instructionExemptReason', 'instruction_exempt_reason'],
  ['runtimeInstructionSource', 'runtime_instruction_source'],
  ['isMilestone', 'milestone'],
  ['stageOnComplete', 'stage_on_complete'],
  ['episodeStage', 'episode_stage'],
  ['assigneeId', 'assignee_id'],
  ['instructionsUrl', 'instructions_url'],
  ['instructionDocId', 'instruction_doc_id'],
  ['instructionStepId', 'instruction_step_id'],
  ['phase', 'phase_id'],
  ['requires', 'requires'],
  ['browserRequirement', 'browser_requirement'],
  ['dependsOn', 'depends_on'],
  ['validation', 'validation'],
  ['requiredLinkName', 'required_link'],
  ['requiresFile', 'requires_file'],
  ['requiresCalendarInvite', 'requires_calendar_invite'],
  ['optionalGroup', 'optional_group'],
  ['proofRequirement', 'proof'],
  ['tags', 'tags'],
  ['artifactRefs', 'artifact_refs'],
  ['intakeRefs', 'intake_refs'],
  ['auditEventRefs', 'audit_event_refs'],
] as const;

const PHASE_FIELDS = [
  ['id', 'id'], ['name', 'name'], ['stage', 'stage'],
  ['entryCriteria', 'entry_criteria'], ['exitCriteria', 'exit_criteria'],
  ['allowedNextPhaseIds', 'allowed_next_phase_ids'],
] as const;

const CLOSURE_FIELDS = [
  ['successCriteria', 'success_criteria'], ['followUp', 'follow_up'],
  ['closeCondition', 'close_condition'], ['waitingFor', 'waiting_for'],
  ['followUpAfterDays', 'follow_up_after_days'], ['recipientRole', 'recipient_role'],
] as const;

const COUNT_FIELD_FIELDS = [
  ['id', 'id'], ['label', 'label'], ['default', 'default'], ['min', 'min'], ['max', 'max'],
] as const;

const EXTERNAL_SOURCE_FIELDS = [
  ['id', 'id'], ['location', 'location'], ['kind', 'kind'], ['status', 'status'], ['note', 'note'],
] as const;

type Dict = Record<string, unknown>;

function assign(target: Dict, key: string, value: unknown): void {
  if (value === undefined) return;
  target[key] = value;
}

function mapFields(value: Dict, fields: readonly (readonly [string, string])[], toYaml: boolean): Dict {
  const result: Dict = {};
  for (const [runtime, authored] of fields) {
    assign(result, toYaml ? authored : runtime, value[toYaml ? runtime : authored]);
  }
  return result;
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

  const references = template.references as Dict[] | undefined;
  if (references !== undefined) doc.references = references.map((ref) => ({ name: ref.name, url: ref.url }));

  const cardLinks = template.cardLinkDefinitions as Dict[] | undefined;
  if (cardLinks !== undefined) doc.card_links = cardLinks.map((link) => ({ name: link.name }));

  const countFields = template.countFields as Dict[] | undefined;
  if (countFields !== undefined) doc.count_fields = countFields.map((field) => mapFields(field, COUNT_FIELD_FIELDS, true));

  const phases = template.phases as Dict[] | undefined;
  if (phases !== undefined) doc.phases = phases.map((phase) => mapFields(phase, PHASE_FIELDS, true));
  const externalSources = template.externalSourceDocuments as Dict[] | undefined;
  if (externalSources !== undefined) {
    doc.external_source_documents = externalSources.map((source) => mapFields(source, EXTERNAL_SOURCE_FIELDS, true));
  }

  doc.tasks = ((template.taskDefinitions as Dict[] | undefined) || []).map((task) => {
    const out: Dict = { id: task.refId, name: task.description };
    const schedule: Dict = { offset_days: task.offsetDays };
    if (task.anchor === 'end') schedule.anchor = 'end';
    else if (task.anchor === 'start') schedule.anchor = 'start';
    out.schedule = schedule;
    for (const [runtime, authored] of TASK_FIELDS) assign(out, authored, task[runtime]);
    if (task.repeat !== undefined) out.repeat = { count_field: (task.repeat as Dict).countField };
    if (task.linkCard !== undefined) {
      const linkCard = task.linkCard as Dict;
      out.link_card = { template_type: linkCard.templateType, ...(linkCard.slot !== undefined ? { slot: linkCard.slot } : {}) };
    }
    if (task.closure !== undefined) out.closure = mapFields(task.closure as Dict, CLOSURE_FIELDS, true);
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

  const phases = doc.phases as Dict[] | undefined;
  if (phases !== undefined) template.phases = phases.map((phase) => mapFields(phase, PHASE_FIELDS, false));
  const externalSources = doc.external_source_documents as Dict[] | undefined;
  if (externalSources !== undefined) {
    template.externalSourceDocuments = externalSources.map((source) => mapFields(source, EXTERNAL_SOURCE_FIELDS, false));
  }

  // Absence and an explicitly empty authored list are distinct definitions.
  if (doc.references !== undefined) {
    template.references = (doc.references as Dict[]).map((ref) => ({ name: ref.name, url: ref.url }));
  }
  if (doc.card_links !== undefined) {
    template.cardLinkDefinitions = (doc.card_links as Dict[]).map((link) => ({ name: link.name }));
  }
  if (doc.count_fields !== undefined) {
    template.countFields = (doc.count_fields as Dict[]).map((field) => mapFields(field, COUNT_FIELD_FIELDS, false));
  }

  template.taskDefinitions = ((doc.tasks as Dict[] | undefined) || []).map((task) => {
    const schedule = (task.schedule as Dict | undefined) || {};
    const out: Dict = {
      refId: task.id,
      description: task.name,
      offsetDays: schedule.offset_days,
    };
    if (schedule.anchor === 'end') out.anchor = 'end';
    else if (schedule.anchor === 'start') out.anchor = 'start';
    for (const [runtime, authored] of TASK_FIELDS) assign(out, runtime, task[authored]);
    if (task.repeat !== undefined) out.repeat = { countField: (task.repeat as Dict | null)?.count_field };
    if (task.link_card !== undefined) {
      const linkCard = task.link_card as Dict | null;
      out.linkCard = { templateType: linkCard?.template_type, ...(linkCard?.slot !== undefined ? { slot: linkCard.slot } : {}) };
    }
    if (task.closure !== undefined) out.closure = mapFields(task.closure as Dict, CLOSURE_FIELDS, false);
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
  const strings = (value: Dict, fields: string[]) => {
    for (const field of fields) {
      if (value[field] !== undefined && typeof value[field] !== 'string') fail(`${field} must be a string`);
    }
  };
  const stringLists = (value: Dict, fields: string[]) => {
    for (const field of fields) {
      const list = value[field];
      if (list !== undefined && (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string'))) {
        fail(`${field} must be a string list`);
      }
    }
  };
  strings(doc, ['id', 'department', 'business_system', 'owner_role', 'status', 'criticality', 'outcome']);
  stringLists(doc, ['tools']);
  for (const field of ['schema_version', 'review_cycle_days']) {
    if (doc[field] !== undefined && !Number.isInteger(doc[field])) fail(`${field} must be an integer`);
  }
  for (const field of ['last_reviewed_at', 'next_review_at']) {
    if (doc[field] !== undefined && doc[field] !== null && typeof doc[field] !== 'string') {
      fail(`${field} must be a date string or null`);
    }
  }
  if (doc.external_source_documents !== undefined) {
    if (!Array.isArray(doc.external_source_documents)) fail('external_source_documents must be a list');
    else for (const source of doc.external_source_documents) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        fail('external source document must be an object');
        continue;
      }
      for (const field of ['id', 'location', 'kind', 'status', 'note']) {
        if (typeof source[field] !== 'string') fail(`external source document ${field} must be a string`);
      }
    }
  }

  if (!doc.type || !/^[a-z0-9][a-z0-9-]*$/.test(String(doc.type))) fail('type must be a slug');
  if (!doc.name) fail('name is required');
  if (doc.icon !== undefined && !isTemplateIcon(doc.icon)) {
    fail(`icon must be one of: ${TEMPLATE_ICONS.join(', ')}`);
  }

  if (doc.event_policy !== undefined) {
    for (const issue of eventPolicyIssues(doc.event_policy)) fail(issue);
  }

  if (doc.card_title !== undefined) {
    for (const message of cardTitlePatternIssues(String(doc.type), doc.card_title)) fail(message);
  }

  const trigger = (doc.trigger as Dict | undefined) || {};
  if (!trigger.mode) fail('trigger.mode is required');

  const tasks = (doc.tasks as Dict[] | undefined) || [];
  if (tasks.length === 0) fail('at least one task is required');

  const phaseIds = new Set(((doc.phases as Dict[] | undefined) || []).map((phase) => String(phase.id)));
  for (const phase of (doc.phases as Dict[] | undefined) || []) {
    stringLists(phase, ['entry_criteria', 'exit_criteria', 'allowed_next_phase_ids']);
  }
  const linkNames = new Set(((doc.card_links as Dict[] | undefined) || []).map((link) => String(link.name)));
  const countFieldIds = new Set<string>();
  if (doc.count_fields !== undefined) {
    if (!Array.isArray(doc.count_fields)) fail('count_fields must be a list');
    else for (const field of doc.count_fields as unknown[]) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        fail('count field must be an object');
        continue;
      }
      const entry = field as Dict;
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('count field id must be a slug');
      else if (countFieldIds.has(id)) fail(`duplicate count field '${id}'`);
      countFieldIds.add(id);
      if (typeof entry.label !== 'string' || !entry.label.trim()) fail(`count field '${id}' needs a label`);
      const [min, max, initial] = [entry.min, entry.max, entry.default];
      if (![min, max, initial].every(Number.isInteger)) {
        fail(`count field '${id}' min, max and default must be integers`);
      } else if (!(0 <= (min as number) && (min as number) <= (initial as number)
        && (initial as number) <= (max as number) && (max as number) <= MAX_COUNT)) {
        fail(`count field '${id}' needs 0 <= min <= default <= max <= ${MAX_COUNT}`);
      }
    }
  }
  const seen = new Set<string>();
  const episodeStageTasks = new Map<string, string>();
  const createsEpisodes = recordTemplateTypes('podcast-episode').includes(type);

  for (const task of tasks) {
    strings(task, ['task_kind', 'owner_role', 'instruction_exempt_reason', 'runtime_instruction_source', 'optional_group']);
    stringLists(task, ['tools', 'tags', 'depends_on']);
    if (task.closure !== undefined) {
      const closure = task.closure as Dict;
      if (!closure || typeof closure !== 'object' || Array.isArray(closure)) fail('closure must be an object');
      else {
        for (const field of ['success_criteria', 'follow_up', 'close_condition']) {
          if (typeof closure[field] !== 'string') fail(`closure ${field} must be a string`);
        }
        strings(closure, ['waiting_for', 'recipient_role']);
        if (closure.follow_up_after_days !== undefined && !Number.isInteger(closure.follow_up_after_days)) {
          fail('closure follow_up_after_days must be an integer');
        }
      }
    }
    const id = String(task.id || '');
    if (!id) { fail('a task is missing an id'); continue; }
    if (seen.has(id)) fail(`duplicate task id '${id}'`);
    if (id.includes('#')) fail(`task id '${id}' must not contain '#' (it numbers repeated tasks)`);
    seen.add(id);
    if (typeof task.optional_group === 'string' && !/^[a-z0-9][a-z0-9-]*$/.test(task.optional_group)) {
      fail(`task '${id}' optional_group must be a slug`);
    }

    if (task.requires !== undefined) {
      const error = requiresError(task.requires);
      if (error) fail(`task '${id}' ${error}`);
    }

    if (task.repeat !== undefined) {
      const repeat = task.repeat as Dict | null;
      const field = repeat && typeof repeat === 'object' ? repeat.count_field : undefined;
      if (typeof field !== 'string') fail(`task '${id}' repeat needs a count_field`);
      else if (!countFieldIds.has(field)) fail(`task '${id}' repeats by unknown count field '${field}'`);
    }

    if (task.link_card !== undefined) {
      const linkCard = task.link_card as Dict | null;
      const type = linkCard && typeof linkCard === 'object' ? linkCard.template_type : undefined;
      if (typeof type !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(type)) {
        fail(`task '${id}' link_card needs a template_type slug`);
      }
      if (linkCard?.slot !== undefined && (typeof linkCard.slot !== 'string' || !linkCard.slot.trim() || linkCard.slot.length > 80)) {
        fail(`task '${id}' link_card slot must be a name of 1 to 80 characters`);
      }
    }

    if (task.browser_requirement !== undefined) {
      const error = browserRequirementError(task.browser_requirement, 'browser_requirement');
      if (error) fail(`task '${id}' ${error}`);
    }

    const schedule = (task.schedule as Dict | undefined) || {};
    if (typeof schedule.offset_days !== 'number') fail(`task '${id}' needs schedule.offset_days`);
    if (schedule.anchor !== undefined && schedule.anchor !== 'start' && schedule.anchor !== 'end') {
      fail(`task '${id}' schedule.anchor must be start or end`);
    }

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
    if (
      task.stage_on_complete !== undefined
      && !['preparation', 'announced', 'after-event'].includes(String(task.stage_on_complete))
    ) {
      fail(`task '${id}' stage_on_complete must be preparation, announced, or after-event`);
    }
    if (task.episode_stage !== undefined) {
      const stage = task.episode_stage;
      if (!createsEpisodes) {
        fail(`task '${id}' episode_stage is only supported on templates that create podcast episodes (${recordTemplateTypes('podcast-episode').join(', ')})`);
      } else if (!isEpisodeStage(stage)) {
        fail(`task '${id}' episode_stage must be ${EPISODE_STAGES.join(', ')}`);
      } else if (episodeStageTasks.has(stage)) {
        fail(`task '${id}' episode_stage ${stage} is already marked by task '${episodeStageTasks.get(stage)}'`);
      } else {
        episodeStageTasks.set(stage, id);
      }
    }
    const link = task.required_link;
    if (typeof link === 'string' && linkNames.size > 0 && !linkNames.has(link)) {
      fail(`task '${id}' requires card link '${link}' which the template does not define`);
    }
  }

  const dependencyShapeValid = Array.isArray(tasks) && tasks.every((task) => (
    task && typeof task === 'object' && (task.depends_on === undefined
    || (Array.isArray(task.depends_on) && task.depends_on.every((ref) => typeof ref === 'string')))
  ));
  if (dependencyShapeValid) {
    for (const message of templateDependencyIssues(tasks.map((task) => ({
      refId: String(task.id || ''),
      dependsOn: task.depends_on as string[] | undefined,
      optionalGroup: typeof task.optional_group === 'string' ? task.optional_group : undefined,
      repeat: task.repeat && typeof (task.repeat as Dict).count_field === 'string'
        ? { countField: (task.repeat as Dict).count_field as string }
        : undefined,
    })))) fail(message);
  }

  return issues;
}
