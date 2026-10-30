import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import yaml from 'js-yaml';

import {
  expandTemplateIncludes,
  isIncludeEntry,
  parseBlockFiles,
} from '../src/templates/blocks';
import { loadAuthoredTemplatesFromDirectory, parseAuthoredTemplateFiles } from '../src/templates/authoredTemplates';

const SPONSOR_BLOCK = [
  'params:',
  '  prefix: ""',
  '  slot: null',
  '  anchor: schedule-email-newsletter',
  '  offset_days: 7',
  '  name_prefix: ""',
  'anchor_from: schedule-email-newsletter',
  'slot_tasks:',
  '  - send-performance-to-sponsor',
  'tasks:',
  '  - id: collect-mailchimp-stats',
  '    name: Collect newsletter stats from Mailchimp',
  '    schedule: { offset_days: 7 }',
  '    depends_on: [schedule-email-newsletter]',
  '    task_kind: milestone',
  '    owner_role: newsletter-owner',
  '    tools: [mailchimp]',
  '    requires: [mailchimp]',
  '    phase_id: performance',
  '    proof: { type: external-status, label: Mailchimp stats recorded, required: true }',
  '    closure: { success_criteria: Stats recorded, follow_up: none, close_condition: Proof present }',
  '  - id: collect-x-stats',
  '    name: Collect stats from X post',
  '    schedule: { offset_days: 7 }',
  '    depends_on: [schedule-email-newsletter]',
  '    task_kind: milestone',
  '    owner_role: newsletter-owner',
  '    tools: [x]',
  '    requires: [x]',
  '    phase_id: performance',
  '    proof: { type: external-status, label: X stats recorded, required: true }',
  '    closure: { success_criteria: Stats recorded, follow_up: none, close_condition: Proof present }',
  '  - id: send-performance-to-sponsor',
  '    name: Send the performance of the newsletter to the sponsor',
  '    schedule: { offset_days: 7 }',
  '    depends_on: [collect-mailchimp-stats, collect-x-stats]',
  '    optional_group: primary-slot',
  '    task_kind: milestone',
  '    owner_role: newsletter-owner',
  '    tools: [email]',
  '    requires: [gmail]',
  '    phase_id: performance',
  '    proof: { type: comment, label: Sponsor report sent, required: true }',
  '    closure: { success_criteria: Report sent, follow_up: none, close_condition: Proof present }',
  '',
].join('\n');

function templateWithTasks(tasks: unknown[]): Record<string, unknown> {
  return {
    id: 'workflow.newsletter',
    schema_version: 2,
    type: 'newsletter',
    name: 'Newsletter',
    department: 'd',
    business_system: 's',
    owner_role: 'o',
    status: 'proposed',
    criticality: 'core',
    outcome: 'Done',
    tools: [],
    review_cycle_days: 90,
    last_reviewed_at: null,
    next_review_at: null,
    trigger: { mode: 'manual' },
    phases: [{ id: 'performance', name: 'Performance', stage: 'after-event' }],
    tasks,
  };
}

function blockMap() {
  return parseBlockFiles([{
    path: 'workflow-templates/blocks/sponsor-performance.yaml',
    revision: 'block-a',
    content: SPONSOR_BLOCK,
  }]);
}

describe('template blocks', () => {
  it('detects include entries and plain tasks', () => {
    assert.ok(isIncludeEntry({ include: 'blocks/sponsor-performance.yaml' }));
    assert.ok(!isIncludeEntry({ id: 'x', include: 'blocks/sponsor-performance.yaml' }));
    assert.ok(!isIncludeEntry({ id: 'x' }));
  });

  it('expands a full include with defaults', () => {
    const doc = templateWithTasks([
      { id: 'schedule-email-newsletter', name: 'Send', schedule: { offset_days: 0 } },
      { include: 'blocks/sponsor-performance.yaml', slot: 'primary-slot' },
    ]);
    const expanded = expandTemplateIncludes(doc, 'workflow-templates/newsletter.yaml', blockMap());
    const ids = (expanded.tasks as Array<Record<string, unknown>>).map((task) => task.id);
    assert.deepStrictEqual(ids, [
      'schedule-email-newsletter',
      'collect-mailchimp-stats',
      'collect-x-stats',
      'send-performance-to-sponsor',
    ]);
    const tasks = expanded.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[3].depends_on, ['collect-mailchimp-stats', 'collect-x-stats']);
    assert.strictEqual(tasks[3].optional_group, 'primary-slot');
    assert.strictEqual((tasks[1].schedule as Record<string, unknown>).offset_days, 7);
  });

  it('emits a prefixed send-only subset that keeps shared dependencies', () => {
    const doc = templateWithTasks([
      { id: 'schedule-email-newsletter', name: 'Send', schedule: { offset_days: 0 } },
      { id: 'collect-mailchimp-stats', name: 'Collect', schedule: { offset_days: 7 } },
      { id: 'collect-x-stats', name: 'Collect X', schedule: { offset_days: 7 } },
      {
        include: 'blocks/sponsor-performance.yaml',
        prefix: 'secondary-',
        slot: 'secondary-slot',
        name_prefix: 'Secondary slot: ',
        only: ['send-performance-to-sponsor'],
      },
    ]);
    const expanded = expandTemplateIncludes(doc, 'workflow-templates/newsletter.yaml', blockMap());
    const tasks = expanded.tasks as Array<Record<string, unknown>>;
    const send = tasks.at(-1)!;
    assert.strictEqual(send.id, 'secondary-send-performance-to-sponsor');
    assert.strictEqual(send.optional_group, 'secondary-slot');
    assert.strictEqual(send.name, 'Secondary slot: Send the performance of the newsletter to the sponsor');
    assert.deepStrictEqual(send.depends_on, ['collect-mailchimp-stats', 'collect-x-stats']);
    assert.strictEqual((send.schedule as Record<string, unknown>).offset_days, 7);
  });

  it('rewrites the anchor and adds the include offset to each task offset', () => {
    const doc = templateWithTasks([
      { include: 'blocks/sponsor-performance.yaml', anchor: 'custom-anchor', offset_days: 9 },
    ]);
    const expanded = expandTemplateIncludes(doc, 'workflow-templates/newsletter.yaml', blockMap());
    const tasks = expanded.tasks as Array<Record<string, unknown>>;
    assert.deepStrictEqual(tasks[0].depends_on, ['custom-anchor']);
    for (const task of tasks) {
      assert.strictEqual((task.schedule as Record<string, unknown>).offset_days, 16);
    }
  });

  it('leaves documents without includes untouched', () => {
    const doc = templateWithTasks([{ id: 'only', name: 'Only', schedule: { offset_days: 0 } }]);
    assert.strictEqual(expandTemplateIncludes(doc, 'p', blockMap()), doc);
  });

  it('fails closed on unknown blocks, tasks, prefixes, and duplicates', () => {
    const blocks = blockMap();
    assert.throws(
      () => expandTemplateIncludes(
        templateWithTasks([{ include: 'blocks/missing.yaml' }]), 'p', blocks,
      ),
      /unknown block/,
    );
    assert.throws(
      () => expandTemplateIncludes(
        templateWithTasks([{ include: 'blocks/sponsor-performance.yaml', only: ['nope'] }]), 'p', blocks,
      ),
      /unknown block task/,
    );
    assert.throws(
      () => expandTemplateIncludes(
        templateWithTasks([
          { id: 'collect-mailchimp-stats', name: 'Dup', schedule: { offset_days: 0 } },
          { include: 'blocks/sponsor-performance.yaml' },
        ]), 'p', blocks,
      ),
      /duplicate task id 'collect-mailchimp-stats'/,
    );
    assert.throws(
      () => expandTemplateIncludes(
        templateWithTasks([{ include: 'blocks/sponsor-performance.yaml', prefix: 'BAD ' }]), 'p', blocks,
      ),
      /invalid task id/,
    );
    assert.throws(
      () => expandTemplateIncludes(
        templateWithTasks([{ include: 'blocks/sponsor-performance.yaml', wat: 1 }]), 'p', blocks,
      ),
      /unknown parameter/,
    );
    assert.throws(
      () => parseBlockFiles([{
        path: 'workflow-templates/blocks/nested.yaml',
        revision: 'b',
        content: 'tasks:\n  - include: blocks/other.yaml\n',
      }]),
      /cannot include other blocks/,
    );
  });

  it('parses templates with includes through the authored-template loader', () => {
    const files = [{
      path: 'workflow-templates/newsletter.yaml',
      revision: 'blob-a',
      content: yaml.dump(templateWithTasks([
        {
          id: 'schedule-email-newsletter', name: 'Send', schedule: { offset_days: 0 },
          task_kind: 'milestone', owner_role: 'o', tools: [], requires: [],
          proof: { type: 'comment', label: 'Sent', required: true },
          closure: { success_criteria: 'Sent', follow_up: 'none', close_condition: 'Proof' },
          phase_id: 'performance',
        },
        { include: 'blocks/sponsor-performance.yaml', slot: 'primary-slot' },
      ])),
    }];
    const definitions = parseAuthoredTemplateFiles(files, [{
      path: 'workflow-templates/blocks/sponsor-performance.yaml',
      revision: 'block-a',
      content: SPONSOR_BLOCK,
    }]);
    assert.strictEqual(definitions.length, 1);
    const ids = (definitions[0].taskDefinitions as Array<Record<string, unknown>>).map((task) => task.refId);
    assert.deepStrictEqual(ids, [
      'schedule-email-newsletter',
      'collect-mailchimp-stats',
      'collect-x-stats',
      'send-performance-to-sponsor',
    ]);
  });

  it('loads blocks from a directory checkout alongside templates', () => {
    const root = mkdtempSync(join(tmpdir(), 'dataops-template-blocks-'));
    writeFileSync(join(root, 'newsletter.yaml'), yaml.dump(templateWithTasks([
      {
        id: 'schedule-email-newsletter', name: 'Send', schedule: { offset_days: 0 },
        task_kind: 'milestone', owner_role: 'o', tools: [], requires: [],
        proof: { type: 'comment', label: 'Sent', required: true },
        closure: { success_criteria: 'Sent', follow_up: 'none', close_condition: 'Proof' },
        phase_id: 'performance',
      },
      { include: 'blocks/sponsor-performance.yaml' },
    ])));
    mkdirSync(join(root, 'blocks'));
    writeFileSync(join(root, 'blocks', 'sponsor-performance.yaml'), SPONSOR_BLOCK);
    const definitions = loadAuthoredTemplatesFromDirectory(root);
    assert.strictEqual(definitions.length, 1);
    assert.strictEqual(definitions[0].sourcePath, 'workflow-templates/newsletter.yaml');
    const ids = (definitions[0].taskDefinitions as Array<Record<string, unknown>>).map((task) => task.refId);
    assert.ok(ids.includes('collect-mailchimp-stats'));
    assert.ok(ids.includes('send-performance-to-sponsor'));
  });
});
