import {checksum} from '../src/docs/knowledgeStore';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { stopLocal } from '../scripts/local-dynamodb';
import { createRecurringConfig, listRecurringConfigs } from '../src/db/recurring';
import { listUsers } from '../src/db/users';
import { listTemplates } from '../src/db/templates';
import { handler } from '../src/handler';
import { setDeploymentTemplateLoaderForTest } from '../src/deploymentSeeds';
import { loadAuthoredTemplatesFromKnowledge } from '../src/templates/authoredTemplates';
import { templateToYaml } from '../src/templates/yamlTemplates';
import { useTestDatabase } from './helpers/db';
import { syntheticAuthoredFiles, syntheticAuthoredTemplate, syntheticKnowledgeStore } from './helpers/authoredTemplates';

describe('handler - IAM-only deployment seeds', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    client = (await useTestDatabase()).client;
  });

  after(async () => {
    setDeploymentTemplateLoaderForTest(null);
    await stopLocal();
  });

  it('rejects near-miss deployment events without writing seed data', async () => {
    const nearMisses = [
      {
        source: 'dataops.deploy.other',
        'detail-type': 'Runtime Seed',
        detail: { dataopsAction: 'sync-runtime-seeds' },
      },
      {
        source: 'dataops.deploy',
        'detail-type': 'Runtime Seed',
        detail: { dataopsAction: 'sync-runtime-seed' },
      },
      {
        source: 'dataops.deploy',
        'detail-type': 'Runtime Seeds',
        detail: { dataopsAction: 'sync-runtime-seeds' },
      },
    ];

    const results = [];
    for (const event of nearMisses) results.push(await handler(event));
    assert.ok(results.every((result) => 'statusCode' in result));
    assert.deepStrictEqual(
      results.slice(1).map((result) => 'statusCode' in result ? result.statusCode : undefined),
      [400, 400]
    );
    assert.strictEqual((await listUsers(client)).length, 0);
    assert.strictEqual((await listRecurringConfigs(client)).length, 0);
    assert.strictEqual((await listTemplates(client)).length, 0);
  });

  it('projects authored templates only, creating no people and leaving recurring schedules alone', async () => {
    const event = {
      source: 'dataops.deploy',
      'detail-type': 'Runtime Seed',
      detail: { dataopsAction: 'sync-runtime-seeds' },
    };
    const files = syntheticAuthoredFiles(11);
    const { store, requests } = syntheticKnowledgeStore(files);
    const paused = await createRecurringConfig(client, {
      description: 'Check bookkeeping, invoices, and receipts',
      cronExpression: '0 9 * * 1',
      enabled: false,
    });

    setDeploymentTemplateLoaderForTest(() => loadAuthoredTemplatesFromKnowledge(store));
    const firstResponse = await handler(event);
    assert.ok('statusCode' in firstResponse);
    assert.strictEqual(firstResponse.statusCode, 200);
    const first = JSON.parse(firstResponse.body);
    assert.deepStrictEqual(first, {
      templates: { total: 11, created: 11, updated: 0, unchanged: 0 },
    });
    const firstTemplates = await listTemplates(client);
    assert.strictEqual(firstTemplates.length, 11);
    for (const template of firstTemplates) {
      assert.deepStrictEqual(templateToYaml({ ...template }), syntheticAuthoredTemplate(template.type));
      assert.notStrictEqual(template.id, template.authoredId);
      assert.strictEqual(template.version, 1);
      assert.strictEqual(template.schemaVersion, 2);
      assert.strictEqual(template.sourceRevision, checksum(files.find((file) => file.path === template.sourcePath)!.content));
    }

    setDeploymentTemplateLoaderForTest(() => loadAuthoredTemplatesFromKnowledge(store));
    const secondResponse = await handler(event);
    assert.ok('statusCode' in secondResponse);
    assert.strictEqual(secondResponse.statusCode, 200);
    const second = JSON.parse(secondResponse.body);
    assert.deepStrictEqual(second, {
      templates: { total: 11, created: 0, updated: 0, unchanged: 11 },
    });
    assert.deepStrictEqual(
      (await listTemplates(client)).sort((left, right) => left.id.localeCompare(right.id)),
      firstTemplates.sort((left, right) => left.id.localeCompare(right.id)),
      'idempotent seeding must preserve every stored definition, identity and version',
    );
    assert.strictEqual(requests.filter((request) => request === 'active.json').length, 1);
    assert.strictEqual(requests.filter((request) => request.startsWith('objects/')).length, 22);

    // Accounts are added on the Users page and sign in with SSO; a deploy
    // never creates a person or a password.
    assert.deepStrictEqual(await listUsers(client), []);

    // Recurring schedules are user data: a deploy neither creates nor
    // re-enables nor rewrites them.
    assert.deepStrictEqual(await listRecurringConfigs(client), [paused]);

    // The shipped handler owns the exact action. Its success path uses the
    // same function above with the GitHub loader; near-miss dispatch is covered
    // separately without making an external request in this suite.
    assert.deepStrictEqual(event.detail, { dataopsAction: 'sync-runtime-seeds' });
  });
});
