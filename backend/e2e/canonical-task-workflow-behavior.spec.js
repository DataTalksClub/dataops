const { test: baseTest, expect } = require('@playwright/test');
const { recordCapabilityEvidence } = require('./helpers/capability-evidence');
const { BERLIN_TIME_ZONE } = require('./helpers/business-date');
const {
  assertOwnedServerResponse,
  installServerExitDiagnostics,
  startIsolatedCapabilityServer,
  stopIsolatedCapabilityServer,
} = require('./helpers/isolated-capability-server');
const fs = require('node:fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.tmp', 'issue-216-task-workflows');
const SCREENSHOTS_ROOT = path.join(REPO_ROOT, '.tmp', 'screenshots', 'issue-216');
const PENDING_SCREENSHOT_PATH = path.join(SCREENSHOTS_ROOT, 'required-file-pending-disabled.png');
const UPLOADED_SCREENSHOT_PATH = path.join(SCREENSHOTS_ROOT, 'required-file-saved-uploaded.png');
const ADMIN_ID = '20700000-0000-4000-8000-000000000001';

const syntheticSop = `---
id: sop.synthetic.capability
aliases: []
title: Synthetic Capability Procedure
summary: Public-safe procedure used only by browser behavior tests.
doc_type: sop
schema_version: 1
systems:
  - dataops
tags:
  - synthetic
---

# Synthetic Capability Procedure

<!-- sop-section-start: summary -->
## Summary
Exercise a public-safe retained portal surface.
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
Use synthetic records only.
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
<!-- sop-step-start id=1 systems="dataops" -->
1. Verify the synthetic capability.
<!-- sop-step-end -->
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
The visible state is reloadable.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
Retry the local request.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
None.
<!-- sop-section-end -->
`;

function baseUrl(server) {
  return `http://127.0.0.1:${server.port}`;
}

async function clearFaults(request) {
  const response = await request.delete('/__e2e__/route-faults');
  expect(response.ok()).toBe(true);
}

async function json(response) {
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function setFaults(request, faults) {
  const response = await request.post('/__e2e__/route-faults', { data: { faults } });
  expect(response.ok()).toBe(true);
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function observeBrowserErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push({
    kind: 'pageerror',
    url: page.url(),
    message: error.message,
  }));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    errors.push({
      kind: 'console',
      url: message.location()?.url || page.url(),
      message: message.text(),
    });
  });
  page.on('requestfailed', (request) => errors.push({
    kind: 'requestfailed',
    method: request.method(),
    url: request.url(),
    failure: request.failure()?.errorText || 'unknown',
  }));
  return errors;
}

function isExpectedReloadAbort(entry, cardId) {
  if (entry.kind !== 'requestfailed') return false;
  if (entry.method !== 'GET') return false;
  if (entry.failure !== 'net::ERR_ABORTED') return false;

  const url = new URL(entry.url);
  const exactReloadReads = new Set([
    `/work/api/cards/${encodeURIComponent(cardId)}`,
    '/work/api/notifications?limit=100',
  ]);
  return exactReloadReads.has(`${url.pathname}${url.search}`);
}

function expectNoUnexpectedBrowserErrors(entries, conflictTaskId, cardId, markers) {
  const expectedConflictPath = `/work/api/tasks/${conflictTaskId}`;
  const conflictStart = markers.conflictStart;
  const reloadStart = markers.reloadStart;
  const unexpected = entries.filter((entry, index) => {
    if (entry.kind === 'console' && index >= conflictStart && index < reloadStart) {
      const url = new URL(entry.url);
      return !(
        url.pathname === expectedConflictPath
        && entry.message === 'Failed to load resource: the server responded with a status of 409 (Conflict)'
      );
    }
    if (entry.kind === 'console') {
      return true;
    }
    if (index >= reloadStart && isExpectedReloadAbort(entry, cardId)) {
      return false;
    }
    return true;
  });
  expect(unexpected).toEqual([]);
}

const test = baseTest.extend({
  taskWorkflowPortal: [async ({ browser }, use, testInfo) => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    const server = {
      userId: ADMIN_ID,
      role: 'admin',
      noMailingConfig: true,
      documents: [['capability.md', syntheticSop]],
    };
    const reportServerFailure = (body) => {
      console.error(body);
      void testInfo.attach('isolated-server-exit', {
        contentType: 'text/plain',
        body,
      }).catch(() => {});
    };
    await startIsolatedCapabilityServer(server, TMP_ROOT, {
      onRuntimeExit: reportServerFailure,
    });
    let context;
    let page;
    const cleanupErrors = [];
    try {
      context = await browser.newContext({
        baseURL: baseUrl(server),
        timezoneId: BERLIN_TIME_ZONE,
      });
      const sessionResponse = await context.request.get('/__e2e__/browser-session');
      expect(sessionResponse.status()).toBe(200);
      assertOwnedServerResponse(server, sessionResponse, 'canonical task workflow session');
      page = await context.newPage();
      installServerExitDiagnostics(context, server, testInfo);
      await page.goto('/#/');
      await expect(page.getByRole('heading', { name: 'Today', exact: true }).first()).toBeVisible();
      await use({ context, page, server });
    } finally {
      if (context && !context.isClosed()) {
        try { await clearFaults(context.request); }
        catch (error) { cleanupErrors.push(`clear route faults: ${error.message}`); }
        try { await context.close(); }
        catch (error) { cleanupErrors.push(`close browser context: ${error.message}`); }
      }
      try { await stopIsolatedCapabilityServer(server); }
      catch (error) { cleanupErrors.push(error.message); }
    }
    if (cleanupErrors.length > 0) {
      await testInfo.attach('issue-216-cleanup-errors', {
        contentType: 'text/plain',
        body: cleanupErrors.join('\n'),
      });
      throw new Error(`Issue 216 fixture cleanup failed:\n${cleanupErrors.join('\n')}`);
    }
  }, { auto: false }],
});

function taskHydration(page, taskId, cardId) {
  const exactTask = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === `/work/api/tasks/${taskId}`;
  });
  const exactTaskArtifacts = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === '/work/api/artifacts'
      && url.searchParams.get('taskId') === taskId;
  });
  const exactCardArtifacts = cardId
    ? page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/artifacts'
        && url.searchParams.get('cardId') === cardId;
    })
    : null;
  const filesReady = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === '/work/api/files'
      && url.searchParams.get('taskId') === taskId;
  });
  return { exactCardArtifacts, exactTask, exactTaskArtifacts, filesReady };
}

async function openProofTask(page, taskId, cardId, title, options = {}) {
  const hydration = taskHydration(page, taskId, cardId);
  if (options.byNavigation) {
    await options.byNavigation.click();
  } else if (options.reload) {
    await page.reload();
  } else {
    await page.goto(`/#/tasks?taskId=${taskId}`);
  }
  let responses = [
    hydration.exactTask,
    hydration.exactTaskArtifacts,
  ];
  // Same-document navigation reuses the evidence loader's settled cache.
  // A reload creates a fresh runtime and must prove the network read again.
  if (!options.byNavigation) responses.push(hydration.filesReady);
  responses = await Promise.all(responses);
  if (hydration.exactCardArtifacts) responses.push(await hydration.exactCardArtifacts);
  for (const response of responses) expect(response.status()).toBe(200);
  await expect(page.locator('#task-panel-title')).toHaveText(title);
}

test.describe('canonical Tasks and Workflows browser behavior', () => {
  test('Tasks queue persists create, waiting recovery, and selected update', async ({ taskWorkflowPortal }, testInfo) => {
    const { context, page, server: ownedServer } = taskWorkflowPortal;
    await page.goto('/#/tasks');
    for (const [heading, empty] of [
      ['Overdue', 'No overdue work.'],
      ['Follow-ups due', 'No follow-ups due work.'],
      ['Missing proof', 'No missing proof work.'],
      ['Waiting', 'No waiting work.'],
      ['Today', 'No today work.'],
      ['Done / history', 'No done / history work.'],
    ]) {
      const group = page.locator('.ops-queue-group', { has: page.getByRole('heading', { name: heading, exact: true }) });
      await expect(group.locator('header span')).toHaveText('0');
      await expect(group.locator('.ops-empty')).toHaveText(empty);
    }

    await page.goto('/#/');
    const quickTitle = unique('Synthetic quick task');
    await page.getByRole('button', { name: 'New task' }).click();
    const quickTask = page.getByRole('dialog');
    await quickTask.getByLabel('What needs doing?').fill(quickTitle);
    const createdResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname === '/work/api/tasks'
        && response.status() === 201;
    });
    await quickTask.getByRole('button', { name: 'Create task' }).click();
    await createdResponse;
    await expect(page.locator('#task-panel-title')).toHaveText(quickTitle);
    page.once('dialog', (dialog) => dialog.accept('Synthetic upstream response'));
    const waitingResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname.endsWith('/actions/mark-waiting')
        && response.status() === 200;
    });
    await page.locator('#task-panel').getByRole('button', { name: 'Mark waiting' }).click();
    await waitingResponse;
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('waiting');
    await expect(page.locator('#task-panel')).toContainText('Synthetic upstream response');
    const recoveredResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname.endsWith('/actions/response-received')
        && response.status() === 200;
    });
    await page.locator('#task-panel').getByRole('button', { name: 'Response received' }).click();
    const recoveredTask = await json(await recoveredResponse);
    expect(recoveredTask.status).toBe('todo');
    expect(recoveredTask.version).toBeGreaterThan(1);
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('todo');
    await expect(page.locator('#task-panel .task-history-event', { hasText: 'Response received' })).toBeVisible();
    await page.locator('#task-panel-close').click();
    await expect(page.locator('#task-panel')).toBeHidden();

    recordCapabilityEvidence(testInfo, [{
      route: '/#/tasks?taskId=<id>&date=<date>&cardId=<id>&contextCardId=<id>',
      roleId: 'admin',
      stateIds: ['tasks.empty', 'tasks.waiting', 'tasks.create-select-update'],
    }]);
  });

  test('Required proof saves one versioned link, file, conflict, and durable completion', async ({ taskWorkflowPortal }, testInfo) => {
    test.setTimeout(60_000);
    const { context, page, server: ownedServer } = taskWorkflowPortal;
    const browserErrors = observeBrowserErrors(page);
    const cardTitle = unique('Synthetic staged workflow');
    const cardResponse = await context.request.post('/api/cards', { data: {
      title: cardTitle, anchorDate: '2026-08-12', description: 'Public-safe staged workflow', stage: 'preparation',
    } });
    expect(cardResponse.status()).toBe(201);
    const card = (await json(cardResponse)).card;
    const proofTitle = unique('Synthetic proof task');
    const proofResponse = await context.request.post('/api/tasks', { data: {
      description: proofTitle, date: '2026-08-12', cardId: card.id,
      requiredLinkName: 'Evidence URL', requiresFile: true,
      instructionDocId: 'sop.synthetic.capability', instructionStepId: '1', phase: 'preparation',
      systems: ['dataops'], validation: { requiredEvidence: 'A URL and attached public-safe file' },
    } });
    expect(proofResponse.status()).toBe(201);
    const proofTask = await json(proofResponse);

    await expect(page.locator('.operations-home[data-operations-work-loaded="true"]')).toHaveCount(1);
    await openProofTask(page, proofTask.id, card.id, proofTitle);
    const complete = page.locator('#task-panel').getByRole('button', { name: 'Mark done' });
    await expect(complete).toBeDisabled();
    await expect(complete).toHaveAttribute('title', /Fill in Evidence URL.*Upload required file/);
    const documentsPayload = await json(await context.request.get('/docs'));
    expect(documentsPayload.documents.some((document) => document.path === 'content/synthetic/capability.md')).toBe(true);
    const instructionReady = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/docs'
        && url.searchParams.get('path') === 'content/synthetic/capability.md';
    });
    await page.locator('#task-panel .task-instruction-doc-link', { hasText: 'Synthetic Capability Procedure' }).click();
    expect((await instructionReady).status()).toBe(200);
    await expect(page.locator('#document-title')).toHaveValue('Synthetic Capability Procedure');
    await expect(page.locator('#doc-context-return')).toContainText(`Opened from task: ${proofTitle}`);

    const returnedPanel = openProofTask(
      page,
      proofTask.id,
      card.id,
      proofTitle,
      { byNavigation: page.getByRole('button', { name: 'Back to Task' }) },
    );
    await returnedPanel;
    const requiredLink = page.locator('#task-panel .task-required-link input[type="url"]');
    const fileInput = page.locator('#task-panel input[type="file"]');
    const proofUrl = 'https://example.invalid/synthetic-evidence';
    const savedLinkRequests = [];
    const uploadRequests = [];
    const uploadResponses = [];
    const onRequest = (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === `/work/api/tasks/${proofTask.id}`) {
        savedLinkRequests.push(request);
      }
    };
    const onUploadRequest = (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/work/api/files') {
        uploadRequests.push(request);
      }
    };
    const onUploadResponse = (response) => {
      const url = new URL(response.url());
      if (response.request().method() === 'POST' && url.pathname === '/work/api/files') {
        uploadResponses.push(response);
      }
    };
    page.on('request', onRequest);
    page.on('request', onUploadRequest);
    page.on('response', onUploadResponse);
    await setFaults(context.request, [{
      method: 'GET',
      path: '/api/tasks',
      query: { cardId: card.id },
      delayMs: 500,
    }]);
    const taskRefreshRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'GET'
        && url.pathname === '/work/api/tasks'
        && url.searchParams.get('cardId') === card.id;
    });
    const taskRefreshResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/tasks'
        && url.searchParams.get('cardId') === card.id;
    });
    const linkRequest = page.waitForRequest((request) => request.method() === 'PUT'
      && new URL(request.url()).pathname === `/work/api/tasks/${proofTask.id}`);
    await requiredLink.fill(proofUrl);
    await requiredLink.blur();
    const savedLinkRequest = await linkRequest;
    await savedLinkRequest.response();
    await taskRefreshRequest;
    await expect(page.locator('#task-panel [data-task-mutation-feedback="pending"]'))
      .toHaveText('Saving Task link…');
    await expect(fileInput).toBeDisabled();
    expect(uploadRequests).toHaveLength(0);
    expect(uploadResponses).toHaveLength(0);
    fs.mkdirSync(SCREENSHOTS_ROOT, { recursive: true });
    await page.screenshot({ path: PENDING_SCREENSHOT_PATH, animations: 'disabled', fullPage: true });
    const savedLinkResponse = await savedLinkRequest.response();
    const refreshedTaskResponse = await taskRefreshResponse;
    expect(savedLinkRequests).toHaveLength(1);
    expect(savedLinkResponse.status()).toBe(200);
    assertOwnedServerResponse(ownedServer, savedLinkResponse, 'required-link PUT');
    expect(refreshedTaskResponse.status()).toBe(200);
    assertOwnedServerResponse(ownedServer, refreshedTaskResponse, 'required-link task refresh');
    expect(savedLinkRequests[0].postDataJSON()).toEqual({ expectedVersion: proofTask.version, link: proofUrl });
    const savedTask = await json(savedLinkResponse);
    expect(savedTask.version).toBe(proofTask.version + 1);
    await expect(requiredLink).toHaveValue(proofUrl);
    await expect(page.locator('#task-panel .task-detail-meta').first()).toContainText(`Version ${savedTask.version}`);
    await expect(page.locator('#task-panel [data-task-mutation-feedback="success"]'))
      .toHaveText('Task link is saved in the refreshed Task.');
    await expect(fileInput).toBeEnabled();

    const uploadResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'POST'
        && url.pathname === '/work/api/files';
    });
    const uploadedFilesResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/files'
        && url.searchParams.get('taskId') === proofTask.id
        && url.searchParams.get('limit') === '100'
        && !url.searchParams.has('cursor');
    });
    await fileInput.setInputFiles({
      name: 'synthetic-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('public-safe synthetic proof'),
    });
    const uploadedResponse = await uploadResponse;
    expect(uploadedResponse.status()).toBe(201);
    assertOwnedServerResponse(ownedServer, uploadedResponse, 'required-file POST');
    const uploadedPayload = await json(uploadedResponse);
    const uploadedFile = uploadedPayload.file;
    expect(uploadedFile).toEqual(expect.objectContaining({
      id: expect.any(String),
      taskId: proofTask.id,
      cardId: card.id,
      filename: 'synthetic-proof.txt',
      category: 'document',
    }));
    const uploadedFilesResponseValue = await uploadedFilesResponse;
    expect(uploadedFilesResponseValue.status()).toBe(200);
    assertOwnedServerResponse(ownedServer, uploadedFilesResponseValue, 'required-file refresh');
    const uploadedFilesPayload = await json(uploadedFilesResponseValue);
    expect(uploadedFilesPayload.files.items).toHaveLength(1);
    expect(uploadedFilesPayload.files.nextCursor).toBeUndefined();
    expect(uploadedFilesPayload.files.items[0]).toEqual(expect.objectContaining({
      id: uploadedFile.id,
      taskId: proofTask.id,
      cardId: card.id,
      filename: 'synthetic-proof.txt',
      category: 'document',
    }));
    await expect(page.locator('#task-panel .task-file-item')).toContainText('synthetic-proof.txt');
    await expect(page.locator('#task-panel [data-task-mutation-feedback="success"]'))
      .toHaveText('File is attached in the refreshed Task.');
    expect(uploadRequests).toHaveLength(1);
    expect(uploadResponses).toHaveLength(1);
    expect(uploadResponses[0].status()).toBe(201);
    await expect(complete).toBeEnabled();
    await page.screenshot({ path: UPLOADED_SCREENSHOT_PATH, animations: 'disabled', fullPage: true });
    page.off('request', onRequest);
    page.off('request', onUploadRequest);
    page.off('response', onUploadResponse);

    const conflictErrorStart = browserErrors.length;
    await setFaults(context.request, [{ method: 'PUT', path: `/api/tasks/${proofTask.id}`, status: 409 }]);
    const failedCompletionRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'PUT' && url.pathname === `/work/api/tasks/${proofTask.id}`;
    });
    const failedCompletionResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === `/work/api/tasks/${proofTask.id}`
        && response.status() === 409;
    });
    await complete.click();
    const failedCompletion = await failedCompletionRequest;
    const failedResponse = await failedCompletionResponse;
    expect(failedResponse.status()).toBe(409);
    assertOwnedServerResponse(ownedServer, failedResponse, 'synthetic completion conflict');
    expect(await json(failedResponse)).toEqual({ error: 'Synthetic route failure (409)' });
    expect(failedCompletion.postDataJSON()).toEqual({
      expectedVersion: savedTask.version,
      status: 'done',
    });
    const taskMutationFailure = page.locator('#task-panel [data-task-mutation-feedback="error"]');
    await expect(taskMutationFailure).toContainText('Could not update task: Synthetic route failure (409)');
    await expect(taskMutationFailure).toBeFocused();
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('todo');
    await expect(requiredLink).toHaveValue(proofUrl);
    await expect(page.locator('#task-panel .task-file-item')).toContainText('synthetic-proof.txt');
    await clearFaults(context.request);
    const successfulCompletion = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === `/work/api/tasks/${proofTask.id}`
        && response.status() === 200;
    });
    await complete.click();
    const completionResponse = await successfulCompletion;
    assertOwnedServerResponse(ownedServer, completionResponse, 'Task completion PUT');
    const completedTask = await json(completionResponse);
    expect(completionResponse.request().postDataJSON()).toEqual({
      expectedVersion: savedTask.version,
      status: 'done',
    });
    expect(completedTask.version).toBe(savedTask.version + 1);
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
    await expect(page.locator('#task-panel')).toContainText(completedTask.taskHistory.at(-1)?.note || '');

    await page.waitForLoadState('networkidle');
    const reloadErrorStart = browserErrors.length;
    await openProofTask(page, proofTask.id, card.id, proofTitle, { reload: true });
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
    await expect(page.locator('#task-panel .task-required-link input[type="url"]')).toHaveValue(proofUrl);
    await expect(page.locator('#task-panel .task-file-item')).toContainText('synthetic-proof.txt');
    expectNoUnexpectedBrowserErrors(browserErrors, proofTask.id, card.id, {
      conflictStart: conflictErrorStart,
      reloadStart: reloadErrorStart,
    });

    recordCapabilityEvidence(testInfo, [{
      route: '/#/tasks?taskId=<id>&date=<date>&cardId=<id>&contextCardId=<id>',
      roleId: 'admin',
      stateIds: ['tasks.file-proof', 'tasks.sop-link', 'tasks.conflict'],
    }]);
  });

  test('Workflows resolve blocked relationships, staged progress, and completion', async ({ taskWorkflowPortal }, testInfo) => {
    test.setTimeout(75_000);
    const { context, page } = taskWorkflowPortal;
    await page.goto('/#/cards');
    await expect(page.locator('.ops-workflows-board')).toBeVisible();
    await expect(page.locator('.ops-workflow-card')).toHaveCount(0);

    const cardTitle = unique('Synthetic staged workflow');
    const cardResponse = await context.request.post('/api/cards', { data: {
      title: cardTitle, anchorDate: '2026-08-12', description: 'Public-safe staged workflow', stage: 'preparation',
    } });
    expect(cardResponse.status()).toBe(201);
    const card = (await json(cardResponse)).card;
    const proofTitle = unique('Synthetic proof task');
    const proofResponse = await context.request.post('/api/tasks', { data: {
      description: proofTitle, date: '2026-08-12', cardId: card.id, status: 'done',
      instructionDocId: 'sop.synthetic.capability', phase: 'preparation',
    } });
    expect(proofResponse.status()).toBe(201);
    const completedTitle = unique('Synthetic completed task');
    const completedResponse = await context.request.post('/api/tasks', { data: {
      description: completedTitle, date: '2026-08-12', cardId: card.id, status: 'done',
      instructionDocId: 'sop.synthetic.capability', phase: 'preparation',
    } });
    expect(completedResponse.status()).toBe(201);
    const missingArtifactTitle = unique('Synthetic missing artifact relationship');
    const missingArtifactResponse = await context.request.post('/api/tasks', { data: {
      description: missingArtifactTitle, date: '2026-08-12', cardId: card.id,
      proofRequirement: { type: 'artifact', required: true, label: 'Approved synthetic output' },
      artifactRefs: [{ artifactId: 'stale-synthetic-artifact', status: 'draft' }],
      instructionDocId: 'sop.synthetic.capability',
    } });
    expect(missingArtifactResponse.status()).toBe(201);
    const missingArtifactTask = await json(missingArtifactResponse);

    await openProofTask(page, missingArtifactTask.id, card.id, missingArtifactTitle);
    await expect(page.locator('#task-panel')).toContainText('No approved artifact attached.');
    await expect(page.locator('#task-panel').getByRole('button', { name: 'Mark done' })).toBeDisabled();
    const staleArtifact = await context.request.get('/api/artifacts/stale-synthetic-artifact');
    expect(staleArtifact.status()).toBe(404);
    expect(staleArtifact.headers()['content-type']).toContain('application/json');

    await page.goto('/#/cards');
    const refreshedWorkflows = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/work/api/cards'
        && url.searchParams.has('limit');
    });
    await page.reload();
    await refreshedWorkflows;
    const workflowCard = page.locator(`.ops-workflow-card[data-card-id="${card.id}"]`);
    await expect(workflowCard).toContainText(cardTitle);
    await expect(workflowCard).toContainText('2/3 tasks');
    await workflowCard.click();
    await expect(page.locator('#card-panel-title')).toHaveText(cardTitle);
    for (const taskTitle of [missingArtifactTitle, proofTitle, completedTitle]) {
      await expect(page.locator('#card-panel .card-checklist-label', { hasText: taskTitle })).toBeVisible();
    }
    await expect(page.locator('#card-panel')).toContainText('Active (1)');
    await expect(page.locator('#card-panel')).toContainText('Done / history (2)');
    await expect(page.locator('#card-panel .card-stage-select')).toHaveValue('preparation');
    const stageChanged = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'PUT'
        && url.pathname === `/work/api/cards/${card.id}`
        && response.status() === 200;
    });
    await page.locator('#card-panel .card-stage-select').selectOption('announced');
    await stageChanged;
    await expect.poll(async () => (await json(await context.request.get(`/api/cards/${card.id}`))).card.stage).toBe('announced');
    await page.reload();
    await expect(page.locator('#card-panel .card-stage-select')).toHaveValue('announced');

    const approvedArtifactResponse = await context.request.post('/api/artifacts', { data: {
      type: 'other', title: 'Synthetic approved task proof',
      storageUri: 'https://example.invalid/synthetic-approved-proof', storageProvider: 'external-url',
      dataClass: 'internal', status: 'approved', sourceType: 'manual-link',
      taskId: missingArtifactTask.id, cardId: card.id,
    } });
    expect(approvedArtifactResponse.status()).toBe(201);
    const approvedArtifact = (await json(approvedArtifactResponse)).artifact;
    const currentMissingArtifactTask = await json(await context.request.get(`/api/tasks/${missingArtifactTask.id}`));
    expect(Number.isInteger(currentMissingArtifactTask.version)).toBe(true);
    const attachApprovedArtifact = await context.request.put(`/api/tasks/${missingArtifactTask.id}`, { data: {
      expectedVersion: currentMissingArtifactTask.version,
      proofRequirement: { type: 'artifact', required: true, label: 'Approved synthetic output' },
      artifactRefs: [{ artifactId: approvedArtifact.id, status: 'approved' }],
    } });
    expect(attachApprovedArtifact.status()).toBe(200);
    expect((await json(attachApprovedArtifact)).version).toBeGreaterThan(currentMissingArtifactTask.version);
    await page.reload();
    const missingArtifactCheckbox = page.getByRole('checkbox', { name: `Complete ${missingArtifactTitle}` });
    await expect(missingArtifactCheckbox).toBeEnabled();
    await missingArtifactCheckbox.click();
    await expect.poll(async () => (await json(await context.request.get(`/api/tasks/${missingArtifactTask.id}`))).status).toBe('done');
    await page.reload();
    await expect(page.locator('#card-panel [role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('#card-panel')).toContainText('3/3 tasks');
    await expect(page.locator('#card-panel .card-stage-static')).toHaveText('Completed');
    await expect(page.locator('#card-panel .card-completion-meta')).toContainText('from Announced');
    await expect(page.locator('#card-panel')).toContainText('Done / history (3)');
    await page.reload();
    await expect(page.locator('#card-panel .card-stage-static')).toHaveText('Completed');
    await expect(page.locator('#card-panel .card-completion-meta')).toContainText('from Announced');
    await expect(page.locator('#card-panel')).toContainText('Done / history (3)');
    await expect(page.locator('#card-panel [role="progressbar"]')).toHaveAttribute('aria-valuenow', '100');

    recordCapabilityEvidence(testInfo, [
      { route: '/#/tasks?taskId=<id>&date=<date>&cardId=<id>&contextCardId=<id>', roleId: 'admin', stateIds: ['tasks.blocked', 'tasks.done'] },
      { route: '/#/cards?cardId=<id>&taskId=<id>', roleId: 'admin', stateIds: ['workflows.empty', 'workflows.active', 'workflows.staged', 'workflows.completed'] },
      { route: '/#/artifacts', roleId: 'admin', stateIds: ['artifacts.not-found'] },
    ]);
  });
});
