import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('handler - EventBridge scheduled events', () => {
  after(async () => {
    await stopLocal();
  });

  it('routes EventBridge scheduled event to cron runner (source: aws.events)', async () => {
    const event = {
      source: 'aws.events',
      'detail-type': 'Scheduled Event',
      detail: {},
    };

    const result = await handler(event);

    // Result should be a CronRunnerResult, not a LambdaResponse
    assert.ok('created' in result, 'should have "created" field');
    assert.ok('skipped' in result, 'should have "skipped" field');
    assert.ok(Array.isArray((result as Record<string, unknown>).created));
  });

  it('routes EventBridge event with only detail-type', async () => {
    const event = {
      'detail-type': 'Scheduled Event',
      detail: {},
    };

    const result = await handler(event);

    assert.ok('created' in result, 'should have "created" field');
    assert.ok('skipped' in result, 'should have "skipped" field');
  });

  it('does not route normal HTTP events as cron', async () => {
    const event = {
      httpMethod: 'GET',
      path: '/api/health',
    };

    const result = await handler(event);

    // This should be a normal HTTP response
    assert.ok('statusCode' in result, 'should have statusCode');
    assert.strictEqual((result as Record<string, unknown>).statusCode, 200);
  });
});
