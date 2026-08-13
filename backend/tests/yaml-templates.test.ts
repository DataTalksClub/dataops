import { describe, it } from 'node:test';
import assert from 'node:assert';
import yaml from 'js-yaml';

import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import { findKnownDocIds } from './helpers/content';
import { DEFAULT_TEMPLATES } from '../scripts/seed-templates';

// Corpus lives in the private knowledge repository; skip when absent.
const knownDocIds = findKnownDocIds();

describe('authored YAML templates', () => {
  it('round-trips every template without losing a field', () => {
    for (const template of DEFAULT_TEMPLATES as any[]) {
      const authored = templateToYaml(template);
      const restored = templateFromYaml(authored);
      assert.deepStrictEqual(restored, template, `${template.type} did not survive the round trip`);
    }
  });

  it('survives serialisation, so the file on disk is the source and not a rendering', () => {
    for (const template of DEFAULT_TEMPLATES as any[]) {
      const text = yaml.dump(templateToYaml(template), { lineWidth: 100, noRefs: true });
      const restored = templateFromYaml(yaml.load(text) as Record<string, unknown>);
      assert.deepStrictEqual(restored, template, `${template.type} changed through YAML`);
    }
  });

  it('accepts the real templates', (t) => {
    if (!knownDocIds) return t.skip('knowledge repository not checked out');
    for (const template of DEFAULT_TEMPLATES as any[]) {
      const issues = validateAuthoredTemplate(templateToYaml(template), knownDocIds);
      assert.deepStrictEqual(issues, [], `${template.type} should validate`);
    }
  });

  it('refuses a task pointing at a process document that does not exist', (t) => {
    if (!knownDocIds) return t.skip('knowledge repository not checked out');
    const doc = templateToYaml((DEFAULT_TEMPLATES as any[])[0]);
    (doc.tasks as any[])[0].instruction_doc_id = 'sop.nowhere.missing';
    const issues = validateAuthoredTemplate(doc, knownDocIds);
    assert.ok(
      issues.some((issue) => issue.message.includes("unknown process document 'sop.nowhere.missing'")),
      JSON.stringify(issues),
    );
  });

  it('refuses a Google Docs link with no internal process document', (t) => {
    if (!knownDocIds) return t.skip('knowledge repository not checked out');
    const doc = templateToYaml((DEFAULT_TEMPLATES as any[])[0]);
    const task = (doc.tasks as any[])[0];
    delete task.instruction_doc_id;
    task.instructions_url = 'https://docs.google.com/document/d/abc/edit';
    const issues = validateAuthoredTemplate(doc, knownDocIds);
    assert.ok(issues.some((issue) => issue.message.includes('without an internal process document')), JSON.stringify(issues));
  });

  it('catches duplicate task ids, unknown phases and undefined card links', (t) => {
    if (!knownDocIds) return t.skip('knowledge repository not checked out');
    const doc = templateToYaml((DEFAULT_TEMPLATES as any[])[0]);
    const tasks = doc.tasks as any[];
    tasks.push({ ...tasks[0] });
    tasks[1].phase_id = 'no-such-phase';
    tasks[1].required_link = 'No Such Link';
    doc.phases = [{ id: 'real-phase', name: 'Real', stage: 'preparation' }];
    doc.card_links = [{ name: 'Real Link' }];

    const messages = validateAuthoredTemplate(doc, knownDocIds).map((issue) => issue.message).join('\n');
    assert.match(messages, /duplicate task id/);
    assert.match(messages, /unknown phase 'no-such-phase'/);
    assert.match(messages, /card link 'No Such Link'/);
  });

  it('requires a type, a name and at least one task', (t) => {
    if (!knownDocIds) return t.skip('knowledge repository not checked out');
    const issues = validateAuthoredTemplate({ tasks: [] }, knownDocIds).map((issue) => issue.message);
    assert.ok(issues.some((m) => m.includes('type must be a slug')));
    assert.ok(issues.some((m) => m.includes('name is required')));
    assert.ok(issues.some((m) => m.includes('at least one task')));
  });
});
