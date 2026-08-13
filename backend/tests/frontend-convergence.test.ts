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
const application = readFileSync(path.join(frontendRoot, 'src', 'runtime', 'application.js'), 'utf8');
const styles = readFileSync(path.join(frontendRoot, 'src', 'styles.css'), 'utf8');
const shellModules = [
  'api.js',
  'feedback.js',
  'preferences.js',
  'account.js',
  'notifications.js',
  'navigation.js',
  'bootstrap.js',
  'dom-bindings.js',
];
const coreModules = ['workspace.js', 'operations-model.js'];
const runtimeModules = [
  'application.js',
  'application-events.js',
  'operation-kernel.js',
  'shell-composition.js',
  'surface-composition.js',
  'workspace-state.js',
];
const financeModules = [
  'index.js',
  'bookkeeping.js',
  'mailing.js',
  'shared.js',
  'sponsor-communications.js',
  'sponsor-finance.js',
  'sponsor-layout.js',
  'sponsors.js',
];
const home = readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'home.js'), 'utf8');
const knowledgeModules = [
  'index.js',
  'catalog.js',
  'filters.js',
  'process-docs.js',
  'search.js',
  'tree.js',
  'navigation.js',
  'menus.js',
  'references.js',
];
const knowledge = knowledgeModules
  .map((file) => readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'knowledge', file), 'utf8'))
  .join('\n');
const documentEditorModules = [
  'index.js',
  'lifecycle.js',
  'changes.js',
  'git.js',
  'document-renderer.js',
  'procedure-renderer.js',
  'review-media.js',
  'structured-editor.js',
  'procedure-markdown.js',
  'markdown.js',
];
const documentEditor = documentEditorModules
  .map((file) => readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'document-editor', file), 'utf8'))
  .join('\n');
const operationsModules = [
  'index.js',
  'admin.js',
  'artifacts.js',
  'assistants.js',
  'device.js',
  'inbox.js',
  'inbox-actions.js',
];
const operations = operationsModules
  .map((file) => readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'operations', file), 'utf8'))
  .join('\n');
const taskModules = [
  'index.js',
  'cards.js',
  'queue.js',
  'quick-create.js',
  'recurring.js',
  'templates.js',
];
const tasks = taskModules
  .map((file) => readFileSync(path.join(frontendRoot, 'src', 'surfaces', 'tasks', file), 'utf8'))
  .join('\n');
const workDetailModules = [
  'index.js',
  'route-state.js',
  'task-panel.js',
  'task-actions.js',
  'task-evidence.js',
  'card-panel.js',
];
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
    assert.match(js.body, /import "\.\/runtime\/application\.js"/);

    const runtime = await handler({ httpMethod: 'GET', path: '/src/runtime/application.js' }, {});
    assert.strictEqual(runtime.statusCode, 200);
    assert.match(runtime.headers?.['Content-Type'] || '', /javascript/);
    assert.match(runtime.body, /createHomeSurface/);

    const css = await handler({ httpMethod: 'GET', path: '/src/styles.css' }, {});
    assert.strictEqual(css.statusCode, 200);
    assert.match(css.headers?.['Content-Type'] || '', /text\/css/);
    assert.match(css.body, /\.operations-home/);

    for (const modulePath of [
      ...shellModules.map((file) => `/src/shell/${file}`),
      ...coreModules.map((file) => `/src/core/${file}`),
      ...runtimeModules.map((file) => `/src/runtime/${file}`),
      ...financeModules.map((file) => `/src/surfaces/finance/${file}`),
      '/src/surfaces/home.js',
      '/src/surfaces/operations-overview.js',
      ...knowledgeModules.map((file) => `/src/surfaces/knowledge/${file}`),
      ...documentEditorModules.map((file) => `/src/surfaces/document-editor/${file}`),
      ...operationsModules.map((file) => `/src/surfaces/operations/${file}`),
      '/src/surfaces/planning.js',
      ...taskModules.map((file) => `/src/surfaces/tasks/${file}`),
      ...workDetailModules.map((file) => `/src/surfaces/work-detail/${file}`),
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
      ...shellModules.map((file) => `src/shell/${file}`),
      ...coreModules.map((file) => `src/core/${file}`),
      ...runtimeModules.map((file) => `src/runtime/${file}`),
      ...financeModules.map((file) => `src/surfaces/finance/${file}`),
      'src/surfaces/home.js',
      'src/surfaces/operations-overview.js',
      ...knowledgeModules.map((file) => `src/surfaces/knowledge/${file}`),
      ...documentEditorModules.map((file) => `src/surfaces/document-editor/${file}`),
      ...operationsModules.map((file) => `src/surfaces/operations/${file}`),
      'src/surfaces/planning.js',
      ...taskModules.map((file) => `src/surfaces/tasks/${file}`),
      ...workDetailModules.map((file) => `src/surfaces/work-detail/${file}`),
    ]);
    assert.match(backendPackage.scripts.build, /copy-frontend-artifact\.mjs --source \.\.\/frontend --artifact dist/);
    assert.match(backendPackage.scripts.build, /verify-frontend-artifact\.mjs --source \.\.\/frontend --artifact dist/);
    assert.doesNotMatch(backendPackage.scripts.build, /cp\s+-[Rr]|frontend\/DESIGN\.md|frontend\/Dockerfile|src\/public|src\/pages/);
  });

  // Two suites used to live here that read `workspace.js`, the surface modules
  // and `styles.css` as text and asserted that route literals, a private
  // function name (`taskRequiresApprovedArtifact`) and CSS class names appeared
  // somewhere in them. They broke on renames while a broken implementation
  // still passed, and the same ground is already covered behaviourally, by
  // running the production modules, in the `frontend/test/` suite that CI gates
  // through `npm run test:frontend:coverage`:
  //
  //   - routes and deep-link parameters: `frontend/test/routing.test.mjs`
  //     imports `WORKSPACE_ROUTE_DEFINITIONS`, `parseWorkspaceHash` and
  //     `canonicalWorkspaceUrl` and asserts the full route list, parameter
  //     serialisation order and rejection of malformed deep links.
  //   - proof/artifact gating: `frontend/test/work-detail-surface.test.mjs`
  //     drives the real task panel through `taskRequiresApprovedArtifact`.
  //   - surface rendering: `frontend/test/tasks-surface.test.mjs`,
  //     `finance-surface.test.mjs`, `planning-surface.test.mjs` and
  //     `work-detail-surface.test.mjs` render those surfaces and assert the
  //     resulting DOM.
  //
  // What stays in this file is the part `frontend/test/` cannot see: that the
  // backend actually serves the canonical artifact, and only it.

  it('keeps Today attention, status, and process-quality modeling in the canonical Home module', () => {
    assert.match(application, /createHomeSurface/);
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
    assert.match(application, /createOperationsSurface/);
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

  it('provides a read-only Git-authored runtime-template inspector', () => {
    for (const marker of [
      'renderRuntimeTemplateInspector',
      '/api/templates',
      'taskDefinitions',
      'sourcePath',
      'sourceRevision',
      'private knowledge repository',
      'Create card',
    ]) assert.ok(tasks.includes(marker), `Runtime template inspector is missing ${marker}`);
    for (const removed of ['Save template', 'Delete template', 'expectedVersion', 'runtime-template-json']) {
      assert.ok(!tasks.includes(removed), `Runtime template mutation UI still contains ${removed}`);
    }
    assert.match(tasks, /className = "runtime-template-editor runtime-template-readonly"/);
    assert.match(styles, /\.ops-section,/);
    assert.match(styles, /:focus-visible/);
  });
});
