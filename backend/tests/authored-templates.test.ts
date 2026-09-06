import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import yaml from 'js-yaml';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createTemplate, listTemplates } from '../src/db/templates';
import {
  loadAuthoredTemplatesFromDirectory,
  loadAuthoredTemplatesFromGithub,
  parseAuthoredTemplateFiles,
  reconcileAuthoredTemplates,
} from '../src/templates/authoredTemplates';
import { templateToYaml } from '../src/templates/yamlTemplates';
import { syntheticAuthoredTemplate, syntheticAuthoredFiles, syntheticGithubStore } from './helpers/authoredTemplates';

function authored(type: string, name = `Synthetic ${type}`): string {
  return [
    `type: ${type}`,
    `name: ${name}`,
    'trigger:',
    '  mode: manual',
    'tasks:',
    '  - id: first',
    '    name: Synthetic first task',
    '    schedule:',
    '      offset_days: 0',
    '',
  ].join('\n');
}

describe('Git-authored template projection', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('loads a directory with content-addressed source metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'dataops-authored-templates-'));
    writeFileSync(join(root, 'synthetic.yaml'), authored('synthetic'));
    const templates = loadAuthoredTemplatesFromDirectory(root);
    assert.strictEqual(templates.length, 1);
    assert.strictEqual(templates[0].sourcePath, 'workflow-templates/synthetic.yaml');
    assert.match(templates[0].sourceRevision, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual((templates[0].taskDefinitions as any[])[0].refId, 'first');
  });

  it('rejects malformed, mismatched, duplicate, and lossy authored files safely', () => {
    assert.throws(
      () => parseAuthoredTemplateFiles([{ path: 'workflow-templates/bad.yaml', revision: 'a', content: ': private body' }]),
      /bad\.yaml: invalid authored workflow template YAML/,
    );
    assert.throws(
      () => parseAuthoredTemplateFiles([{ path: 'workflow-templates/other.yaml', revision: 'a', content: authored('synthetic') }]),
      /filename must match/,
    );
    assert.throws(
      () => parseAuthoredTemplateFiles([
        { path: 'workflow-templates/synthetic.yaml', revision: 'a', content: authored('synthetic') },
        { path: 'workflow-templates/synthetic.yml', revision: 'b', content: authored('synthetic') },
      ]),
      /duplicate authored workflow template type/,
    );
    assert.throws(
      () => parseAuthoredTemplateFiles([{
        path: 'workflow-templates/synthetic.yaml',
        revision: 'a',
        content: `${authored('synthetic')}private_unknown_field: must-not-be-dropped\n`,
      }]),
      /mapping is not lossless/,
    );
  });

  it('loads eleven metadata-rich definitions through the actual GitHub tree/blob adapter', async () => {
    const files = syntheticAuthoredFiles();
    // Date-shaped YAML scalars must stay strings, including when unquoted.
    files[0].content = files[0].content.replace(/next_review_at: ['"]2030-06-15['"]/, 'next_review_at: 2030-06-15');
    assert.match(files[0].content, /next_review_at: 2030-06-15/);
    const { store, requests } = syntheticGithubStore(files);
    const definitions = await loadAuthoredTemplatesFromGithub(store);
    assert.strictEqual(definitions.length, 11);
    assert.deepStrictEqual(definitions.map((definition) => definition.type),
      files.map((file) => file.path.split('/').at(-1)!.replace('.yaml', '')).sort());
    for (const definition of definitions) {
      const file = files.find((candidate) => candidate.path === definition.sourcePath)!;
      assert.ok(file);
      assert.strictEqual(definition.sourceRevision, file.revision);
      assert.deepStrictEqual(templateToYaml(definition), syntheticAuthoredTemplate(definition.type));
      assert.strictEqual(typeof definition.nextReviewAt, 'string');
    }
    assert.strictEqual(requests.length, 12, 'one tree and exactly eleven authored blobs');
    assert.strictEqual(requests.filter((request) => request.includes('/git/blobs/')).length, 11);
  });

  it('rejects unsupported nested metadata and invalid structures without leaking source values', () => {
    const marker = 'synthetic-private-marker-not-for-errors';
    const document = syntheticAuthoredTemplate();
    const cases: Array<{ document: Record<string, unknown>; error: RegExp }> = [
      { document: { ...document, unknown: marker }, error: /mapping is not lossless/ },
      { document: { ...document, phases: [{ ...document.phases[0], unknown: marker }] }, error: /mapping is not lossless/ },
      { document: { ...document, tasks: [{ ...document.tasks[0], unknown: marker }] }, error: /mapping is not lossless/ },
      { document: { ...document, tasks: [{ ...document.tasks[0], closure: { ...document.tasks[0].closure, unknown: marker } }] }, error: /mapping is not lossless/ },
      { document: { ...document, external_source_documents: [{ ...document.external_source_documents[0], unknown: marker }] }, error: /mapping is not lossless/ },
      { document: { ...document, tools: marker }, error: /validation failed/ },
      { document: { ...document, tasks: [{ ...document.tasks[0], schedule: { offset_days: marker } }] }, error: /validation failed/ },
      { document: { ...document, tasks: marker }, error: /validation failed/ },
      { document: { ...document, references: [null] }, error: /invalid authored workflow template structure/ },
    ];
    for (const entry of cases) {
      assert.throws(() => parseAuthoredTemplateFiles([{
        path: 'workflow-templates/synthetic-workflow.yaml', revision: 'synthetic-revision',
        content: yaml.dump(entry.document),
      }]), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, entry.error);
        assert.ok(!error.message.includes(marker));
        assert.ok(!error.message.includes(document.name));
        return true;
      });
    }
  });

  it('creates, replaces in place, removes stale fields, and is idempotent', async () => {
    const document = syntheticAuthoredTemplate('alpha');
    const definitions = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-a',
      content: yaml.dump(document),
    }]);
    const created = await reconcileAuthoredTemplates(client, definitions);
    assert.deepStrictEqual(created, { total: 1, created: 1, updated: 0, unchanged: 0 });
    const original = (await listTemplates(client))[0];
    assert.deepStrictEqual(templateToYaml({ ...original }), document);
    assert.notStrictEqual(original.id, document.id);
    assert.strictEqual(original.authoredId, document.id);
    assert.strictEqual(original.version, 1);
    assert.strictEqual(original.schemaVersion, 2);
    assert.strictEqual(original.sourcePath, 'workflow-templates/alpha.yaml');

    const changedDocument = {
      ...document, name: 'Alpha changed in Git', owner_role: 'synthetic-new-owner',
      tools: [], last_reviewed_at: '2030-06-15', next_review_at: null, external_source_documents: [],
      phases: [{ ...document.phases[0], allowed_next_phase_ids: [] }],
      tasks: [{ ...document.tasks[0], tools: ['synthetic-new-tool'], closure: {
        success_criteria: 'Synthetic replacement passes', follow_up: 'none', close_condition: 'Synthetic result filed',
      } }],
    };

    const changed = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-b',
      content: yaml.dump(changedDocument),
    }]);
    const updated = await reconcileAuthoredTemplates(client, changed);
    assert.deepStrictEqual(updated, { total: 1, created: 0, updated: 1, unchanged: 0 });
    const replacement = (await listTemplates(client))[0];
    assert.deepStrictEqual(templateToYaml({ ...replacement }), changedDocument);
    assert.strictEqual(replacement.id, original.id);
    assert.strictEqual(replacement.createdAt, original.createdAt);
    assert.strictEqual(replacement.name, 'Alpha changed in Git');
    assert.strictEqual(replacement.sourceRevision, 'blob-b');
    assert.strictEqual(replacement.version, original.version + 1);

    const unchanged = await reconcileAuthoredTemplates(client, changed);
    assert.deepStrictEqual(unchanged, { total: 1, created: 0, updated: 0, unchanged: 1 });
    assert.strictEqual((await listTemplates(client))[0].version, replacement.version);

    const reduced = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml', revision: 'blob-c', content: authored('alpha'),
    }]);
    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, reduced), { total: 1, created: 0, updated: 1, unchanged: 0 });
    const withoutMetadata = (await listTemplates(client))[0];
    assert.deepStrictEqual(templateToYaml({ ...withoutMetadata }), yaml.load(authored('alpha')));
    for (const field of ['authoredId', 'schemaVersion', 'department', 'businessSystem', 'ownerRole', 'status',
      'criticality', 'outcome', 'tools', 'reviewCycleDays', 'lastReviewedAt', 'nextReviewAt', 'externalSourceDocuments', 'phases']) {
      assert.ok(!Object.hasOwn(withoutMetadata, field), `${field} must not survive its removal from Git`);
    }
    assert.strictEqual(withoutMetadata.id, original.id);
    assert.strictEqual(withoutMetadata.createdAt, original.createdAt);
    assert.strictEqual(withoutMetadata.version, replacement.version + 1);
    assert.strictEqual(withoutMetadata.sourceRevision, 'blob-c');
    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, reduced), { total: 1, created: 0, updated: 0, unchanged: 1 });
    assert.deepStrictEqual((await listTemplates(client))[0], withoutMetadata);
  });

  it('rejects runtime-only and duplicate runtime types before writing', async () => {
    await createTemplate(client, {
      type: 'runtime-only',
      name: 'Runtime only',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    const definition = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(() => reconcileAuthoredTemplates(client, definition), /absent from Git: runtime-only/);

    await createTemplate(client, {
      type: 'alpha',
      name: 'Duplicate alpha',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    await assert.rejects(() => reconcileAuthoredTemplates(client, definition), /Duplicate runtime workflow template types: alpha/);
  });
});
