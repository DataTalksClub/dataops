import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('SPA shell and static files', () => {
  after(async () => {
    await stopLocal();
  });

  it('GET / returns HTML containing nav links and script tags', async () => {
    const event = { httpMethod: 'GET', path: '/' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'text/html');

    assert.ok(result.body.includes('href="#/tasks"'), 'should have Tasks nav link');
    assert.ok(result.body.includes('href="#/bundles"'), 'should have Bundles nav link');
    assert.ok(result.body.includes('href="#/templates"'), 'should have Templates nav link');

    assert.ok(result.body.includes('<script src="/public/api.js"></script>'), 'should load api.js');
    assert.ok(result.body.includes('<script src="/public/app.js"></script>'), 'should load app.js');

    assert.ok(result.body.includes('id="app"'), 'should have app container');
    assert.ok(result.body.includes('name="dataops-auth-mode" content="legacy-bearer"'), 'standalone SPA should preserve legacy bearer mode');
    assert.ok(!result.body.includes('__DATAOPS_AUTH_MODE__'), 'auth mode placeholder should be rendered server-side');
  });

  it('GET /public/app.js returns JavaScript', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'application/javascript');
    assert.ok(result.body.length > 0, 'body should not be empty');
    assert.ok(result.body.includes('hashchange'), 'app.js should contain router code');
  });

  it('GET /public/api.js returns JavaScript', async () => {
    const event = { httpMethod: 'GET', path: '/public/api.js' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.headers!['Content-Type'], 'application/javascript');
    assert.ok(result.body.length > 0, 'body should not be empty');
    assert.ok(result.body.includes('window.api'), 'api.js should define window.api');
  });

  it('GET /public/../secret returns 404 (path traversal blocked)', async () => {
    const event = { httpMethod: 'GET', path: '/public/../secret' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 404);
  });

  it('GET /public/nonexistent.js returns 404', async () => {
    const event = { httpMethod: 'GET', path: '/public/nonexistent.js' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 404);
  });

  it('GET /public/evil.html returns 404 (non-JS file rejected)', async () => {
    const event = { httpMethod: 'GET', path: '/public/evil.html' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 404);
  });
});
