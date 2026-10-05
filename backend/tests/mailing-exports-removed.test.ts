import assert from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { route } from '../src/router';
import { createArtifact } from '../src/db/artifacts';
import { BASELINE_RECURRING_CONFIGS } from '../src/deploymentSeeds';
import { setArtifactDownloadSignerForTests } from '../src/routes/artifacts';
import type { LambdaEvent, LambdaResponse } from '../src/types';
import { truncateTestTables, useTestDatabase } from './helpers/db';

const environment = {
  NODE_ENV: process.env.NODE_ENV,
  SKIP_AUTH: process.env.SKIP_AUTH,
  IS_LOCAL: process.env.IS_LOCAL,
};

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH = 'true';
process.env.IS_LOCAL = 'true';

function restoreEnvironmentVariable(name: keyof typeof environment): void {
  const value = environment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('mailing-export capability is removed', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    ({ client } = await useTestDatabase());
  });

  after(() => {
    restoreEnvironmentVariable('NODE_ENV');
    restoreEnvironmentVariable('SKIP_AUTH');
    restoreEnvironmentVariable('IS_LOCAL');
  });

  beforeEach(async () => {
    process.env.SKIP_AUTH = 'true';
    await truncateTestTables(client);
    setArtifactDownloadSignerForTests(async () => {
      throw new Error('leftover mailing archives must not be signed');
    });
  });

  async function invoke(event: LambdaEvent): Promise<LambdaResponse> {
    return route(event, client);
  }

  it('refuses unauthenticated mailing-export API calls like other unknown /api/* paths', async () => {
    process.env.SKIP_AUTH = 'false';
    for (const event of [
      { httpMethod: 'GET', path: '/api/mailing-exports' },
      { httpMethod: 'POST', path: '/api/mailing-exports/run', body: '{}' },
    ] as LambdaEvent[]) {
      const response = await invoke(event);
      assert.strictEqual(response.statusCode, 401, `${event.httpMethod} ${event.path}`);
      assert.deepStrictEqual(JSON.parse(response.body), { error: 'Unauthorized' });
    }
  });

  it('returns 404 for authenticated mailing-export API calls', async () => {
    for (const event of [
      { httpMethod: 'GET', path: '/api/mailing-exports' },
      { httpMethod: 'POST', path: '/api/mailing-exports/run', body: '{}' },
    ] as LambdaEvent[]) {
      const response = await invoke(event);
      assert.strictEqual(response.statusCode, 404, `${event.httpMethod} ${event.path}`);
      assert.deepStrictEqual(JSON.parse(response.body), { error: 'Not found' });
    }
  });

  it('does not download leftover private mailing archives', async () => {
    const artifact = await createArtifact(client, {
      type: 'other',
      title: 'Leftover mailing archive',
      status: 'approved',
      storageProvider: 's3',
      storageUri: 's3://synthetic-private-bucket/mailing-exports/leftover.zip',
      dataClass: 'private',
      sourceType: 'system',
    });
    const response = await invoke({
      httpMethod: 'GET',
      path: `/api/artifacts/${artifact.id}/download`,
    });
    assert.strictEqual(response.statusCode, 409);
    assert.deepStrictEqual(JSON.parse(response.body), {
      error: 'Private download is not available for this artifact',
    });
  });

  it('does not special-case mailing-export scheduled events', async () => {
    const result = await handler({
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
      detail: { dataopsAction: 'mailing-export' },
    });
    assert.ok('created' in result, 'unknown scheduled actions fall through to cron');
    assert.ok('skipped' in result);
    assert.ok(!('statusCode' in result));
  });

  it('does not seed a MailChimp mailing-list backup recurring config', () => {
    assert.equal(
      BASELINE_RECURRING_CONFIGS.some((config) => /mailchimp|mailing list/i.test(config.description)),
      false,
    );
  });
});
