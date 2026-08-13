const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');

const SHOTS = path.resolve(__dirname, '..', '..', '.tmp', 'screenshots', 'issue-156');

function suffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function berlinToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function createFixtures(request) {
  const id = suffix();
  const card = (await (await request.post('/api/cards', {
    data: { title: `Route workflow ${id}`, anchorDate: '2026-08-11' },
  })).json()).card;
  const contextCard = (await (await request.post('/api/cards', {
    data: { title: `Return workflow ${id}`, anchorDate: '2026-08-12' },
  })).json()).card;
  const task = await (await request.post('/api/tasks', {
    data: { description: `Route task ${id}`, date: '2026-08-11', cardId: card.id },
  })).json();
  const intake = (await (await request.post('/api/intake', {
    data: { source: 'manual', title: `New intake ${id}`, note: 'Synthetic operator context', dataClass: 'internal' },
  })).json()).item;
  const blocked = (await (await request.post('/api/intake', {
    data: { source: 'manual', title: `Blocked intake ${id}`, note: 'Waiting on a synthetic reply', dataClass: 'internal' },
  })).json()).item;
  await request.post(`/api/intake/${blocked.id}/block`, {
    data: { reason: 'Need a response', waitingFor: 'Synthetic partner', followUpAt: '2026-08-01T09:00:00.000Z' },
  });
  await request.post(`/api/intake/${blocked.id}/follow-up-sent`, {
    data: { note: 'Sent a synthetic reminder', nextFollowUpAt: '2026-08-10T09:00:00.000Z', channel: 'email' },
  });
  const filteredOut = (await (await request.post('/api/intake', {
    data: { source: 'manual', title: `Archived intake ${id}`, note: 'Genuinely outside the actionable filter', dataClass: 'internal' },
  })).json()).item;
  await request.post(`/api/intake/${filteredOut.id}/archive`, { data: { reason: 'Synthetic filtered-out route evidence' } });
  const assistant = (await (await request.post('/api/assistant-jobs', {
    data: { assistantType: 'podcast', title: `Route assistant ${id}`, cardId: card.id, inputRefs: [{ type: 'card', id: card.id }], approvalRequired: true, maxAttempts: 2 },
  })).json()).job;
  const templates = (await (await request.get('/api/templates')).json()).templates;
  const organization = await (await request.post('/api/sponsor-crm/organizations', {
    data: { displayName: `Route sponsor ${id}` },
  })).json();
  const booking = await (await request.post('/api/sponsor-crm/bookings', {
    data: { organizationId: organization.id, slotType: 'main', status: 'inquiry', plannedPublicationDate: '2026-09-01' },
  })).json();
  return { id, card, contextCard, task, intake, blocked, filteredOut, assistant, template: templates[0], booking };
}

async function setRouteFaults(request, faults) {
  const response = await request.post('/__e2e__/route-faults', { data: { faults } });
  expect(response.ok()).toBe(true);
}

async function clearRouteFaults(request) {
  await request.delete('/__e2e__/route-faults');
}

async function expectNoHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectNoSeriousA11y(page, selector) {
  let scan = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (selector) scan = scan.include(selector);
  const result = await scan.analyze();
  const blocking = result.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));
  expect(blocking, blocking.map((violation) => `${violation.id}: ${violation.help}`).join('\n')).toEqual([]);
}

test.describe('issue 156 canonical route and operator parity', () => {
  test('boots hash workspace routes without waiting for a delayed docs provider', async ({ page, request }) => {
    await setRouteFaults(request, [{ method: 'GET', path: '/docs', delayMs: 5000 }]);
    try {
      const docsStarted = page.waitForRequest((req) => new URL(req.url()).pathname === '/docs');
      await page.goto('/#/');
      await docsStarted;
      await expect(page.locator('#library-title')).toHaveText('Home', { timeout: 2000 });
      await expect(page.locator('.operations-home')).toBeVisible();
    } finally {
      await page.goto('about:blank');
      await clearRouteFaults(request);
    }
  });

  test('resolves every supported row, valid task combination, normalization, and browser history', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    const routes = [
      ['/#/', 'Home'],
      [`/#/inbox?intakeId=${encodeURIComponent(fixture.intake.id)}`, 'Inbox'],
      [`/#/tasks?taskId=${encodeURIComponent(fixture.task.id)}&date=2026-08-11&cardId=${encodeURIComponent(fixture.card.id)}&contextCardId=${encodeURIComponent(fixture.contextCard.id)}`, 'Tasks - Work Queue'],
      [`/#/cards?cardId=${encodeURIComponent(fixture.card.id)}&taskId=${encodeURIComponent(fixture.task.id)}`, 'Tasks - Cards'],
      [`/#/assistants?assistantJobId=${encodeURIComponent(fixture.assistant.id)}`, 'Tasks - Assistants'],
      [`/#/templates?templateId=${encodeURIComponent(fixture.template.id)}`, 'Tasks - Templates'],
      ['/#/recurring', 'Tasks - Recurring'],
      ['/#/artifacts', 'Tasks - Artifacts'],
      ['/#/notifications', 'Home'],
      ['/#/bookkeeping', 'Bookkeeping'],
      [`/#/sponsors?bookingId=${encodeURIComponent(fixture.booking.id)}`, 'Sponsors'],
      ['/#/newsletter', 'Newsletter'],
      ['/#/calendar', 'Calendar'],
      ['/#/mailing-exports', 'Mailing exports'],
      ['/#/processes', 'Docs'],
      ['/#/admin', 'Admin'],
      ['/#/users', 'Users'],
    ];
    for (const [route, title] of routes) {
      await page.goto(route);
      await expect(page.locator('#library-title')).toHaveText(title);
      expect(new URL(page.url()).hash).toBe(new URL(`http://local${route}`).hash);
    }

    await page.goto('/#/tasks/?date=2026-08-11&unsupported=%3Cb%3Eunsafe%3C%2Fb%3E');
    await expect(page).toHaveURL(/\/#\/tasks\?date=2026-08-11$/);
    await page.evaluate(() => { window.location.hash = '#/tasks?date=2026-02-30'; });
    await expect(page).toHaveURL(/\/#\/$/);
    await page.evaluate(() => { window.location.hash = '#/unknown?x=%3Cimg%3E'; });
    await expect(page).toHaveURL(/\/#\/$/);
    await page.evaluate(() => { window.location.hash = '#/cards?taskId=orphan'; });
    await expect(page).toHaveURL(/\/#\/$/);

    await page.goto('/#/inbox');
    await page.locator('.intake-row', { hasText: fixture.intake.title }).click();
    await expect(page).toHaveURL(new RegExp(`/#/inbox\\?intakeId=${fixture.intake.id}$`));
    await page.locator('[data-close-intake]').click();
    await expect(page).toHaveURL(/\/#\/inbox$/);
    await page.goBack();
    await expect(page.locator('.intake-detail h3')).toHaveText(fixture.intake.title);
    await page.goForward();
    await expect(page.locator('.intake-detail .ops-honest-state')).toBeVisible();
  });

  test('keeps exact entities honest, filtered intake exact, and task/workflow mismatch recoverable', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    await page.goto(`/#/inbox?intakeId=${fixture.filteredOut.id}`);
    await expect(page.locator('.intake-detail h3')).toHaveText(fixture.filteredOut.title);
    await expect(page.locator('.intake-row', { hasText: fixture.filteredOut.title })).toHaveCount(0);
    await page.goto('/#/inbox?intakeId=stale-intake');
    await expect(page.locator('.entity-route-not-found:visible')).toContainText('stale-intake');
    await expect(page.locator('.entity-route-not-found:visible')).toBeFocused();

    for (const [route, id] of [
      ['tasks?taskId=stale-task', 'stale-task'],
      ['cards?cardId=stale-workflow', 'stale-workflow'],
      ['assistants?assistantJobId=stale-assistant', 'stale-assistant'],
      ['templates?templateId=stale-template', 'stale-template'],
      ['sponsors?bookingId=stale-booking', 'stale-booking'],
    ]) {
      await page.goto(`/#/${route}`);
      await expect(page.locator('.entity-route-not-found:visible')).toContainText(id);
      await expect(page.locator('button:visible', { hasText: 'Retry' }).first()).toBeVisible();
    }

    await page.goto(`/#/cards?cardId=${fixture.contextCard.id}&taskId=${fixture.task.id}`);
    await expect(page.locator('.entity-route-mismatch')).toContainText(fixture.task.id);
    await expect(page.locator('.entity-route-mismatch')).toContainText(fixture.contextCard.id);
  });

  test('resolves each task parameter independently and reports source-specific non-404 failures', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    const encodedCard = encodeURIComponent(fixture.card.id);
    const encodedContext = encodeURIComponent(fixture.contextCard.id);

    await page.goto('/#/tasks?date=2026-08-11');
    await expect(page.locator('.task-route-context')).toContainText('Date 2026-08-11');
    await expect(page.locator('.ops-queue-row', { hasText: fixture.task.description })).toBeVisible();
    await page.goto(`/#/tasks?cardId=${encodedCard}`);
    await expect(page.locator('.task-route-context')).toContainText(fixture.card.title);
    await expect(page.locator('.ops-queue-row', { hasText: fixture.task.description })).toBeVisible();
    await page.goto(`/#/tasks?contextCardId=${encodedContext}`);
    await expect(page.locator('.task-route-context')).toContainText(fixture.contextCard.title);
    await expect(page.getByRole('button', { name: 'Open return workflow' })).toBeVisible();
    await page.goto(`/#/tasks?taskId=${encodeURIComponent(fixture.task.id)}`);
    await expect(page.locator('#task-panel-title')).toHaveText(fixture.task.description);

    const route = `/#/tasks?date=2026-08-11&cardId=${encodedCard}&contextCardId=${encodedContext}`;
    await setRouteFaults(request, [{ method: 'GET', path: `/api/cards/${fixture.card.id}`, status: 503 }]);
    await page.goto(route);
    await expect(page.locator('[data-context-source="filter-card"]')).toContainText('Filter workflow unavailable');
    await expect(page.locator('[data-context-source="return-context"]')).toHaveCount(0);
    await expect(page.locator('.ops-queue-row', { hasText: fixture.task.description })).toBeVisible();
    await expect(page.locator('.task-route-context')).toContainText(fixture.contextCard.title);

    await setRouteFaults(request, [{
      method: 'GET', path: '/api/tasks', query: { date: '2026-08-11', cardId: fixture.card.id }, status: 503,
    }]);
    await page.goto(route);
    await expect(page.locator('[data-context-source="task-query"]')).toContainText('Filtered task queue unavailable');
    await expect(page.locator('[data-context-source="filter-card"]')).toHaveCount(0);
    await expect(page.locator('[data-context-source="return-context"]')).toHaveCount(0);
    await expect(page.locator('.task-route-context')).toContainText(fixture.card.title);
    await expect(page.locator('.task-route-context')).toContainText(fixture.contextCard.title);

    await setRouteFaults(request, [{ method: 'GET', path: `/api/cards/${fixture.contextCard.id}`, status: 503 }]);
    await page.goto(route);
    await expect(page.locator('[data-context-source="return-context"]')).toContainText('Return workflow unavailable');
    await expect(page.locator('[data-context-source="filter-card"]')).toHaveCount(0);
    await expect(page.locator('.ops-queue-row', { hasText: fixture.task.description })).toBeVisible();
    await expect(page.locator('.task-route-context')).toContainText(fixture.card.title);

    await setRouteFaults(request, [{ method: 'GET', path: `/api/cards/${fixture.card.id}`, status: 503 }]);
    await page.goto(`/#/cards?cardId=${encodedCard}`);
    await expect(page.locator('#card-panel .entity-route-error')).toContainText('Synthetic route failure (503)');
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}$`));
    await clearRouteFaults(request);
  });

  test('keeps relationship, notification, search, and panel close routes synchronized', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    const linked = (await (await request.post('/api/intake', {
      data: { source: 'manual', title: `Linked intake ${fixture.id}`, note: 'Cross-surface relationship evidence', dataClass: 'internal' },
    })).json()).item;
    await request.post(`/api/intake/${linked.id}/attach`, { data: { taskIds: [fixture.task.id], cardIds: [fixture.card.id] } });

    await page.goto(`/#/inbox?intakeId=${linked.id}`);
    await page.getByRole('button', { name: `Task ${fixture.task.id}` }).click();
    await expect(page).toHaveURL(new RegExp(`/#/tasks\\?taskId=${fixture.task.id}$`));
    await expect(page.locator('#task-panel-title')).toHaveText(fixture.task.description);
    await expectNoSeriousA11y(page, '#task-panel');
    await page.locator('#task-panel-close').click();
    await expect(page).toHaveURL(/\/#\/tasks$/);
    await expect(page.locator('#task-panel')).toBeHidden();

    await page.goto(`/#/inbox?intakeId=${linked.id}`);
    await page.getByRole('button', { name: fixture.card.title }).click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}$`));
    await expect(page.locator('#card-panel-title')).toHaveText(fixture.card.title);
    await expectNoSeriousA11y(page, '#card-panel');
    await page.locator('#card-panel-close').click();
    await expect(page).toHaveURL(/\/#\/cards$/);
    await expect(page.locator('#card-panel')).toBeHidden();

    await page.goto(`/#/tasks?taskId=${fixture.task.id}`);
    await page.locator('.task-detail-meta button', { hasText: fixture.card.title }).click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}&taskId=${fixture.task.id}$`));
    await page.locator('#task-panel-close').click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}$`));
    await expect(page.locator('#card-panel')).toBeVisible();

    const dueResponse = await request.post('/api/tasks', {
      data: { description: `Route notification ${fixture.id}`, date: '2026-08-11', status: 'waiting', waitingFor: 'Reply', followUpAt: '2026-08-01T09:00:00.000Z', comment: 'Synthetic notification route evidence' },
    });
    expect(dueResponse.ok()).toBe(true);
    const duePayload = await dueResponse.json();
    const dueTask = duePayload.task || duePayload;
    await page.goto('/#/notifications');
    const notice = page.locator('.work-bell-item', { hasText: dueTask.description });
    await notice.getByRole('button', { name: 'Open task' }).click();
    await expect(page).toHaveURL(new RegExp(`/#/tasks\\?taskId=${dueTask.id}$`));
    await page.locator('#task-panel-close').click();
    await expect(page).toHaveURL(/\/#\/tasks$/);
    await page.goto('/#/notifications');
    await page.locator('#work-bell-close').click();
    await expect(page).toHaveURL(/\/#\/$/);

    await page.goto('/#/');
    await page.locator('#search-input').fill(fixture.assistant.title);
    const assistantResult = page.locator('.unified-search-row.result-assistant-job', { hasText: fixture.assistant.title });
    await expect(assistantResult).toBeVisible();
    await assistantResult.click();
    await expect(page).toHaveURL(new RegExp(`/#/assistants\\?assistantJobId=${fixture.assistant.id}$`));
    await expect(page.locator('.assistant-detail h3')).toHaveText(fixture.assistant.title);
  });

  test('guards desktop and mobile notification navigation while a runtime-template draft is dirty', async ({ page }) => {
    test.setTimeout(60000);
    const cases = [
      { viewport: { width: 1440, height: 900 }, bell: '#work-bell-button', label: 'desktop' },
      { viewport: { width: 390, height: 844 }, bell: '#mobile-work-bell-button', label: 'mobile' },
    ];

    for (const scenario of cases) {
      await page.setViewportSize(scenario.viewport);
      await page.goto('/#/templates');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: 'New runtime template' }).click();
      const draftName = `Dirty notification ${scenario.label} ${suffix()}`;
      await page.getByLabel('Name').fill(draftName);
      await expect(page.locator('[data-template-save-state]')).toHaveText('Unsaved changes');

      const notificationRequests = [];
      const recordNotificationRequest = (request) => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname === '/work/api/notifications') notificationRequests.push(request);
      };
      page.on('request', recordNotificationRequest);
      const bell = page.locator(scenario.bell);
      await bell.click();
      await expect(page.locator('#confirm-modal')).toBeVisible();
      await expect(page.locator('#confirm-cancel')).toBeFocused();
      await expect(page).toHaveURL(/\/#\/templates$/);
      expect(notificationRequests).toHaveLength(0);

      await page.keyboard.press('Enter');
      await expect(page.locator('#confirm-modal')).toBeHidden();
      await expect(page).toHaveURL(/\/#\/templates$/);
      await expect(page.locator('[data-tasks-section="templates"]')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByLabel('Name')).toHaveValue(draftName);
      await expect(page.locator('[data-template-save-state]')).toHaveText('Unsaved changes');
      await expect(bell).toBeFocused();
      expect(notificationRequests).toHaveLength(0);

      const historyLength = await page.evaluate(() => history.length);
      await bell.click();
      await expect(page.locator('#confirm-modal')).toBeVisible();
      await page.locator('#confirm-ok').click();
      await expect(page).toHaveURL(/\/#\/notifications$/);
      await expect(page.locator('#work-bell-panel')).toBeVisible();
      await expect(page.locator('#work-bell-close')).toBeFocused();
      await expect(page.locator('#confirm-modal')).toBeHidden();
      await expect(page.locator('.runtime-template-editor')).toBeHidden();
      await expect.poll(() => notificationRequests.length).toBe(1);
      await page.waitForTimeout(200);
      expect(notificationRequests).toHaveLength(1);
      expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);

      await page.evaluate(() => { window.location.hash = '#/tasks'; });
      await expect(page).toHaveURL(/\/#\/tasks$/);
      await expect(page.locator('#confirm-modal')).toBeHidden();
      await expect(page.locator('#library-title')).toHaveText('Tasks - Work Queue');
      page.off('request', recordNotificationRequest);
    }
  });

  test('keeps desktop and mobile notification counts synchronized across refresh, failure, and retry', async ({ page, request }) => {
    const id = suffix();
    const createDueTask = async (label) => {
      const response = await request.post('/api/tasks', {
        data: {
          description: `${label} ${id}`,
          date: '2026-08-11',
          status: 'waiting',
          waitingFor: 'Synthetic reply',
          followUpAt: '2026-08-01T09:00:00.000Z',
          comment: 'Synthetic notification count evidence',
        },
      });
      expect(response.ok()).toBe(true);
      const payload = await response.json();
      return payload.task || payload;
    };
    const desktopCount = page.locator('#work-bell-button .work-bell-count');
    const mobileCount = page.locator('#mobile-work-bell-button .work-bell-count');

    const initialTask = await createDueTask('Initial count notification');
    await page.goto('/#/notifications');
    const initialItem = page.locator('.work-bell-item', { hasText: initialTask.description });
    await expect(initialItem).toBeVisible();
    const initialNotifications = (await (await request.get('/api/notifications')).json()).notifications;
    await expect(desktopCount).toHaveText(String(initialNotifications.length));
    await expect(mobileCount).toHaveText(String(initialNotifications.length));

    const retryTask = await createDueTask('Retry count notification');
    const refreshedNotifications = (await (await request.get('/api/notifications')).json()).notifications;
    const retryNotification = refreshedNotifications.find((item) => item.taskId === retryTask.id);
    expect(retryNotification).toBeTruthy();
    expect(refreshedNotifications.length).toBe(initialNotifications.length + 1);
    await page.reload();
    const retryItem = page.locator('.work-bell-item', { hasText: retryTask.description });
    await expect(retryItem).toBeVisible();
    await expect(desktopCount).toHaveText(String(refreshedNotifications.length));
    await expect(mobileCount).toHaveText(String(refreshedNotifications.length));

    await setRouteFaults(request, [{
      method: 'PUT',
      path: `/api/notifications/${retryNotification.id}/dismiss`,
      status: 503,
    }]);
    await retryItem.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(retryItem).toBeVisible();
    await expect(retryItem.getByRole('alert')).toContainText('Select Dismiss to retry');
    await expect(retryItem.getByRole('button', { name: /Dismiss notification/ })).toBeFocused();
    await expect(desktopCount).toHaveText(String(refreshedNotifications.length));
    await expect(mobileCount).toHaveText(String(refreshedNotifications.length));
    const afterFailure = (await (await request.get('/api/notifications')).json()).notifications;
    expect(afterFailure.some((item) => item.id === retryNotification.id)).toBe(true);
    await expect(page).toHaveURL(/\/#\/notifications$/);

    await clearRouteFaults(request);
    await retryItem.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(retryItem).toHaveCount(0);
    const afterSuccess = (await (await request.get('/api/notifications')).json()).notifications;
    expect(afterSuccess.some((item) => item.id === retryNotification.id)).toBe(false);
    await expect(desktopCount).toHaveText(String(afterSuccess.length));
    await expect(mobileCount).toHaveText(String(afterSuccess.length));
    await expect(page).toHaveURL(/\/#\/notifications$/);
    await expect(page.locator('#work-bell-panel')).toBeVisible();
  });

  test('labels fresh combined task links from exact route context before a delayed larger snapshot', async ({ page, request }) => {
    test.setTimeout(120000);
    const fixture = await createFixtures(request);
    await Promise.all(Array.from({ length: 12 }, (_, index) => request.post('/api/cards', {
      data: { title: `Larger snapshot workflow ${fixture.id} ${index + 1}`, anchorDate: '2026-08-11' },
    })));
    const route = `/#/tasks?taskId=${encodeURIComponent(fixture.task.id)}&date=2026-08-11&cardId=${encodeURIComponent(fixture.card.id)}&contextCardId=${encodeURIComponent(fixture.contextCard.id)}`;

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto('about:blank');
      await setRouteFaults(request, [
        // Keep the broad snapshot decisively behind exact route hydration even
        // when the complete E2E suite is running under a loaded worker.
        { method: 'GET', path: '/api/cards', delayMs: 20000 },
        { method: 'GET', path: `/api/tasks/${fixture.task.id}`, delayMs: 250 },
      ]);
      let largerSnapshotResolved = false;
      const largerSnapshot = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === '/work/api/cards' && !url.search;
      }).then(() => { largerSnapshotResolved = true; });

      await page.goto(route);
      await expect(page.locator('#task-panel-title')).toHaveText(fixture.task.description);
      await expect(page.locator('.task-panel-route-context')).toContainText(fixture.card.title);
      const workflowLink = page.locator('.task-detail-meta button.task-instruction-doc-link');
      await expect(workflowLink).toHaveText(fixture.card.title);
      await expect(workflowLink).not.toHaveText('—');
      expect(largerSnapshotResolved).toBe(false);
      if (viewport.width < 600) await expectNoHorizontalOverflow(page);

      await largerSnapshot;
      await expect(workflowLink).toHaveText(fixture.card.title);
      await clearRouteFaults(request);
    }

    await page.goto('about:blank');
    await setRouteFaults(request, [{ method: 'GET', path: '/api/cards', delayMs: 900 }]);
    const laterSnapshot = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/work/api/cards' && !url.search;
    });
    await page.goto(`/#/cards?cardId=${fixture.contextCard.id}&taskId=${fixture.task.id}`);
    await expect(page.locator('.entity-route-mismatch')).toContainText(fixture.task.id);
    await laterSnapshot;
    await expect(page.locator('.entity-route-mismatch')).toContainText(fixture.contextCard.id);
    await expect(page.locator('.task-detail-meta button')).toHaveCount(0);
    await clearRouteFaults(request);
  });

  test('keeps runtime-template Back canonical for clean and dirty mobile detail', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    const exactRoute = new RegExp(`/#/templates\\?templateId=${fixture.template.id}$`);
    const templateRow = () => page.locator('.runtime-template-row', { hasText: fixture.template.name });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/templates');
    await templateRow().click();
    await expect(page).toHaveURL(exactRoute);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(fixture.template.name);

    await page.setViewportSize({ width: 390, height: 844 });
    const cleanBack = page.getByRole('button', { name: 'Back to template list' });
    await expect(cleanBack).toBeVisible();
    const cleanHistoryLength = await page.evaluate(() => history.length);
    await cleanBack.click();
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('.runtime-template-list')).toBeVisible();
    await expect(page.locator('.runtime-template-editor')).toBeHidden();
    await expect(page.locator('.runtime-template-search')).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(cleanHistoryLength + 1);

    await page.reload();
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('.runtime-template-list')).toBeVisible();
    await expect(page.locator('.runtime-template-editor')).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(exactRoute);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(fixture.template.name);
    await page.goForward();
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('.runtime-template-list')).toBeVisible();

    await page.goto('/#/templates');
    await templateRow().click();
    await expect(page).toHaveURL(exactRoute);
    const dirtyName = `Dirty Back ${fixture.id}`;
    await page.getByLabel('Name', { exact: true }).fill(dirtyName);
    await expect(page.locator('[data-template-save-state]')).toHaveText('Unsaved changes');
    const dirtyBack = page.getByRole('button', { name: 'Back to template list' });
    const dirtyHistoryLength = await page.evaluate(() => history.length);
    await dirtyBack.click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await expect(page.locator('#confirm-cancel')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(exactRoute);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(dirtyName);
    await expect(page.locator('[data-template-save-state]')).toHaveText('Unsaved changes');
    await expect(dirtyBack).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(dirtyHistoryLength);

    await dirtyBack.click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-ok').click();
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('.runtime-template-list')).toBeVisible();
    await expect(page.locator('.runtime-template-editor')).toBeHidden();
    await expect(page.locator('.runtime-template-search')).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(dirtyHistoryLength + 1);
    await page.reload();
    await expect(page).toHaveURL(/\/#\/templates$/);
    await expect(page.locator('.runtime-template-editor')).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(exactRoute);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(fixture.template.name);
    await expect(page.getByLabel('Name', { exact: true })).not.toHaveValue(dirtyName);
  });

  test('contains task and workflow dialog focus and restores recreated route targets', async ({ page, request }) => {
    const id = suffix();
    const card = (await (await request.post('/api/cards', {
      data: { title: `Focus workflow ${id}`, anchorDate: '1900-01-01' },
    })).json()).card;
    const task = await (await request.post('/api/tasks', {
      data: { description: `Focus task ${id}`, date: berlinToday(), cardId: card.id },
    })).json();
    const fixture = { card, task };

    const filteredTasksRoute = new RegExp(`/#/tasks\\?cardId=${fixture.card.id}$`);
    await page.goto(`/#/tasks?cardId=${fixture.card.id}`);
    const taskRow = page.locator(`.ops-queue-row[data-task-id="${fixture.task.id}"]`).first();
    await expect(taskRow).toBeVisible();
    await taskRow.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/#/tasks\\?taskId=${fixture.task.id}&cardId=${fixture.card.id}$`));
    await expect(page.locator('#task-panel-title')).toHaveText(fixture.task.description);
    await expect(page.locator('#task-panel-close')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('#task-panel [role="dialog"]').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('#task-panel-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(filteredTasksRoute);
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(taskRow).toBeFocused();

    await page.goto('/#/tasks?taskId=keyboard-missing-task');
    await expect(page.locator('#task-panel .entity-route-not-found')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/#\/tasks$/);
    await expect(page.locator('#library-title')).toHaveText('Tasks - Work Queue');
    await expect(page.locator('#library-title')).toBeFocused();

    await page.goto('/#/cards');
    const workflowCard = page.locator('.ops-workflow-card[data-card-id]').first();
    await expect(workflowCard).toBeVisible();
    const visibleWorkflowId = await workflowCard.getAttribute('data-card-id');
    const visibleWorkflowTitle = await workflowCard.locator('strong').textContent();
    await workflowCard.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${visibleWorkflowId}$`));
    await expect(page.locator('#card-panel-title')).toHaveText(visibleWorkflowTitle);
    await expect(page.locator('#card-panel-close')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('#card-panel').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('#card-panel-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/#\/cards$/);
    await expect(page.locator('#card-panel')).toBeHidden();
    await expect(workflowCard).toBeFocused();

    await page.goto(`/#/cards?cardId=${fixture.card.id}`);
    await expect(page.locator('#card-panel-title')).toHaveText(fixture.card.title);
    const fixtureCard = page.locator(`.ops-workflow-card[data-card-id="${fixture.card.id}"]`);
    const fixtureCardWasVisible = await fixtureCard.isVisible().catch(() => false);
    const workflowTaskRow = page.locator(`.card-checklist-label[data-task-id="${fixture.task.id}"]`);
    await workflowTaskRow.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}&taskId=${fixture.task.id}$`));
    await expect(page.locator('#task-panel-close')).toBeFocused();
    await expectNoSeriousA11y(page, '#task-panel');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.querySelector('#task-panel [role="dialog"]').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.querySelector('#task-panel [role="dialog"]').contains(document.activeElement))).toBe(true);
    await page.locator('#task-panel-close').click();
    await expect(page).toHaveURL(new RegExp(`/#/cards\\?cardId=${fixture.card.id}$`));
    await expect(page.locator('#task-panel')).toBeHidden();
    await expect(page.locator('#card-panel')).toBeVisible();
    await expect(workflowTaskRow).toBeFocused();
    await page.locator('#card-panel-close').click();
    await expect(page).toHaveURL(/\/#\/cards$/);
    if (fixtureCardWasVisible) await expect(fixtureCard).toBeFocused();
    else await expect(page.locator('#library-title')).toBeFocused();

    await page.goto('/#/cards?cardId=keyboard-missing-workflow');
    await expect(page.locator('#card-panel .entity-route-not-found')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/#\/cards$/);
    await expect(page.locator('#library-title')).toHaveText('Tasks - Cards');
    await expect(page.locator('#library-title')).toBeFocused();
  });

  test('ignores stale real-server entity responses after a newer navigation', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    await page.goto('/#/');
    await expect(page.locator('#library-title')).toHaveText('Home');
    await setRouteFaults(request, [{ method: 'GET', path: `/api/cards/${fixture.card.id}`, delayMs: 900 }]);
    const started = page.waitForRequest((req) => new URL(req.url()).pathname.endsWith(`/api/cards/${fixture.card.id}`));
    await page.evaluate((cardId) => { window.location.hash = `#/cards?cardId=${cardId}`; }, fixture.card.id);
    await started;
    await page.evaluate((assistantId) => { window.location.hash = `#/assistants?assistantJobId=${assistantId}`; }, fixture.assistant.id);
    await expect(page).toHaveURL(new RegExp(`/#/assistants\\?assistantJobId=${fixture.assistant.id}$`));
    await expect(page.locator('.assistant-detail h3')).toHaveText(fixture.assistant.title);
    await page.waitForTimeout(1100);
    await expect(page.locator('#card-panel')).toBeHidden();
    await expect(page.locator('#library-title')).toHaveText('Tasks - Assistants');
    await expect(page.locator('.assistant-detail h3')).toHaveText(fixture.assistant.title);
    await clearRouteFaults(request);
  });

  test('provides mobile Inbox, dismissal, recurring delete, sign-out, a11y, and exact screenshot evidence', async ({ page, request }) => {
    const fixture = await createFixtures(request);
    const createStateIntake = async (label) => (await (await request.post('/api/intake', {
      data: { source: 'manual', title: `${label} ${fixture.id}`, note: `Synthetic ${label.toLowerCase()} context`, dataClass: 'internal' },
    })).json()).item;
    const triaged = await createStateIntake('Triaged intake');
    await request.put(`/api/intake/${triaged.id}`, { data: { status: 'triaged' } });
    const attached = await createStateIntake('Attached intake');
    await request.post(`/api/intake/${attached.id}/attach`, { data: { taskIds: [fixture.task.id], cardIds: [fixture.card.id] } });
    const convertedSource = await createStateIntake('Converted intake');
    const converted = (await (await request.post(`/api/intake/${convertedSource.id}/convert-task`, {
      data: { date: '2026-08-11', cardId: fixture.card.id },
    })).json()).item;
    const assistantReadySource = await createStateIntake('Assistant-ready intake');
    const assistantReady = (await (await request.post(`/api/intake/${assistantReadySource.id}/prepare-assistant`, {
      data: { assistantType: 'podcast', createJob: false },
    })).json()).item;
    const resolvedSource = await createStateIntake('Resolved intake');
    const resolved = (await (await request.post(`/api/intake/${resolvedSource.id}/ignore`, {
      data: { reason: 'Synthetic resolved-state evidence' },
    })).json()).item;
    const futureBlockedSource = await createStateIntake('Future blocked intake');
    const futureBlocked = (await (await request.post(`/api/intake/${futureBlockedSource.id}/block`, {
      data: { reason: 'Future synthetic wait', waitingFor: 'Synthetic partner', followUpAt: '2026-09-01T09:00:00.000Z' },
    })).json()).item;
    const dueResponse = await request.post('/api/tasks', {
      data: { description: `Dismiss notification ${fixture.id}`, date: '2026-08-11', status: 'waiting', waitingFor: 'Synthetic reply', followUpAt: '2026-08-01T09:00:00.000Z', comment: 'Synthetic notification evidence' },
    });
    expect(dueResponse.ok()).toBe(true);
    const duePayload = await dueResponse.json();
    const dueTask = duePayload.task || duePayload;
    const notifications = (await (await request.get('/api/notifications')).json()).notifications;
    const notification = notifications.find((item) => item.taskId === dueTask.id);
    expect(notification).toBeTruthy();

    const recurring = (await (await request.post('/api/recurring', {
      data: { description: `Referenced recurring ${fixture.id}`, cronExpression: '0 9 * * *' },
    })).json()).recurringConfig;
    await request.post('/api/recurring/generate', { data: { startDate: '2026-08-11', endDate: '2026-08-11' } });
    const removableRecurring = (await (await request.post('/api/recurring', {
      data: { description: `Removable recurring ${fixture.id}`, cronExpression: '0 8 * * *' },
    })).json()).recurringConfig;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/#/tasks?taskId=${fixture.task.id}&date=2026-08-11&cardId=${fixture.card.id}&contextCardId=${fixture.contextCard.id}`);
    await expect(page.locator('#task-panel-title')).toHaveText(fixture.task.description);
    await expectNoSeriousA11y(page, '#task-panel');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-task-combined-context-1440x900.png'), fullPage: true });
    await page.goto('/#/tasks?taskId=missing-for-shot');
    await expectNoSeriousA11y(page, '#task-panel');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-entity-not-found-1440x900.png'), fullPage: true });
    await page.goto(`/#/inbox?intakeId=${fixture.blocked.id}`);
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toHaveText('Record follow-up sent');
    await expect(page.locator('time[datetime]')).toHaveCount(3);
    await expectNoSeriousA11y(page, '.ops-inbox');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-inbox-blocked-actions-history-1440x900.png'), fullPage: true });
    await page.locator('#settings-button').click();
    await expect(page.getByRole('button', { name: /^Sign out/ })).toBeVisible();
    await expectNoSeriousA11y(page, '#settings-menu');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-settings-sign-out-1440x900.png'), fullPage: true });
    await page.locator('#settings-menu-close').click();
    await page.goto('/#/notifications');
    const notificationItem = page.locator('.work-bell-item', { hasText: dueTask.description });
    await expect(notificationItem.getByRole('button', { name: /Dismiss notification/ })).toBeVisible();
    await expectNoSeriousA11y(page, '#work-bell-panel');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-notification-dismiss-1440x900.png'), fullPage: true });
    await notificationItem.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(notificationItem).toHaveCount(0);
    const apiAfterDismiss = await (await request.get('/api/notifications')).json();
    expect(apiAfterDismiss.notifications.some((item) => item.id === notification.id)).toBe(false);

    await page.goto('/#/recurring');
    const removableRow = page.locator('.ops-recurring-item', { hasText: removableRecurring.description });
    await removableRow.getByRole('button', { name: /Delete recurring schedule/ }).click();
    await expect(page.locator('#confirm-message')).toContainText('removes only the schedule');
    await page.locator('#confirm-ok').click();
    await expect(removableRow).toHaveCount(0);
    const recurringRow = page.locator('.ops-recurring-item', { hasText: recurring.description });
    await recurringRow.getByRole('button', { name: /Delete recurring schedule/ }).click();
    await expect(page.locator('#confirm-message')).toContainText('removes only the schedule');
    await page.locator('#confirm-ok').click();
    await expect(recurringRow.locator('[role="alert"]')).toContainText('Pause it instead');
    await page.screenshot({ path: path.join(SHOTS, 'desktop-recurring-delete-guidance-1440x900.png'), fullPage: true });
    await expectNoSeriousA11y(page, '.ops-recurring-section');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/tasks?taskId=${fixture.task.id}&date=2026-08-11&cardId=${fixture.card.id}&contextCardId=${fixture.contextCard.id}`);
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '#task-panel');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-task-combined-context-390x844.png') });
    await page.goto('/#/tasks?taskId=missing-mobile-shot');
    await expectNoSeriousA11y(page, '#task-panel');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-entity-not-found-390x844.png') });
    await page.goto(`/#/inbox?intakeId=${fixture.intake.id}`);
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toHaveText('Convert to task');
    await expect(page.locator('.intake-detail h3')).toBeInViewport();
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '.ops-inbox');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-inbox-new-primary-390x844.png') });
    await page.goto(`/#/inbox?intakeId=${triaged.id}`);
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toHaveText('Convert to task');
    await page.goto(`/#/inbox?intakeId=${futureBlocked.id}`);
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toHaveText('Record response received');
    await page.goto(`/#/inbox?intakeId=${attached.id}`);
    await expect(page.getByRole('button', { name: 'Continue task' })).toBeVisible();
    await page.goto(`/#/inbox?intakeId=${converted.id}`);
    await expect(page.getByRole('button', { name: 'Continue task' })).toBeVisible();
    await page.goto(`/#/inbox?intakeId=${assistantReady.id}`);
    await expect(page.locator('.intake-action-disclosure.is-primary > summary')).toHaveText('Create assistant draft');
    await page.goto(`/#/inbox?intakeId=${resolved.id}`);
    await expect(page.locator('.intake-resolution-summary')).toContainText('read-only');
    await expect(page.locator('[data-intake-submit]')).toHaveCount(0);
    await page.goto(`/#/inbox?intakeId=${fixture.blocked.id}`);
    await page.locator('.intake-action-disclosure.is-primary > summary').click();
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '.ops-inbox');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-inbox-blocked-follow-up-history-390x844.png') });
    await page.locator('#mobile-settings-button').click();
    await expectNoSeriousA11y(page, '#settings-menu');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-settings-sign-out-390x844.png') });
    await page.locator('#settings-menu-close').click();
    await page.goto('/#/notifications');
    await expectNoSeriousA11y(page, '#work-bell-panel');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-notification-dismiss-390x844.png') });
    await page.goto('/#/recurring');
    await expect(page.locator('.recurring-delete-guidance')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, 'mobile-recurring-delete-guidance-390x844.png') });
    await expectNoHorizontalOverflow(page);
    await expectNoSeriousA11y(page, '.ops-recurring-section');

    let logoutSeen = false;
    page.on('request', (req) => { if (new URL(req.url()).pathname === '/logout') logoutSeen = true; });
    await page.locator('#mobile-settings-button').click();
    await page.getByRole('button', { name: /^Sign out/ }).click();
    await page.waitForURL(/\/logout$/);
    expect(logoutSeen).toBe(true);
  });
});
