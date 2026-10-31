const { test, expect } = require("@playwright/test");
const { createDocsCacheRoot } = require("./helpers/docs-content-root");
const {
  assertOwnedServerResponse,
  startOwnedTestServer,
  stopOwnedTestServer,
} = require("./helpers/isolated-capability-server");

let server;

async function gotoOwnedSponsorPage(page) {
  const response = await page.goto("/");
  assertOwnedServerResponse(server, response, "sponsor CRM browser session");
  return response;
}

test.describe("production sponsor CRM portal", () => {
  test.beforeAll(async () => {
    server = await startOwnedTestServer({
      environment: {
        DTC_CACHE_ROOT: createDocsCacheRoot(
          "issue-190-docs-cache/sponsor-crm-production-portal",
        ),
      },
    });
  });

  test.afterAll(async () => {
    await stopOwnedTestServer(server);
  });
  test("renders clean loading, populated, history, alerts, error and mobile states", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ baseURL: server.baseURL }),
      page = await context.newPage();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const organization = {
        id: "org-1",
        displayName: "Synthetic Sponsor",
        version: 1,
      },
      contact = {
        id: "contact-1",
        organizationId: "org-1",
        name: "Synthetic Contact",
        emails: ["finance-contact@example.invalid"],
        primary: true,
        version: 1,
      },
      booking = {
        id: "booking-1",
        organizationId: "org-1",
        primaryContactId: "contact-1",
        status: "agreed",
        productKind: "one-off",
        deliverables: [{
          id: "deliverable-1",
          dealId: "booking-1",
          channel: "main",
          plannedPublicationDate: "2026-08-20",
          materialDeadline: "2026-08-10",
        }],
        version: 2,
      };
    let financeStage = "unclassified",
      financeVersion = 0,
      paymentLinks = 0,
      financeRole = "admin",
      financeDisabled = false,
      financeFailure = "",
      emptyCandidates = false,
      overpaymentCandidate = false,
      downloadRequests = 0,
      reconcileRequests = 0;
    const communicationRequests = [];
    let communicationResponses = 0;
    const mutationKeys = [];
    const financeProjection = () =>
      financeStage === "unclassified"
        ? {
            enabled: true,
            classified: false,
            bookingId: booking.id,
            role: financeRole,
            invoiceState: "unclassified",
            paymentState: "not-applicable",
            timingState: "not-applicable",
            payments: [],
            reconciliationStatus: "coherent",
            paymentLinkCount: 0,
            paymentLinkLimit: 20,
          }
        : financeStage === "not-required" || financeStage === "voided"
          ? {
              enabled: true,
              classified: true,
              bookingId: booking.id,
              role: financeRole,
              finance: {
                version: financeVersion,
                invoiceRequirement:
                  financeStage === "not-required" ? "not-required" : "required",
                ...(financeStage === "voided"
                  ? { voidedAt: "2026-07-30T12:00:00.000Z", voidReason: "Synthetic contract cancelled before payment" }
                  : {}),
              },
              invoiceState:
                financeStage === "not-required" ? "not-required" : "voided",
              paymentState: "not-applicable",
              timingState: "not-applicable",
              payments: [],
              reconciliationStatus: "coherent",
              paymentLinkCount: 0,
              paymentLinkLimit: 20,
            }
          : {
              enabled: true,
              classified: true,
              bookingId: booking.id,
              role: financeRole,
              finance: {
                version: financeVersion,
                invoiceRequirement: "required",
                amountDue: "100",
                currency: "EUR",
                taxMode: "included",
                taxAmount: "19",
                requestBy: "2026-07-10",
                expectedInvoiceBy: "2026-07-20",
                ...(financeStage !== "classified"
                  ? { invoiceRequestedAt: "2026-07-11T10:00:00.000Z" }
                  : {}),
                ...([
                  "issued",
                  "partial",
                  "paid",
                  "reconciliation",
                  "limit",
                ].includes(financeStage)
                  ? { issuedOn: "2026-07-12", dueOn: "2026-07-31" }
                  : {}),
              },
              invoiceState: [
                "issued",
                "partial",
                "paid",
                "reconciliation",
                "limit",
              ].includes(financeStage)
                ? "issued"
                : financeStage === "requested"
                  ? "requested"
                  : "to-request",
              paymentState:
                financeStage === "reconciliation"
                  ? "reconciliation-required"
                  : financeStage === "paid"
                    ? "paid"
                    : financeStage === "partial"
                      ? "partially-paid"
                      : financeStage === "limit"
                        ? "partially-paid"
                        : "unpaid",
              timingState: financeStage === "paid" ? "settled" : "overdue",
              ...(financeStage !== "reconciliation"
                ? {
                    outstanding:
                      financeStage === "paid"
                        ? "0"
                        : financeStage === "partial" || financeStage === "limit"
                          ? "60"
                          : "100",
                  }
                : {}),
              ...([
                "issued",
                "partial",
                "paid",
                "reconciliation",
                "limit",
              ].includes(financeStage)
                ? {
                    invoice: {
                      id: "invoice-opaque-1",
                      label: "Invoice invoice-",
                      uploadedAt: "2026-07-12T09:00:00.000Z",
                    },
                  }
                : {}),
              payments:
                financeStage === "partial" || financeStage === "limit"
                  ? [
                      {
                        id: "payment-opaque-1",
                        effectiveDate: "2026-07-15",
                        amount: "40",
                        currency: "EUR",
                      },
                    ]
                  : financeStage === "paid"
                    ? [
                        {
                          id: "payment-opaque-1",
                          effectiveDate: "2026-07-15",
                          amount: "40",
                          currency: "EUR",
                        },
                        {
                          id: "payment-opaque-2",
                          effectiveDate: "2026-07-20",
                          amount: "60",
                          currency: "EUR",
                        },
                      ]
                    : [],
              reconciliationStatus:
                financeStage === "reconciliation"
                  ? "reconciliation-required"
                  : "coherent",
              paymentLinkCount: financeStage === "limit" ? 20 : paymentLinks,
              paymentLinkLimit: 20,
            };
    await page.route("**/api/sponsor-crm/**", async (route) => {
      const url = new URL(route.request().url()),
        pathname = url.pathname;
      if (pathname.includes("/finance")) {
        if (financeDisabled)
          return route.fulfill({
            status: 404,
            json: { error: "Finance follow-through is disabled" },
          });
        if (pathname.endsWith("/candidates/invoices"))
          return route.fulfill({
            json: {
              items: emptyCandidates ? [] : [
                {
                  id: "invoice-opaque-1",
                  label: "Invoice invoice-",
                  uploadedAt: "2026-07-12T09:00:00.000Z",
                  identityToken: "opaque-invoice-token",
                },
              ],
              nextCursor: null,
            },
          });
        if (pathname.endsWith("/candidates/payments"))
          return route.fulfill({
            json: {
              items: emptyCandidates ? [] : [
                {
                  id: `payment-opaque-${paymentLinks + 1}`,
                  effectiveDate: "2026-07-15",
                  amount: overpaymentCandidate
                    ? "60.0001"
                    : paymentLinks
                      ? "60"
                      : "40",
                  currency: "EUR",
                  identityToken: "opaque-payment-token",
                },
              ],
              nextCursor: null,
            },
          });
        if (route.request().method() !== "GET")
          mutationKeys.push(route.request().headers()["idempotency-key"] || "");
        if (
          overpaymentCandidate &&
          route.request().method() === "POST" &&
          pathname.endsWith("/payments")
        ) {
          return route.fulfill({
            status: 409,
            json: { error: "Finance state changed; reload and retry" },
          });
        }
        if (financeFailure && route.request().method() !== "GET") {
          const failure = financeFailure;
          financeFailure = "";
          if (failure === "unknown")
            return route.fulfill({
              status: 503,
              json: {
                error:
                  "Finance outcome unknown; reload or retry with the same Idempotency-Key",
                outcome: "outcome_unknown",
              },
            });
          return route.fulfill({
            status: 409,
            json: { error: "Finance state changed; reload and retry" },
          });
        }
        if (pathname.endsWith("/reconcile")) reconcileRequests++;
        if (route.request().method() === "PUT") {
          financeStage = "classified";
          financeVersion = 1;
        } else if (pathname.endsWith("/request")) {
          financeStage = "requested";
          financeVersion++;
        } else if (pathname.endsWith("/invoice")) {
          financeStage = "issued";
          financeVersion++;
        } else if (pathname.endsWith("/payments")) {
          paymentLinks++;
          financeStage = paymentLinks === 1 ? "partial" : "paid";
          financeVersion++;
        } else if (
          route.request().method() === "DELETE" &&
          pathname.includes("/payments/")
        ) {
          paymentLinks--;
          financeStage = paymentLinks === 1 ? "partial" : "issued";
          financeVersion++;
        } else if (
          route.request().method() === "DELETE" &&
          pathname.includes("/invoice/")
        ) {
          financeStage = "requested";
          financeVersion++;
        } else if (pathname.endsWith("/void")) {
          expect(route.request().postDataJSON().reason).toBe("Synthetic contract cancelled before payment");
          financeStage = "voided";
          financeVersion++;
        }
        return route.fulfill({ json: financeProjection() });
      }
    if (pathname.endsWith("/organizations"))
      return route.fulfill({ json: { items: [organization] } });
    if (pathname.endsWith("/contacts"))
      return route.fulfill({ json: { items: [contact] } });
    if (pathname.endsWith("/leads"))
      return route.fulfill({ json: { items: [] } });
    if (pathname.endsWith("/messages"))
      return route.fulfill({ json: { items: [] } });
    if (pathname.endsWith("/deals"))
      return route.fulfill({ json: { items: [booking] } });
    // The record open reads the bounded singular deal (real D route); the
    // list mock above is not a substitute for it.
    if (pathname.endsWith(`/deals/${booking.id}`))
      return route.fulfill({ json: booking });
    // Bounded directories, saved views and lazy record reads serve the new
    // CRM lists/record tabs from the same fixtures (D API shapes).
    if (pathname === "/api/sponsor-crm/pipeline")
      return route.fulfill({ json: {
        items: [{
          id: booking.id,
          organizationId: organization.id,
          organizationName: organization.displayName,
          stage: "agreed",
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
      } });
    if (pathname === "/api/sponsor-crm/views")
      return route.fulfill({ json: {
        items: [{
          id: "builtin:companies:active",
          entity: "companies",
          name: "Active",
          builtin: true,
          filters: { active: "true" },
          resolvedFilters: { active: "true" },
          sort: { field: "name", direction: "asc" },
        }],
        total: 1,
      } });
    if (pathname === "/api/sponsor-crm/directory/companies")
      return route.fulfill({ json: {
        items: [{
          id: organization.id,
          displayName: organization.displayName,
          relationship: "talking",
          active: true,
          primaryPerson: { id: contact.id, name: contact.name, email: contact.emails[0] },
          lastTouch: null,
          openDealCount: 1,
          version: organization.version,
          updatedAt: "2026-08-20T00:00:00Z",
        }],
        total: 1,
        nextCursor: null,
      } });
    if (pathname === `/api/sponsor-crm/directory/companies/${organization.id}`)
      return route.fulfill({ json: {
        id: organization.id,
        displayName: organization.displayName,
        active: true,
        lastTouch: null,
        version: organization.version,
        updatedAt: "2026-08-20T00:00:00Z",
        notes: "Synthetic operator summary.",
      } });
    if (pathname === "/api/sponsor-crm/directory/people")
      return route.fulfill({ json: {
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
          updatedAt: "2026-08-20T00:00:00Z",
        }],
        total: 1,
        nextCursor: null,
      } });
    if (pathname.startsWith("/api/sponsor-crm/activity/"))
      return route.fulfill({ json: {
        targetType: "organization",
        targetId: organization.id,
        items: [],
        total: 0,
        nextCursor: null,
        sources: {},
        relatedWork: [],
        tasksScope: "open",
        reads: {},
      } });
    if (pathname.endsWith("/notes/organization/org-1"))
      return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
      if (pathname.endsWith("/deals/booking-1/communications")) {
        const cursor = url.searchParams.get("cursor");
        communicationRequests.push({
          limit: url.searchParams.get("limit"),
          cursor,
        });
        if (
          url.searchParams.get("limit") !== "50"
          || (cursor && cursor !== "finance-history-page-2")
        )
          return route.fulfill({
            status: 400,
            json: { error: "Synthetic communication mismatch" },
          });
        communicationResponses++;
        return route.fulfill({
          json: {
            config: {
              configured: true,
              enabled: true,
              generation: 1,
              hmacActiveVersion: "v1",
              hmacAcceptedVersions: ["v1"],
            },
            permissions: {
              role: "operator",
              canApprove: false,
            },
            // Page one carries the reviewable draft plus a suggestion the
            // archive projection filters out; page two carries the delivery
            // attempt. The lazy archive reads exactly these bounded pages.
            items: cursor
              ? [
                  {
                    id: "attempt-delivered",
                    recordType: "sponsor-send-attempt",
                    status: "provider_observed",
                    derivedStatus: "delivered",
                  },
                ]
              : [
                  {
                    id: "suggestion-confirmation",
                    recordType: "communication-suggestion",
                    communicationType: "booking-confirmation",
                    status: "open",
                    eligible: true,
                    safeReason:
                      "Booking confirmed; reviewed communication is available.",
                  },
                  {
                    id: "draft-example",
                    recordType: "communication-draft-version",
                    communicationId: "communication-example",
                    version: 2,
                    reviewable: true,
                    safeReason: "Reviewed payment request, version 2.",
                  },
                ],
            nextCursor: cursor ? null : "finance-history-page-2",
          },
        });
      }
      if (pathname.endsWith("/history"))
        return route.fulfill({
          json: {
            items: [
              {
                id: "h1",
                oldStatus: null,
                newStatus: "inquiry",
                actorId: "synthetic-operator",
                createdAt: "2026-07-01T00:00:00Z",
              },
              {
                id: "h2",
                oldStatus: "inquiry",
                newStatus: "confirmed",
                actorId: "synthetic-operator",
                note: "Synthetic confirmation",
                createdAt: "2026-07-02T00:00:00Z",
              },
            ],
          },
        });
      return route.fulfill({
        status: 404,
        json: { error: "Synthetic route missing" },
      });
    });
    await page.route(
      "**/api/bookkeeping/documents/*/download",
      async (route) => {
        downloadRequests++;
        return route.fulfill({
          json: {
            downloadUrl: `${server.baseURL}/synthetic-private-invoice`,
            expiresIn: 300,
          },
        });
      },
    );
    await page.route("**/api/notifications*", async (route) => {
      await gate;
      return route.fulfill({
        json: {
          notifications: {
            items: [
              {
                id: "alert-1",
                message:
                  "Sponsor booking materials are missing 10 days before publication",
                dueAt: "2026-08-20",
                dismissed: false,
                metadata: { sponsorDealId: "booking-1" },
              },
            ],
          },
        },
      });
    });
    await gotoOwnedSponsorPage(page);
    await page.getByRole("link", { name: "CRM" }).click();
    await expect(page.getByText("Loading sponsor CRM…")).toBeVisible();
    await page.screenshot({
      path: ".tmp/sponsor-crm-production-loading.png",
    });
    release();
    // The Companies directory is server-paged: identity, relationship,
    // primary person, last touch and open deals per row.
    await page.locator('[data-crm-nav-tab="companies"]').click();
    await expect(page.locator('[data-dir-root="companies"] [data-dir-company]')).toContainText(
      "Synthetic Sponsor",
    );
    await expect(page.locator('[data-dir-root="companies"] [data-dir-company]')).toContainText(
      "Synthetic Contact",
    );
    await page.locator('[data-crm-nav-tab="pipeline"]').click();
    await page.locator("[data-crm-alert-summary]").click();
    await expect(page.getByText(/materials are missing/)).toBeVisible();
    await page
      .locator(".crm-layout")
      .screenshot({ path: ".tmp/sponsor-crm-production-populated.png" });
    await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
    // An open deal replaces the board; Back returns to it to open the deal afresh.
    // Finance evidence loads on its tab, so the helper leaves the record there.
    const reopenDeal = async () => {
      await page.locator("[data-record-back]").click();
      await page.locator('[data-crm-bookings] [data-open-deal]').first().click();
      await page.locator('[data-record-tab="finance"]').click();
    };
    await expect(page.locator("[data-record-title]")).toContainText("Synthetic Sponsor");
    await expect(page.locator('[data-record-tabs][role="tablist"]')).toBeVisible();
    // Finance evidence loads only when its tab opens; the communication
    // history stays lazy: nothing reads it until the archive disclosure
    // does, one bounded 50-page at a time.
    await page.locator('[data-record-tab="finance"]').click();
    await expect(page.locator("[data-finance-panel]")).toBeVisible();
    expect(communicationRequests).toEqual([]);
    const statusMessage = page.locator("[data-crm-message]");
    // The Activity tab keeps the timeline filterable; the archive disclosure
    // loads the preserved drafts/attempts lazily and read-only: exactly one
    // 50-page on open, the older page on demand.
    await page.locator('[data-record-tab="activity"]').click();
    const archiveHost = page.locator("[data-record-archive-host]");
    await archiveHost.locator("[data-record-archive] > summary").click();
    await expect(archiveHost).toContainText("Archived draft v2");
    expect(communicationRequests).toEqual([{ limit: "50", cursor: null }]);
    await archiveHost.getByRole("button", { name: /older/i }).click();
    await expect(archiveHost).toContainText("Delivery delivered");
    expect(communicationRequests).toEqual([
      { limit: "50", cursor: null },
      { limit: "50", cursor: "finance-history-page-2" },
    ]);
    expect(communicationResponses).toBe(2);
    // A clean, loaded CRM states nothing: the ready status stays hidden.
    await expect(statusMessage).toBeHidden();
    await page
      .locator("[data-crm-detail]")
      .screenshot({ path: ".tmp/sponsor-crm-production-history.png" });
    // Back to the real visible Finance tab: the panel screenshots and the
    // classification/mutation flow below act on the finance surface, not on
    // the Activity tab left behind by the archive proof.
    await page.locator('[data-record-tab="finance"]').click();
    await expect(page.locator("[data-finance-panel]")).toBeVisible();
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-unclassified.png" });
    await page.getByRole("button", { name: "Classify" }).click();
    await page
      .locator("[data-finance-dialog]")
      .screenshot({ path: ".tmp/sponsor-finance-classification.png" });
    await page
      .locator('[data-finance-dialog] input[name="amountDue"]')
      .fill("100");
    await page
      .locator('[data-finance-dialog] input[name="currency"]')
      .fill("EUR");
    await page
      .locator('[data-finance-dialog] select[name="taxMode"]')
      .selectOption("included");
    await page
      .locator("[data-finance-dialog]")
      .getByRole("button", { name: "Save classification" })
      .click();
    await expect(
      page.getByRole("button", { name: "Record invoice request" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Record invoice request" }).click();
    await expect(
      page.getByRole("button", { name: "Link invoice PDF" }),
    ).toBeVisible();
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-requested.png" });
    emptyCandidates = true;
    await page.getByRole("button", { name: "Link invoice PDF" }).click();
    await expect(page.locator("[data-finance-candidate-dialog]")).toContainText(
      "No eligible unclaimed evidence is available",
    );
    await page
      .locator("[data-finance-candidate-dialog]")
      .screenshot({ path: ".tmp/sponsor-finance-candidate-empty.png" });
    await page
      .locator("[data-finance-candidate-dialog]")
      .getByRole("button", { name: "Cancel" })
      .click();
    emptyCandidates = false;
    await page.getByRole("button", { name: "Link invoice PDF" }).click();
    await page
      .locator("[data-finance-candidate-dialog]")
      .screenshot({ path: ".tmp/sponsor-finance-invoice-candidate.png" });
    await page
      .locator('[data-finance-candidate-dialog] input[name="issuedOn"]')
      .fill("2026-07-12");
    await page
      .locator('[data-finance-candidate-dialog] input[name="dueOn"]')
      .fill("2026-07-31");
    await page
      .locator("[data-finance-candidate-dialog]")
      .getByRole("button", { name: "Link selected evidence" })
      .click();
    await expect(
      page.getByRole("button", { name: "Link bookkeeping payment", exact: true }),
    ).toBeVisible();
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-issued-unpaid.png" });
    await page
      .getByRole("button", { name: "Link bookkeeping payment", exact: true })
      .click();
    await page
      .locator("[data-finance-candidate-dialog]")
      .getByRole("button", { name: "Link selected evidence" })
      .click();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "partially-paid",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-partial.png" });
    overpaymentCandidate = true;
    await page
      .getByRole("button", { name: "Link bookkeeping payment", exact: true })
      .click();
    await expect(
      page
        .locator("[data-finance-candidate-dialog]")
        .getByRole("radio", { name: /60\.0001 EUR/ }),
    ).toBeVisible();
    const outstanding = page.locator("[data-finance-panel] dl > div", {
      has: page.locator("dt", { hasText: /^Outstanding$/ }),
    });
    await expect(outstanding.locator("dt")).toHaveText("Outstanding");
    await expect(outstanding.locator("dd")).toHaveText("€60.00");
    await page
      .locator("[data-finance-candidate-dialog]")
      .getByRole("button", { name: "Link selected evidence" })
      .click();
    await expect(statusMessage).toContainText("Could not link payment");
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "partially-paid",
    );
    await statusMessage.screenshot({
      path: ".tmp/sponsor-finance-overpayment-rejected.png",
    });
    overpaymentCandidate = false;
    await page
      .getByRole("button", { name: "Link bookkeeping payment", exact: true })
      .click();
    await page
      .locator("[data-finance-candidate-dialog]")
      .getByRole("button", { name: "Link selected evidence" })
      .click();
    await expect(page.locator("[data-finance-panel]")).toContainText("paid");
    await expect(page.locator("[data-finance-panel]")).toHaveCount(1);
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-paid.png" });
    await page.getByRole("button", { name: "Download invoice" }).click();
    await expect.poll(() => downloadRequests).toBe(1);
    await page
      .getByRole("button", { name: "Reconcile current evidence" })
      .click();
    await expect.poll(() => reconcileRequests).toBe(1);
    const confirmDialog = page.locator("[data-sponsor-confirm-dialog]");
    await page.locator("[data-finance-unlink-payment]").first().click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Keep current record" }).click();
    await expect(page.locator("[data-finance-panel]")).toContainText("paid");
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-unlink-cancelled.png" });
    await page.locator("[data-finance-unlink-payment]").first().click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator("[data-confirm-accept]").click();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "partially-paid",
    );
    await page.locator("[data-finance-unlink-payment]").first().click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator("[data-confirm-accept]").click();
    await expect(page.locator("[data-finance-panel]")).toContainText("unpaid");
    await page.locator("[data-finance-unlink-invoice]").click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.locator("[data-confirm-accept]").click();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "requested",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-unlinked-recovery.png" });
    await page.getByRole("button", { name: "Cancel invoice follow-through" }).click();
    const cancellation = page.locator("[data-finance-void-dialog]");
    await expect(cancellation).toBeVisible();
    await cancellation.getByRole("button", { name: "Keep open" }).click();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "requested",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-void-cancelled.png" });
    await page.getByRole("button", { name: "Cancel invoice follow-through" }).click();
    await expect(cancellation).toBeVisible();
    await expect(cancellation.locator('[name="reason"]')).toHaveAttribute("required", "");
    await cancellation.locator('[name="reason"]').fill("Synthetic contract cancelled before payment");
    await cancellation.getByRole("button", { name: "Cancel invoice follow-through" }).click();
    await expect(page.locator("[data-finance-panel]")).toContainText("voided");
    await expect(page.locator("[data-finance-panel]")).toContainText("Synthetic contract cancelled before payment");
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-voided.png" });
    financeStage = "not-required";
    await reopenDeal();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "not-required",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-not-required.png" });
    financeStage = "reconciliation";
    await reopenDeal();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "Evidence is unavailable or changed",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-reconciliation-required.png" });
    financeStage = "limit";
    await reopenDeal();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "Payment link limit reached",
    );
    await page
      .locator("[data-finance-panel]")
      .screenshot({ path: ".tmp/sponsor-finance-link-limit.png" });
    financeStage = "paid";
    financeFailure = "stale";
    await page.getByRole("button", { name: "Update classification" }).click();
    await page
      .locator("[data-finance-dialog]")
      .getByRole("button", { name: "Save classification" })
      .click();
    await expect(statusMessage).toContainText("reload and retry");
    await statusMessage.screenshot({
      path: ".tmp/sponsor-finance-stale-recovery.png",
    });
    await statusMessage
      .getByRole("button", { name: "Reload current finance state" })
      .click();
    financeFailure = "unknown";
    await page.getByRole("button", { name: "Update classification" }).click();
    await page
      .locator("[data-finance-dialog]")
      .getByRole("button", { name: "Save classification" })
      .click();
    await expect(statusMessage).toContainText("outcome unknown");
    await statusMessage.screenshot({
      path: ".tmp/sponsor-finance-unknown-recovery.png",
    });
    const unknownKey = mutationKeys.at(-1),
      beforeRetry = mutationKeys.length;
    await statusMessage
      .getByRole("button", { name: "Retry same operation" })
      .click();
    await expect.poll(() => mutationKeys.length).toBe(beforeRetry + 1);
    expect(mutationKeys.at(-1)).toBe(unknownKey);
    financeStage = "paid";
    financeRole = "operator";
    await reopenDeal();
    await expect(page.locator("[data-finance-panel]")).toContainText("paid");
    await expect(
      page.getByRole("button", { name: "Download invoice" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-finance-thank-you="required"]'),
    ).toBeVisible();
    await expect(page.locator("[data-finance-panel]")).toContainText(
      "template exists, no Alexey approval",
    );
    await expect(statusMessage).not.toContainText(
      /Could not|Synthetic route missing/,
    );
    await page.locator('[data-record-tab="activity"]').click();
    const operatorArchive = page.locator("[data-record-archive-host]");
    await operatorArchive.locator("[data-record-archive] > summary").click();
    // A reopened record starts a fresh bounded archive page; the older
    // delivery arrives on demand, same as the first pass.
    await expect(operatorArchive).toContainText("Archived draft v2");
    await operatorArchive.getByRole("button", { name: /older/i }).click();
    await expect(operatorArchive).toContainText("Delivery delivered");
    await page.screenshot({
      path: ".tmp/sponsor-finance-operator-read-only.png",
      fullPage: true,
    });
    financeDisabled = true;
    await reopenDeal();
    await expect(page.locator("[data-finance-panel]")).toHaveCount(0);
    await page
      .locator("[data-crm-detail]")
      .screenshot({ path: ".tmp/sponsor-finance-disabled.png" });
    financeDisabled = false;
    financeRole = "operator";
    await reopenDeal();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => dakitShell.toggleDrawer(document.querySelector(".dk-shell"), false));
    await expect
      .poll(async () => {
        const box = await page.locator("#sidebar").boundingBox();
        return box ? box.x + box.width : 0;
      })
      .toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await expect(statusMessage).not.toContainText(
      /Could not|Synthetic route missing/,
    );
    expect(communicationResponses).toBe(communicationRequests.length);
    await page.screenshot({
      path: ".tmp/sponsor-crm-production-mobile.png",
      fullPage: true,
    });
    await context.close();
    const errorContext = await browser.newContext({ baseURL: server.baseURL }),
      errorPage = await errorContext.newPage();
    await errorPage.route("**/api/sponsor-crm/**", (route) =>
      route.fulfill({
        status: 403,
        json: { error: "Synthetic permission denied" },
      }),
    );
    await errorPage.route("**/api/notifications*", (route) =>
      route.fulfill({ json: { notifications: { items: [] } } }),
    );
    await gotoOwnedSponsorPage(errorPage);
    await errorPage.getByRole("link", { name: "CRM" }).click();
    await expect(errorPage.locator("[data-crm-message]")).toContainText(
      "Permission or API error",
    );
    await errorPage.waitForTimeout(250);
    await errorPage
      .locator(".sponsor-crm-surface")
      .screenshot({ path: ".tmp/sponsor-crm-production-error.png" });
    await errorContext.close();
  });
});
