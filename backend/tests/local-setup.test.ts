import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { TABLE_USERS } from '../src/db/tableNames';
import { setupLocalEnvironment } from '../scripts/setup-local';
import { stopLocal } from '../scripts/local-dynamodb';

describe('explicit local setup boundary', () => {
  it('starts loopback dynalite and creates the schema only when invoked', async () => {
    const previousEndpoint = process.env.DYNAMODB_ENDPOINT;
    delete process.env.DYNAMODB_ENDPOINT;
    try {
      await setupLocalEnvironment({ persistent: false, seed: false });
      assert.match(process.env.DYNAMODB_ENDPOINT || '', /^http:\/\/127\.0\.0\.1:\d+$/);
      const result = await (await getClient()).send(new ScanCommand({ TableName: TABLE_USERS }));
      assert.deepEqual(result.Items, []);
    } finally {
      await stopLocal();
      if (previousEndpoint === undefined) delete process.env.DYNAMODB_ENDPOINT;
      else process.env.DYNAMODB_ENDPOINT = previousEndpoint;
    }
  });

  it('composes every supported seed in the one setup entry point', async () => {
    const source = await readFile(new URL('../scripts/setup-local.ts', import.meta.url), 'utf8');
    assert.match(source, /seedUsers\(\)/);
    assert.match(source, /seedTemplates\(\)/);
    assert.match(source, /seedRecurring\(\)/);
  });
});
