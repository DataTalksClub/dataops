import { describe, it } from 'node:test';
import assert from 'node:assert';
import yaml from 'js-yaml';

import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import type { Template } from '../src/types';
import { syntheticAuthoredTemplate } from './helpers/authoredTemplates';

const RUNTIME_TEMPLATE = {
  type: 'synthetic-workflow',
  name: 'Synthetic workflow',
  emoji: '',
  tags: ['synthetic'],
  triggerType: 'automatic',
  triggerSchedule: '0 9 * * 1',
  triggerLeadDays: 2,
  triggerEnabled: false,
  references: [],
  cardLinkDefinitions: [{ name: 'Synthetic output' }],
  taskDefinitions: [{
    refId: 'prepare',
    description: 'Prepare the synthetic output',
    offsetDays: -2,
    phase: 'preparation',
    requiredLinkName: 'Synthetic output',
    proofRequirement: { type: 'url', required: true },
  }],
  phases: [{ id: 'preparation', name: 'Preparation', stage: 'preparation' }],
};

describe('authored YAML template mapping', () => {
  it('preserves every supported authored metadata field with explicit runtime names and types', () => {
    const authored = syntheticAuthoredTemplate();
    assert.deepStrictEqual(validateAuthoredTemplate(authored), []);
    const runtime = templateFromYaml(authored);
    const expected = {
      authoredId: 'workflow.synthetic-workflow', schemaVersion: 2,
      type: 'synthetic-workflow', name: 'Synthetic synthetic-workflow',
      department: 'synthetic-department', businessSystem: 'synthetic-system', ownerRole: 'synthetic-owner',
      status: 'draft', criticality: 'supporting', outcome: 'A synthetic result is checked',
      tools: ['synthetic-editor', 'synthetic-checker'], reviewCycleDays: 30,
      lastReviewedAt: null, nextReviewAt: '2030-06-15', emoji: '', tags: [],
      defaultAssigneeId: 'synthetic-user', sourceDocIds: [], externalSourceDocuments: [{
        id: 'synthetic.source', location: 'https://example.invalid/synthetic-source',
        kind: 'external-process', status: 'provenance-only', note: 'Synthetic reference only',
      }],
      triggerType: 'automatic', triggerSchedule: '0 9 * * 1', triggerLeadDays: 0, triggerEnabled: false,
      references: [], cardLinkDefinitions: [{ name: 'Synthetic result' }],
      phases: [{
        id: 'prepare', name: 'Prepare', stage: 'preparation',
        entryCriteria: ['Synthetic input exists', 'Synthetic check is available'],
        exitCriteria: ['Synthetic result is checked'], allowedNextPhaseIds: ['finish'],
      }, {
        id: 'finish', name: 'Finish', stage: 'done', entryCriteria: ['Synthetic check is complete'],
        exitCriteria: ['Synthetic result is filed'], allowedNextPhaseIds: [],
      }],
      taskDefinitions: [{
        refId: 'first', description: 'Check the synthetic result', offsetDays: 0,
        taskKind: 'checklist', ownerRole: 'synthetic-reviewer', tools: [],
        instructionExemptReason: 'Synthetic self-contained check', runtimeInstructionSource: 'synthetic-input',
        isMilestone: false, stageOnComplete: 'preparation', assigneeId: 'synthetic-user',
        instructionDocId: 'synthetic.instructions', instructionStepId: 'check', phase: 'prepare',
        systems: [], validation: { enabled: false, attempts: 0, checks: [] },
        requiredLinkName: 'Synthetic result', requiresFile: false,
        proofRequirement: { type: 'comment', label: 'Synthetic check result', required: false },
        closure: {
          successCriteria: 'Synthetic checks pass', followUp: 'waiting',
          closeCondition: 'Synthetic response is recorded', waitingFor: 'Synthetic response',
          followUpAfterDays: 3, recipientRole: 'synthetic-reviewer',
        },
        artifactRefs: [], assistantJobRefs: [], intakeRefs: [], auditEventRefs: [],
      }],
    } satisfies Omit<Template, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
    assert.deepStrictEqual(runtime, expected);
    assert.deepStrictEqual(templateToYaml(runtime), authored);
    assert.deepStrictEqual(templateFromYaml(templateToYaml(expected)), expected);
    assert.ok(!Object.hasOwn(runtime, 'id'));
    assert.ok(!Object.hasOwn(runtime, 'version'));
  });

  it('distinguishes absent lists from explicitly empty lists at every definition level', () => {
    const authored = syntheticAuthoredTemplate();
    for (const field of ['tools', 'tags', 'source_document_ids', 'external_source_documents', 'references', 'card_links', 'phases']) {
      for (const present of [false, true]) {
        const document: Record<string, unknown> = structuredClone(authored);
        if (present) document[field] = [];
        else delete document[field];
        assert.deepStrictEqual(templateToYaml(templateFromYaml(document)), document, `${field} present=${present}`);
      }
    }
    const document = structuredClone(authored);
    document.phases[0].entry_criteria = [];
    document.phases[0].exit_criteria = [];
    document.phases[0].allowed_next_phase_ids = [];
    document.tasks[0].tools = [];
    document.last_reviewed_at = null;
    assert.deepStrictEqual(templateToYaml(templateFromYaml(document)), document);
  });

  it('round-trips every runtime field without losing false or empty values', () => {
    const authored = templateToYaml(RUNTIME_TEMPLATE);
    const restored = templateFromYaml(authored);
    assert.deepStrictEqual(restored, RUNTIME_TEMPLATE);
  });

  it('survives YAML serialization', () => {
    const text = yaml.dump(templateToYaml(RUNTIME_TEMPLATE), { lineWidth: 100, noRefs: true });
    const restored = templateFromYaml(yaml.load(text) as Record<string, unknown>);
    assert.deepStrictEqual(restored, RUNTIME_TEMPLATE);
  });

  it('validates structural and optional document-reference constraints', () => {
    const authored = templateToYaml(RUNTIME_TEMPLATE);
    assert.deepStrictEqual(validateAuthoredTemplate(authored), []);

    const task = (authored.tasks as Record<string, unknown>[])[0];
    task.instruction_doc_id = 'sop.synthetic.missing';
    const issues = validateAuthoredTemplate(authored, new Set()).map((issue) => issue.message);
    assert.ok(issues.some((message) => message.includes('unknown process document')));
  });

  it('rejects duplicate tasks, unknown phases, undefined card links, and Google Docs-only instructions', () => {
    const authored = templateToYaml(RUNTIME_TEMPLATE);
    const tasks = authored.tasks as Record<string, unknown>[];
    tasks.push({
      ...tasks[0],
      phase_id: 'missing-phase',
      required_link: 'Missing link',
      instructions_url: 'https://docs.google.com/document/d/synthetic/edit',
    });
    const messages = validateAuthoredTemplate(authored).map((issue) => issue.message).join('\n');
    assert.match(messages, /duplicate task id/);
    assert.match(messages, /unknown phase/);
    assert.match(messages, /card link/);
    assert.match(messages, /Google Docs link without an internal process document/);
  });
});
