import { after, describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';
import { serveCanonicalFrontend } from '../src/docs/portal';

const repoRoot = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(repoRoot, 'frontend');
const html = readFileSync(path.join(frontendRoot, 'index.html'), 'utf8');
const app = readFileSync(path.join(frontendRoot, 'src', 'app.js'), 'utf8');
const styles = readFileSync(path.join(frontendRoot, 'src', 'styles.css'), 'utf8');
const workspace = readFileSync(path.join(frontendRoot, 'src', 'core', 'workspace.js'), 'utf8');
const finance = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'finance.js'), 'utf8');
const home = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'home.js'), 'utf8');
const knowledge = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'knowledge.js'), 'utf8');
const documentEditor = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'document-editor.js'), 'utf8');
const operations = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'operations.js'), 'utf8');
const planning = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'planning.js'), 'utf8');
const tasks = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'tasks.js'), 'utf8');
const workDetail = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'work-detail.js'), 'utf8');
const backendPackage = JSON.parse(readFileSync(path.join(repoRoot, 'backend', 'package.json'), 'utf8'));
const frontendManifest = JSON.parse(readFileSync(path.join(repoRoot, 'backend', 'src', 'docs', 'frontend-assets.json'), 'utf8'));

describe('one canonical frontend', () => {
  after(async () => {
    await stopLocal();
  });

  it('serves the top-level frontend and its same-origin assets', async () => {
    const root = await handler({ httpMethod: 'GET', path: '/' }, {});
    assert.strictEqual(root.statusCode, 200);
    assert.match(root.body, /data-workspace-view="home"/);
    assert.match(root.body, /data-workspace-view="inbox"/);
    assert.match(root.body, /src="\/src\/app\.js"/);

    const js = await handler({ httpMethod: 'GET', path: '/src/app.js' }, {});
    assert.strictEqual(js.statusCode, 200);
    assert.match(js.headers?.['Content-Type'] || '', /javascript/);
    assert.match(js.body, /createHomeSurface/);

    const css = await handler({ httpMethod: 'GET', path: '/src/styles.css' }, {});
    assert.strictEqual(css.statusCode, 200);
    assert.match(css.headers?.['Content-Type'] || '', /text\/css/);
    assert.match(css.body, /\.operations-home/);

    for (const modulePath of [
      '/src/core/workspace.js',
      '/src/surfaces/finance.js',
      '/src/surfaces/home.js',
      '/src/surfaces/knowledge.js',
      '/src/surfaces/document-editor.js',
      '/src/surfaces/operations.js',
      '/src/surfaces/planning.js',
      '/src/surfaces/tasks.js',
      '/src/surfaces/work-detail.js',
    ]) {
      const module = await handler({ httpMethod: 'GET', path: modulePath }, {});
      assert.strictEqual(module.statusCode, 200);
      assert.match(module.headers?.['Content-Type'] || '', /javascript/);
      assert.match(module.body, /export function/);
    }
  });

  it('does not serve the retired fallback asset namespace', async () => {
    assert.strictEqual((await handler({ httpMethod: 'GET', path: '/public/app.js' }, {})).statusCode, 404);
    assert.strictEqual((await handler({ httpMethod: 'GET', path: '/public/api.js' }, {})).statusCode, 404);
    assert.strictEqual((await handler({ httpMethod: 'GET', path: '/src/../package.json' }, {})).statusCode, 404);
    assert.strictEqual(existsSync(path.join(repoRoot, 'backend', 'src', 'pages', 'index.html')), false);
    assert.strictEqual(existsSync(path.join(repoRoot, 'backend', 'src', 'public', 'app.js')), false);
    assert.strictEqual(existsSync(path.join(repoRoot, 'backend', 'src', 'public', 'api.js')), false);
  });

  it('fails explicitly when the canonical artifact is missing', () => {
    const previous = process.env.FRONTEND_ROOT;
    process.env.FRONTEND_ROOT = path.join(repoRoot, '.tmp', 'missing-canonical-frontend');
    try {
      const response = serveCanonicalFrontend({ httpMethod: 'GET', path: '/' });
      assert.strictEqual(response?.statusCode, 500);
      assert.match(response?.body || '', /Canonical frontend artifact is missing/);
    } finally {
      if (previous === undefined) delete process.env.FRONTEND_ROOT;
      else process.env.FRONTEND_ROOT = previous;
    }
  });

  it('packages only frontend/ into the backend artifact', () => {
    assert.deepStrictEqual(frontendManifest.files, [
      'index.html',
      'src/app.js',
      'src/styles.css',
      'src/core/workspace.js',
      'src/surfaces/finance.js',
      'src/surfaces/home.js',
      'src/surfaces/knowledge.js',
      'src/surfaces/document-editor.js',
      'src/surfaces/operations.js',
      'src/surfaces/planning.js',
      'src/surfaces/tasks.js',
      'src/surfaces/work-detail.js',
    ]);
    assert.match(backendPackage.scripts.build, /copy-frontend-artifact\.mjs --source \.\.\/frontend --artifact dist/);
    assert.match(backendPackage.scripts.build, /verify-frontend-artifact\.mjs --source \.\.\/frontend --artifact dist/);
    assert.doesNotMatch(backendPackage.scripts.build, /cp\s+-[Rr]|frontend\/DESIGN\.md|frontend\/Dockerfile|src\/public|src\/pages/);
  });

  it('maps established hash routes and entity deep links into the canonical shell', () => {
    assert.match(app, /from "\.\/core\/workspace\.js"/);
    for (const route of ['/', '/inbox', '/tasks', '/cards', '/cards/archive', '/assistants', '/templates', '/recurring', '/notifications', '/bookkeeping', '/sponsors', '/newsletter', '/calendar', '/mailing-exports']) {
      assert.ok(workspace.includes(`"${route}"`), `missing canonical route ${route}`);
    }
    for (const param of ['taskId', 'cardId', 'bundleId', 'intakeId', 'assistantJobId']) {
      assert.ok(workspace.includes(`"${param}"`), `missing deep-link parameter ${param}`);
    }
  });

  it('retains task, workflow, proof, bookkeeping, newsletter, and calendar behavior', () => {
    for (const marker of [
      'openTaskPanel',
      'requiredLinkName',
      'openBundlePanel',
      'updateBundleStage',
    ]) assert.ok(workDetail.includes(marker), `work detail is missing ${marker}`);
    for (const marker of [
      'renderWorkQueueSurface',
      'renderWorkflowsSurface',
      'renderTemplatesRecurringSurface',
      'renderRecurringOperationsSection',
      'openQuickTaskForm',
      'openQuickWorkflowForm',
    ]) assert.ok(tasks.includes(marker), `Tasks surface is missing ${marker}`);
    for (const marker of ['renderBookkeepingSurface', 'PDF evidence', 'monthly package']) {
      assert.ok(finance.includes(marker), `finance surface is missing ${marker}`);
    }
    for (const marker of ['renderNewsletterSurface', 'renderCalendarSurface']) {
      assert.ok(planning.includes(marker), `planning surface is missing ${marker}`);
    }
    assert.match(workspace, /function taskRequiresApprovedArtifact/);
    assert.match(styles, /\.bundle-checklist/);
    assert.match(styles, /\.bookkeeping-surface/);
    assert.match(styles, /\.newsletter-surface/);
    assert.match(styles, /\.calendar-surface/);
  });

  it('keeps Today attention, status, and process-quality modeling in the canonical Home module', () => {
    assert.match(app, /createHomeSurface/);
    for (const marker of [
      'renderOperationsHome',
      'renderHomeStatusStrip',
      'renderHomeAttentionQueue',
      'Needs your attention',
      'View all tasks',
      'buildOperationsHomeModel',
      'buildProcessQualityModel',
      'refreshOperationsWorkSnapshot',
    ]) assert.ok(home.includes(marker), `Home surface is missing ${marker}`);
  });

  it('keeps Process Docs, Search, and document editing in the canonical Knowledge graph', () => {
    for (const marker of [
      'renderDocsSurface',
      'renderUnifiedSearchSurface',
      'renderTree',
      'openDocument',
      'resolveMarkdownDocLink',
      '/docs/backlinks',
    ]) assert.ok(knowledge.includes(marker), `Knowledge surface is missing ${marker}`);
    for (const marker of [
      'saveCurrentDocument',
      'createDocument',
      'renderParsedDocument',
      'renderFrontmatterBlock',
      'renderSectionBlock',
      'renderMarkdown',
      '/git/status',
    ]) assert.ok(documentEditor.includes(marker), `Document editor is missing ${marker}`);
  });

  it('keeps Admin diagnostics and Users management in the canonical module graph', () => {
    for (const marker of [
      'renderAdminSurface',
      'renderUsersSurfaceView',
      '/api/users',
      'Read-only diagnostics',
      'Add user',
    ]) assert.ok(operations.includes(marker), `Operations module is missing ${marker}`);
  });

  it('provides complete Inbox triage in the canonical shell', () => {
    assert.match(app, /createOperationsSurface/);
    for (const marker of [
      'renderInboxSurface',
      '/api/intake',
      'convert-task',
      'mark-duplicate',
      'follow-up-sent',
      'response-received',
      'prepare-assistant',
      'archive',
    ]) assert.ok(operations.includes(marker), `Inbox is missing ${marker}`);
    assert.match(operations, /className = "intake-layout"/);
    assert.match(styles, /\.ops-surface,/);
  });

  it('provides the full assistant lifecycle in the canonical shell', () => {
    for (const marker of [
      'renderAssistantCreatePanel',
      'renderAssistantJobDetail',
      'runAssistantAction',
      '/api/assistant-jobs',
      'run-dry',
      'approve',
      'reject',
      'retry',
      'cancel',
      'output artifacts',
    ]) assert.ok(operations.toLowerCase().includes(marker.toLowerCase()), `Assistant UI is missing ${marker}`);
    assert.match(operations, /className = "assistant-layout"/);
    assert.match(styles, /\.assistant-card,/);
  });

  it('keeps the Artifacts index in the canonical Operations module graph', () => {
    for (const marker of [
      'renderArtifactsSurface',
      'renderArtifactSurfaceRow',
      '/api/artifacts',
      'Artifact review index not connected',
      'No artifacts registered',
    ]) assert.ok(operations.includes(marker), `Artifacts UI is missing ${marker}`);
  });

  it('provides schema-complete runtime-template administration', () => {
    for (const marker of [
      'renderRuntimeTemplateAdmin',
      'RUNTIME_TEMPLATE_FIELDS',
      '/api/templates',
      'taskDefinitions',
      'bundleLinkDefinitions',
      'triggerSchedule',
      'sourceDocIds',
      'Advanced JSON',
      'validateRuntimeTemplateDraft',
      'Move up',
      'expectedVersion',
      'template_in_use',
    ]) assert.ok(tasks.includes(marker), `Runtime template UI is missing ${marker}`);
    assert.match(tasks, /className = "runtime-template-json"/);
    assert.match(tasks, /className = "runtime-task-card"/);
    assert.match(styles, /\.ops-section,/);
    assert.match(styles, /:focus-visible/);
  });
});
