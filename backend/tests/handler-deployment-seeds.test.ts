import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { stopLocal } from '../scripts/local-dynamodb';
import { listRecurringConfigs } from '../src/db/recurring';
import { listUsers } from '../src/db/users';
import { listTemplates } from '../src/db/templates';
import { handler } from '../src/handler';
import {
  BASELINE_RECURRING_CONFIGS,
  setDeploymentTemplateLoaderForTest,
  USERS,
} from '../src/deploymentSeeds';
import { loadAuthoredTemplatesFromGithub } from '../src/templates/authoredTemplates';
import { templateToYaml } from '../src/templates/yamlTemplates';
import { useTestDatabase } from './helpers/db';
import { syntheticAuthoredFiles, syntheticAuthoredTemplate, syntheticGithubStore } from './helpers/authoredTemplates';

describe('handler - IAM-only deployment seeds', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    process.env.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED = 'false';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'none';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED = 'false';
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

  it('runs users, authored templates, and recurring configs in order with sanitized idempotent counts', async () => {
    const event = {
      source: 'dataops.deploy',
      'detail-type': 'Runtime Seed',
      detail: { dataopsAction: 'sync-runtime-seeds' },
    };
    const files = syntheticAuthoredFiles(11);
    const { store, requests } = syntheticGithubStore(files);
    const loadTemplates = async () => {
      assert.strictEqual((await listUsers(client)).length, USERS.length, 'users must exist before template loading');
      assert.strictEqual((await listRecurringConfigs(client)).length, 0, 'recurring configs must wait for templates');
      return loadAuthoredTemplatesFromGithub(store);
    };

    setDeploymentTemplateLoaderForTest(loadTemplates);
    const firstResponse = await handler(event);
    assert.ok('statusCode' in firstResponse);
    assert.strictEqual(firstResponse.statusCode, 200);
    const first = JSON.parse(firstResponse.body);
    assert.deepStrictEqual(first, {
      users: { processed: USERS.length, created: USERS.length, updated: 0, unchanged: 0 },
      templates: { total: 11, created: 11, updated: 0, unchanged: 0 },
      recurring: {
        created: BASELINE_RECURRING_CONFIGS.length,
        updated: 0,
        skipped: 0,
        repairedTasks: 0,
        total: BASELINE_RECURRING_CONFIGS.length,
      },
    });
    const firstTemplates = await listTemplates(client);
    assert.strictEqual(firstTemplates.length, 11);
    for (const template of firstTemplates) {
      assert.deepStrictEqual(templateToYaml({ ...template }), syntheticAuthoredTemplate(template.type));
      assert.notStrictEqual(template.id, template.authoredId);
      assert.strictEqual(template.version, 1);
      assert.strictEqual(template.schemaVersion, 2);
      assert.strictEqual(template.sourceRevision, files.find((file) => file.path === template.sourcePath)!.revision);
    }

    setDeploymentTemplateLoaderForTest(() => loadAuthoredTemplatesFromGithub(store));
    const secondResponse = await handler(event);
    assert.ok('statusCode' in secondResponse);
    assert.strictEqual(secondResponse.statusCode, 200);
    const second = JSON.parse(secondResponse.body);
    assert.deepStrictEqual(second, {
      users: { processed: USERS.length, created: 0, updated: 0, unchanged: USERS.length },
      templates: { total: 11, created: 0, updated: 0, unchanged: 11 },
      recurring: {
        created: 0,
        updated: 0,
        skipped: BASELINE_RECURRING_CONFIGS.length,
        repairedTasks: 0,
        total: BASELINE_RECURRING_CONFIGS.length,
      },
    });
    assert.deepStrictEqual(
      (await listTemplates(client)).sort((left, right) => left.id.localeCompare(right.id)),
      firstTemplates.sort((left, right) => left.id.localeCompare(right.id)),
      'idempotent seeding must preserve every stored definition, identity and version',
    );
    assert.strictEqual(requests.filter((request) => request.includes('/git/trees/')).length, 1);
    assert.strictEqual(requests.filter((request) => request.includes('/git/blobs/')).length, 22);

    const body = JSON.stringify(second);
    for (const user of USERS) {
      assert.ok(!body.includes(user.name));
      assert.ok(!body.includes(user.email));
      assert.ok(!body.includes(user.id));
    }

    // The shipped handler owns the exact action. Its success path uses the
    // same function above with the GitHub loader; near-miss dispatch is covered
    // separately without making an external request in this suite.
    assert.deepStrictEqual(event.detail, { dataopsAction: 'sync-runtime-seeds' });
  });
});
