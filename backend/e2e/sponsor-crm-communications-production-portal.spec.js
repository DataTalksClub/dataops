const { test, expect } = require('@playwright/test');
const { createDocsCacheRoot } = require('./helpers/docs-content-root');
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require('./helpers/isolated-capability-server');

let server;

async function gotoOwnedCommunicationsPage(page) {
  const response = await page.goto('/');
  assertOwnedServerResponse(server, response, 'sponsor communications browser session');
  return response;
}

test.describe('production sponsor CRM communications portal', () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot(
          'issue-190-docs-cache/sponsor-crm-communications-production-portal',
        ),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
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
    const booking = {
      id: 'booking-1',
      organizationId: 'org-1',
      primaryContactId: 'contact-1',
      status: 'agreed',
      productKind: 'one-off',
      deliverables: [{
        id: 'deliverable-1',
        dealId: 'booking-1',
        channel: 'main',
        plannedPublicationDate: '2026-08-20',
        materialDeadline: '2026-08-10',
      }],
      version: 2,
    };
    // Archived history only: suggestions/drafts live read-only under the
    // record Activity disclosure. The old in-deal composer section
    // ([data-crm-communications] with Draft message / suppression controls)
    // no longer exists, so the suite seeds one immutable draft version and
    // proves the lazy archive + version-scoped exact preview instead. Sending,
    // approve, cancel and reconcile affordances must never reappear.
    const attempts = [
      { id: 'attempt-queued-control', recordType: 'sponsor-send-attempt', status: 'queued', derivedStatus: 'queued', createdAt: '2026-07-02T00:00:00Z' },
      { id: 'attempt-accepted', recordType: 'sponsor-send-attempt', status: 'accepted', derivedStatus: 'accepted', createdAt: '2026-07-03T00:00:00Z' },
      { id: 'attempt-delayed', recordType: 'sponsor-send-attempt', status: 'accepted', derivedStatus: 'delayed', createdAt: '2026-07-04T00:00:00Z' },
      { id: 'attempt-rejected', recordType: 'sponsor-send-attempt', status: 'provider_observed', derivedStatus: 'rejected', createdAt: '2026-07-05T00:00:00Z' },
      { id: 'attempt-delivered', recordType: 'sponsor-send-attempt', status: 'provider_observed', derivedStatus: 'delivered', createdAt: '2026-07-06T00:00:00Z' },
      { id: 'attempt-pending', recordType: 'sponsor-send-attempt', status: 'executing', derivedStatus: 'pending_event', createdAt: '2026-07-07T00:00:00Z' },
      { id: 'attempt-unknown', recordType: 'sponsor-send-attempt', status: 'outcome_unknown', derivedStatus: 'outcome_unknown', createdAt: '2026-07-08T00:00:00Z' },
    ];
    const drafts = [{
      version: 1,
      createdAt: '2026-07-09T00:00:00Z',
      subject: 'Exact operator-authored subject',
      body: 'Exact operator-authored private body.\nSecond line.',
      safeReason: 'Booking confirmed with an active recipient',
      claimed: false,
    }];
    const presentations = new Map();
    const presentationCalls = { operator: 0, admin: 0 };
    const archiveRequests = [];
    let nextPresentation = 1;
    let failNextRevoke = false;

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
      await page.route('**/api/notifications*', (route) =>
        route.fulfill({
          json: {
            notifications: {
              items: [{
                id: 'alert-1',
                message: 'Sponsor booking materials are missing 10 days before publication',
                dueAt: '2026-08-20',
                dismissed: false,
                metadata: { sponsorDealId: 'booking-1' },
              }],
            },
          },
        }));
      await page.route('**/api/sponsor-crm/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        if (pathname.endsWith('/organizations')) return route.fulfill({ json: { items: [organization] } });
        if (pathname.endsWith('/contacts')) return route.fulfill({ json: { items: [contact] } });
        if (pathname.endsWith('/leads')) return route.fulfill({ json: { items: [] } });
        if (pathname.endsWith('/messages')) return route.fulfill({ json: { items: [] } });
        if (pathname === '/api/sponsor-crm/deals') return route.fulfill({ json: { items: [booking] } });
        if (pathname === '/api/sponsor-crm/deals/booking-1') return route.fulfill({ json: booking });
        // Bounded pipeline, saved views and lazy record reads serve the CRM
        // lists/record tabs from the same fixtures (D API shapes).
        if (pathname === '/api/sponsor-crm/pipeline') {
          return route.fulfill({
            json: {
              items: [{
                id: booking.id,
                organizationId: organization.id,
                organizationName: organization.displayName,
                stage: 'agreed',
                title: null,
                primaryContact: { name: contact.name, email: contact.emails[0] },
                nextTask: null,
                lastContacted: null,
                amountEur: null,
              }],
              counts: { agreed: 1 },
              total: 1,
              nextCursor: null,
              financeEnabled: true,
            },
          });
        }
        if (pathname === '/api/sponsor-crm/views') {
          return route.fulfill({
            json: {
              items: [{
                id: 'builtin:pipeline:needs-attention',
                entity: 'pipeline',
                name: 'Needs attention',
                builtin: true,
                filters: { view: 'actionable' },
                resolvedFilters: { view: 'actionable' },
                sort: { field: 'next-action' },
              }],
              total: 1,
            },
          });
        }
        if (pathname === '/api/sponsor-crm/directory/companies') {
          return route.fulfill({
            json: {
              items: [{
                id: organization.id,
                displayName: organization.displayName,
                relationship: 'talking',
                active: true,
                primaryPerson: { id: contact.id, name: contact.name, email: contact.emails[0] },
                lastTouch: null,
                openDealCount: 1,
                version: organization.version,
                updatedAt: '2026-08-20T00:00:00Z',
              }],
              total: 1,
              nextCursor: null,
            },
          });
        }
        if (pathname === '/api/sponsor-crm/directory/companies/org-1') {
          return route.fulfill({
            json: {
              id: organization.id,
              displayName: organization.displayName,
              active: true,
              lastTouch: null,
              version: organization.version,
              updatedAt: '2026-08-20T00:00:00Z',
            },
          });
        }
        if (pathname === '/api/sponsor-crm/directory/people') {
          return route.fulfill({
            json: {
              items: [{
                id: contact.id,
                organizationId: contact.organizationId,
                companyName: organization.displayName,
                name: contact.name,
                emails: contact.emails,
                primary: contact.primary,
                lastTouch: null,
                active: true,
                version: contact.version,
                updatedAt: '2026-08-20T00:00:00Z',
              }],
              total: 1,
              nextCursor: null,
            },
          });
        }
        if (pathname.startsWith('/api/sponsor-crm/activity/')) {
          return route.fulfill({
            json: {
              targetType: 'organization',
              targetId: organization.id,
              items: [],
              total: 0,
              nextCursor: null,
              sources: {},
              relatedWork: [],
              tasksScope: 'open',
              reads: {},
            },
          });
        }
        if (pathname.endsWith('/notes/organization/org-1')) {
          return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
        }
        if (pathname.endsWith('/deals/booking-1/communications')) {
          archiveRequests.push({
            limit: url.searchParams.get('limit'),
            cursor: url.searchParams.get('cursor'),
          });
          const draftDtos = drafts.map((draft) => ({
            id: `suggestion-1#${draft.version}`,
            recordType: 'communication-draft-version',
            communicationId: 'suggestion-1',
            bookingId: 'booking-1',
            suggestionId: 'suggestion-1',
            version: draft.version,
            reviewState: draft.claimed ? 'claimed' : 'awaiting_review',
            reviewable: !draft.claimed,
            safeReason: draft.safeReason,
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
              permissions: {
                role,
                canApprove: role === 'admin',
              },
              items: pageTwo
                ? [...attempts.slice(3)]
                : [draftDtos[0], ...attempts.slice(0, 3)],
              nextCursor: pageTwo ? null : 'safe-page-2',
            },
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
        if (pathname.endsWith('/communications/evaluate')) {
          return route.fulfill({ json: { created: [], existing: ['suggestion-1'] } });
        }
        return route.fulfill({ status: 404, json: { error: `Synthetic route missing: ${pathname}` } });
      });
    };

    const openDealRecord = async (page) => {
      await gotoOwnedCommunicationsPage(page);
      await page.getByRole('link', { name: 'CRM' }).click();
      await expect(page.locator('[data-crm-bookings]')).toContainText('Synthetic Sponsor');
      await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
      await expect(page.locator('[data-record-title]')).toContainText('Synthetic Sponsor');
      await expect(page.locator('[data-record-tabs][role="tablist"]')).toBeVisible();
      // Deal selection resolves on the Deals tab; the Activity archive
      // disclosure stays empty until a deal is selected.
      await page.locator('[data-record-tab="deals"]').click();
      await expect(page.locator('[data-record-panel="deals"]')).not.toContainText('Loading deals');
    };
    const openArchive = async (page) => {
      await page.locator('[data-record-tab="activity"]').click();
      const host = page.locator('[data-record-archive-host]');
      await expect(host).toContainText('Archived drafts and delivery history');
      return host;
    };
    const captureArchive = async (page, screenshotPath) => {
      await page.locator('[data-record-archive-host]').evaluate((source) => {
        document.querySelector('[data-archive-evidence]')?.remove();
        const evidence = source.cloneNode(true);
        evidence.dataset.archiveEvidence = 'true';
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
      await page.locator('[data-archive-evidence]').screenshot({
        path: screenshotPath,
      });
      await page.locator('[data-archive-evidence]').evaluate((node) => node.remove());
    };

    const operatorContext = await browser.newContext({ baseURL: server.baseURL });
    const operatorPage = await operatorContext.newPage();
    await routeRole(operatorPage, 'operator');
    await openDealRecord(operatorPage);
    // Sending/approve/cancel/reconcile affordances are removed everywhere;
    // the archived history is the only communications surface in the record.
    await expect(operatorPage.getByRole('button', { name: 'Approve and queue' })).toHaveCount(0);
    await expect(operatorPage.getByRole('button', { name: 'Cancel before dispatch' })).toHaveCount(0);
    await expect(operatorPage.getByRole('button', { name: 'Reconcile outcome' })).toHaveCount(0);
    await expect(operatorPage.getByRole('button', { name: 'Draft message' })).toHaveCount(0);
    expect(archiveRequests.length).toBe(0);
    const operatorArchive = await openArchive(operatorPage);
    // The disclosure stays idle until first open: no archive fetch yet.
    expect(archiveRequests.length).toBe(0);
    await operatorArchive.locator('[data-record-archive] > summary').click();
    await expect(operatorArchive).toContainText('Archived draft v1');
    // One bounded page per explicit open; cursor continues on demand.
    expect(archiveRequests).toEqual([{ limit: '50', cursor: null }]);
    await expect(operatorArchive).toContainText('Booking confirmed with an active recipient');
    await expect(operatorArchive).toContainText('Delivery delayed');
    // History redaction: the private draft payload never appears in rows.
    await expect(operatorArchive).not.toContainText(preview.body);
    await expect(operatorArchive).not.toContainText(preview.subject);
    // Read-only exact preview stays available to the operator role too: the
    // presentations endpoint admits both roles and every preview is a
    // one-time token revoked on close.
    await operatorArchive.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(operatorPage.getByRole('heading', { name: preview.subject })).toBeVisible();
    await expect(operatorPage.locator('[data-review-body]')).toHaveText(preview.body);
    await expect(operatorPage.locator('[data-review-warning]')).toContainText('no longer sends sponsor email');
    expect(presentationCalls.operator).toBe(1);
    const operatorReviewId = [...presentations.keys()].at(-1);
    await operatorPage.keyboard.press('Escape');
    await expect.poll(() => presentations.get(operatorReviewId).state).toBe('revoked');
    await expect(operatorPage.locator('[data-communication-review-dialog]')).not.toBeVisible();
    await captureArchive(
      operatorPage,
      '.tmp/sponsor-communications-archive-operator-desktop.png',
    );
    await operatorPage.setViewportSize({ width: 390, height: 844 });
    await operatorPage.evaluate(() => dakitShell.toggleDrawer(document.querySelector('.dk-shell'), false));
    await operatorPage.addStyleTag({ content: '.dk-topbar{display:none!important}' });
    expect(await operatorPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureArchive(
      operatorPage,
      '.tmp/sponsor-communications-archive-operator-mobile.png',
    );
    await operatorPage.setViewportSize({ width: 1280, height: 900 });
    // Archived history survives reload: reopening the record refetches lazily.
    await operatorPage.reload();
    await operatorPage.getByRole('link', { name: 'CRM' }).click();
    await expect(operatorPage.locator('[data-crm-bookings]')).toContainText('Synthetic Sponsor');
    await operatorPage.locator('[data-crm-bookings] [data-open-deal]').first().click();
    await expect(operatorPage.locator('[data-record-title]')).toContainText('Synthetic Sponsor');
    await operatorPage.locator('[data-record-tab="deals"]').click();
    await expect(operatorPage.locator('[data-record-panel="deals"]')).not.toContainText('Loading deals');
    const reopenedArchive = await openArchive(operatorPage);
    await reopenedArchive.locator('[data-record-archive] > summary').click();
    await expect(reopenedArchive).toContainText('Archived draft v1');
    await expect(reopenedArchive).not.toContainText(preview.body);

    const adminContext = await browser.newContext({ baseURL: server.baseURL });
    const adminPage = await adminContext.newPage();
    await routeRole(adminPage, 'admin');
    await openDealRecord(adminPage);
    await expect(adminPage.getByRole('button', { name: 'Approve and queue' })).toHaveCount(0);
    await expect(adminPage.getByRole('button', { name: 'Cancel before dispatch' })).toHaveCount(0);
    await expect(adminPage.getByRole('button', { name: 'Reconcile outcome' })).toHaveCount(0);
    const adminArchive = await openArchive(adminPage);
    await adminArchive.locator('[data-record-archive] > summary').click();
    await expect(adminArchive).toContainText('Archived draft v1');
    await expect(adminArchive).toContainText('Delivery delayed');
    await expect(adminArchive).not.toContainText(preview.body);
    await expect(adminArchive).toContainText('Archived drafts and delivery history (4 loaded)');
    await adminArchive.getByRole('button', { name: /Load older/ }).click();
    await expect(adminArchive).toContainText('Delivery delivered');
    await expect(adminArchive).toContainText('Archived drafts and delivery history (8 loaded)');
    await captureArchive(
      adminPage,
      '.tmp/sponsor-communications-archive-admin-desktop.png',
    );
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.evaluate(() => dakitShell.toggleDrawer(document.querySelector('.dk-shell'), false));
    await adminPage.addStyleTag({ content: '.dk-topbar{display:none!important}' });
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureArchive(
      adminPage,
      '.tmp/sponsor-communications-archive-admin-mobile.png',
    );
    await adminPage.setViewportSize({ width: 1280, height: 900 });

    await adminArchive.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.getByRole('heading', { name: preview.subject })).toBeVisible();
    await expect(adminPage.locator('[data-review-body]')).toHaveText(preview.body);
    await expect(adminPage.getByRole('button', { name: 'Approve and queue' })).toHaveCount(0);
    await expect(adminPage.locator('[data-review-warning]')).toContainText('no longer sends sponsor email');
    await adminPage.locator('[data-communication-review-dialog]').screenshot({
      path: '.tmp/sponsor-communications-admin-exact-preview-desktop.png',
    });
    const clickReviewId = [...presentations.keys()].at(-1);
    await adminPage.getByRole('button', { name: 'Reject / close' }).click();
    await expect.poll(() => presentations.get(clickReviewId).state).toBe('revoked');
    await expect(adminPage.locator('[data-communication-review-dialog]')).not.toBeVisible();

    await adminArchive.getByRole('button', { name: 'Review exact draft' }).click();
    await expect(adminPage.locator('[data-communication-review-dialog]')).toBeVisible();
    const escapeReviewId = [...presentations.keys()].at(-1);
    await adminPage.keyboard.press('Escape');
    await expect.poll(() => presentations.get(escapeReviewId).state).toBe('revoked');
    await expect(adminPage.locator('[data-communication-review-dialog]')).not.toBeVisible();

    await adminArchive.getByRole('button', { name: 'Review exact draft' }).click();
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

    await adminArchive.getByRole('button', { name: 'Review exact draft' }).click();
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
    await expect(adminPage.getByRole('link', { name: 'CRM' })).toBeVisible();

    await adminPage.getByRole('link', { name: 'CRM' }).click();
    await expect(adminPage.locator('[data-crm-bookings]')).toContainText('Synthetic Sponsor');
    await adminPage.locator('[data-crm-bookings] [data-open-deal]').first().click();
    await expect(adminPage.locator('[data-record-title]')).toContainText('Synthetic Sponsor');
    await adminPage.locator('[data-record-tab="deals"]').click();
    await expect(adminPage.locator('[data-record-panel="deals"]')).not.toContainText('Loading deals');
    const rereadArchive = await openArchive(adminPage);
    await rereadArchive.locator('[data-record-archive] > summary').click();
    await rereadArchive.getByRole('button', { name: 'Review exact draft' }).click();
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.evaluate(() => dakitShell.toggleDrawer(document.querySelector('.dk-shell'), false));
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await adminPage.locator('[data-communication-review-dialog]').screenshot({
      path: '.tmp/sponsor-communications-admin-exact-preview-mobile.png',
    });
    expect(presentationCalls.admin).toBeGreaterThanOrEqual(4);

    await operatorContext.close();
    await adminContext.close();
  });
});
