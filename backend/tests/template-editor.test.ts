import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('Template Editor - Frontend assets (issue #29)', () => {
  after(async () => {
    await stopLocal();
  });

  it('app.js includes template card rendering code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.ok(result.body.includes('template-card'), 'app.js should contain template-card CSS class');
    assert.ok(result.body.includes('currentTemplateId'), 'app.js should have currentTemplateId state');
    assert.ok(result.body.includes('renderTemplateEditor'), 'app.js should have renderTemplateEditor function');
    assert.ok(result.body.includes('loadTemplateCards'), 'app.js should have loadTemplateCards function');
  });

  it('app.js includes template editor form building code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('buildTemplateEditorForm'), 'app.js should have buildTemplateEditorForm function');
    assert.ok(result.body.includes('tpl-name'), 'editor should have name input');
    assert.ok(result.body.includes('tpl-type'), 'editor should have type input');
    assert.ok(result.body.includes('tpl-emoji'), 'editor should have emoji input');
    assert.ok(result.body.includes('tpl-tags'), 'editor should have tags input');
    assert.ok(result.body.includes('tpl-assignee'), 'editor should have assignee select');
  });

  it('app.js includes trigger config code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('tpl-trigger'), 'editor should have trigger radio buttons');
    assert.ok(result.body.includes('tpl-cron'), 'editor should have cron input');
    assert.ok(result.body.includes('tpl-lead-days'), 'editor should have lead days input');
    assert.ok(result.body.includes('trigger-auto-fields'), 'editor should have auto fields container');
  });

  it('app.js includes references management code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('addReferenceRow'), 'app.js should have addReferenceRow function');
    assert.ok(result.body.includes('tpl-references-list'), 'editor should have references list');
    assert.ok(result.body.includes('Add Reference'), 'editor should have Add Reference button');
  });

  it('app.js includes bundle link definitions management code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('addBundleLinkRow'), 'app.js should have addBundleLinkRow function');
    assert.ok(result.body.includes('tpl-bundlelinks-list'), 'editor should have bundle links list');
    assert.ok(result.body.includes('Add Bundle Link'), 'editor should have Add Bundle Link button');
  });

  it('app.js includes task definition management code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('addTaskDefItem'), 'app.js should have addTaskDefItem function');
    assert.ok(result.body.includes('tpl-taskdefs-list'), 'editor should have task definitions list');
    assert.ok(result.body.includes('td-description'), 'task def should have description field');
    assert.ok(result.body.includes('td-offset'), 'task def should have offset days field');
    assert.ok(result.body.includes('td-milestone'), 'task def should have milestone checkbox');
    assert.ok(result.body.includes('td-stage'), 'task def should have stage select');
    assert.ok(result.body.includes('td-assignee'), 'task def should have assignee select');
    assert.ok(result.body.includes('td-instructions'), 'task def should have instructions field');
    assert.ok(result.body.includes('td-required-link'), 'task def should have required link field');
    assert.ok(result.body.includes('td-requires-file'), 'task def should have requires file checkbox');
  });

  it('app.js includes drag-and-drop code for task definitions', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('setupTaskDefDragDrop'), 'app.js should have setupTaskDefDragDrop function');
    assert.ok(result.body.includes('dragstart'), 'should handle dragstart event');
    assert.ok(result.body.includes('dragover'), 'should handle dragover event');
    assert.ok(result.body.includes('drop'), 'should handle drop event');
    assert.ok(result.body.includes('dragend'), 'should handle dragend event');
    assert.ok(result.body.includes('draggable'), 'task items should be draggable');
  });

  it('app.js includes save template code', async () => {
    const event = { httpMethod: 'GET', path: '/public/app.js' };
    const result = await handler(event, {});

    assert.ok(result.body.includes('saveTemplate'), 'app.js should have saveTemplate function');
    assert.ok(result.body.includes('tpl-save-btn'), 'editor should have save button');
    assert.ok(result.body.includes('tpl-save-feedback'), 'editor should have save feedback element');
    assert.ok(result.body.includes('Saved successfully'), 'should show success message on save');
  });

  it('api.js includes users.list API', async () => {
    const event = { httpMethod: 'GET', path: '/public/api.js' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.ok(result.body.includes('users:'), 'api.js should have users namespace');
    assert.ok(result.body.includes('/api/users'), 'api.js should fetch from /api/users');
  });

  it('HTML includes template card and editor CSS', async () => {
    const event = { httpMethod: 'GET', path: '/' };
    const result = await handler(event, {});

    assert.strictEqual(result.statusCode, 200);
    assert.ok(result.body.includes('.template-cards'), 'HTML should have template-cards CSS');
    assert.ok(result.body.includes('.template-card'), 'HTML should have template-card CSS');
    assert.ok(result.body.includes('.template-editor'), 'HTML should have template-editor CSS');
    assert.ok(result.body.includes('.badge-type'), 'HTML should have badge-type CSS');
    assert.ok(result.body.includes('.badge-tag'), 'HTML should have badge-tag CSS');
    assert.ok(result.body.includes('.badge-trigger'), 'HTML should have badge-trigger CSS');
    assert.ok(result.body.includes('.task-def-item'), 'HTML should have task-def-item CSS');
    assert.ok(result.body.includes('.task-def-drag-handle'), 'HTML should have drag handle CSS');
    assert.ok(result.body.includes('.save-bar'), 'HTML should have save-bar CSS');
  });
});
