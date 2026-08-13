import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTemplate, listTemplates } from '../src/db/templates';
import {
  loadAuthoredTemplatesFromDirectory,
  parseAuthoredTemplateFiles,
  reconcileAuthoredTemplates,
} from '../src/templates/authoredTemplates';

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

  it('creates, replaces in place, removes stale fields, and is idempotent', async () => {
    const definitions = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-a',
      content: authored('alpha', 'Alpha from Git'),
    }]);
    const created = await reconcileAuthoredTemplates(client, definitions);
    assert.deepStrictEqual(created, { total: 1, created: 1, updated: 0, unchanged: 0 });
    const original = (await listTemplates(client))[0];

    const changed = parseAuthoredTemplateFiles([{
      path: 'workflow-templates/alpha.yaml',
      revision: 'blob-b',
      content: authored('alpha', 'Alpha changed in Git'),
    }]);
    const updated = await reconcileAuthoredTemplates(client, changed);
    assert.deepStrictEqual(updated, { total: 1, created: 0, updated: 1, unchanged: 0 });
    const replacement = (await listTemplates(client))[0];
    assert.strictEqual(replacement.id, original.id);
    assert.strictEqual(replacement.createdAt, original.createdAt);
    assert.strictEqual(replacement.name, 'Alpha changed in Git');
    assert.strictEqual(replacement.sourceRevision, 'blob-b');
    assert.strictEqual(replacement.version, original.version + 1);

    const unchanged = await reconcileAuthoredTemplates(client, changed);
    assert.deepStrictEqual(unchanged, { total: 1, created: 0, updated: 0, unchanged: 1 });
    assert.strictEqual((await listTemplates(client))[0].version, replacement.version);
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
