import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../scripts/local-dynamodb';

describe('handler', () => {
  after(async () => {
    await stopLocal();
  });

  it('GET / returns SPA HTML with status 200', async () => {
    const event = { httpMethod: 'GET', path: '/' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.match(result.headers!['Content-Type'], /^text\/html/);
    assert.ok(result.body.includes('<title>DataOps</title>'));
    assert.ok(result.body.includes('id="document-list"'));
    assert.ok(result.body.includes('data-workspace-view="home"'));
    assert.ok(result.body.includes('data-workspace-view="inbox"'));
    // Tasks is a nav group with a section submenu, not a flat workspace-view button.
    assert.ok(result.body.includes('id="tasks-nav-button"'));
    assert.ok(result.body.includes('data-tasks-section="queue"'));
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

describe('handler Function URL event normalization', () => {
  after(async () => {
    await stopLocal();
  });

  it('FU-shaped GET / (requestContext.http.method + rawPath, no httpMethod) returns SPA HTML with status 200', async () => {
    const event = {
      requestContext: { http: { method: 'GET', path: '/' } },
      rawPath: '/',
    };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.match(result.headers!['Content-Type'], /^text\/html/);
    assert.ok(result.body.includes('<title>DataOps</title>'));
    assert.ok(result.body.includes('id="document-list"'));
  });

  it('FU-shaped GET /api/health returns {"status":"ok"} with status 200', async () => {
    const event = {
      requestContext: { http: { method: 'GET', path: '/api/health' } },
      rawPath: '/api/health',
    };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'application/json');

    const body = JSON.parse(result.body);
    assert.deepStrictEqual(body, { status: 'ok' });
  });

  it('FU-shaped GET /api/health matches the equivalent API-Gateway-shaped event', async () => {
    const fuEvent = {
      requestContext: { http: { method: 'GET', path: '/api/health' } },
      rawPath: '/api/health',
    };
    const apiGwEvent = { httpMethod: 'GET', path: '/api/health' };

    const fuResult = await handler(fuEvent, {});
    const apiGwResult = await handler(apiGwEvent, {});

    assert.strictEqual(fuResult.statusCode, apiGwResult.statusCode);
    assert.strictEqual(fuResult.body, apiGwResult.body);
  });
});
