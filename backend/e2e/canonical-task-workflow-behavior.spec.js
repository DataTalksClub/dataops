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
const TMP_ROOT = path.join(REPO_ROOT, '.tmp', 'issue-207-task-workflows');
const SCREENSHOT_PATH = path.join(REPO_ROOT, '.tmp/screenshots/issue-207/desktop.png');
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
      await expect(page.locator('#library-title')).toHaveText('Home');
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
      await testInfo.attach('issue-207-cleanup-errors', {
        contentType: 'text/plain',
        body: cleanupErrors.join('\n'),
      });
      throw new Error(`Issue 207 fixture cleanup failed:\n${cleanupErrors.join('\n')}`);
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
    const proofUrl = 'https://example.invalid/synthetic-evidence';
    const savedLinkRequests = [];
    const onRequest = (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === `/work/api/tasks/${proofTask.id}`) {
        savedLinkRequests.push(request);
      }
    };
    page.on('request', onRequest);
    const linkRequest = page.waitForRequest((request) => request.method() === 'PUT'
      && new URL(request.url()).pathname === `/work/api/tasks/${proofTask.id}`);
    await requiredLink.fill(proofUrl);
    await requiredLink.blur();
    const savedLinkRequest = await linkRequest;
    const savedLinkResponse = await savedLinkRequest.response();
    page.off('request', onRequest);
    expect(savedLinkRequests).toHaveLength(1);
    expect(savedLinkResponse.status()).toBe(200);
    assertOwnedServerResponse(ownedServer, savedLinkResponse, 'required-link PUT');
    expect(savedLinkRequests[0].postDataJSON()).toEqual({ expectedVersion: proofTask.version, link: proofUrl });
    const savedTask = await json(savedLinkResponse);
    expect(savedTask.version).toBe(proofTask.version + 1);
    await expect(requiredLink).toHaveValue(proofUrl);
    await expect(page.locator('#task-panel .task-detail-meta').first()).toContainText(`Version ${savedTask.version}`);

    await page.locator('#task-panel input[type="file"]').setInputFiles({
      name: 'synthetic-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('public-safe synthetic proof'),
    });
    await expect(page.locator('#task-panel .task-file-item')).toContainText('synthetic-proof.txt');
    await expect(complete).toBeEnabled();
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, animations: 'disabled', fullPage: true });

    await setFaults(context.request, [{ method: 'PUT', path: `/api/tasks/${proofTask.id}`, status: 409 }]);
    const failedCompletionRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === 'PUT' && url.pathname === `/work/api/tasks/${proofTask.id}`;
    });
    await complete.click();
    const failedCompletion = await failedCompletionRequest;
    expect(failedCompletion.postDataJSON().expectedVersion).toBe(savedTask.version);
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

    await openProofTask(page, proofTask.id, card.id, proofTitle, { reload: true });
    await expect(page.locator('#task-panel .task-status-badge')).toHaveText('done');
    await expect(page.locator('#task-panel .task-required-link input[type="url"]')).toHaveValue(proofUrl);
    await expect(page.locator('#task-panel .task-file-item')).toContainText('synthetic-proof.txt');

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
