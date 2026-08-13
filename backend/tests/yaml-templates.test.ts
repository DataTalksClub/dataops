import { describe, it } from 'node:test';
import assert from 'node:assert';
import yaml from 'js-yaml';

import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';

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
