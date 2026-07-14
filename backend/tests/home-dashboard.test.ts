import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';

describe('Home dashboard (issue #26)', () => {
  after(async () => {
    await stopLocal();
  });

  describe('HTML/CSS for dashboard layout', () => {
    it('index.html contains dashboard-layout CSS class', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('.dashboard-layout'), 'should have dashboard-layout CSS');
    });

    it('index.html contains dashboard-left and dashboard-right CSS classes', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.dashboard-left'), 'should have dashboard-left CSS');
      assert.ok(result.body.includes('.dashboard-right'), 'should have dashboard-right CSS');
    });

    it('index.html contains notification-bar CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.notification-bar'), 'should have notification-bar CSS');
      assert.ok(result.body.includes('.notification-item'), 'should have notification-item CSS');
    });

    it('index.html contains bundle-group-heading CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-group-heading'), 'should have bundle-group-heading CSS');
    });

    it('index.html contains dashboard-bundle-card CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.dashboard-bundle-card'), 'should have dashboard-bundle-card CSS');
    });

    it('index.html contains Templates-library "Start workflow" form CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.template-start-action'), 'should have Start-workflow action CSS');
      assert.ok(result.body.includes('.template-start-form'), 'should have inline start form CSS');
      assert.ok(result.body.includes('.template-start-btn'), 'should have start button CSS');
    });

    it('index.html contains badge-anchor-date CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-anchor-date'), 'should have badge-anchor-date CSS');
    });

    it('index.html contains badge-stage CSS with color variants', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-stage'), 'should have badge-stage CSS');
      assert.ok(result.body.includes('.badge-stage.preparation'), 'should have preparation stage style');
      assert.ok(result.body.includes('.badge-stage.announced'), 'should have announced stage style');
      assert.ok(result.body.includes('.badge-stage.after-event'), 'should have after-event stage style');
      assert.ok(result.body.includes('.badge-stage.done'), 'should have done stage style');
    });

    it('index.html contains waiting follow-up badge CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.badge-waiting'), 'should have waiting follow-up badge style');
    });

    it('index.html contains dashboard task action CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.task-action-group'), 'should have task action group style');
      assert.ok(result.body.includes('.follow-up-next-date'), 'should have next follow-up date input style');
    });

    it('index.html contains assigned-toggle CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.assigned-toggle'), 'should have assigned-toggle CSS');
    });

    it('index.html contains responsive media query for dashboard', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('@media (max-width: 900px)'), 'should have responsive breakpoint');
    });

    it('index.html has Home nav link', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('href="#/"') && result.body.includes('Home'), 'should have Home nav link');
    });

    it('index.html contains dashboard-wide CSS class', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('#app.dashboard-wide'), 'should have dashboard-wide CSS');
    });

    it('index.html constrains dashboard queue overflow', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('#dashboard-tasks'), 'should target dashboard task queue');
      assert.ok(result.body.includes('#dashboard-tasks .task-table-compact thead tr'), 'should size dashboard queue header columns explicitly');
      assert.ok(result.body.includes('grid-template-columns: 34px'), 'should keep dense queue rows in stable grid columns');
      assert.ok(result.body.includes('#dashboard-tasks .task-table-compact tbody tr[data-task-row]'), 'should size dashboard queue body rows explicitly');
      assert.ok(result.body.includes('#dashboard-tasks .task-table-compact tbody tr[data-task-row],'), 'should reset queue rows for mobile card layout');
    });
  });

  describe('app.js dashboard route and logic', () => {
    it('app.js contains #/ route mapping to renderDashboard', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes("'#/': renderDashboard"), 'should map #/ to renderDashboard');
    });

    it('app.js defaults to #/ route (not #/tasks)', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("location.hash = '#/'"), 'default route should be #/');
    });

    it('app.js contains renderDashboard function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function renderDashboard'), 'should have renderDashboard function');
    });

    it('app.js contains loadDashboardBundles function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function loadDashboardBundles'), 'should have loadDashboardBundles');
    });

    it('app.js contains loadDashboardTasks function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function loadDashboardTasks'), 'should have loadDashboardTasks');
    });

    it('app.js loads due waiting tasks into the dashboard task table', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("api.tasks.list({ status: 'waiting' })"), 'should load waiting tasks');
      assert.ok(result.body.includes('isDueFollowUpTask'), 'should filter due follow-ups');
      assert.ok(result.body.includes('badge-waiting'), 'should render waiting badge');
    });

    it('app.js renders follow-up action controls on waiting dashboard tasks', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('renderDashboardTaskActions'), 'should render dashboard task actions');
      assert.ok(result.body.includes('response-received'), 'should support marking response received');
      assert.ok(result.body.includes('follow-up-sent'), 'should support recording sent follow-up');
      assert.ok(result.body.includes('resolve-done'), 'should support resolving waiting tasks as done');
      assert.ok(result.body.includes('follow-up-channel'), 'should include follow-up channel control');
      assert.ok(result.body.includes('follow-up-note'), 'should include follow-up note control');
      assert.ok(result.body.includes('follow-up-next-date'), 'should include next follow-up date input');
      assert.ok(result.body.includes('taskHistory'), 'should render structured task history');
    });

    it('app.js contains refreshBellBadge function (replaces loadNotifications)', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function refreshBellBadge'), 'should have refreshBellBadge');
    });

    it('app.js contains assigned-to-me toggle logic', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('assigned-to-me'), 'should have assigned-to-me toggle element');
      assert.ok(result.body.includes('dashboardState.assignedToMe'), 'should reference assignedToMe state');
    });

    it('app.js contains dashboardState with default user', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('dashboardState'), 'should have dashboardState');
      assert.ok(result.body.includes('assignedToMe: true'), 'assignedToMe should default to true');
      assert.ok(result.body.includes('currentUserId'), 'should have currentUserId field set from logged-in user');
    });

    it('app.js resets assigned-to-me when current user is missing from loaded users', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('if (dashboardState.currentUserId && !usersMap[dashboardState.currentUserId])'), 'should detect missing current user');
      assert.ok(result.body.includes("dashboardState.currentUserId = '';"), 'should clear missing current user id');
      assert.ok(result.body.includes('dashboardState.assignedToMe = false;'), 'should turn off assigned-to-me filtering');
      assert.ok(result.body.includes("document.getElementById('assigned-to-me')"), 'should find assigned-to-me checkbox');
      assert.ok(result.body.includes('if (toggle) toggle.checked = false;'), 'should uncheck assigned-to-me checkbox');
      assert.ok(result.body.includes("allOpt.textContent = 'All operators';"), 'should include All operators option');
      assert.ok(result.body.includes('allOpt.selected = !dashboardState.currentUserId;'), 'should select All operators with no current user');
    });

    it('app.js only applies assigned-to-me filtering for known users and keeps unassigned rows', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('if (dashboardState.assignedToMe && dashboardState.currentUserId && usersMap[dashboardState.currentUserId])'), 'should guard assigned-to-me filtering by usersMap membership');
      assert.ok(result.body.includes('return !t.assigneeId || t.assigneeId === dashboardState.currentUserId;'), 'should include unassigned tasks in assigned-to-me view');
      assert.ok(result.body.includes('return !item.assigneeId || item.assigneeId === dashboardState.currentUserId;'), 'should include unassigned intake items in assigned-to-me view');
    });

    it('app.js filters active bundles client-side', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("b.status === 'active'"), 'should filter bundles by active status');
    });

    it('app.js dashboard no-active-work state links to the Templates library instead of hosting start-forms', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('renderDashboardFirstRunState'), 'should render dashboard first-run state');
      assert.ok(result.body.includes('No active production work yet'), 'should distinguish clean production runtime copy');
      assert.ok(result.body.includes('dashboard-no-active-work'), 'should expose the no-active-work empty state hook');
      assert.ok(result.body.includes('Start a workflow from the Templates library'), 'should CTA to the Templates library');
      assert.ok(result.body.includes("href: '#/templates'"), 'should link to the Templates library');
      // The scattered per-template start-forms must be gone from the dashboard.
      assert.ok(!result.body.includes('renderFirstRunWorkflowCard'), 'should not render per-template start-form cards');
      assert.ok(!result.body.includes("'first-run-start-' + type"), 'should not expose per-template start button hooks');
    });

    it('app.js Templates library exposes a "Start workflow" action that reuses api.bundles.create', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('buildTemplateStartForm'), 'should build a Templates-library start form');
      assert.ok(result.body.includes('template-start-action'), 'should expose the Start-workflow action hook');
      assert.ok(result.body.includes("triggerType === 'manual' && taskCount > 0"), 'should only start manual templates with tasks');
      assert.ok(result.body.includes('api.bundles.create({'), 'should use existing bundle creation semantics');
      assert.ok(result.body.includes('templateId: template.id'), 'should start workflows from the selected template');
      assert.ok(result.body.includes('location.hash = bundleHash(currentBundleId)'), 'should navigate to the created workflow');
    });

    it('app.js renders useful copy when no workflow templates are available', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('No workflow templates available'), 'should distinguish missing templates');
      assert.ok(result.body.includes('first-run-no-templates'), 'should expose missing-template empty state hook');
    });

    it('app.js groups bundles by templateId', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('b.templateId'), 'should reference templateId for grouping');
      assert.ok(result.body.includes("'__other__'"), 'should have Other group for bundles without templateId');
    });

    it('app.js renders stage badge in dashboard bundle cards', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('badge-stage'), 'should render stage badge');
    });

    it('app.js renders anchor date badge in dashboard bundle cards', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('badge-anchor-date'), 'should render anchor date badge');
    });

    it('app.js renders progress badge in dashboard bundle cards', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('progress-badge'), 'should render progress badge');
    });

    it('app.js renders workflow risk context on dashboard bundle cards', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('bundleRiskSummary'), 'should calculate bundle risk summary');
      assert.ok(result.body.includes('dashboard-bundle-risk'), 'should render bundle risk badges');
      assert.ok(result.body.includes('Missing evidence'), 'should surface missing evidence context');
    });

    it('app.js groups daily queue tasks and labels generated work sources', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('taskPrimaryQueueGroup'), 'should assign queue groups');
      assert.ok(result.body.includes('dashboard-queue-group'), 'should render queue group rows');
      // The four core operator questions lead the queue as explicit, labelled
      // sections in priority order, each with an empty state (#105).
      assert.ok(result.body.includes("{ group: 'Today', empty: 'Nothing due today' }"), 'should lead with a Today section');
      assert.ok(result.body.includes("{ group: 'Overdue', empty: 'No overdue tasks' }"), 'should include an Overdue section');
      assert.ok(result.body.includes("{ group: 'Follow-ups due', empty: 'No follow-ups due' }"), 'should include a Follow-ups due section with empty state');
      assert.ok(result.body.includes("{ group: 'At-risk workflows', empty: 'No at-risk workflows' }"), 'should include an At-risk workflows section');
      assert.ok(result.body.includes('dashboard-queue-empty'), 'should render empty-state rows for empty core sections');
      assert.ok(result.body.includes('badge-recurring'), 'should label recurring tasks');
      assert.ok(result.body.includes('badge-template-source'), 'should label template-generated tasks');
    });

    it('app.js dashboard bundle cards navigate to exact bundle context on click', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      // In loadDashboardBundles, clicking sets currentBundleId and navigates
      assert.ok(result.body.includes('location.hash = bundleHash(currentBundleId)'), 'should navigate to exact bundle context on card click');
    });

    it('app.js dashboard tasks has checkbox disabled for required link', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('renderDashboardTaskTable'), 'should have renderDashboardTaskTable function');
    });

    it('app.js renders user picker dropdown on dashboard', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('dashboard-user-picker'), 'should have user picker on dashboard');
    });

    it('app.js adds dashboard-wide class for wider layout', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('dashboard-wide'), 'should add dashboard-wide class');
    });

    it('app.js contains bundleSortMode in dashboardState defaulting to date', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("bundleSortMode: 'date'"), 'bundleSortMode should default to date');
    });

    it('app.js contains bundle-sort-control data-testid', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('bundle-sort-control'), 'should have bundle-sort-control element');
      assert.ok(result.body.includes('sort-btn-date'), 'should have sort-btn-date testid');
      assert.ok(result.body.includes('sort-btn-stage'), 'should have sort-btn-stage testid');
      assert.ok(result.body.includes('sort-btn-template'), 'should have sort-btn-template testid');
    });

    it('app.js contains renderBundlesDate function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function renderBundlesDate'), 'should have renderBundlesDate function');
    });

    it('app.js contains renderBundlesStage function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function renderBundlesStage'), 'should have renderBundlesStage function');
    });

    it('app.js contains renderBundlesTemplate function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function renderBundlesTemplate'), 'should have renderBundlesTemplate function');
    });

    it('app.js STAGE_ORDER includes all four stages', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("'preparation'"), 'should include preparation stage');
      assert.ok(result.body.includes("'announced'"), 'should include announced stage');
      assert.ok(result.body.includes("'after-event'"), 'should include after-event stage');
      assert.ok(result.body.includes("'done'"), 'should include done stage');
    });

    it('app.js STAGE_LABELS maps after-event to After Event', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("'After Event'"), 'should have After Event label');
    });
  });

  describe('index.html bundle sort control CSS (issue #32)', () => {
    it('index.html contains .bundle-sort-control CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-sort-control'), 'should have .bundle-sort-control CSS');
    });

    it('index.html contains .bundle-sort-btn CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-sort-btn'), 'should have .bundle-sort-btn CSS');
    });

    it('index.html contains .bundle-sort-btn.active CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.bundle-sort-btn.active'), 'should have .bundle-sort-btn.active CSS');
    });
  });

  describe('api.js notifications namespace', () => {
    it('api.js contains notifications namespace with list and dismiss', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      assert.ok(result.body.includes('notifications:'), 'should have notifications namespace');
      assert.ok(result.body.includes('/api/notifications'), 'should call /api/notifications');
    });

    it('api.js notifications.dismiss calls PUT with /dismiss suffix', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('/dismiss'), 'should include dismiss endpoint');
      assert.ok(result.body.includes("method: 'PUT'"), 'should use PUT method for dismiss');
    });

    it('api.js contains listAll function calling ?all=true', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('listAll'), 'should have listAll function');
      assert.ok(result.body.includes('all=true'), 'listAll should use ?all=true');
    });

    it('api.js contains dismissAll function', async () => {
      const event = { httpMethod: 'GET', path: '/public/api.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('dismissAll'), 'should have dismissAll function');
      assert.ok(result.body.includes('dismiss-all'), 'dismissAll should call /dismiss-all');
    });
  });

  describe('Notifications API (backend)', () => {
    it('GET /api/notifications returns 200 with notifications array', async () => {
      const event = { httpMethod: 'GET', path: '/api/notifications' };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(Array.isArray(body.notifications), 'should return notifications array');
    });

    it('GET /api/notifications creates due follow-up reminders for waiting tasks', async () => {
      const createResult = await handler({
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({
          description: 'Follow up with venue from notifications route',
          date: '2099-04-01',
          status: 'waiting',
          waitingFor: 'Venue team',
          followUpAt: '2001-01-01T09:00:00.000Z',
          comment: 'Waiting for venue team',
        }),
      }, {});
      assert.strictEqual(createResult.statusCode, 201);
      const task = JSON.parse(createResult.body);

      const result = await handler({ httpMethod: 'GET', path: '/api/notifications' }, {});
      assert.strictEqual(result.statusCode, 200);
      const body = JSON.parse(result.body);
      const reminder = body.notifications.find((n: any) => n.taskId === task.id && n.type === 'follow-up-due');

      assert.ok(reminder, 'should include generated follow-up reminder');
      assert.strictEqual(reminder.dueAt, '2001-01-01T09:00:00.000Z');
      assert.ok(reminder.message.includes('Follow up with venue from notifications route'));
      assert.ok(reminder.message.includes('Venue team'));
    });

    it('GET /api/notifications?all=true returns 200 with notifications array', async () => {
      const event = {
        httpMethod: 'GET',
        path: '/api/notifications',
        queryStringParameters: { all: 'true' },
      };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(Array.isArray(body.notifications), 'should return notifications array');
    });

    it('PUT /api/notifications/dismiss-all returns 200 with count', async () => {
      const event = {
        httpMethod: 'PUT',
        path: '/api/notifications/dismiss-all',
        body: '{}',
      };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.ok(typeof body.count === 'number', 'should return count number');
    });

    it('PUT /api/notifications/nonexistent/dismiss returns 404', async () => {
      const event = {
        httpMethod: 'PUT',
        path: '/api/notifications/nonexistent-id/dismiss',
        body: '{}',
      };
      const result = await handler(event, {});
      assert.strictEqual(result.statusCode, 404);
    });
  });

  describe('Bell icon and notifications view (index.html + app.js)', () => {
    it('index.html contains notif-bell-wrapper element', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('notif-bell-wrapper'), 'should have notif-bell-wrapper');
    });

    it('index.html contains notif-bell element with id', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('id="notif-bell"'), 'should have notif-bell id');
    });

    it('index.html contains notif-badge element', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('notif-badge'), 'should have notif-badge element');
    });

    it('index.html contains notif-dropdown CSS', async () => {
      const event = { httpMethod: 'GET', path: '/' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('.notif-dropdown'), 'should have notif-dropdown CSS');
    });

    it('app.js contains #/notifications route', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("'#/notifications': renderNotifications"), 'should have notifications route');
    });

    it('app.js contains renderNotifications function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function renderNotifications'), 'should have renderNotifications');
    });

    it('app.js contains refreshBellBadge function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function refreshBellBadge'), 'should have refreshBellBadge');
    });

    it('app.js contains initBell function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function initBell'), 'should have initBell');
    });

    it('app.js contains formatRelativeTime function', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes('function formatRelativeTime'), 'should have formatRelativeTime');
    });

    it('app.js does not render #notification-bar in dashboard', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(!result.body.includes("'notification-bar'"), 'should not have notification-bar in app.js');
    });
  });
});
