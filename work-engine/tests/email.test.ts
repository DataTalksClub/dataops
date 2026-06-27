import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';
import { extractDate } from '../src/routes/email';

// ── Unit tests for extractDate ─────────────────────────────────────

describe('extractDate', () => {
  it('returns the first YYYY-MM-DD date from a string', () => {
    assert.strictEqual(extractDate('Please review by 2026-03-15.'), '2026-03-15');
  });

  it('returns the first date when multiple dates are present', () => {
    assert.strictEqual(
      extractDate('First meeting 2026-04-01, second 2026-04-15'),
      '2026-04-01'
    );
  });

  it('returns null when no date is found', () => {
    assert.strictEqual(extractDate('No date here'), null);
  });

  it('returns null for null input', () => {
    assert.strictEqual(extractDate(null as any), null);
  });

  it('returns null for undefined input', () => {
    assert.strictEqual(extractDate(undefined as any), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(extractDate(''), null);
  });

  it('extracts date from multiline text', () => {
    assert.strictEqual(
      extractDate('Line one\nDue by 2026-06-20\nLine three'),
      '2026-06-20'
    );
  });
});

// ── Integration tests for email webhook ────────────────────────────

describe('POST /api/webhook/email', () => {
  let handler: typeof import('../src/handler').handler;
  let originalSecret: string | undefined;

  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.WEBHOOK_EMAIL_SECRET = 'test-secret';

    const mod = await import('../src/handler');
    handler = mod.handler;

    // Trigger cold start initialization
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.WEBHOOK_EMAIL_SECRET;
  });

  beforeEach(() => {
    originalSecret = process.env.WEBHOOK_EMAIL_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.WEBHOOK_EMAIL_SECRET = originalSecret;
    } else {
      delete process.env.WEBHOOK_EMAIL_SECRET;
    }
  });

  it('creates a task from email with subject and body', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'alexey@example.com',
        subject: 'Review newsletter draft',
        body: 'Please review by 2026-03-15.\nhttps://example.com/draft',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 201);

    const task = JSON.parse(res.body);
    assert.ok(task.id);
    assert.strictEqual(task.description, 'Review newsletter draft');
    assert.strictEqual(task.date, '2026-03-15');
    assert.strictEqual(task.comment, 'Please review by 2026-03-15.\nhttps://example.com/draft');
    assert.strictEqual(task.source, 'email');
    assert.strictEqual(task.status, 'todo');
    assert.ok(task.createdAt);
    assert.ok(task.updatedAt);
  });

  it('extracts the first date from body when multiple dates present', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Plan meetings',
        body: 'First meeting 2026-04-01, second 2026-04-15',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 201);

    const task = JSON.parse(res.body);
    assert.strictEqual(task.date, '2026-04-01');
  });

  it('defaults to today when no date in body', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Buy groceries',
        body: 'Milk, eggs, bread',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 201);

    const task = JSON.parse(res.body);
    assert.strictEqual(task.date, today);
    assert.strictEqual(task.description, 'Buy groceries');
    assert.strictEqual(task.comment, 'Milk, eggs, bread');
    assert.strictEqual(task.source, 'email');
  });

  it('stores null comment and defaults date when body is missing', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Quick reminder',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 201);

    const task = JSON.parse(res.body);
    assert.strictEqual(task.description, 'Quick reminder');
    assert.strictEqual(task.comment, null);
    assert.strictEqual(task.date, today);
    assert.strictEqual(task.source, 'email');
  });

  it('stores null comment and defaults date when body is empty string', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Quick reminder',
        body: '',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 201);

    const task = JSON.parse(res.body);
    assert.strictEqual(task.comment, null);
    assert.strictEqual(task.date, today);
  });

  it('returns 400 when from field is missing', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        subject: 'Test task',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 400);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Missing required field: from');
  });

  it('returns 400 when subject field is missing', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 400);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Missing required field: subject');
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: 'not-json',
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 400);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Invalid request body');
  });

  it('returns 401 when webhook secret header is missing', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: {},
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Test',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 401);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Unauthorized');
  });

  it('returns 401 when webhook secret is wrong', async () => {
    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'wrong-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Test',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 401);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Unauthorized');
  });

  it('returns 500 when WEBHOOK_EMAIL_SECRET env var is not configured', async () => {
    delete process.env.WEBHOOK_EMAIL_SECRET;

    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'any-value' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Test',
      }),
    };

    const res = await handler(event, {});
    assert.strictEqual(res.statusCode, 500);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Webhook not configured');
  });

  it('returns 500 on unexpected server error', async () => {
    const { route } = await import('../src/router');

    const brokenClient = {
      send: () => { throw new Error('Simulated DB failure'); },
    };

    const event = {
      httpMethod: 'POST',
      path: '/api/webhook/email',
      headers: { 'x-webhook-secret': 'test-secret' },
      body: JSON.stringify({
        from: 'user@example.com',
        subject: 'Test',
        body: 'Some text',
      }),
    };

    const res = await route(event, brokenClient as any);
    assert.strictEqual(res.statusCode, 500);

    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Internal server error');
  });

  it('does not break existing routes', async () => {
    const healthRes = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(healthRes.statusCode, 200);

    const indexRes = await handler({ httpMethod: 'GET', path: '/' }, {});
    assert.strictEqual(indexRes.statusCode, 200);
    assert.strictEqual(indexRes.headers!['Content-Type'], 'text/html');

    const taskRes = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Test task', date: '2099-01-01' }),
    }, {});
    assert.strictEqual(taskRes.statusCode, 201);
  });
});
