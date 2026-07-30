const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3016;
const BASE_URL = `http://127.0.0.1:${PORT}`;
let child;

const waitForPortal = () => new Promise((resolve, reject) => {
  const deadline = Date.now() + 30_000;
  (function poll() {
    const request = http.get(`${BASE_URL}/api/health`, (response) => {
      response.resume();
      resolve();
    });
    request.on('error', () => (
      Date.now() > deadline
        ? reject(new Error('portal timeout'))
        : setTimeout(poll, 200)
    ));
  }());
});

test.describe('production sponsor CRM communications portal', () => {
  test.beforeAll(async () => {
    child = spawn('npx', ['tsx', 'scripts/test-server.ts'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'true',
        DATAOPS_DOCS_DOMAIN: '1',
        DTC_OFFLINE: '1',
        FRONTEND_ROOT: path.resolve(__dirname, '..', '..', 'frontend'),
        PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    await waitForPortal();
  });

  test.afterAll(() => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  });

  test('supports the two-role exact-review journey and safe review cleanup', async ({ browser }) => {
    test.setTimeout(120_000);
    const organization = { id: 'org-1', displayName: 'Synthetic Sponsor', version: 1 };
    const contact = {
      id: 'contact-1',
      organizationId: 'org-1',
      name: 'Synthetic Contact',
      emails: ['recipient@example.invalid'],
      primary: true,
      active: true,
      version: 1,
    };
    const alternateContact = {
      id: 'contact-2',
      organizationId: 'org-1',
      name: 'Alternate Contact',
      emails: ['Alternate@Example.invalid'],
      active: true,
      version: 1,
    };
    const booking = {
      id: 'booking-1',
      organizationId: 'org-1',
      primaryContactId: 'contact-1',
      slotType: 'main',
      status: 'confirmed',
      plannedPublicationDate: '2026-08-20',
      materialDeadline: '2026-08-10',
      nextActionDate: '2026-08-01',
      bundleId: 'newsletter-bundle-1',
      version: 2,
    };
    const suggestion = {
      id: 'suggestion-1',
      recordType: 'communication-suggestion',
      communicationType: 'booking-confirmation',
      status: 'open',
      safeReason: 'Booking confirmed with an active recipient',
    };
    const attempts = [
      { id: 'attempt-queued-control', recordType: 'sponsor-send-attempt', status: 'queued', derivedStatus: 'queued' },
      { id: 'attempt-accepted', recordType: 'sponsor-send-attempt', status: 'accepted', derivedStatus: 'accepted' },
      { id: 'attempt-delayed', recordType: 'sponsor-send-attempt', status: 'accepted', derivedStatus: 'delayed' },
      { id: 'attempt-rejected', recordType: 'sponsor-send-attempt', status: 'provider_observed', derivedStatus: 'rejected' },
      { id: 'attempt-delivered', recordType: 'sponsor-send-attempt', status: 'provider_observed', derivedStatus: 'delivered' },
      { id: 'attempt-pending', recordType: 'sponsor-send-attempt', status: 'executing', derivedStatus: 'pending_event' },
      { id: 'attempt-unknown', recordType: 'sponsor-send-attempt', status: 'outcome_unknown', derivedStatus: 'outcome_unknown' },
    ];
    const drafts = [];
    const presentations = new Map();
    const presentationCalls = { operator: 0, admin: 0 };
    let nextPresentation = 1;
    let failNextRevoke = false;
    let failNextApprove = false;
    let suppressedRequest = null;

    const preview = {
      from: 'sender@example.invalid',
      replyTo: 'reply@example.invalid',
      to: 'recipient@example.invalid',
      communicationType: 'booking-confirmation',
      subject: 'Exact operator-authored subject',
      body: 'Exact operator-authored private body.\nSecond line.',
      publicLinks: ['https://example.invalid/public'],
    };

    const routeRole = async (page, role) => {
      await page.route('**/work/api/notifications', (route) =>
        route.fulfill({
          json: {
            notifications: [{
              id: 'alert-1',
              message: 'Sponsor booking materials are missing 10 days before publication',
              dueAt: '2026-08-20',
              dismissed: false,
              metadata: { sponsorBookingId: 'booking-1' },
            }],
          },
        }));
      await page.route('**/work/api/sponsor-crm/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if (pathname.endsWith('/organizations')) return route.fulfill({ json: { items: [organization] } });
        if (pathname.endsWith('/contacts')) return route.fulfill({ json: { items: [contact, alternateContact] } });
        if (pathname.endsWith('/bookings')) return route.fulfill({ json: { items: [booking] } });
        if (pathname.endsWith('/bookings/booking-1/history')) {
          return route.fulfill({
            json: {
              items: [{
                id: 'history-1',
                oldStatus: 'inquiry',
                newStatus: 'confirmed',
                actorId: 'operator-1',
                createdAt: '2026-07-01T00:00:00Z',
              }],
            },
          });
        }
        if (pathname.endsWith('/bookings/booking-1/communications')) {
          const permissions = {
            role,
            canApprove: role === 'admin',
            canCancel: role === 'admin',
            canReconcile: role === 'admin',
          };
          const draftDtos = drafts.map((draft) => ({
            id: `suggestion-1#${draft.version}`,
            recordType: 'communication-draft-version',
            communicationId: 'suggestion-1',
            bookingId: 'booking-1',
            suggestionId: 'suggestion-1',
            version: draft.version,
            reviewState: draft.claimed ? 'claimed' : 'awaiting_review',
            reviewable: !draft.claimed,
            createdAt: draft.createdAt,
          }));
          const pageTwo = url.searchParams.get('cursor') === 'safe-page-2';
          return route.fulfill({
            json: {
              config: {
                configured: true,
                enabled: true,
                generation: 1,
                hmacActiveVersion: 'v1',
                hmacAcceptedVersions: ['v1'],
              },
              permissions,
              items: pageTwo
                ? [...draftDtos, ...attempts.slice(3)]
                : [suggestion, ...attempts.slice(0, 3)],
              nextCursor: pageTwo ? null : 'safe-page-2',
            },
          });
        }
        if (pathname.endsWith('/communication-suggestions/suggestion-1/drafts')) {
          const body = JSON.parse(request.postData());
          drafts.push({
            version: drafts.length + 1,
            createdAt: new Date().toISOString(),
            subject: body.subject,
            body: body.body,
            claimed: false,
          });
          return route.fulfill({
            status: 201,
            json: { communicationId: 'suggestion-1', version: drafts.length },
          });
        }
        if (pathname.endsWith('/communications/suggestion-1/presentations')) {
          presentationCalls[role] += 1;
          const body = JSON.parse(request.postData());
          const draft = drafts.find((item) => item.version === body.version);
          if (!draft || draft.claimed) {
            return route.fulfill({ status: 409, json: { error: 'Draft is no longer reviewable' } });
          }
          const id = `presentation-${nextPresentation++}`;
          const token = `${role}-fresh-token-${id}-${'x'.repeat(32)}`;
          presentations.set(id, { id, token, role, state: 'active', version: body.version });
          return route.fulfill({
            status: 201,
            json: {
              presentationId: id,
              version: body.version,
              token,
              previewHash: 'b'.repeat(64),
              preview: { ...preview, subject: draft.subject, body: draft.body },
            },
          });
        }
        if (pathname.includes('/presentations/') && pathname.endsWith('/reject')) {
          const id = pathname.split('/').at(-2);
          const presentation = presentations.get(id);
          if (!presentation || presentation.role !== role) {
            return route.fulfill({ status: 404, json: { error: 'Presentation not found' } });
          }
          if (failNextRevoke) {
            failNextRevoke = false;
            return route.fulfill({ status: 503, json: { error: 'Synthetic revoke interruption' } });
          }
          presentation.state = 'revoked';
          return route.fulfill({ json: { state: 'revoked' } });
        }
        if (pathname.endsWith('/communications/suggestion-1/approve')) {
          const body = JSON.parse(request.postData());
          const presentation = presentations.get(body.presentationId);
          if (
            role !== 'admin'
            || !presentation
            || presentation.role !== 'admin'
            || presentation.token !== body.token
          ) {
            return route.fulfill({ status: 403, json: { error: 'Forbidden' } });
          }
          if (failNextApprove) {
            failNextApprove = false;
            presentation.state = 'revoked';
            return route.fulfill({ status: 409, json: { error: 'Review changed; generate a fresh preview' } });
          }
          if (!attempts.some((item) => item.id === 'attempt-new')) {
            attempts.push({
              id: 'attempt-new',
              recordType: 'sponsor-send-attempt',
              status: 'queued',
              derivedStatus: 'queued',
            });
          }
          drafts.find((item) => item.version === body.version).claimed = true;
          suggestion.status = 'dismissed';
          presentation.state = 'consumed';
          return route.fulfill({
            status: 202,
            json: { attemptId: 'attempt-new', status: 'queued', derivedStatus: 'queued' },
          });
        }
        if (pathname.endsWith('/communications/attempts/attempt-queued-control/cancel')) {
          const queued = attempts.find((item) => item.id === 'attempt-queued-control');
          queued.status = 'cancelled';
          queued.derivedStatus = 'cancelled';
          return route.fulfill({ json: { status: 'cancelled' } });
        }
        if (pathname.endsWith('/contacts/contact-2/suppressions')) {
          suppressedRequest = JSON.parse(request.postData());
          return route.fulfill({ status: 201, json: { status: 'active' } });
        }
        if (pathname.endsWith('/communications/evaluate')) {
          return route.fulfill({ json: { created: [], existing: ['suggestion-1'] } });
        }
        return route.fulfill({ status: 404, json: { error: `Synthetic route missing: ${pathname}` } });
      });
    };

    const openBooking = async (page) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Sponsors' }).click();
      await expect(page.locator('[data-crm-orgs]')).toContainText('Synthetic Sponsor');
      await page.getByRole('button', { name: 'Open booking' }).first().click();
      await expect(page.locator('[data-crm-communications]')).toContainText('Booking confirmed with an active recipient');
    };
    const captureCommunications = async (page, screenshotPath) => {
      await page.locator('[data-crm-communications]').evaluate((source) => {
        document.querySelector('[data-communications-evidence]')?.remove();
        const evidence = source.cloneNode(true);
        evidence.dataset.communicationsEvidence = 'true';
        evidence.classList.add('crm-communications');
        Object.assign(evidence.style, {
          position: 'fixed',
          inset: '0 auto auto 0',
          zIndex: '100000',
          width: 'min(760px, calc(100vw - 28px))',
          maxHeight: 'none',
          padding: '14px',
          background: 'var(--surface)',
          overflow: 'visible',
        });
        document.body.append(evidence);
      });
      await page.locator('[data-communications-evidence]').screenshot({
        path: screenshotPath,
      });
      await page.locator('[data-communications-evidence]').evaluate((node) => node.remove());
    };

    const operatorContext = await browser.newContext({ baseURL: BASE_URL });
    const operatorPage = await operatorContext.newPage();
    await routeRole(operatorPage, 'operator');
    await openBooking(operatorPage);
    await expect(operatorPage.getByRole('button', { name: 'Approve and queue' })).toHaveCount(0);
    await expect(operatorPage.getByRole('button', { name: 'Cancel before dispatch' })).toHaveCount(0);
    await expect(operatorPage.getByRole('button', { name: 'Reconcile outcome' })).toHaveCount(0);
    await operatorPage.getByRole('button', { name: 'Suppress sponsor address' }).click();
    await operatorPage.locator('[data-suppression-dialog]').getByLabel('Recipient').selectOption('Alternate@Example.invalid');
    await operatorPage.locator('[data-suppression-dialog]').getByLabel('Reason').fill('Synthetic suppression reason');
    await operatorPage.getByRole('button', { name: 'Suppress future messages' }).click();
    await expect.poll(() => suppressedRequest).toEqual({
      email: 'Alternate@Example.invalid',
      reason: 'Synthetic suppression reason',
    });
    await operatorPage.getByRole('button', { name: 'Draft message' }).click();
    await operatorPage.getByLabel('Subject').fill(preview.subject);
    await operatorPage.getByLabel('Plain-text message').fill(preview.body);
    await operatorPage.getByLabel('Public link').fill(preview.publicLinks[0]);
    await operatorPage.getByRole('button', { name: 'Save draft for admin review' }).click();
    await expect(operatorPage.getByRole('status')).toContainText('Awaiting administrator review');
    await expect(operatorPage.locator('[data-crm-communications]')).toContainText('Draft version 1');
    await expect(operatorPage.locator('[data-crm-communications]')).toContainText('Draft saved. Awaiting administrator review.');
    await expect(operatorPage.locator('[data-crm-communications]')).not.toContainText(preview.body);
    expect(presentationCalls.operator).toBe(0);
    await captureCommunications(
      operatorPage,
      '.tmp/sponsor-communications-operator-awaiting-desktop.png',
    );
    await operatorPage.setViewportSize({ width: 390, height: 844 });
    await operatorPage.evaluate(() => document.body.classList.remove('sidebar-open'));
    await operatorPage.addStyleTag({ content: '.mobile-topbar{display:none!important}' });
    expect(await operatorPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureCommunications(
      operatorPage,
      '.tmp/sponsor-communications-operator-awaiting-mobile.png',
    );
    await operatorPage.setViewportSize({ width: 1280, height: 900 });
    await operatorPage.reload();
    await operatorPage.getByRole('button', { name: 'Sponsors' }).click();
    await operatorPage.getByRole('button', { name: 'Open booking' }).first().click();
    await expect(operatorPage.locator('[data-crm-communications]')).toContainText('Draft version 1');
    await expect(operatorPage.getByRole('button', { name: 'Review exact draft' })).toHaveCount(0);

    const adminContext = await browser.newContext({ baseURL: BASE_URL });
    const adminPage = await adminContext.newPage();
    await routeRole(adminPage, 'admin');
    await openBooking(adminPage);
    await expect(adminPage.getByRole('button', { name: 'Review exact draft' })).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Cancel before dispatch' })).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Reconcile outcome' })).toBeVisible();
    await expect(adminPage.locator('[data-crm-communications]')).toContainText('Waiting for a trusted provider fact');
    await captureCommunications(
      adminPage,
      '.tmp/sponsor-communications-admin-states-desktop.png',
    );
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.evaluate(() => document.body.classList.remove('sidebar-open'));
    await adminPage.addStyleTag({ content: '.mobile-topbar{display:none!important}' });
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureCommunications(
      adminPage,
      '.tmp/sponsor-communications-admin-states-mobile.png',
    );
    await adminPage.setViewportSize({ width: 1280, height: 900 });

    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.getByRole('heading', { name: preview.subject })).toBeVisible();
    await expect(adminPage.locator('[data-review-body]')).toHaveText(preview.body);
    await expect(adminPage.getByRole('button', { name: 'Approve and queue' })).toBeVisible();
    await adminPage.locator('[data-communication-review-dialog]').screenshot({
      path: '.tmp/sponsor-communications-admin-exact-preview-desktop.png',
    });
    const clickReviewId = [...presentations.keys()].at(-1);
    await adminPage.getByRole('button', { name: 'Reject / close' }).click();
    await expect.poll(() => presentations.get(clickReviewId).state).toBe('revoked');
    await expect(adminPage.locator('[data-communication-review-dialog]')).not.toBeVisible();

    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    const escapeReviewId = [...presentations.keys()].at(-1);
    await adminPage.keyboard.press('Escape');
    await expect.poll(() => presentations.get(escapeReviewId).state).toBe('revoked');
    await expect(adminPage.locator('[data-communication-review-dialog]')).not.toBeVisible();

    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    const failedReviewId = [...presentations.keys()].at(-1);
    failNextRevoke = true;
    await adminPage.getByRole('button', { name: 'Reject / close' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    await expect(adminPage.locator('[data-review-status]')).toContainText('Could not revoke this review');
    expect(presentations.get(failedReviewId).state).toBe('active');
    await adminPage.locator('[data-communication-review-dialog]').screenshot({
      path: '.tmp/sponsor-communications-revoke-failure.png',
    });
    await adminPage.getByRole('button', { name: 'Reject / close' }).click();
    await expect.poll(() => presentations.get(failedReviewId).state).toBe('revoked');

    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    const navigationReviewId = [...presentations.keys()].at(-1);
    await adminPage.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('dataops:navigate-workspace', {
          detail: { view: 'home' },
        }),
      );
    });
    await expect.poll(() => presentations.get(navigationReviewId).state).toBe('revoked');
    await expect(adminPage.getByRole('button', { name: 'Sponsors' })).toBeVisible();

    await adminPage.getByRole('button', { name: 'Sponsors' }).click();
    await adminPage.getByRole('button', { name: 'Open booking' }).first().click();
    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    failNextApprove = true;
    await adminPage.getByRole('button', { name: 'Approve and queue' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    await expect(adminPage.locator('[data-review-status]')).toContainText('Approval was not applied');
    await adminPage.getByRole('button', { name: 'Reject / close' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).not.toBeVisible();

    await adminPage.getByRole('button', { name: 'Review exact draft' }).click();
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.evaluate(() => document.body.classList.remove('sidebar-open'));
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await adminPage.locator('[data-communication-review-dialog]').screenshot({
      path: '.tmp/sponsor-communications-admin-exact-preview-mobile.png',
    });
    await adminPage.getByRole('button', { name: 'Approve and queue' }).click();
    await expect(adminPage.locator('[data-crm-message]')).toContainText('Approved immutable message queued as attempt-new');
    await expect(adminPage.locator('[data-crm-communications]')).toContainText('Draft version 1');
    expect(attempts.filter((item) => item.id === 'attempt-new')).toHaveLength(1);
    expect(presentationCalls.admin).toBeGreaterThanOrEqual(5);

    await operatorContext.close();
    await adminContext.close();

    const disabledContext = await browser.newContext({ baseURL: BASE_URL });
    const disabledPage = await disabledContext.newPage();
    await disabledPage.route('**/work/api/notifications', (route) =>
      route.fulfill({ json: { notifications: [] } }));
    await disabledPage.route('**/work/api/sponsor-crm/**', (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.endsWith('/organizations')) return route.fulfill({ json: { items: [organization] } });
      if (pathname.endsWith('/contacts')) return route.fulfill({ json: { items: [contact] } });
      if (pathname.endsWith('/bookings')) return route.fulfill({ json: { items: [booking] } });
      if (pathname.endsWith('/history')) return route.fulfill({ json: { items: [] } });
      if (pathname.endsWith('/communications')) {
        return route.fulfill({
          json: {
            config: { configured: true, enabled: false },
            permissions: { role: 'operator', canApprove: false, canCancel: false, canReconcile: false },
            items: attempts,
            nextCursor: null,
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: 'missing' } });
    });
    await disabledPage.goto('/');
    await disabledPage.getByRole('button', { name: 'Sponsors' }).click();
    await disabledPage.getByRole('button', { name: 'Open booking' }).click();
    await expect(disabledPage.getByText('Reviewed sending is disabled')).toBeVisible();
    await captureCommunications(
      disabledPage,
      '.tmp/sponsor-communications-disabled-desktop.png',
    );
    await disabledPage.setViewportSize({ width: 390, height: 844 });
    await disabledPage.evaluate(() => document.body.classList.remove('sidebar-open'));
    await disabledPage.addStyleTag({ content: '.mobile-topbar{display:none!important}' });
    expect(await disabledPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureCommunications(
      disabledPage,
      '.tmp/sponsor-communications-disabled-mobile.png',
    );
    await disabledContext.close();
  });
});
