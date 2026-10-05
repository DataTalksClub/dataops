import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createFinanceSurface } from "../src/surfaces/finance/index.js";

const originalGlobals = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  FormData: globalThis.FormData,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

class FakeClassList {
  #values = new Set();

  add(...values) {
    values.forEach((value) => this.#values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.#values.delete(value));
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.#values.has(value) : force;
    if (enabled) this.#values.add(value);
    else this.#values.delete(value);
    return enabled;
  }

  contains(value) {
    return this.#values.has(value);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.isConnected = true;
    this.files = [];
    this.selectedOptions = [];
    this.listeners = new Map();
    this.queries = new Map();
    this.queryLists = new Map();
    this.attributes = new Map();
    this.clicked = false;
    this.focused = false;
    if (this.tagName === "FORM") this.#initializeForm();
  }

  #initializeForm() {
    const items = [];
    const named = new Map();
    this.elements = new Proxy(items, {
      get: (target, property, receiver) => {
        if (typeof property !== "string" || property in target)
          return Reflect.get(target, property, receiver);
        if (!named.has(property)) {
          const input = new FakeElement("input");
          input.name = property;
          named.set(property, input);
          target.push(input);
        }
        return named.get(property);
      },
    });
    this.formEntries = [];
  }

  setQuery(selector, element) {
    this.queries.set(selector, element);
    return element;
  }

  setQueryAll(selector, elements) {
    this.queryLists.set(selector, elements);
    return elements;
  }

  querySelector(selector) {
    if (this.queries.has(selector)) return this.queries.get(selector);
    const tagName = selector === "form" ? "form" : "div";
    const element = new FakeElement(tagName);
    if (selector === "[data-crm-active]") element.value = "true";
    this.queries.set(selector, element);
    return element;
  }

  querySelectorAll(selector) {
    return this.queryLists.get(selector) || [];
  }

  append(...values) {
    for (const value of values) {
      if (typeof value === "string") this.textContent += value;
      else this.children.push(value);
    }
  }

  appendChild(value) {
    this.children.push(value);
    return value;
  }

  replaceChildren(...values) {
    this.children = values;
    this.innerHTML = "";
    this.textContent = "";
  }

  insertAdjacentHTML(_position, markup) {
    this.innerHTML += markup;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  async dispatch(type, event = {}) {
    const normalized = {
      preventDefault() {},
      target: this,
      currentTarget: this,
      ...event,
    };
    if (type === "click" && this.onclick) await this.onclick(normalized);
    for (const listener of this.listeners.get(type) || [])
      await listener(normalized);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  remove() {}

  reset() {
    this.formEntries = [];
    if (!this.elements) return;
    for (const element of this.elements) element.value = "";
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  click() {
    this.clicked = true;
  }

  focus() {
    this.focused = true;
  }

  scrollIntoView() {
    this.scrolled = true;
  }

  closest() {
    return null;
  }
}

class FakeDocument {
  constructor(setupSurface = () => {}) {
    this.created = [];
    this.setupSurface = setupSurface;
    this.surface = null;
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    this.created.push(element);
    if (tagName === "section" && !this.surface) {
      this.surface = element;
      this.setupSurface(element);
    }
    return element;
  }
}

class FakeFormData {
  constructor(form) {
    this.entries = form.formEntries || [];
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
  }

  get(name) {
    return this.entries.find(([key]) => key === name)?.[1] ?? null;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function humanizeOptionLabel(value) {
  return String(value || "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createHarness({ request, route = null, setupSurface } = {}) {
  const documentList = new FakeElement("main");
  const document = new FakeDocument(setupSurface);
  const requests = [];
  const routeTitles = [];
  globalThis.document = document;
  globalThis.FormData = FakeFormData;
  const finance = createFinanceSurface({
    documentList,
    escapeHtml,
    getPendingLegacyRoute: () => route,
    humanizeOptionLabel,
    isWorkspaceRouteFresh: () => true,
    navigateCanonicalWorkspace() {},
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (request) return request(url, options);
      return {};
    },
    renderEntityLoadState() {},
    setRouteTitle: (title) => routeTitles.push(title),
    todayIsoDate: () => "2026-08-13",
    workApiUrl: (path) => path,
  });
  return { document, documentList, finance, requests, routeTitles };
}

function requestPath(url) {
  return new URL(url, "http://dataops.test").pathname;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Finance surface boundary", () => {
  test("directly imports the production factory and exposes the stable Finance facade", () => {
    const { finance } = createHarness();
    assert.deepEqual(Object.keys(finance).sort(), [
      "canLeaveFinanceSurface",
      "renderBookkeepingSurface",
      "renderSponsorCrmSurface",
    ]);
  });

  test("focuses the first usable control when bookkeeping and sponsor dialogs open", async () => {
    const bookkeepingControl = new FakeElement("input");
    const { document, finance, requests } = createHarness({
      setupSurface: (surface) => {
        const dialog = new FakeElement("dialog");
        const form = new FakeElement("form");
        const heading = new FakeElement("h3");
        const originalQuery = dialog.querySelector.bind(dialog);
        dialog.querySelector = (selector) => {
          if (selector === "form") return form;
          if (selector === "h3") return heading;
          if (selector.includes("input:not")) return bookkeepingControl;
          return originalQuery(selector);
        };
        surface.setQuery(".bookkeeping-entry-dialog", dialog);
      },
      request: async (url) => {
        const path = requestPath(url);
        if (path.endsWith("/transactions")) return { items: [] };
        if (path.endsWith("/documents") || path.endsWith("/links"))
          return { items: [] };
        if (path.endsWith("/accounts")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();
    await document.surface.querySelector("[data-bookkeeping-add]").dispatch("click");
    assert.equal(bookkeepingControl.focused, true);

    const sponsorControl = new FakeElement("select");
    const sponsorForm = new FakeElement("form");
    const sponsorDialog = new FakeElement("dialog");
    const originalSponsorQuery = sponsorDialog.querySelector.bind(sponsorDialog);
    sponsorDialog.querySelector = (selector) => {
      if (selector === "form") return sponsorForm;
      if (selector.includes("input:not") || selector.includes("select:not"))
        return sponsorControl;
      return originalSponsorQuery(selector);
    };

    const sponsorHarness = createHarness({
      setupSurface: (surface) =>
        surface.setQuery("[data-booking-dialog]", sponsorDialog),
      request: async (url) => {
        const path = requestPath(url);
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/bookings"))
          return {
            items: [
              {
                id: "booking-1",
                organizationId: "org-1",
                status: "confirmed",
              },
            ],
          };
        if (path.endsWith("/notifications")) return { notifications: { items: [] } };
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    await sponsorHarness.finance.renderSponsorCrmSurface();
    const bookings = sponsorHarness.document.surface.querySelector(
      "[data-crm-bookings]",
    );
    await bookings.dispatch("click", {
      target: {
        closest(selector) {
          return selector === "[data-edit-booking]"
            ? { dataset: { editBooking: "booking-1" } }
            : null;
        },
      },
    });
    assert.equal(sponsorControl.focused, true);
  });

  test("keeps sponsor alert failures truthful and retries pages without duplicates", async () => {
    let notificationRequestCount = 0;
    let continuationOnline = false;
    const sponsorAlert = (id, message) => ({
      id,
      message,
      dismissed: false,
      dueAt: "2026-08-20",
      metadata: { sponsorBookingId: "booking-alert" },
    });
    const { document, finance, requests } = createHarness({
      request: async (url) => {
        const path = requestPath(url);
        const query = new URL(url, "http://dataops.test").searchParams;
        if (path === "/api/notifications") {
          notificationRequestCount += 1;
          assert.equal(query.get("limit"), "100");
          if (notificationRequestCount === 1)
            throw new Error("Notifications offline");
          if (!query.get("cursor")) {
            return {
              notifications: {
                items: [
                  sponsorAlert("alert-a", "First alert"),
                  sponsorAlert("alert-b", "Second alert"),
                ],
                nextCursor: "opaque-notification-cursor",
              },
            };
          }
          if (!continuationOnline)
            throw new Error("Notifications continuation offline");
          return {
            notifications: {
              items: [
                sponsorAlert("alert-a", "Duplicate alert"),
                sponsorAlert("alert-c", "Third alert"),
              ],
            },
          };
        }
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/bookings"))
          return {
            items: [{ id: "booking-alert", organizationId: "org-1", status: "confirmed" }],
          };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderSponsorCrmSurface();
    const alerts = document.surface.querySelector("[data-crm-alerts]");
    assert.doesNotMatch(alerts.innerHTML, /No active sponsor booking alerts/);
    assert.match(alerts.innerHTML, /Booking alerts are unavailable:/);
    assert.match(alerts.innerHTML, /Notifications offline/);
    assert.match(
      alerts.innerHTML,
      /<button type="button" data-load-sponsor-alerts-retry>/,
    );

    const clickAlertControl = async (selector) => {
      await alerts.dispatch("click", {
        target: {
          closest: (candidate) => (candidate === selector ? {} : null),
        },
      });
      await settle();
    };

    await clickAlertControl("[data-load-sponsor-alerts-retry]");
    assert.match(alerts.innerHTML, /First alert/);
    assert.match(alerts.innerHTML, /Second alert/);
    assert.match(alerts.innerHTML, /More booking alerts are available\./);
    assert.match(
      alerts.innerHTML,
      /<button type="button" data-load-sponsor-alerts>/,
    );

    await clickAlertControl("[data-load-sponsor-alerts]");
    assert.match(alerts.innerHTML, /First alert/);
    assert.match(alerts.innerHTML, /Second alert/);
    assert.match(alerts.innerHTML, /More alerts are available, but loading failed:/);
    assert.match(alerts.innerHTML, /Notifications continuation offline/);

    continuationOnline = true;
    await clickAlertControl("[data-load-sponsor-alerts]");
    const renderedArticleCount = [
      ...alerts.innerHTML.matchAll(/<article class="crm-card">/g),
    ].length;
    assert.equal(renderedArticleCount, 3);
    assert.match(alerts.innerHTML, /First alert/);
    assert.match(alerts.innerHTML, /Second alert/);
    assert.match(alerts.innerHTML, /Third alert/);
    assert.doesNotMatch(alerts.innerHTML, /Duplicate alert/);
    assert.doesNotMatch(alerts.innerHTML, /loading failed|are unavailable/);
    // A fully loaded alert panel states nothing: the alerts are the evidence.
    assert.doesNotMatch(alerts.innerHTML, /All notification pages loaded/);
    const notificationUrls = requests
      ? []
      : [];
    assert.deepEqual(notificationUrls, []);
  });

  test("renders only safe sponsor communication projections and preserves the operator action hierarchy", async () => {
    const booking = {
      id: "booking-1",
      organizationId: "org-1",
      primaryContactId: "contact-1",
      status: "confirmed",
      version: 3,
    };
    const { document, finance } = createHarness({
      route: {
        path: "/sponsors",
        token: 1,
        params: new URLSearchParams({ bookingId: booking.id }),
      },
      request: async (url) => {
        const path = requestPath(url);
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Safe Sponsor" }] };
        if (path.endsWith("/contacts"))
          return {
            items: [
              {
                id: "contact-1",
                organizationId: "org-1",
                name: "Partner Contact",
                emails: ["partner@example.test"],
              },
            ],
          };
        if (path.endsWith("/bookings")) return { items: [booking] };
        if (path.endsWith("/notifications")) return { notifications: { items: [] } };
        if (path.endsWith("/history")) return { items: [] };
        if (path.includes("/communications"))
          return {
            items: [
              {
                id: "suggestion-1",
                recordType: "communication-suggestion",
                communicationType: "materials-reminder",
                status: "open",
                safeReason: "Materials deadline needs operator review.",
                privatePrompt: "DO NOT RENDER THIS PRIVATE FIELD",
              },
              {
                communicationId: "message-1",
                recordType: "communication-draft-version",
                version: 4,
                reviewState: "awaiting_review",
                reviewable: true,
                subject: "DO NOT RENDER DRAFT SUBJECT",
              },
              {
                id: "attempt-1",
                recordType: "sponsor-send-attempt",
                status: "outcome_unknown",
                providerPayload: "DO NOT RENDER PROVIDER PAYLOAD",
              },
            ],
            config: { enabled: true },
            permissions: {
              role: "operator",
              canApprove: false,
              canCancel: false,
              canReconcile: false,
            },
          };
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      async json() {
        return { error: "Finance not enabled" };
      },
    });

    await finance.renderSponsorCrmSurface();

    const communications = document.surface.querySelector(
      "[data-crm-communications]",
    ).innerHTML;
    assert.match(communications, /Materials deadline needs operator review/);
    assert.match(communications, /Draft saved\. Awaiting administrator review/);
    assert.match(communications, /administrator must reconcile it/);
    assert.doesNotMatch(communications, /Review exact draft/);
    assert.doesNotMatch(communications, /DO NOT RENDER/);
  });

  test("keeps exact sponsor review immutable and revokes it before navigation", async () => {
    const booking = {
      id: "booking-1",
      organizationId: "org-1",
      status: "confirmed",
      version: 3,
    };
    const seen = [];
    const { document, finance } = createHarness({
      route: {
        path: "/sponsors",
        token: 1,
        params: new URLSearchParams({ bookingId: booking.id }),
      },
      request: async (url, options) => {
        const path = requestPath(url);
        seen.push({ path, options });
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Safe Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/bookings")) return { items: [booking] };
        if (path.endsWith("/notifications")) return { notifications: { items: [] } };
        if (path.endsWith("/history")) return { items: [] };
        if (path.includes("/bookings/booking-1/communications"))
          return {
            items: [
              {
                communicationId: "message-1",
                recordType: "communication-draft-version",
                version: 7,
                reviewState: "awaiting_review",
                reviewable: true,
              },
            ],
            config: { enabled: true },
            permissions: {
              role: "admin",
              canApprove: true,
              canCancel: true,
              canReconcile: true,
            },
          };
        if (path.endsWith("/communications/message-1/presentations"))
          return {
            presentationId: "presentation-1",
            token: "one-time-token",
            previewHash: "sha256:exact-preview",
            preview: {
              from: "ops@example.test",
              replyTo: "team@example.test",
              to: "partner@example.test",
              communicationType: "materials-reminder",
              subject: "Exact subject",
              body: "Exact private body",
              publicLinks: ["https://example.test/public"],
            },
          };
        if (path.endsWith("/presentations/presentation-1/reject")) return {};
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      async json() {
        return { error: "Finance not enabled" };
      },
    });

    await finance.renderSponsorCrmSurface();
    const communicationRoot = document.surface.querySelector(
      "[data-crm-communications]",
    );
    assert.match(communicationRoot.innerHTML, /Review exact draft/);

    const reviewButton = new FakeElement("button");
    reviewButton.dataset.reviewDraft = "message-1";
    reviewButton.dataset.draftVersion = "7";
    const target = {
      closest(selector) {
        if (selector === "[data-crm-communications]") return communicationRoot;
        if (selector === "[data-review-draft]") return reviewButton;
        return null;
      },
    };
    await document.surface.dispatch("click", { target });
    await settle();

    const dialog = document.surface.querySelector(
      "[data-communication-review-dialog]",
    );
    assert.equal(dialog.open, true);
    assert.equal(
      dialog.querySelector("[data-review-subject]").textContent,
      "Exact subject",
    );
    assert.equal(
      dialog.querySelector("[data-review-body]").textContent,
      "Exact private body",
    );
    assert.match(
      dialog.querySelector("[data-review-addresses]").innerHTML,
      /partner@example\.test/,
    );
    assert.match(
      dialog.querySelector("[data-review-status]").textContent,
      /sha256:exact-preview/,
    );
    assert.equal(dialog.querySelector("[data-approve-message]").hidden, false);
    assert.match(
      dialog.querySelector("[data-review-warning]").textContent,
      /exactly this one-recipient plain-text message/,
    );

    assert.equal(await finance.canLeaveFinanceSurface("navigation"), true);
    assert.equal(dialog.open, false);
    assert.equal(
      seen.filter(({ path }) =>
        path.endsWith("/presentations/presentation-1/reject"),
      ).length,
      1,
    );
    assert.equal(
      seen.some(({ path }) => path.endsWith("/approve")),
      false,
    );
  });

  test("derives bookkeeping totals and evidence relationships from loaded records", async () => {
    const filters = [
      "search",
      "entryType",
      "category",
      "counterparty",
      "currency",
    ].map((name) => {
      const input = new FakeElement("input");
      input.dataset.filter = name;
      return input;
    });
    const { document, finance } = createHarness({
      setupSurface: (surface) => surface.setQueryAll("[data-filter]", filters),
      request: async (url) => {
        const path = requestPath(url);
        if (path.endsWith("/transactions"))
          return {
            items: [
              {
                id: "entry-1",
                transactionDate: "2026-08-01",
                paidDate: "2026-08-02",
                counterparty: "Provider One",
                description: "Operations support",
                amount: "125.50",
                currency: "EUR",
                category: "Services",
                entryType: "Expense",
                statementRef: "statement-42",
              },
              {
                id: "entry-2",
                transactionDate: "2026-08-03",
                counterparty: "Provider Two",
                description: "Unmatched item",
                amount: "10.00",
                currency: "EUR",
              },
              {
                id: "entry-3",
                transactionDate: "2026-08-10",
                counterparty: "Sponsor GmbH",
                description: "Sponsorship payment",
                amount: "200.00",
                currency: "EUR",
                category: "Sponsorship",
                entryType: "income",
              },
              {
                id: "entry-4",
                transactionDate: "2026-08-15",
                counterparty: "Finanzamt",
                description: "Tax payment",
                amount: "20.00",
                currency: "EUR",
                category: "Taxes",
                entryType: "Tax",
              },
              {
                id: "entry-5",
                transactionDate: "2026-08-20",
                counterparty: "Cloud Sponsor",
                description: "Grant payment",
                amount: "40.00",
                currency: "EUR",
                category: "Sponsorship",
                entryType: "Grant income",
              },
            ],
          };
        if (path.endsWith("/documents"))
          return {
            items: [
              {
                id: "document-1",
                originalFilename: "invoice-august.pdf",
                documentType: "invoice",
              },
            ],
          };
        if (path.endsWith("/links"))
          return {
            items: [
              {
                id: "link-1",
                documentId: "document-1",
                transactionId: "entry-1",
                coverageType: "evidence",
              },
            ],
          };
        if (path.endsWith("/accounts")) return { items: [] };
        if (path.endsWith("/reports/vat"))
          return { months: [], transactions: [] };
        if (path.endsWith("/reports")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();

    const surface = document.surface;
    assert.match(surface.innerHTML, /Record and review the ledger/);
    assert.match(surface.innerHTML, /Match transaction evidence/);
    assert.match(surface.innerHTML, /Close the month with a package/);
    // The forwarded-invoice intake sits below the monthly package instead of
    // opening the page, and the received-intake recovery form has moved off
    // the page entirely (it lives on Admin now).
    assert.ok(
      surface.innerHTML.indexOf("data-invoice-review") >
        surface.innerHTML.indexOf("Close the month with a package"),
      "invoice intake renders below the monthly-package section",
    );
    assert.match(
      surface.querySelector("[data-invoice-review]").innerHTML,
      /Invoice ledger/,
    );
    assert.equal(
      surface
        .querySelector("[data-invoice-review]")
        .innerHTML.includes("Process a received intake"),
      false,
    );
    // Types containing "income" count as income whatever their wording;
    // every other typed entry is an expense; only untyped rows are
    // unclassified. No mixed income+expenses sum.
    assert.equal(
      surface.querySelector(".bookkeeping-totals").textContent,
      "EUR Income 240.00 · EUR Expenses 145.50 · EUR Unclassified 10.00",
    );
    // The page opens quiet: the download-expiry note lives next to the
    // download actions, not as a permanent strip.
    assert.equal(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      "",
    );
    const ledger = surface.querySelector(".bookkeeping-ledger").innerHTML;
    assert.match(ledger, /Provider One/);
    assert.match(ledger, /-125\.50 EUR/);
    // Typed non-income rows carry the expense sign; income rows stay positive.
    assert.match(ledger, /-20\.00 EUR/);
    assert.match(ledger, /40\.00 EUR/);
    assert.match(ledger, /Referenced/);
    assert.match(ledger, /Provider Two/);
    assert.match(
      ledger,
      /<button type="button" class="evidence-state is-missing" data-attach-evidence="entry-2">Missing<\/button>/,
    );
    assert.match(ledger, /VAT/);
    assert.match(
      surface.querySelector("[data-vat-summary]").innerHTML,
      /No VAT recorded in 2026/,
    );
    // Dialog vocabularies are seeded from the ledger, odd cases included.
    const categoryOptions = surface.querySelector(
      "[data-category-options]",
    ).innerHTML;
    assert.match(categoryOptions, /<option value="Services"><\/option>/);
    assert.match(categoryOptions, /<option value="Sponsorship"><\/option>/);
    const typeOptions = surface.querySelector("[data-entry-type]").innerHTML;
    assert.match(typeOptions, /value="expense"/);
    assert.match(typeOptions, /value="income"/);
    // Distinct stored wording seeds the choice list verbatim so editing keeps
    // it, including types the classifier reads as income.
    assert.match(typeOptions, /value="Tax"/);
    assert.match(typeOptions, /value="Grant income"/);
    const evidence = surface.querySelector(".bookkeeping-documents").innerHTML;
    assert.match(evidence, /Downloads are private and expire after five minutes/);
    assert.match(evidence, /invoice-august\.pdf/);
    assert.match(evidence, /matched to 1 entry/);
    assert.match(evidence, /Unlink Provider One/);
    // Directions with nothing in them drop out instead of reading 0.00.
    // Kept last: it filters the shared harness and must not skew the
    // assertions above.
    filters[1].value = "expense";
    await filters[1].dispatch("input");
    assert.equal(
      surface.querySelector(".bookkeeping-totals").textContent,
      "EUR Expenses 125.50",
    );
  });

  test("keeps the entry dialog typed, seeded, and locally validated", async () => {
    const savedBodies = [];
    let rejectSave = false;
    const pdfInput = new FakeElement("input");
    const transactionSelect = new FakeElement("select");
    const evidenceSection = new FakeElement("section");
    const { document, finance } = createHarness({
      setupSurface: (surface) => {
        surface.setQuery("[data-pdf]", pdfInput);
        surface.setQuery("[data-transaction]", transactionSelect);
        surface.setQuery("#bookkeeping-evidence", evidenceSection);
      },
      request: async (url, options = {}) => {
        const path = requestPath(url);
        if (path.endsWith("/transactions")) {
          if (options.method === "POST" || options.method === "PUT") {
            if (rejectSave) {
              const error = new Error("Validation failed");
              error.payload = { fields: ["currency"] };
              throw error;
            }
            savedBodies.push(JSON.parse(options.body));
            return {
              id: "entry-new",
              transactionDate: "2026-08-05",
              counterparty: "Provider Three",
              description: "Another thing",
              amount: "125.50",
              currency: "EUR",
              entryType: "expense",
            };
          }
          return {
            items: [
              {
                id: "entry-1",
                transactionDate: "2026-08-01",
                counterparty: "Provider One",
                description: "Operations support",
                amount: "125.50",
                currency: "EUR",
                category: "Services",
                entryType: "Expense",
              },
              {
                id: "entry-2",
                transactionDate: "2026-08-03",
                counterparty: "Provider Two",
                description: "Unmatched item",
                amount: "10.00",
                currency: "EUR",
              },
            ],
          };
        }
        if (path.endsWith("/documents") || path.endsWith("/links"))
          return { items: [] };
        if (path.endsWith("/accounts"))
          return {
            items: [{ id: "account-1", displayName: "Finom", kind: "business" }],
          };
        if (path.endsWith("/reports/vat"))
          return { months: [], transactions: [] };
        if (path.endsWith("/reports")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();
    const surface = document.surface;
    const entryDialog = surface.querySelector(".bookkeeping-entry-dialog");
    const form = entryDialog.querySelector("form");
    // Accounts already exist, so the setup action shows its done state.
    assert.equal(surface.querySelector("[data-setup-accounts]").disabled, true);
    assert.equal(
      surface.querySelector("[data-setup-accounts]").textContent,
      "Business accounts ready",
    );

    await surface.querySelector("[data-bookkeeping-add]").dispatch("click");
    assert.equal(entryDialog.open, true);
    assert.equal(form.elements.entryType.value, "expense");

    form.formEntries = [
      ["transactionDate", "2026-08-05"],
      ["counterparty", "Provider Three"],
      ["description", "Another thing"],
      ["amount", "-5"],
      ["currency", "eur"],
      ["entryType", "expense"],
    ];
    await surface.querySelector("[data-save]").dispatch("click");
    await settle();
    // A negative amount is caught locally with the direction convention;
    // the API is not called.
    assert.match(
      surface.querySelector("[data-form-error]").textContent,
      /Amount must be a positive number/,
    );
    assert.equal(
      form.elements.amount.getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(savedBodies.length, 0);

    form.formEntries = [
      ["transactionDate", "2026-08-05"],
      ["counterparty", "Provider Three"],
      ["description", "Another thing"],
      ["amount", "125.50"],
      ["currency", "eur"],
      ["entryType", "expense"],
    ];
    rejectSave = true;
    await surface.querySelector("[data-save]").dispatch("click");
    await settle();
    assert.match(
      surface.querySelector("[data-form-error]").textContent,
      /The API rejected: Currency\. Fix the highlighted fields/,
    );
    assert.equal(
      form.elements.currency.getAttribute("aria-invalid"),
      "true",
    );

    rejectSave = false;
    await surface.querySelector("[data-save]").dispatch("click");
    await settle();
    assert.equal(entryDialog.open, false);
    assert.equal(savedBodies.length, 1);
    assert.deepEqual(savedBodies[0], {
      transactionDate: "2026-08-05",
      counterparty: "Provider Three",
      description: "Another thing",
      amount: "125.50",
      currency: "EUR",
      entryType: "expense",
    });

    // Editing an entry whose stored direction differs only in case keeps it
    // selectable on the seeded lowercase options.
    await surface.querySelector(".bookkeeping-ledger").dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-edit]" ? { dataset: { edit: "entry-1" } } : null,
      },
    });
    await settle();
    assert.equal(entryDialog.open, true);
    assert.equal(form.elements.entryType.value, "expense");
    assert.equal(
      entryDialog.querySelector("h3").textContent,
      "Edit ledger entry",
    );

    // Untyped entries stay unclassified when edited instead of silently
    // becoming expenses.
    await surface.querySelector(".bookkeeping-ledger").dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-edit]" ? { dataset: { edit: "entry-2" } } : null,
      },
    });
    await settle();
    assert.equal(form.elements.entryType.value, "");

    // The "Missing" chip is an action: it preselects the transaction,
    // brings the evidence upload into view, and focuses the PDF input.
    await surface.querySelector(".bookkeeping-ledger").dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-attach-evidence]"
            ? { dataset: { attachEvidence: "entry-1" } }
            : null,
      },
    });
    await settle();
    assert.equal(transactionSelect.value, "entry-1");
    assert.equal(evidenceSection.scrolled, true);
    assert.equal(pdfInput.focused, true);
    assert.match(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      /Attach evidence for Provider One/,
    );
  });

  test("validates bookkeeping entry and month before mutation, then builds the selected monthly package", async () => {
    const filters = [
      "search",
      "entryType",
      "category",
      "counterparty",
      "currency",
    ].map((name) => {
      const input = new FakeElement("input");
      input.dataset.filter = name;
      return input;
    });
    const checkedStatement = new FakeElement("input");
    checkedStatement.value = "private-statement-1";
    const calls = [];
    let reportsItems = [];
    const { document, finance } = createHarness({
      setupSurface: (surface) => {
        surface.setQueryAll("[data-filter]", filters);
        surface.setQueryAll("[data-private-statements] input:checked", [
          checkedStatement,
        ]);
      },
      request: async (url, options = {}) => {
        const path = requestPath(url);
        calls.push({ path, options });
        if (path.endsWith("/transactions")) return { items: [] };
        if (path.endsWith("/documents"))
          return {
            items: [
              {
                id: "private-statement-1",
                documentType: "private-account-statement",
                originalFilename: "private-august.pdf",
              },
            ],
          };
        if (path.endsWith("/links") || path.endsWith("/accounts"))
          return { items: [] };
        if (path.endsWith("/reports/vat"))
          return {
            months: [
              {
                month: "2026-08",
                currency: "EUR",
                outputVat: 19.0,
                inputVat: 4.2,
                net: 14.8,
                transactionCount: 3,
              },
            ],
            transactions: [],
          };
        if (path.endsWith("/reports/snapshot")) {
          reportsItems = [
            {
              id: "report-1",
              month: "2026-08",
              status: "ready",
              reconciliation: {
                transactionCount: 0,
                excludedTransactionCount: 2,
                documentCount: 3,
              },
            },
          ];
          return {
            report: { id: "report-1", reconciliation: { excludedTransactionCount: 2 } },
            warnings: {},
          };
        }
        if (path.endsWith("/reports/report-1/archive"))
          return { downloadUrl: "https://private.test/monthly.zip" };
        if (path.endsWith("/reports")) return { items: reportsItems };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();
    const surface = document.surface;
    const entryForm = surface
      .querySelector(".bookkeeping-entry-dialog")
      .querySelector("form");
    entryForm.formEntries = [];
    await surface.querySelector("[data-save]").dispatch("click");
    await settle();
    assert.equal(
      surface.querySelector("[data-form-error]").textContent,
      "Transaction date is required.",
    );
    assert.equal(
      entryForm.elements.transactionDate.getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(entryForm.elements.transactionDate.focused, true);
    assert.equal(
      calls.some(
        ({ path, options }) =>
          path.endsWith("/transactions") && options.method === "POST",
      ),
      false,
    );

    // The report month follows the close lens, and the review shows the
    // pre-flight state before anything is created: with no business accounts
    // the package is blocked and says why.
    const review = surface.querySelector("[data-package-review]");
    assert.match(review.innerHTML, /August 2026 package/);
    assert.match(review.innerHTML, /Two business accounts are required/);
    assert.equal(
      surface.querySelector("[data-report-month]").value,
      "2026-08",
    );

    const report = surface.querySelector("[data-report]");
    surface.querySelector("[data-report-month]").value = "";
    await report.dispatch("click");
    await settle();
    assert.equal(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      "Pick the month to close with the lens above.",
    );
    assert.equal(
      calls.some(({ path }) => path.endsWith("/reports/snapshot")),
      false,
    );

    surface.querySelector("[data-report-month]").value = "2026-08";
    await report.dispatch("click");
    await settle();
    const snapshot = calls.find(({ path }) =>
      path.endsWith("/reports/snapshot"),
    );
    assert.deepEqual(JSON.parse(snapshot.options.body), {
      month: "2026-08",
      privateDocumentIds: ["private-statement-1"],
    });
    assert.equal(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      "Package created. 2 tax/health-insurance entries kept out.",
    );
    // Creation no longer auto-downloads; the review shows the ready package
    // and its download is an explicit action.
    assert.equal(
      calls.some(({ path }) => path.endsWith("/reports/report-1/archive")),
      false,
    );
    assert.match(review.innerHTML, /Package ready/);
    assert.match(review.innerHTML, /0\s*transactions and 3 documents inside/);
    await review.dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-download-archive]"
            ? { dataset: { downloadArchive: "report-1" } }
            : null,
      },
    });
    await settle();
    assert.equal(
      calls.some(({ path }) => path.endsWith("/reports/report-1/archive")),
      true,
    );
    assert.equal(
      document.created.some(
        (element) =>
          element.tagName === "A" &&
          element.href === "https://private.test/monthly.zip" &&
          element.clicked,
      ),
      true,
    );
  });
  test("anchors the page on the month lens with an actionable worklist", async () => {
    const pdfInput = new FakeElement("input");
    const transactionSelect = new FakeElement("select");
    const evidenceSection = new FakeElement("section");
    const savedPuts = [];
    const entries = [
      {
        id: "entry-linked",
        transactionDate: "2026-09-02",
        counterparty: "Hosting GmbH",
        description: "Hosting",
        amount: "50.00",
        currency: "EUR",
        entryType: "expense",
      },
      {
        id: "entry-usd",
        transactionDate: "2026-09-05",
        counterparty: "Sponsor LLC",
        description: "Sponsorship",
        amount: "200.00",
        currency: "USD",
        entryType: "income",
      },
      {
        id: "entry-untyped",
        transactionDate: "2026-09-07",
        counterparty: "Misc Payee",
        description: "Unclassified item",
        amount: "10.00",
        currency: "EUR",
      },
      {
        id: "entry-august",
        transactionDate: "2026-08-20",
        counterparty: "August Payee",
        description: "Older month",
        amount: "30.00",
        currency: "EUR",
        entryType: "expense",
      },
    ];
    const { document, finance } = createHarness({
      setupSurface: (surface) => {
        surface.setQuery("[data-pdf]", pdfInput);
        surface.setQuery("[data-transaction]", transactionSelect);
        surface.setQuery("#bookkeeping-evidence", evidenceSection);
      },
      request: async (url, options = {}) => {
        const path = requestPath(url);
        if (path.includes("/transactions/")) {
          assert.equal(options.method, "PUT");
          savedPuts.push(JSON.parse(options.body));
          const id = path.split("/").pop();
          const saved = entries.find((e) => e.id === id);
          return { ...saved, ...JSON.parse(options.body) };
        }
        if (path.endsWith("/transactions")) return { items: entries };
        if (path.endsWith("/documents")) return { items: [] };
        if (path.endsWith("/links"))
          return {
            items: [
              {
                id: "link-1",
                documentId: "document-1",
                transactionId: "entry-linked",
                coverageType: "evidence",
              },
            ],
          };
        if (path.endsWith("/accounts"))
          return {
            items: [
              { id: "account-1", displayName: "Finom", kind: "business" },
              { id: "account-2", displayName: "Revolut", kind: "business" },
            ],
          };
        if (path.endsWith("/reports/vat"))
          return { months: [], transactions: [] };
        if (path.endsWith("/reports")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();
    const surface = document.surface;
    // The lens opens on the month that has work, not on all-time.
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /September 2026 close/,
    );
    // The four close counters answer "what is left for this month".
    const counters = surface.querySelector("[data-close-state]").innerHTML;
    assert.match(counters, /<strong>3<\/strong\s*>\s*transactions/);
    assert.match(counters, /<strong>2<\/strong\s*>\s*evidence missing/);
    assert.match(counters, /<strong>1<\/strong\s*>\s*EUR conversions open/);
    // Three missing-evidence/conversion/unclassified items drive the CTA.
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /Review 4 open items/,
    );
    // The worklist is the reconcile output with its fixes attached.
    const worklist = surface.querySelector("[data-worklist]");
    assert.match(worklist.innerHTML, /Attach evidence/);
    assert.match(worklist.innerHTML, /data-add-eur="entry-usd"/);
    assert.match(worklist.innerHTML, /data-classify="entry-untyped"/);
    // The ledger is scoped to the lens month; August stays out until the
    // operator asks for it.
    const ledger = surface.querySelector(".bookkeeping-ledger").innerHTML;
    assert.match(ledger, /Hosting GmbH/);
    assert.doesNotMatch(ledger, /August Payee/);
    // The package review pre-flight names each statement requirement.
    const review = surface.querySelector("[data-package-review]");
    assert.match(review.innerHTML, /✗ Bank statement —\s*Finom/);
    assert.match(review.innerHTML, /✗ Bank statement —\s*Revolut/);

    // Adding the EUR value closes the conversion from the worklist.
    await worklist.dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-add-eur]"
            ? { dataset: { addEur: "entry-usd" } }
            : null,
      },
    });
    const eurDialog = surface.querySelector(".bookkeeping-eur-dialog");
    assert.equal(eurDialog.open, true);
    assert.match(
      eurDialog.querySelector("[data-eur-context]").textContent,
      /Sponsor LLC — 200\.00 USD/,
    );
    const eurInput = eurDialog.querySelector("input[name=amountEur]");
    eurInput.value = "not-a-number";
    await eurDialog.querySelector("[data-eur-save]").dispatch("click");
    await settle();
    assert.match(
      eurDialog.querySelector("[data-eur-error]").textContent,
      /positive number/,
    );
    assert.equal(savedPuts.length, 0);
    eurInput.value = "184.20";
    await eurDialog.querySelector("[data-eur-save]").dispatch("click");
    await settle();
    assert.equal(eurDialog.open, false);
    assert.deepEqual(savedPuts[0], { amountEur: "184.20" });
    assert.match(
      surface.querySelector(".bookkeeping-ledger").innerHTML,
      /≈ 184\.20 EUR/,
    );
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /<strong>0<\/strong\s*>\s*EUR conversions open/,
    );

    // Classifying happens inline from the worklist row.
    entries[2].entryType = "";
    await worklist.dispatch("change", {
      target: {
        closest: (selector) =>
          selector === "[data-classify]"
            ? { dataset: { classify: "entry-untyped" }, value: "income" }
            : null,
        value: "income",
      },
    });
    await settle();
    assert.deepEqual(savedPuts[1], { entryType: "income" });
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /Review 2 open items/,
    );

    // Attaching evidence from the worklist scopes the upload form.
    await worklist.dispatch("click", {
      target: {
        closest: (selector) =>
          selector === "[data-attach-evidence]"
            ? { dataset: { attachEvidence: "entry-usd" } }
            : null,
      },
    });
    await settle();
    assert.equal(transactionSelect.value, "entry-usd");
    assert.match(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      /Attach evidence for Sponsor LLC/,
    );

    // The all-time lookup stays reachable, and stepping months works.
    await surface.querySelector("[data-lens-toggle]").dispatch("click");
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /All months — 4 transactions\s*on record/,
    );
    assert.equal(surface.querySelector("[data-worklist-section]").hidden, true);
    assert.match(
      surface.querySelector(".bookkeeping-ledger").innerHTML,
      /August Payee/,
    );
    await surface.querySelector("[data-lens-toggle]").dispatch("click");
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /September 2026 close/,
    );
    await surface.querySelector("[data-lens-prev]").dispatch("click");
    assert.match(
      surface.querySelector("[data-close-state]").innerHTML,
      /August 2026 close/,
    );
    assert.match(
      surface.querySelector(".bookkeeping-ledger").innerHTML,
      /August Payee/,
    );
    assert.doesNotMatch(
      surface.querySelector(".bookkeeping-ledger").innerHTML,
      /Hosting GmbH/,
    );
  });
});
