import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('Bundle detail view (issue #27)', () => {
  after(async () => {
    await stopLocal();
  });

  describe('CSS classes in index.html', () => {
    it('index.html contains stage badge CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('.badge-stage'), 'should have stage badge CSS');
      assert.ok(result.body.includes('.badge-stage.preparation'), 'should have preparation stage CSS');
      assert.ok(result.body.includes('.badge-stage.announced'), 'should have announced stage CSS');
      assert.ok(result.body.includes('.badge-stage.after-event'), 'should have after-event stage CSS');
      assert.ok(result.body.includes('.badge-stage.done'), 'should have done stage CSS');
    });

    it('index.html contains anchor date badge CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-anchor-date'), 'should have anchor date badge CSS');
    });

    it('index.html contains status badge CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-status'), 'should have status badge CSS');
    });

    it('index.html contains stage transition button CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.btn-stage'), 'should have stage transition button CSS');
    });

    it('index.html contains references section CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.references-section'), 'should have references section CSS');
      assert.ok(result.body.includes('.reference-link'), 'should have reference link CSS');
    });

    it('index.html contains editable bundle links CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-links-editable'), 'should have editable bundle links CSS');
      assert.ok(result.body.includes('.bundle-link-row'), 'should have bundle link row CSS');
      assert.ok(result.body.includes('.bundle-link-label'), 'should have bundle link label CSS');
      assert.ok(result.body.includes('.bundle-link-url-input'), 'should have bundle link URL input CSS');
      assert.ok(result.body.includes('.btn-save-link'), 'should have save link button CSS');
    });

    it('index.html contains add link form CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.add-link-form'), 'should have add link form CSS');
    });

    it('index.html contains bundle tasks table CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-tasks-table'), 'should have bundle tasks table CSS');
    });

    it('index.html contains bundle detail badges row CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-detail-badges'), 'should have badges row CSS');
    });
  });

  describe('app.js frontend logic', () => {
    it('app.js contains stage transitions map', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('stageTransitions'), 'app.js should have stageTransitions');
      assert.ok(result.body.includes('Mark Announced'), 'should have Mark Announced transition label');
      assert.ok(result.body.includes('Mark After-Event'), 'should have Mark After-Event transition label');
      assert.ok(result.body.includes('Mark Done'), 'should have Mark Done transition label');
    });

    it('app.js contains renderBundleTasksTable function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('renderBundleTasksTable'), 'app.js should have renderBundleTasksTable function');
    });

    it('app.js loads users for assignee display in bundle detail', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('loadUsersOnce'), 'app.js should call loadUsersOnce in bundle detail');
    });

    it('app.js renders references section with read-only links', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('references-section'), 'should create references section');
      assert.ok(result.body.includes('reference-link'), 'should create reference links');
      assert.ok(result.body.includes('References'), 'should have References header');
    });

    it('app.js renders bundle links with editable inputs', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('bundle-links-editable'), 'should create editable bundle links section');
      assert.ok(result.body.includes('bundle-link-url-input'), 'should create URL inputs for bundle links');
      assert.ok(result.body.includes('Bundle Links'), 'should have Bundle Links header');
      assert.ok(result.body.includes('btn-save-link'), 'should have save button per link');
    });

    it('app.js renders add link form for custom links', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('add-bl-name'), 'should have add link name input');
      assert.ok(result.body.includes('add-bl-url'), 'should have add link URL input');
      assert.ok(result.body.includes('add-bl-btn'), 'should have add link button');
    });

    it('app.js renders stage badge with testid', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('stage-badge'), 'should have stage-badge testid');
      assert.ok(result.body.includes('badge-stage'), 'should use badge-stage CSS class');
    });

    it('app.js renders progress badge with testid', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('progress-badge'), 'should have progress-badge testid');
    });

    it('app.js renders task checkboxes with disabled state for required links', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('checkboxDisabled'), 'should compute checkboxDisabled');
      assert.ok(result.body.includes('requiredLinkName'), 'should check requiredLinkName');
      assert.ok(result.body.includes('required-link-input'), 'should create required link input');
    });

    it('app.js renders instructions URL as link icon', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('instructions-link'), 'should use instructions-link class');
      assert.ok(result.body.includes('instructionsUrl'), 'should check instructionsUrl');
    });

    it('app.js does not show comments in bundle task table', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      // The old table had a Comment column header in loadBundleTasks. The new code should not.
      assert.ok(!result.body.includes("'<th>Comment</th>'"), 'should not have Comment column in bundle tasks');
    });

    it('app.js sorts tasks by date ascending', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('tasks.sort'), 'should sort tasks');
    });

    it('app.js updates bundle links when saving required link on task', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('data-save-required-link'), 'should have save required link button');
      assert.ok(result.body.includes('bundleUpdatePromise'), 'should update bundle links when saving required link');
      assert.ok(result.body.includes('taskUpdatePromise'), 'should update task link when saving required link');
    });
  });

  describe('Bundle API - stage update', () => {
    it('PUT /api/bundles/:id with stage updates the bundle stage', async () => {
      // Create a bundle
      const createEvent = {
        httpMethod: 'POST',
        path: '/api/bundles',
        body: JSON.stringify({ title: 'Stage Test', anchorDate: '2026-03-01' }),
      };
      const createResult = await handler(createEvent, {});
      assert.strictEqual(createResult.statusCode, 201);
      const created = JSON.parse(createResult.body);
      const bundleId = created.bundle.id;
      assert.strictEqual(created.bundle.stage, 'preparation');

      // Update stage to announced
      const updateEvent = {
        httpMethod: 'PUT',
        path: '/api/bundles/' + bundleId,
        body: JSON.stringify({ stage: 'announced' }),
      };
      const updateResult = await handler(updateEvent, {});
      assert.strictEqual(updateResult.statusCode, 200);
      const updated = JSON.parse(updateResult.body);
      assert.strictEqual(updated.bundle.stage, 'announced');
    });

    it('PUT /api/bundles/:id with bundleLinks updates the links', async () => {
      // Create a bundle with bundleLinks
      const createEvent = {
        httpMethod: 'POST',
        path: '/api/bundles',
        body: JSON.stringify({
          title: 'Links Test',
          anchorDate: '2026-03-01',
          bundleLinks: [{ name: 'Luma', url: '' }, { name: 'YouTube', url: '' }],
        }),
      };
      const createResult = await handler(createEvent, {});
      assert.strictEqual(createResult.statusCode, 201);
      const created = JSON.parse(createResult.body);
      const bundleId = created.bundle.id;

      // Update bundleLinks
      const updateEvent = {
        httpMethod: 'PUT',
        path: '/api/bundles/' + bundleId,
        body: JSON.stringify({
          bundleLinks: [
            { name: 'Luma', url: 'https://lu.ma/abc' },
            { name: 'YouTube', url: '' },
          ],
        }),
      };
      const updateResult = await handler(updateEvent, {});
      assert.strictEqual(updateResult.statusCode, 200);
      const updated = JSON.parse(updateResult.body);
      assert.deepStrictEqual(updated.bundle.bundleLinks, [
        { name: 'Luma', url: 'https://lu.ma/abc' },
        { name: 'YouTube', url: '' },
      ]);
    });

    it('PUT /api/bundles/:id rejects invalid stage values', async () => {
      const createEvent = {
        httpMethod: 'POST',
        path: '/api/bundles',
        body: JSON.stringify({ title: 'Invalid Stage', anchorDate: '2026-03-01' }),
      };
      const createResult = await handler(createEvent, {});
      const created = JSON.parse(createResult.body);

      const updateEvent = {
        httpMethod: 'PUT',
        path: '/api/bundles/' + created.bundle.id,
        body: JSON.stringify({ stage: 'invalid-stage' }),
      };
      const updateResult = await handler(updateEvent, {});
      assert.strictEqual(updateResult.statusCode, 400);
    });
  });
});
