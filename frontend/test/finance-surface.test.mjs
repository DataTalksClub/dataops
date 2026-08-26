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

  scrollIntoView() {}

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
      "renderMailingExportsSurface",
      "renderSponsorCrmSurface",
    ]);
  });

  test("focuses the first usable control when bookkeeping and sponsor dialogs open", async () => {
    const bookkeepingControl = new FakeElement("input");
    const { document, finance } = createHarness({
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
        if (path.endsWith("/notifications")) return { notifications: [] };
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
        if (path.endsWith("/notifications")) return { notifications: [] };
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
        if (path.endsWith("/notifications")) return { notifications: [] };
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
      "year",
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
              },
            ],
          };
        if (path.endsWith("/accounts")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderBookkeepingSurface();

    const surface = document.surface;
    assert.match(surface.innerHTML, /Record and review the ledger/);
    assert.match(surface.innerHTML, /Match transaction evidence/);
    assert.match(surface.innerHTML, /Prepare the monthly package/);
    assert.equal(
      surface.querySelector(".bookkeeping-totals").textContent,
      "EUR 135.50",
    );
    const ledger = surface.querySelector(".bookkeeping-ledger").innerHTML;
    assert.match(ledger, /Provider One/);
    assert.match(ledger, /Referenced/);
    assert.match(ledger, /Provider Two/);
    assert.match(ledger, /Missing/);
    const evidence = surface.querySelector(".bookkeeping-documents").innerHTML;
    assert.match(evidence, /invoice-august\.pdf/);
    assert.match(evidence, /matched to 1 entry/);
    assert.match(evidence, /Unlink Provider One/);
  });

  test("validates bookkeeping entry and month before mutation, then builds the selected monthly package", async () => {
    const filters = [
      "search",
      "year",
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
        if (path.endsWith("/reports/snapshot"))
          return { report: { id: "report-1" }, warnings: {} };
        if (path.endsWith("/reports/report-1/archive"))
          return { downloadUrl: "https://private.test/monthly.zip" };
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

    const report = surface.querySelector("[data-report]");
    await report.dispatch("click");
    await settle();
    assert.equal(
      surface.querySelector("[data-bookkeeping-status]").textContent,
      "Choose a report month.",
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

  test("renders an honest no-configuration mailing state without offering a run", async () => {
    const { document, finance } = createHarness({
      request: async () => ({ configs: [], exports: [] }),
    });

    await finance.renderMailingExportsSurface();

    const surface = document.surface;
    assert.match(
      surface.querySelector("[data-configs]").innerHTML,
      /data-export-state="no-config"/,
    );
    assert.match(
      surface.querySelector("[data-configs]").innerHTML,
      /No export configurations/,
    );
    assert.doesNotMatch(
      surface.querySelector("[data-configs]").innerHTML,
      /data-run=/,
    );
    assert.match(
      surface.querySelector("[data-history]").innerHTML,
      /data-export-state="empty"/,
    );
    assert.equal(
      surface.querySelector('[role="status"]').textContent,
      "No export configurations are enabled.",
    );
  });

  test("maps mailing runs and an absent run to stable next actions", async () => {
    const requestedAt = "2026-08-12T08:00:00.000Z";
    const completedAt = "2026-08-12T09:00:00.000Z";
    const configs = [
      ["pending", "Account pending"],
      ["failed", "Account failed"],
      ["completed", "Account completed"],
      ["empty", "Account empty"],
    ].map(([id, account]) => ({
      id,
      account,
      scopeLabel: "All contacts",
      provider: "Mailchimp",
    }));
    const exports = [
      {
        configId: "pending",
        account: "Account pending",
        scopeLabel: "All contacts",
        status: "pending",
        nextAction: "wait",
        runKey: "durable-pending-key",
        requestedAt,
      },
      {
        configId: "failed",
        account: "Account failed",
        scopeLabel: "All contacts",
        status: "failed",
        nextAction: "fix-storage",
        runKey: "durable-failed-key",
        errorCode: "archive_write_failed",
        errorMessage: "Private archive was not stored.",
        requestedAt,
      },
      {
        configId: "completed",
        account: "Account completed",
        scopeLabel: "All contacts",
        status: "completed",
        nextAction: "download",
        artifactId: "artifact-1",
        requestedAt,
        completedAt,
      },
    ];
    const { document, finance } = createHarness({
      request: async () => ({ configs, exports }),
    });

    await finance.renderMailingExportsSurface();

    const cards = document.surface.querySelector("[data-configs]").innerHTML;
    assert.match(cards, /data-export-state="pending"/);
    assert.match(
      cards,
      /Wait for the provider, then refresh or advance this run/,
    );
    assert.match(cards, /data-run-key="durable-pending-key"/);
    assert.match(cards, /data-export-state="failed"/);
    assert.match(cards, /Fix private storage access, then retry/);
    assert.match(cards, /archive_write_failed/);
    assert.match(cards, /data-run-key="durable-failed-key"/);
    assert.match(cards, /data-export-state="completed"/);
    assert.match(cards, /Archive ready for a private five-minute download/);
    assert.match(cards, /data-download="artifact-1"/);
    assert.match(cards, /data-export-state="empty"/);
    assert.match(cards, /data-run-key="2026-08-13"/);
    assert.match(cards, /Start daily export/);
    assert.match(cards, /Requested/);
    assert.match(cards, /Completed/);
    assert.doesNotMatch(cards, /2026-08-12T08:00:00\.000Z/);
  });
});
