import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import {
  REQUIRED_RESOURCES,
  matchesRequiresFilter,
  parseResourceList,
  requiresError,
} from '../src/resources/vocabulary';
import { validateAuthoredTemplate } from '../src/templates/yamlTemplates';

describe('required-resource vocabulary', () => {
  it('has unique slug ids, names, icons and an access line', () => {
    const ids = REQUIRED_RESOURCES.map((resource) => resource.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const resource of REQUIRED_RESOURCES) {
      assert.match(resource.id, /^[a-z0-9][a-z0-9-]*$/);
      assert.ok(resource.name && resource.icon && resource.access, resource.id);
    }
    for (const id of ['youtube', 'luma', 'meetup', 'mailchimp', 'gmail', 'slack', 'website']) {
      assert.ok(ids.includes(id), id);
    }
  });

  it('validates requires lists', () => {
    assert.strictEqual(requiresError(['youtube', 'luma']), null);
    assert.strictEqual(requiresError([]), null);
    assert.match(String(requiresError('youtube')), /array of resource ids/);
    assert.match(String(requiresError(['youtube', 42])), /array of resource ids/);
    assert.match(String(requiresError(['myspace'])), /unknown resource 'myspace'/);
    assert.match(String(requiresError(['luma', 'luma'])), /more than once/);
  });

  it('parses comma-separated filters and rejects unknown ids', () => {
    assert.deepStrictEqual(parseResourceList(' youtube, luma ,,youtube', 'canDo'), { ok: true, ids: ['youtube', 'luma'] });
    const parsed = parseResourceList('youtube,myspace', 'canDo');
    assert.strictEqual(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /canDo has unknown resource 'myspace'/);
  });

  it('filters by any-of, none-of and capability subset', () => {
    assert.ok(matchesRequiresFilter(['youtube', 'luma'], { anyOf: ['luma'] }));
    assert.ok(!matchesRequiresFilter(['youtube'], { anyOf: ['luma'] }));
    assert.ok(!matchesRequiresFilter(undefined, { anyOf: ['luma'] }));
    assert.ok(!matchesRequiresFilter(['youtube', 'luma'], { noneOf: ['luma'] }));
    assert.ok(matchesRequiresFilter(['youtube'], { within: ['youtube', 'luma'] }));
    assert.ok(!matchesRequiresFilter(['youtube', 'mailchimp'], { within: ['youtube', 'luma'] }));
    assert.ok(matchesRequiresFilter(undefined, { within: [] }), 'a Task with no requirements is doable by anyone');
  });

  it('rejects unknown resources in authored templates', () => {
    const template = {
      type: 'safe-example',
      name: 'Safe',
      trigger: { mode: 'manual' },
      tasks: [{ id: 'one', name: 'One', schedule: { offset_days: 0 }, requires: ['youtube', 'myspace'] }],
    };
    const issues = validateAuthoredTemplate(template).map((issue) => issue.message);
    assert.deepStrictEqual(issues, ["task 'one' requires has unknown resource 'myspace'"]);
    template.tasks[0].requires = ['youtube'];
    assert.deepStrictEqual(validateAuthoredTemplate(template), []);
  });
});

describe('API — required resources', () => {
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    const port = await startLocal();
    await createTables(await getClient(port));
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function call(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const res = await handler({
      httpMethod: method,
      path,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(query ? { queryStringParameters: query } : {}),
    }, {});
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('serves the vocabulary', async () => {
    const res = await call('GET', '/api/resources');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.resources, JSON.parse(JSON.stringify(REQUIRED_RESOURCES)));
  });

  it('validates requires on create and update', async () => {
    const bad = await call('POST', '/api/tasks', { description: 'Bad', date: '2026-05-01', requires: ['myspace'] });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /unknown resource 'myspace'/);

    const created = await call('POST', '/api/tasks', { description: 'Edit', date: '2026-05-01', requires: ['youtube'] });
    assert.strictEqual(created.status, 201);
    const updated = await call('PUT', `/api/tasks/${created.body.id}`, {
      requires: ['youtube', 'luma'],
      expectedVersion: created.body.version,
    });
    assert.strictEqual(updated.status, 200);
    assert.deepStrictEqual(updated.body.requires, ['youtube', 'luma']);
    const duplicate = await call('PUT', `/api/tasks/${created.body.id}`, {
      requires: ['luma', 'luma'],
      expectedVersion: updated.body.version,
    });
    assert.strictEqual(duplicate.status, 400);
  });

  it('filters the task list by requires, excludeRequires and canDo', async () => {
    const date = '2026-06-15';
    for (const [description, requires] of [
      ['Stream', ['youtube']],
      ['Event', ['luma', 'youtube']],
      ['Newsletter', ['mailchimp']],
      ['Think', undefined],
    ] as const) {
      const res = await call('POST', '/api/tasks', { description, date, ...(requires ? { requires } : {}) });
      assert.strictEqual(res.status, 201);
    }
    const names = async (query: Record<string, string>) => {
      const res = await call('GET', '/api/tasks', undefined, { date, ...query });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      return res.body.tasks.map((task: { description: string }) => task.description).sort();
    };
    assert.deepStrictEqual(await names({ requires: 'youtube' }), ['Event', 'Stream']);
    assert.deepStrictEqual(await names({ requires: 'mailchimp,luma' }), ['Event', 'Newsletter']);
    assert.deepStrictEqual(await names({ excludeRequires: 'youtube' }), ['Newsletter', 'Think']);
    assert.deepStrictEqual(await names({ canDo: 'youtube' }), ['Stream', 'Think']);
    assert.deepStrictEqual(await names({ canDo: 'youtube,luma', requires: 'luma' }), ['Event']);
    assert.deepStrictEqual(await names({ canDo: '' }), ['Think']);

    const bad = await call('GET', '/api/tasks', undefined, { date, canDo: 'myspace' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /canDo has unknown resource 'myspace'/);
  });
});
