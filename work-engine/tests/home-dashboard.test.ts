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

    it('app.js filters active bundles client-side', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      assert.ok(result.body.includes("b.status === 'active'"), 'should filter bundles by active status');
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

    it('app.js dashboard bundle cards navigate to #/bundles on click', async () => {
      const event = { httpMethod: 'GET', path: '/public/app.js' };
      const result = await handler(event, {});
      // In loadDashboardBundles, clicking sets currentBundleId and navigates
      assert.ok(result.body.includes("location.hash = '#/bundles'"), 'should navigate to #/bundles on card click');
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
