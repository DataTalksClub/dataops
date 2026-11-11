import {checksum} from '../src/docs/knowledgeStore';
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import yaml from 'js-yaml';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createTemplate, deleteGitTemplate, listTemplates } from '../src/db/templates';
import { truncateTestTables } from './helpers/db';
import {
  loadAuthoredTemplatesFromDirectory,
  loadAuthoredTemplatesFromKnowledge,
  parseAuthoredTemplateFiles,
  reconcileAuthoredTemplates,
  gitBlobSha,
} from '../src/templates/authoredTemplates';
import { templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import { syntheticAuthoredTemplate, syntheticAuthoredFiles, syntheticKnowledgeStore } from './helpers/authoredTemplates';

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

  beforeEach(async () => {
    await truncateTestTables(client);
  });

  it('loads a directory with content-addressed source metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'dataops-authored-templates-'));
    writeFileSync(join(root, 'synthetic.yaml'), authored('synthetic'));
    const templates = loadAuthoredTemplatesFromDirectory(root);
    assert.strictEqual(templates.length, 1);
    assert.strictEqual(templates[0].sourcePath, 'workflow-templates/synthetic.yaml');
    assert.match(templates[0].sourceRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(templates[0].sourceBlobSha, /^[a-f0-9]{40}$/);
    assert.strictEqual(templates[0].sourceBlobSha, gitBlobSha(authored('synthetic')));
    assert.strictEqual((templates[0].taskDefinitions as any[])[0].refId, 'first');
  });

  it('parses existing source bases while deferring the new workflow lint to seed preflight', () => {
    const legacySource = {
      type: 'synthetic',
      name: 'Synthetic workflow',
      trigger: { mode: 'manual' },
      tasks: [
        { id: 'first', name: 'First', schedule: { offset_days: -2 } },
        { id: 'later', name: 'Later', schedule: { offset_days: -1 }, depends_on: ['first'] },
      ],
    };
    const content = yaml.dump(legacySource);
    const parsed = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/synthetic.yaml', revision: 'source-a', content,
    }]);
    assert.strictEqual(parsed.length, 1);
    assert.match(
      validateAuthoredTemplate(legacySource).map(({ message }) => message).join('\n'),
      /useless schedule offset/,
    );
  });

  it('rejects a lint-invalid source before creating an unpinned runtime Template', async () => {
    const content = yaml.dump({
      type: 'unlinted-source',
      name: 'Synthetic unlinted source',
      trigger: { mode: 'manual' },
      tasks: [
        { id: 'first', name: 'First', schedule: { offset_days: -2 } },
        { id: 'later', name: 'Later', schedule: { offset_days: -1 }, depends_on: ['first'] },
      ],
    });
    const [definition] = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/unlinted-source.yaml', revision: 'source-b', content,
    }]);
    await assert.rejects(
      reconcileAuthoredTemplates(client, [definition]),
      /unlinted-source\.yaml: authored workflow template validation failed \(1 issues\)/,
    );
    assert.deepStrictEqual(await listTemplates(client), []);
  });

  it('exposes the Git blob SHA1 alongside the SHA256 content hash (AC6)', () => {
    // Probe from intake 52291ad1: live tax-report sourceRevision dad2... is the
    // sha256 of knowledge main 33776d9, blob ad64be8... is `git hash-object`.
    const probeContent = 'type: tax-report\nname: Tax report\ntrigger:\n  mode: manual\ntasks:\n  - id: first\n    name: First\n    schedule:\n      offset_days: 0\n';
    const definitions = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/tax-report.yaml',
      revision: 'dad2d88302bc0b4ab0cada1e3dcf622ababd1c00a10580401e4eb5f9b3ecf1b2',
      content: probeContent,
    }]);
    assert.strictEqual(definitions.length, 1);
    assert.strictEqual(definitions[0].sourceRevision, 'dad2d88302bc0b4ab0cada1e3dcf622ababd1c00a10580401e4eb5f9b3ecf1b2');
    assert.match(definitions[0].sourceBlobSha, /^[a-f0-9]{40}$/);
    assert.strictEqual(definitions[0].sourceBlobSha, gitBlobSha(probeContent));
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
    const { store, requests } = syntheticKnowledgeStore(files);
    const definitions = await loadAuthoredTemplatesFromKnowledge(store);
    assert.strictEqual(definitions.length, 11);
    assert.deepStrictEqual(definitions.map((definition) => definition.type),
      files.map((file) => file.path.split('/').at(-1)!.replace('.yaml', '')).sort());
    for (const definition of definitions) {
      const file = files.find((candidate) => candidate.path === definition.sourcePath)!;
      assert.ok(file);
      assert.strictEqual(definition.sourceRevision, checksum(file.content));
      assert.deepStrictEqual(templateToYaml(definition), syntheticAuthoredTemplate(definition.type));
      assert.strictEqual(typeof definition.nextReviewAt, 'string');
    }
    assert.strictEqual(requests.length, 13, 'one tree and exactly eleven authored blobs');
    assert.strictEqual(requests.filter((request) => request.startsWith('objects/')).length, 11);
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

  it('creates, replaces the unpinned base, removes stale fields, and is idempotent', async () => {
    const document = syntheticAuthoredTemplate('alpha');
    const definitions = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-a',
      content: yaml.dump(document),
    }]);
    const created = await reconcileAuthoredTemplates(client, definitions);
    assert.deepStrictEqual(created, { total: 1, created: 1, updated: 0, unchanged: 0, deleted: 0 });
    const original = (await listTemplates(client))[0];
    assert.deepStrictEqual(templateToYaml({ ...original }), document);
    assert.notStrictEqual(original.id, document.id);
    assert.strictEqual(original.authoredId, document.id);
    assert.strictEqual(original.version, 1);
    assert.strictEqual(original.schemaVersion, 2);
    assert.strictEqual(original.sourcePath, 'workflow-templates/alpha.yaml');
    assert.strictEqual(original.origin, 'git');
    assert.strictEqual(original.pinned, false);
    assert.ok(typeof original.revision === 'string');
    assert.match(original.sourceBlobSha as string, /^[a-f0-9]{40}$/);
    assert.strictEqual(original.baseSourceBlobSha, original.sourceBlobSha);

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
    assert.deepStrictEqual(updated, { total: 1, created: 0, updated: 1, unchanged: 0, deleted: 0 });
    const replacement = (await listTemplates(client))[0];
    assert.deepStrictEqual(templateToYaml({ ...replacement }), changedDocument);
    assert.strictEqual(replacement.id, original.id);
    assert.strictEqual(replacement.revision, original.revision);
    assert.strictEqual(replacement.createdAt, original.createdAt);
    assert.strictEqual(replacement.name, 'Alpha changed in Git');
    assert.strictEqual(replacement.sourceRevision, 'blob-b');
    assert.strictEqual(replacement.version, original.version + 1);

    const unchanged = await reconcileAuthoredTemplates(client, changed);
    assert.deepStrictEqual(unchanged, { total: 1, created: 0, updated: 0, unchanged: 1, deleted: 0 });
    assert.strictEqual((await listTemplates(client))[0].version, replacement.version);

    const reduced = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml', revision: 'blob-c', content: authored('alpha'),
    }]);
    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, reduced), { total: 1, created: 0, updated: 1, unchanged: 0, deleted: 0 });
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
    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, reduced), { total: 1, created: 0, updated: 0, unchanged: 1, deleted: 0 });
    assert.deepStrictEqual((await listTemplates(client))[0], withoutMetadata);
  });

  it('preserves custom rows whose type is absent from Git', async () => {
    await createTemplate(client, {
      type: 'runtime-only',
      name: 'Runtime only',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    const seeded = await reconcileAuthoredTemplates(client, alpha);
    assert.deepStrictEqual(seeded, { total: 1, created: 1, updated: 0, unchanged: 0, deleted: 0 });
    const kept = (await listTemplates(client)).find((item) => item.type === 'runtime-only');
    assert.ok(kept);
    assert.strictEqual(kept.origin, 'custom');
  });

  it('fails closed loudly on explicit custom collisions', async () => {
    await createTemplate(client, {
      type: 'alpha',
      name: 'Operator alpha',
      taskDefinitions: [{ refId: 'mine', description: 'Mine', offsetDays: 4 }],
    });
    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(
      reconcileAuthoredTemplates(client, alpha),
      /collides with custom template: alpha/,
    );
    // Nothing was written: the custom row keeps its identity and version.
    const kept = (await listTemplates(client)).find((item) => item.type === 'alpha');
    assert.strictEqual(kept?.origin, 'custom');
    assert.strictEqual(kept?.version, 1);
  });

  it('prunes source-absent Git rows through sync and releases their type guard', async () => {
    const stale = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/stale-git.yaml',
      revision: 'rev-1',
      content: authored('stale-git'),
    }]);
    await reconcileAuthoredTemplates(client, stale);
    const original = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(original);

    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, alpha), {
      total: 1, created: 1, updated: 0, unchanged: 0, deleted: 1,
    });
    assert.deepStrictEqual((await listTemplates(client)).map((item) => item.type), ['alpha']);

    assert.deepStrictEqual(await reconcileAuthoredTemplates(client, [...alpha, ...stale]), {
      total: 2, created: 1, updated: 0, unchanged: 1, deleted: 0,
    });
    const restored = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(restored);
    assert.notStrictEqual(restored.id, original.id);
  });

  it('preserves a source-absent Git Template when any Card still uses it', async () => {
    const stale = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/stale-git.yaml',
      revision: 'rev-1',
      content: authored('stale-git'),
    }]);
    await reconcileAuthoredTemplates(client, stale);
    const original = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(original);
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { TABLE_CARDS } = await import('../src/db/tableNames');
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: { PK: 'CARD#still-uses-stale-git', SK: 'CARD#still-uses-stale-git', templateId: original.id },
    }));

    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(reconcileAuthoredTemplates(client, alpha), /template-in-use/);
    const preserved = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(preserved);
    assert.strictEqual(preserved.id, original.id);
    assert.deepStrictEqual((await listTemplates(client)).map((item) => item.type), ['stale-git']);
  });

  it('preserves a source-absent Git Template when an independent Task cites it', async () => {
    const stale = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/stale-git.yaml',
      revision: 'rev-1',
      content: authored('stale-git'),
    }]);
    await reconcileAuthoredTemplates(client, stale);
    const original = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(original);
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { TABLE_TASKS } = await import('../src/db/tableNames');
    await client.send(new PutCommand({
      TableName: TABLE_TASKS,
      Item: { PK: 'TASK#independent-stale-template-use', SK: 'TASK#independent-stale-template-use', templateId: original.id },
    }));

    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(reconcileAuthoredTemplates(client, alpha), /template-in-use/);
    const preserved = (await listTemplates(client)).find((item) => item.type === 'stale-git');
    assert.ok(preserved);
    assert.strictEqual(preserved.id, original.id);
    assert.deepStrictEqual((await listTemplates(client)).map((item) => item.type), ['stale-git']);
  });

  it('preflights every stale Git Template before deleting any of them', async () => {
    const stale = parseAuthoredTemplateFiles([
      {
        path: 'workflow-templates/first-stale.yaml',
        revision: 'rev-first',
        content: authored('first-stale'),
      },
      {
        path: 'workflow-templates/second-stale.yaml',
        revision: 'rev-second',
        content: authored('second-stale'),
      },
    ]);
    await reconcileAuthoredTemplates(client, stale);
    const before = await listTemplates(client);
    assert.equal(before.length, 2);

    // Reference the second row in reconciliation order. A per-row delete loop
    // would remove the first row before discovering this use.
    const referenced = before[1];
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { TABLE_CARDS } = await import('../src/db/tableNames');
    await client.send(new PutCommand({
      TableName: TABLE_CARDS,
      Item: { PK: 'CARD#still-uses-second-stale', SK: 'CARD#still-uses-second-stale', templateId: referenced.id },
    }));

    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(reconcileAuthoredTemplates(client, alpha), /template-in-use/);

    const after = await listTemplates(client);
    assert.deepStrictEqual(after.map((item) => item.id).sort(), before.map((item) => item.id).sort());
    assert.deepStrictEqual(after.map((item) => item.type).sort(), ['first-stale', 'second-stale']);
  });

  it('checks later filtered Scan pages before pruning a Git Template', async () => {
    const row = {
      PK: 'TEMPLATE#stale-git-id', SK: 'TEMPLATE#stale-git-id', id: 'stale-git-id',
      type: 'stale-git', name: 'Stale Git', version: 1, revision: 'rev-1',
      origin: 'git', pinned: false, base: {}, cardCreateSeq: 0,
    };
    const scans: Record<string, unknown>[] = [];
    const paginatedClient = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'GetCommand') return { Item: row };
        if (command.constructor.name === 'ScanCommand') {
          scans.push(command.input);
          return scans.length === 1
            ? { Count: 0, LastEvaluatedKey: { PK: 'next', SK: 'next' } }
            : { Count: 1, Items: [{ templateId: row.id }] };
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    } as unknown as DynamoDBDocumentClient;

    await assert.rejects(deleteGitTemplate(paginatedClient, row.id, row.version, row.revision), /template-in-use/);
    assert.equal(scans.length, 2);
    assert.equal(scans[0].Limit, undefined);
    assert.deepEqual(scans[1].ExclusiveStartKey, { PK: 'next', SK: 'next' });
  });

  it('fails closed loudly on unclassified rows', async () => {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const { TABLE_TEMPLATES } = await import('../src/db/tableNames');
    const id = 'unclassified-row';
    await client.send(new PutCommand({
      TableName: TABLE_TEMPLATES,
      Item: {
        PK: `TEMPLATE#${id}`, SK: `TEMPLATE#${id}`, id,
        name: 'Mystery', type: 'mystery-type', version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    }));
    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(
      reconcileAuthoredTemplates(client, alpha),
      /Unclassified runtime workflow template/,
    );
  });

  it('still rejects duplicate runtime types before writing', async () => {
    await createTemplate(client, {
      type: 'alpha',
      name: 'First alpha',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    await createTemplate(client, {
      type: 'alpha',
      name: 'Duplicate alpha',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    const alpha = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-c',
      content: authored('alpha'),
    }]);
    await assert.rejects(
      reconcileAuthoredTemplates(client, alpha),
      /Duplicate runtime workflow template types: alpha/,
    );
  });
});
