import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('Task list view redesign', () => {
  after(async () => {
    await stopLocal();
  });

  describe('HTML/CSS changes', () => {
    it('index.html contains compact task table CSS class', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('.task-table-compact'), 'should have compact task table CSS');
    });

    it('index.html contains filter bar CSS class', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.filter-bar'), 'should have filter bar CSS');
    });

    it('index.html contains instructions link CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.instructions-link'), 'should have instructions link CSS');
    });

    it('index.html contains required link input CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.required-link-input'), 'should have required link input CSS');
      assert.ok(result.body.includes('.required-link-label'), 'should have required link label CSS');
      assert.ok(result.body.includes('.required-link-wrapper'), 'should have required link wrapper CSS');
    });

    it('index.html contains assignee badge CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-assignee'), 'should have assignee badge CSS');
    });

    it('index.html contains disabled checkbox CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.task-status-checkbox:disabled'), 'should have disabled checkbox CSS');
    });
  });

  describe('app.js frontend logic', () => {
    it('app.js contains filter-status element setup', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('filter-status'), 'should have status filter');
    });

    it('app.js contains filter-assignee element setup', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('filter-assignee'), 'should have assignee filter');
    });

    it('app.js contains filter-bundle element setup', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('filter-bundle'), 'should have bundle filter');
    });

    it('app.js contains task-assignee dropdown in create form', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('task-assignee'), 'should have assignee dropdown in create form');
    });

    it('app.js does NOT contain task-comment in create form', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(!result.body.includes('task-comment'), 'should not have comment field in create form');
    });

    it('app.js does NOT contain delete button for tasks', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(!result.body.includes('data-delete-task'), 'should not have delete button');
    });

    it('app.js contains instructions-link rendering', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('instructions-link'), 'should render instructions link');
    });

    it('app.js contains required-link-input rendering', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('required-link-input'), 'should render required link input');
    });

    it('app.js contains checkbox disabled logic for requiredLinkName', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('requiredLinkName'), 'should check requiredLinkName');
      assert.ok(result.body.includes('checkboxDisabled'), 'should have checkboxDisabled logic');
    });

    it('app.js contains loadUsersOnce for caching users', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('loadUsersOnce'), 'should cache users');
    });

    it('app.js contains badge-assignee rendering for assignee names', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('badge-assignee'), 'should display assignee name badge');
    });

    it('app.js contains task-table-compact class on the table', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('task-table-compact'), 'table should have compact class');
    });

    it('app.js has statusFilter in taskState', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('statusFilter'), 'should have statusFilter in state');
    });

    it('app.js has assigneeFilter in taskState', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('assigneeFilter'), 'should have assigneeFilter in state');
    });

    it('app.js has bundleFilter in taskState', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('bundleFilter'), 'should have bundleFilter in state');
    });

    it('app.js client-side filters tasks by status', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("taskState.statusFilter"), 'should use statusFilter for filtering');
    });

    it('app.js client-side filters tasks by assignee', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("taskState.assigneeFilter"), 'should use assigneeFilter for filtering');
    });
  });

  describe('api.js users endpoint', () => {
    it('api.js contains users.list method', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes("users:"), 'should have users namespace');
      assert.ok(result.body.includes("/api/users"), 'should call /api/users');
    });

    it('api.js users namespace has list and get methods', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      // Check that both list and get are defined in the users namespace
      const usersSection = result.body.substring(
        result.body.indexOf('users:'),
        result.body.indexOf('recurring:')
      );
      assert.ok(usersSection.includes('list:'), 'users should have list method');
      assert.ok(usersSection.includes('get:'), 'users should have get method');
    });
  });
});
