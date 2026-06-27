import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('handler', () => {
  after(async () => {
    await stopLocal();
  });

  it('GET / returns SPA HTML with status 200', async () => {
    const event = { httpMethod: 'GET', path: '/' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'text/html');
    assert.ok(result.body.includes('<title>DataTasks</title>'));
    assert.ok(result.body.includes('id="app"'));
    assert.ok(result.body.includes('href="#/tasks"'));
    assert.ok(result.body.includes('href="#/bundles"'));
    assert.ok(result.body.includes('href="#/templates"'));
  });

  it('GET /api/health returns {"status":"ok"} with status 200', async () => {
    const event = { httpMethod: 'GET', path: '/api/health' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'application/json');

    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body, { status: 'ok' });
  });

  it('GET /unknown returns 404', async () => {
    const event = { httpMethod: 'GET', path: '/unknown' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 404);
    assert.strictEqual(result.headers!['Content-Type'], 'application/json');

    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body, { error: 'Not found' });
  });

  it('POST /api/health returns 404', async () => {
    const event = { httpMethod: 'POST', path: '/api/health' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 404);
  });
});
