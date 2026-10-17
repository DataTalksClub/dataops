import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { formatAmount } from "../src/surfaces/finance/bookkeeping-format.js";

import { createFinanceSurface } from "../src/surfaces/finance/index.js";
import { createSponsorFinance } from "../src/surfaces/finance/sponsor-finance.js";
import { createFinanceRecordForms, followUpSummary, replaceablePayment } from "../src/surfaces/finance/sponsor-finance-records.js";
import {
  copyToClipboard,
  formatFullCsv,
  formatReportCsv,
  formatReportTsv,
  yearsOf,
} from "../src/surfaces/finance/bookkeeping-format.js";

const originalGlobals = {
  document: globalThis.document,
  fetch: globalThis.fetch,
  FormData: globalThis.FormData,
};

test("the payment form books verified receipts and corrects actual cash without changing the invoice total", () => {
  createHarness();
  const surface = new FakeElement("section"), calls = [];
  const forms = createFinanceRecordForms({ surface, financeMutation: async (...args) => calls.push(args), reopenBookingDetail: async () => {}, safe() {} });
  const dialog = surface.children.find((child) => "financeRecordPaymentDialog" in child.dataset);
  const form = dialog.querySelector("form");
  form.elements.replacesPaymentId.closest = () => new FakeElement("label");
  const projection = { finance: { version: 3, currency: "EUR", amountDue: "100" }, outstanding: "100", payments: [] };
  const values = { receivedOn: "2026-10-02", amount: "95", reference: "bank:account:unique-txn", counterparty: "Synthetic Sponsor", amountEur: "95", category: "Consulting", replacesPaymentId: "" };
  forms.openRecordPayment({ id: "deal" }, projection);
  form.formEntries = Object.entries(values);
  form.onsubmit({ preventDefault() {} });
  assert.equal(calls[0][1], "/receipts");
  assert.equal(calls[0][2], "POST");
  assert.equal(calls[0][3].amount, "95");
  assert.equal(calls[0][3].amountDue, undefined);
  forms.openRecordPayment({ id: "deal" }, projection, { id: "receipt-one", source: "ledger", amount: "95", reference: values.reference });
  form.formEntries = Object.entries({ ...values, amount: "94" });
  form.onsubmit({ preventDefault() {} });
  assert.equal(calls[1][1], "/receipts/receipt-one");
  assert.equal(calls[1][2], "PUT");
  assert.equal(calls[1][3].amount, "94");
});

test("noncash settlement requires explicit approval fields and evidence and never calls cash receipts", () => {
  createHarness();
  const surface = new FakeElement("section"), calls = [];
  const forms = createFinanceRecordForms({ surface, financeMutation: async (...args) => calls.push(args), reopenBookingDetail: async () => {}, safe() {} });
  const projection = { finance: { version: 4, currency: "EUR" }, paid: "95", outstanding: "5", payments: [{ source: "recorded", id: "reviewed-report", amount: "5", currency: "EUR" }] };
  forms.openSettlementAdjustment({ id: "deal" }, projection);
  const form = surface.children.find((child) => "financeAdjustmentDialog" in child.dataset).querySelector("form");
  form.formEntries = Object.entries({ amount: "5", reason: "Conversion fee accepted", approvedBy: "Owner", approvedOn: "2026-10-02", kind: "document", ref: "owner-approval", replacesPaymentId: "reviewed-report" });
  form.onsubmit({ preventDefault() {} });
  assert.equal(calls[0][1], "/settlement-adjustment"); assert.equal(calls[0][2], "POST");
  assert.deepEqual(calls[0][3], { expectedVersion: 4, amount: "5", currency: "EUR", reason: "Conversion fee accepted", approvedBy: "Owner", approvedOn: "2026-10-02", evidence: [{ kind: "document", ref: "owner-approval" }], replacesPaymentId: "reviewed-report" });
});

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

  insertBefore(value, reference) {
    if (value.parentNode) {
      value.parentNode.children = value.parentNode.children.filter((child) => child !== value);
    }
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, value);
    value.parentNode = this;
    return value;
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

  reportValidity() {
    return true;
  }

  reset() {    this.formEntries = [];
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
    this.body = new FakeElement("body");
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
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createHarness({ request, route = null, setupSurface, pipelineRows = [] } = {}) {
  const documentList = new FakeElement("main");
  const document = new FakeDocument(setupSurface);
  const requests = [];
  const navigations = [];
  const routeTitles = [];
  globalThis.document = document;
  globalThis.FormData = FakeFormData;
  const finance = createFinanceSurface({
    documentList,
    escapeHtml,
    getPendingLegacyRoute: () => route,
    humanizeOptionLabel,
    isWorkspaceRouteFresh: () => true,
    navigateCanonicalWorkspace: (path, params) => navigations.push({ path, params: { ...(params || {}) } }),
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (requestPath(url) === "/api/team-members") {
        return {
          teamMembers: [{ id: "operator-1", name: "Synthetic Operator", active: true }],
          defaultAssigneeId: "operator-1",
        };
      }
      const path = requestPath(url);
      if (path === "/api/sponsor-crm/pipeline") return { items: pipelineRows, counts: {}, total: pipelineRows.length, nextCursor: null };
      const record = path.match(/^\/api\/sponsor-crm\/(deals|organizations)\/([^/]+)$/);
      if (request && record && (!options.method || options.method === "GET")) {
        const result = await request(`/api/sponsor-crm/${record[1]}`, options);
        return result.items.find((item) => item.id === record[2]);
      }
      if (request) return request(url, options);
      return {};
    },
    renderEntityLoadState() {},
    setRouteTitle: (title) => routeTitles.push(title),
    todayIsoDate: () => "2026-08-13",
    viewportWidth: () => 1280,
    workApiUrl: (path) => path,
  });
  return { document, documentList, finance, requests, navigations, routeTitles };
}

function requestPath(url) {
  return new URL(url, "http://dataops.test").pathname;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function openSponsorTab(document, view) {
  await document.surface.querySelector("[data-crm-nav]").dispatch("click", {
    preventDefault() {},
    target: { closest: (selector) => selector === "[data-crm-nav-tab]" ? { dataset: { crmNavTab: view } } : null },
  });
  await settle();
}

describe("Finance surface boundary", () => {
  test("treats missing sponsor finance as an empty state and keeps actual failures visible", async () => {
    createHarness();
    const surface = new FakeElement("section");
    const panel = surface.querySelector('[data-booking-panel="finance"]');
    const sponsorFinance = createSponsorFinance({
      surface,
      escapeHtml,
      humanizeOptionLabel,
      message: new FakeElement("p"),
      request: async () => ({}),
      workApiUrl: (path) => path,
    });
    for (const status of [404, 503]) {
      globalThis.fetch = async () => ({
        ok: false,
        status,
        json: async () => ({ error: "Synthetic unavailable finance" }),
      });
      await sponsorFinance.loadFinance({ id: "missing-finance" });
      if (status === 404) {
        assert.match(panel.innerHTML, /No finance recorded yet/);
        assert.doesNotMatch(panel.innerHTML, /Finance is not enabled|Finance is unavailable/);
      } else {
        assert.match(panel.innerHTML, /Finance is unavailable/);
        assert.doesNotMatch(panel.innerHTML, /No finance recorded yet/);
      }
    }
  });

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
        surface.setQuery("[data-deal-dialog]", sponsorDialog),
      request: async (url) => {
        const path = requestPath(url);
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/deals"))
          return {
            items: [
              {
                id: "deal-1",
                organizationId: "org-1",
                status: "agreed",
              },
            ],
          };
        if (path.endsWith("/leads")) return { items: [] };
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
          return selector === "[data-edit-deal]"
            ? { dataset: { editDeal: "deal-1" } }
            : null;
        },
      },
    });
    await settle();
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
      metadata: { sponsorDealId: "deal-alert" },
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
        if (path.endsWith("/deals"))
          return {
            items: [{ id: "deal-alert", organizationId: "org-1", status: "agreed" }],
          };
        if (path.endsWith("/leads")) return { items: [] };
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderSponsorCrmSurface();
    const alertsPanel = document.surface.querySelector(".crm-alerts");
    alertsPanel.open = true;
    await alertsPanel.dispatch("toggle");
    await settle();
    const alerts = document.surface.querySelector("[data-crm-alerts]");
    assert.doesNotMatch(alerts.innerHTML, /No active sponsor alerts/);
    assert.match(alerts.innerHTML, /Sponsor alerts are unavailable:/);
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
    assert.match(alerts.innerHTML, /More sponsor alerts are available\./);
    assert.match(
      alerts.innerHTML,
      /<button type="button" data-load-sponsor-alerts>/,
    );
    // The folded list's one line counts what waits inside.
    const summary = document.surface.querySelector("[data-crm-alert-summary]");
    assert.equal(summary.textContent, "2+ sponsor alerts");

    await clickAlertControl("[data-load-sponsor-alerts]");
    assert.match(alerts.innerHTML, /First alert/);
    assert.match(alerts.innerHTML, /Second alert/);
    assert.match(alerts.innerHTML, /More alerts are available, but loading failed:/);
    assert.match(alerts.innerHTML, /Notifications continuation offline/);

    continuationOnline = true;
    await clickAlertControl("[data-load-sponsor-alerts]");
    const renderedArticleCount = [
      ...alerts.innerHTML.matchAll(/<article class="crm-card crm-alert-row">/g),
    ].length;
    assert.equal(renderedArticleCount, 3);
    assert.equal(summary.textContent, "3 sponsor alerts");
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

  test("lists potential leads independently and transitions status for review", async () => {
    let leadsOnline = false;
    const lead = {
      id: "lead-1",
      version: 1,
      status: "new",
      messageId: "newsletter-1",
      newsletter: { name: "Example Newsletter", subject: "Issue 42" },
      sponsor: {
        name: "Acme Gadgets",
        url: "https://acme.example.test/widgets",
        blurb: "A fictional widget vendor.",
        context: "Sponsored segment.",
      },
    };
    const { document, finance, requests } = createHarness({
      request: async (url, options = {}) => {
        const path = requestPath(url);
        const query = new URL(url, "http://dataops.test").searchParams;
        if (path === "/api/notifications")
          return { notifications: { items: [] } };
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/deals")) return { items: [] };
        if (path === "/api/sponsor-crm/leads") {
          if (!leadsOnline) throw new Error("Leads offline");
          assert.equal(query.get("limit"), "50");
          if (query.get("cursor") === "page-2")
            return { items: [{ ...lead, id: "lead-2", sponsor: { name: "Older Sponsor" } }], nextCursor: null, newsletters: ["Example Newsletter"] };
          return { items: [lead], nextCursor: "page-2", newsletters: ["Example Newsletter"] };
        }
        if (path === "/api/sponsor-crm/leads/lead-1" && options.method === "PATCH") {
          const body = JSON.parse(options.body);
          assert.deepEqual(body, { version: 1, status: "triaged" });
          return { ...lead, ...body, version: 2 };
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderSponsorCrmSurface();
    await openSponsorTab(document, "leads");
    const leads = document.surface.querySelector("[data-crm-leads]");
    // The booking queue still renders while the review queue fails on its own.
    assert.match(leads.innerHTML, /Could not load potential leads\./);
    assert.match(leads.innerHTML, /Leads offline/);
    assert.match(leads.innerHTML, /<button type="button" data-retry-leads>/);

    leadsOnline = true;
    await leads.dispatch("click", {
      target: { closest: (candidate) => (candidate === "[data-retry-leads]" ? {} : null) },
    });
    await settle();
    assert.match(leads.innerHTML, /Acme Gadgets/);
    assert.match(leads.innerHTML, /https:\/\/acme\.example\.test\/widgets/);
    assert.match(leads.innerHTML, /Example Newsletter/);
    assert.match(leads.innerHTML, /data-lead-status="triaged"/);

    await leads.dispatch("click", {
      target: {
        closest: (candidate) =>
          candidate === "[data-lead-status]"
            ? { dataset: { leadId: "lead-1", leadStatus: "triaged" } }
            : null,
      },
    });
    await settle();
    const patch = requests.find(
      (entry) => requestPath(entry.url) === "/api/sponsor-crm/leads/lead-1",
    );
    assert.ok(patch);
    assert.equal(patch.options.method, "PATCH");

    // The default view is the review queue: new leads only.
    const first = requests.find((entry) => requestPath(entry.url) === "/api/sponsor-crm/leads");
    assert.equal(new URL(first.url, "http://dataops.test").searchParams.get("status"), "new");
    assert.match(
      document.surface.querySelector("[data-crm-lead-newsletter]").innerHTML,
      /<option value="Example Newsletter">Example Newsletter<\/option>/,
    );

    // The triaged lead stays in place with its new status, without a reload.
    assert.match(leads.innerHTML, /data-status="triaged"/);
    assert.equal(requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/leads").length, 2);
    const filter = document.surface.querySelector("[data-crm-lead-status]");
    await filter.dispatch("click", {
      target: {
        closest: (candidate) =>
          candidate === "[data-lead-filter-status]" ? { dataset: { leadFilterStatus: "triaged" } } : null,
      },
    });
    await settle();
    const filtered = requests.filter((entry) =>
      entry.url.includes("/api/sponsor-crm/leads?") &&
      entry.url.includes("status=triaged"),
    );
    assert.equal(filtered.length, 1);
    assert.match(leads.innerHTML, /data-leads-more/);

    await leads.dispatch("click", {
      target: {
        closest: (candidate) =>
          candidate === "[data-leads-more]" ? { getAttribute: () => null, setAttribute() {}, removeAttribute() {} } : null,
      },
    });
    await settle();
    const more = requests.find((entry) => entry.url.includes("cursor=page-2"));
    assert.ok(more);
    assert.equal(new URL(more.url, "http://dataops.test").searchParams.get("status"), "triaged");
    assert.match(leads.innerHTML, /Acme Gadgets[\s\S]*Older Sponsor/);
    assert.doesNotMatch(leads.innerHTML, /data-leads-more/);

    const newsletterFilter = document.surface.querySelector("[data-crm-lead-newsletter]");
    await newsletterFilter.dispatch("change", { target: { value: "Example Newsletter" } });
    await settle();
    assert.ok(requests.some((entry) => entry.url.includes("newsletter=Example+Newsletter") && entry.url.includes("status=triaged")));
  });

  test("renders only safe sponsor communication projections and preserves the operator action hierarchy", async () => {
    const booking = {
      id: "booking-1",
      organizationId: "org-1",
      primaryContactId: "contact-1",
      status: "agreed",
      version: 3,
    };
    const seenPaths = [];
    const { document, finance } = createHarness({
      route: {
        view: "sponsors",
        sponsorsTab: "pipeline",
        path: `/sponsors/deals/${booking.id}`,
        token: 1,
        params: new URLSearchParams({ dealId: booking.id }),
      },
      request: async (url) => {
        const path = requestPath(url);
        seenPaths.push(path);
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Safe Sponsor", relationship: "talking" }] };
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
        if (path.endsWith("/deals")) return { items: [booking] };
        if (path.endsWith("/leads")) return { items: [] };
        if (path.endsWith("/notifications")) return { notifications: { items: [] } };
        if (path.endsWith("/history")) return { items: [] };
        if (path.endsWith("/directory/companies/org-1"))
          return { id: "org-1", displayName: "Safe Sponsor", relationship: "talking", notes: "", version: 3 };
        if (path.includes("/activity/organization/org-1"))
          return {
            targetType: "organization",
            targetId: "org-1",
            items: [
              { ts: "2026-01-12T23:30:00Z", source: "mail", id: "m1", actor: null, text: "Synthetic <reply> from the sponsor", provenance: { direction: "inbound", link: "direct" } },
              { ts: "2026-01-12T23:45:00Z", source: "touch", id: "t1", actor: "operator-1", text: "Synthetic response logged", provenance: {} },
            ],
            total: 2,
            nextCursor: null,
            sources: { mail: 1, touch: 1 },
            relatedWork: [],
            tasksScope: "open",
            reads: {},
          };
        if (path.includes("/deals/booking-1/communications"))
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
                reviewable: false,
                subject: "DO NOT RENDER DRAFT SUBJECT",
              },
              {
                id: "attempt-1",
                recordType: "sponsor-send-attempt",
                status: "outcome_unknown",
                providerPayload: "DO NOT RENDER PROVIDER PAYLOAD",
              },
            ],
            nextCursor: null,
            config: { enabled: true },
            permissions: {
              role: "operator",
              canApprove: false,
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
    await settle();
    // Record opens progressively: identity header + tabs, no eager mail,
    // communications or finance loads.
    const record = document.surface.querySelector("[data-crm-record]").innerHTML;
    assert.doesNotMatch(record, /class="booking-kind"/);
    assert.match(record, /data-status="talking">\s*Talking/);
    assert.match(record, /role="tablist"/);
    assert.match(record, /data-record-tab="finance"/);
    assert.ok(!seenPaths.some((path) => path.includes("/messages")), "no eager filed-mail load");
    assert.ok(!seenPaths.some((path) => path.includes("/deals/booking-1/communications")), "no eager communications load");
    assert.ok(!seenPaths.some((path) => path.endsWith("/history")), "no eager history load");
    assert.ok(!seenPaths.some((path) => path.includes("organizationId=org-1")), "no eager deals load");
    // Overview shows the bounded activity preview with escaped snippets and
    // no private payloads or full bodies.
    const overview = document.surface.querySelector("[data-crm-record]").querySelector('[data-record-panel="overview"]').innerHTML;
    assert.match(overview, /Synthetic &lt;reply&gt; from the sponsor/);
    assert.doesNotMatch(overview, /DO NOT RENDER/);
    // The Activity tab keeps the timeline filterable; the archive disclosure
    // loads the preserved drafts/attempts lazily and read-only.
    const wired = document.surface.querySelector("[data-crm-detail]").querySelector("[data-crm-record]");
    const tabTarget = (name) => ({ closest: (selector) => selector === "[data-record-tab]" ? { dataset: { recordTab: name } } : null });
    await wired.dispatch("click", { target: tabTarget("deals") });
    await settle();
    assert.match(
      document.surface.querySelector("[data-crm-record]").querySelector("[data-record-header]").innerHTML,
      /data-status="agreed">\s*Agreed/,
      "selecting the deep-linked deal chips its status in the header",
    );
    await wired.dispatch("click", { target: tabTarget("activity") });
    await settle();
    const panel = document.surface.querySelector("[data-crm-record]").querySelector('[data-record-panel="activity"]');
    assert.match(panel.innerHTML, /Show/);
    const archiveHost = panel.querySelector("[data-record-archive-host]");
    const disclosure = archiveHost.querySelector("[data-record-archive]");
    disclosure.open = true;
    await archiveHost.dispatch("toggle", { target: { open: true, closest: (selector) => selector === "[data-record-archive]" ? disclosure : null } });
    await settle();
    assert.match(archiveHost.innerHTML, /Archived draft v4/);
    assert.match(archiveHost.innerHTML, /Delivery outcome_unknown/);
    assert.doesNotMatch(archiveHost.innerHTML, /Review exact draft/, "operators keep the read-only archive without exact-preview entry");
    assert.doesNotMatch(archiveHost.innerHTML, /DO NOT RENDER/);
    assert.doesNotMatch(archiveHost.innerHTML, /data-approve-message|data-cancel-attempt|data-suppress-address|data-create-review|data-draft-suggestion/);
  });

  test("keeps exact sponsor review immutable and revokes it before navigation", async () => {
    const booking = {
      id: "booking-1",
      organizationId: "org-1",
      status: "agreed",
      version: 3,
    };
    const seen = [];
    const { document, finance } = createHarness({
      route: {
        view: "sponsors",
        sponsorsTab: "pipeline",
        path: `/sponsors/deals/${booking.id}`,
        token: 1,
        params: new URLSearchParams({ dealId: booking.id }),
      },
      request: async (url, options) => {
        const path = requestPath(url);
        seen.push({ path, options });
        if (path.endsWith("/organizations"))
          return { items: [{ id: "org-1", displayName: "Safe Sponsor" }] };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/deals")) return { items: [booking] };
        if (path.endsWith("/leads")) return { items: [] };
        if (path.endsWith("/notifications")) return { notifications: { items: [] } };
        if (path.endsWith("/history")) return { items: [] };
        if (path.includes("/messages")) return { items: [] };
        if (path.endsWith("/directory/companies/org-1"))
          return { id: "org-1", displayName: "Safe Sponsor", active: true, lastTouch: null, version: 3, updatedAt: "2026-08-20T00:00:00Z" };
        if (path.includes("/activity/organization/org-1"))
          return {
            targetType: "organization",
            targetId: "org-1",
            items: [],
            total: 0,
            nextCursor: null,
            sources: {},
            relatedWork: [],
            tasksScope: "open",
            reads: {},
          };
        if (path.includes("/deals/booking-1/communications"))
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
    await settle();
    // The archived draft is reachable through the record Activity tab; the
    // exact preview itself stays immutable and read-only.
    const wired = document.surface.querySelector("[data-crm-detail]").querySelector("[data-crm-record]");
    const tabTarget = (name) => ({ closest: (selector) => selector === "[data-record-tab]" ? { dataset: { recordTab: name } } : null });
    await wired.dispatch("click", { target: tabTarget("deals") });
    await settle();
    await wired.dispatch("click", { target: tabTarget("activity") });
    await settle();
    const panel = document.surface.querySelector("[data-crm-record]").querySelector('[data-record-panel="activity"]');
    const archiveHost = panel.querySelector("[data-record-archive-host]");
    const disclosure = archiveHost.querySelector("[data-record-archive]");
    disclosure.open = true;
    await archiveHost.dispatch("toggle", { target: { open: true, closest: (selector) => selector === "[data-record-archive]" ? disclosure : null } });
    await settle();
    assert.match(archiveHost.innerHTML, /Review exact draft/);

    const reviewButton = { dataset: { archiveReview: "message-1", archiveVersion: "7" } };
    const target = {
      closest(selector) {
        if (selector === "[data-archive-review]") return reviewButton;
        return null;
      },
    };
    await archiveHost.dispatch("click", { target });
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
    assert.doesNotMatch(dialog.innerHTML, /data-approve-message/);
    assert.match(
      dialog.querySelector("[data-review-warning]").textContent,
      /no longer sends sponsor email/,
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

  test("unfolded sponsor alerts stay unfolded when the surface repaints", async () => {
    const { document, finance } = createHarness({
      request: async (url) => {
        const path = requestPath(url);
        if (path === "/api/notifications") return { notifications: { items: [] } };
        return { items: [] };
      },
    });
    await finance.renderSponsorCrmSurface();
    const first = document.surface.querySelector(".crm-alerts");
    assert.equal(first.open, false, "alerts start folded");
    first.open = true;
    await first.dispatch("toggle");
    await finance.renderSponsorCrmSurface();
    const sections = document.created.filter((element) => element.tagName === "SECTION");
    const repainted = sections.at(-1);
    assert.notEqual(repainted, document.surface);
    assert.equal(repainted.querySelector(".crm-alerts").open, true);
  });

  test("renders Pipeline, Company, and Leads and Convert hits the leads API", async () => {
    let lead = {
      id: "lead-convert",
      version: 1,
      status: "new",
      sponsor: { name: "Queue Vendor", url: "https://queue.example.invalid" },
      newsletter: { name: "Digest" },
    };
    const { document, finance, requests } = createHarness({
      pipelineRows: [{ id: "deal-1", organizationId: "org-1", organizationName: "Talking Co", stage: "open" }],
      request: async (url, options = {}) => {
        const path = requestPath(url);
        if (path === "/api/notifications")
          return { notifications: { items: [] } };
        if (path.endsWith("/organizations"))
          return {
            items: [
              {
                id: "org-1",
                displayName: "Talking Co",
                relationship: "talking",
              },
            ],
          };
        if (path.endsWith("/contacts")) return { items: [] };
        if (path.endsWith("/deals"))
          return {
            items: [
              {
                id: "deal-1",
                organizationId: "org-1",
                status: "open",
                money: "none",
              },
            ],
          };
        if (path === "/api/sponsor-crm/views") {
          const entity = new URL(url, "http://dataops.test").searchParams.get("entity");
          return {
            items: [
              { id: `builtin:${entity}:active`, entity, name: "Active", builtin: true,
                filters: { active: "true" }, resolvedFilters: { active: "true" }, sort: { field: "name", direction: "asc" } },
            ],
            total: 1,
          };
        }
        if (path === "/api/sponsor-crm/directory/companies")
          return {
            items: [
              {
                id: "org-1",
                displayName: "Talking Co",
                domain: "talking.example",
                relationship: "talking",
                active: true,
                primaryPerson: null,
                lastTouch: null,
                openDealCount: 1,
                version: 1,
                updatedAt: "2026-10-17T00:00:00Z",
              },
            ],
            total: 1,
            nextCursor: null,
          };
        if (path === "/api/sponsor-crm/directory/people") return { items: [], total: 0, nextCursor: null };
        if (path === "/api/sponsor-crm/leads") return { items: [lead] };
        if (path === "/api/sponsor-crm/leads/lead-convert" && options.method === "PATCH") {
          lead = { ...lead, status: "converted", version: 2 };
          return lead;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await finance.renderSponsorCrmSurface();
    // Sponsor work lives in the Tasks queue; Sponsors has no Queue of its own.
    assert.doesNotMatch(document.surface.innerHTML, /data-crm-queue|data-crm-view="queue"/);
    assert.match(document.surface.innerHTML, /data-crm-bookings/);
    const pipeline = document.surface.querySelector("[data-crm-bookings]");
    const companiesRoot = document.surface.querySelector('[data-dir-root="companies"]');
    const companies = companiesRoot.querySelector("[data-dir-rows]");
    const peopleRoot = document.surface.querySelector('[data-dir-root="people"]');
    const people = peopleRoot.querySelector("[data-dir-rows]");
    const leads = document.surface.querySelector("[data-crm-leads]");
    assert.match(pipeline.innerHTML, /Talking Co/);
    assert.match(pipeline.innerHTML, /Opportunities & history/);
    assert.equal(companies.innerHTML, "", "directory stays unloaded until opened");
    assert.equal(leads.innerHTML, "", "leads stay unloaded until opened");
    await openSponsorTab(document, "companies");
    assert.match(companies.innerHTML, /Talking Co/);
    assert.match(companies.innerHTML, /talking\.example/);
    assert.match(companies.innerHTML, /1 open deal/);
    await openSponsorTab(document, "people");
    assert.match(people.innerHTML, /No people yet/);
    await openSponsorTab(document, "leads");
    assert.match(leads.innerHTML, /Queue Vendor/);

    await document.surface.querySelector("[data-crm-nav]").dispatch("click", {
      preventDefault() {},
      target: {
        closest: (selector) =>
          selector === "[data-crm-nav-tab]"
            ? { dataset: { crmNavTab: "pipeline" } }
            : null,
      },
    });
    assert.equal(
      document.surface.querySelector("[data-crm-list-heading]").textContent,
      "Pipeline",
    );

    await leads.dispatch("click", {
      target: {
        closest: (candidate) =>
          candidate === "[data-lead-status]"
            ? { dataset: { leadId: "lead-convert", leadStatus: "converted" } }
            : null,
      },
    });
    await settle();
    const patch = requests.find(
      (entry) => requestPath(entry.url) === "/api/sponsor-crm/leads/lead-convert",
    );
    assert.ok(patch);
    assert.equal(patch.options.method, "PATCH");
    assert.deepEqual(JSON.parse(patch.options.body), {
      version: 1,
      status: "converted",
    });
    assert.match(leads.innerHTML, /Converted/);
    assert.doesNotMatch(leads.innerHTML, /data-lead-status|data-lead-id|crm-lead-actions/);
    for (const status of ["converted", "triaged", "ignored"]) {
      await leads.dispatch("click", {
        target: {
          closest: (selector) => selector === "[data-lead-status]"
            ? { dataset: { leadId: "lead-convert", leadStatus: status } }
            : null,
        },
      });
    }
    await settle();
    assert.equal(requests.filter(({ url, options }) =>
      requestPath(url) === "/api/sponsor-crm/leads/lead-convert" && options.method === "PATCH",
    ).length, 1, "stale converted-lead controls cannot issue another transition");
  });
});


test("currency display uses separators and two decimals without throwing on unknown values", () => {
  assert.equal(formatAmount("4800.0000"), "€4,800.00");
  assert.equal(formatAmount(-4800), "-€4,800.00");
  assert.equal(formatAmount("1234.5678", "usd"), "$1,234.57");
  assert.equal(formatAmount(12, "GBP"), "£12.00");
  assert.equal(formatAmount("pending", "EUR"), "pending EUR");
  assert.equal(formatAmount("12.3456", "EURO"), "12.3456 EURO");
  assert.equal(formatAmount(Infinity), "Infinity EUR");
  assert.equal(formatAmount(null), "—");
  assert.equal(formatAmount(""), "—");
});

test("report exports preserve decimal precision, quote cells, and require a real EUR conversion", () => {
  const entries = [
    { transactionDate: "2024-12-01", counterparty: 'Vendor, "quoted"', description: "First\nsecond", amount: "12.3456", currency: "USD", entryType: "expense", vatAmount: "0" },
    { transactionDate: "2024-12-02", counterparty: "Converted", amount: "5.1234", currency: "GBP", amountEur: "0", entryType: "expense" },
    { transactionDate: "2024-12-03", counterparty: "Tax", amount: "4", currency: "EUR", category: "Taxes", entryType: "expense" },
  ];
  const report = formatReportCsv(entries);
  assert.match(report, /"Vendor, ""quoted""","First\nsecond","","-12\.3456","USD","0"/);
  assert.match(report, /"Converted","","-0","","GBP"/);
  assert.doesNotMatch(report, /"Tax"/);
  assert.match(formatFullCsv(entries), /"Tax"/);
  const tsv = formatReportTsv(entries);
  assert.match(tsv, /Vendor, "quoted"\tFirst second\t\t-12\.3456/);
  assert.equal(tsv.split("\n").length, 3);
});

test("clipboard fallback reports failure when no copy command is available", async () => {
  globalThis.document = new FakeDocument();
  assert.equal(await copyToClipboard("report"), false);
});


test("spreadsheet exports escape text formulas while retaining numeric expense signs and VAT currency", () => {
  const entries = [{ transactionDate: "2024-12-01", counterparty: "=1+1", description: " @SUM(A1)", amount: "12.3400", currency: "EUR", entryType: "expense", vatAmount: "1.2500", vatCurrency: "USD", category: "+formula", statementRef: "-formula" }];
  const csv = formatReportCsv(entries);
  assert.match(csv, /"'=1\+1","' @SUM\(A1\)","-12\.3400"/);
  assert.match(csv, /"1\.2500","USD","'\+formula","Expense","'-formula"/);
  assert.match(formatFullCsv(entries), /"'=1\+1","' @SUM\(A1\)","12\.3400"/);
  const tsv = formatReportTsv(entries);
  assert.match(tsv, /VAT\tVAT Currency/);
  assert.match(tsv, /'=1\+1\t' @SUM\(A1\)\t-12\.3400/);
  assert.match(tsv, /1\.2500\tUSD\t'\+formula/);
});

test("sponsor finance panel leads with the derived next step, the blocker, payments and evidence", async () => {
  createHarness();
  const surface = new FakeElement("section");
  const panel = surface.querySelector('[data-booking-panel="finance"]');
  const sponsorFinance = createSponsorFinance({
    surface,
    escapeHtml,
    humanizeOptionLabel,
    message: new FakeElement("p"),
    request: async () => ({}),
    workApiUrl: (path) => path,
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      enabled: true,
      classified: true,
      dealId: "deal-1",
      role: "admin",
      finance: {
        version: 4,
        invoiceRequirement: "required",
        amountDue: "2500.00",
        currency: "EUR",
        taxMode: "included",
        issuedOn: "2026-09-01",
        sentOn: "2026-09-02",
        dueOn: "2026-09-30",
        waitingOn: { party: "sponsor", reason: "purchase-order", since: "2026-09-05", note: "AP queue" },
        evidence: [
          { kind: "email", ref: "https://mail.example.invalid/thread/1", label: "Invoice thread" },
          { kind: "ledger", ref: "row-42" },
        ],
      },
      invoiceState: "issued",
      paymentState: "partially-paid",
      timingState: "overdue",
      outstanding: "1500.00",
      payments: [
        { id: "a".repeat(32), effectiveDate: "2026-09-20", amount: "1000.00", currency: "EUR", source: "recorded", method: "sponsor-confirmation" },
      ],
      followUp: { code: "payment-follow-up", party: "us", since: "2026-09-30", daysOverdue: 14 },
      reconciliationStatus: "coherent",
      paymentLinkCount: 0,
      paymentLinkLimit: 10,
    }),
  });
  await sponsorFinance.loadFinance({ id: "deal-1", version: 3 });
  const markup = panel.innerHTML;
  assert.ok(markup.indexOf("Follow up on the payment") < markup.indexOf("Waiting on the sponsor for a purchase order"));
  assert.match(markup, /data-finance-next-step="payment-follow-up"/);
  assert.match(markup, /Overdue 14 days, due/);
  assert.match(markup, /AP queue/);
  assert.match(markup, /data-finance-waiting-clear/);
  assert.match(markup, /Invoice without number/);
  assert.match(markup, /data-finance-issue[^>]*>\s*Correct invoice/);
  assert.match(markup, /data-finance-record-payment/);
  assert.match(markup, /Sponsor confirmation/);
  assert.match(markup, new RegExp(`data-finance-delete-payment="${"a".repeat(32)}"`));
  assert.match(markup, /href="https:\/\/mail\.example\.invalid\/thread\/1"[^>]*>Invoice thread/);
  assert.match(markup, /Bookkeeping row/);
  assert.match(markup, /data-finance-evidence-remove="1"/);
});

test("follow-up summaries name the fix and who acts", () => {
  assert.equal(followUpSummary({ code: "send-invoice", party: "us", since: "2026-10-01" }).title, "Verify or send the invoice");
  assert.equal(followUpSummary({ code: "unblock", party: "us", reason: "payment-link" }).title, "Send the sponsor a payment link");
  assert.equal(followUpSummary({ code: "await-sponsor", party: "sponsor", reason: "billing-details" }).tone, "info");
  assert.equal(followUpSummary({ code: "reconcile", party: "us" }).tone, "danger");
  assert.equal(followUpSummary({ code: "none", party: "none" }).title, "Nothing to follow up on");
});

test("Money lists what to follow up on first with each fix, then outstanding and expected cash without tiles", async () => {
  const { moneyMarkup, forecastBucketLabel } = await import("../src/surfaces/finance/sponsor-money.js");
  const markup = moneyMarkup(
    {
      asOf: "2026-10-14",
      rows: [],
      followUps: [
        {
          dealId: "deal-1",
          organizationName: "Sponsor A",
          dealTitle: "Q4 newsletter",
          currency: "EUR",
          amountDue: "2500.00",
          outstanding: "2500.00",
          followUp: { code: "payment-follow-up", party: "us", since: "2026-09-30", daysOverdue: 14 },
        },
        { dealId: "deal-2", organizationName: "Sponsor B", followUp: { code: "classify", party: "us" } },
      ],
      totals: [
        { currency: "EUR", outstanding: "2500.00", overdue: "2500.00", notInvoiced: "800.00", paidThisYear: "0.00" },
        { currency: "USD", outstanding: "0.00", overdue: "0.00", notInvoiced: "0.00", paidThisYear: "100.00" },
      ],
      forecast: [
        { bucket: "overdue", currency: "EUR", amount: "2500.00", dealIds: ["deal-1"] },
        { bucket: "2026-11", currency: "EUR", amount: "800.00", dealIds: ["deal-3", "deal-4"] },
      ],
    },
    escapeHtml,
  );
  assert.ok(markup.indexOf("What to follow up on") < markup.indexOf("Outstanding"));
  assert.ok(markup.indexOf("Outstanding") < markup.indexOf("Expected cash"));
  assert.match(markup, /Follow up on the payment/);
  assert.match(markup, /Sponsor A · Q4 newsletter/);
  assert.match(markup, /data-money-open-deal="deal-2"/);
  assert.match(markup, /1 agreed deal has no money recorded/);
  assert.match(markup, /Record what to invoice/);
  assert.match(markup, /data-money-currency="EUR"/);
  assert.doesNotMatch(markup, /data-money-currency="USD"/);
  assert.match(markup, /2 deals/);
  assert.doesNotMatch(markup, /dk-stat/);
  assert.equal(forecastBucketLabel("2026-11"), "November 2026");
  assert.equal(forecastBucketLabel("not-invoiced"), "Not invoiced yet");
});

test("a bookkeeping row replaces the payment recorded before it: same amount, within 14 days", () => {
  const payments = [
    { id: "ledger-1", source: "ledger", amount: "5950.00", effectiveDate: "2026-09-04" },
    { id: "recorded-1", source: "recorded", amount: "5950", effectiveDate: "2026-09-04" },
  ];
  assert.equal(replaceablePayment(payments, { amount: "5950.00", effectiveDate: "2026-09-07" })?.id, "recorded-1");
  assert.equal(replaceablePayment(payments, { amount: "5900.00", effectiveDate: "2026-09-04" }), undefined);
  assert.equal(replaceablePayment(payments, { amount: "5950.00", effectiveDate: "2026-10-04" }), undefined);
});

const paymentFollowUpProjection = (paymentFollowUp) => ({
  enabled: true,
  classified: true,
  dealId: "deal-1",
  role: "admin",
  finance: {
    version: 4,
    invoiceRequirement: "required",
    amountDue: "1000.00",
    currency: "EUR",
    taxMode: "included",
    issuedOn: "2026-09-01",
    dueOn: "2026-09-30",
  },
  invoiceState: "issued",
  paymentState: "unpaid",
  timingState: "overdue",
  outstanding: "1000.00",
  payments: [],
  followUp: { code: "payment-follow-up", party: "us", since: "2026-09-30", daysOverdue: 14 },
  reconciliationStatus: "coherent",
  paymentLinkCount: 0,
  paymentLinkLimit: 10,
  ...(paymentFollowUp ? { paymentFollowUp } : {}),
});

test("an overdue invoice without a payment follow-up offers creating the follow-up Task in the main pool", async () => {
  createHarness();
  const surface = new FakeElement("section");
  const panel = surface.querySelector('[data-booking-panel="finance"]');
  const sponsorFinance = createSponsorFinance({
    surface,
    escapeHtml,
    humanizeOptionLabel,
    message: new FakeElement("p"),
    request: async () => ({}),
    workApiUrl: (path) => path,
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => paymentFollowUpProjection(null),
  });
  await sponsorFinance.loadFinance({ id: "deal-1", version: 3 });
  const markup = panel.innerHTML;
  assert.match(markup, /Payment follow-up/);
  assert.match(markup, /data-finance-payment-follow-up-create>Add next finance action to Tasks</);
  assert.match(markup, /regular task pool/);
  assert.doesNotMatch(markup, /chase/i);

  // Clicking creates the payment follow-up through the finance endpoint and repaints.
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), method: options?.method, body: options?.body && JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => paymentFollowUpProjection(null) };
  };
  const createButton = surface
    .querySelector("[data-finance-panel]")
    .querySelector("[data-finance-payment-follow-up-create]");
  await createButton.dispatch("click", {});
  const followUpCall = requests.find((request) => request.url.endsWith("/finance/follow-up"));
  assert.ok(followUpCall, "creates through the finance follow-up endpoint");
  assert.equal(followUpCall.method, "POST");
  assert.deepEqual(followUpCall.body, { dealVersion: 3, expectedVersion: 4 });
});

test("open payment follow-up work is listed with its next follow-up and opens its Task over the deal", async () => {
  createHarness();
  const surface = new FakeElement("section");
  const panel = surface.querySelector('[data-booking-panel="finance"]');
  const openedTasks = [];
  const sponsorFinance = createSponsorFinance({
    surface,
    escapeHtml,
    humanizeOptionLabel,
    message: new FakeElement("p"),
    openTaskPanel: (taskId) => openedTasks.push(taskId),
    request: async () => ({}),
    workApiUrl: (path) => path,
  });
  // The open buttons bind through querySelectorAll, so seed the one the
  // dispatch will use before the panel renders and binds.
  const openButton = new FakeElement("button");
  openButton.dataset.financePaymentFollowUpOpen = "task-follow-up-1";
  surface
    .querySelector("[data-finance-panel]")
    .setQueryAll("[data-finance-payment-follow-up-open]", [openButton]);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () =>
      paymentFollowUpProjection({
        tasks: [
          {
            id: "task-follow-up-1",
            description: "Follow up on the payment from Synthetic Sponsor. 1000 EUR outstanding.",
            date: "2026-10-16",
            status: "waiting",
            followUpAt: "2026-10-23",
            assigneeId: "operator-1",
          },
        ],
      }),
  });
  await sponsorFinance.loadFinance({ id: "deal-1", version: 3 });
  const markup = panel.innerHTML;
  assert.match(markup, /Follow up on the payment from Synthetic Sponsor/);
  assert.match(markup, /Next follow-up/);
  assert.match(markup, /data-finance-payment-follow-up-open="task-follow-up-1"/);
  assert.doesNotMatch(markup, /data-finance-payment-follow-up-create/);

  await openButton.dispatch("click", {});
  assert.deepEqual(openedTasks, ["task-follow-up-1"]);
});


test("existing sponsor work must be reviewed before adding a separate payment follow-up", async () => {
  createHarness();
  const surface = new FakeElement("section");
  const message = new FakeElement("p");
  const finance = createSponsorFinance({ surface, escapeHtml, humanizeOptionLabel, message,
    request: async () => ({}), workApiUrl: (path) => path });
  const projection = paymentFollowUpProjection({ tasks: [], existingTasks: [
    { id: "existing-1", version: 3, description: "Existing payment follow-up", date: "2026-10-16", status: "todo" },
  ] });
  const posts = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") posts.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => projection };
  };
  await finance.loadFinance({ id: "deal-1", version: 3 });
  assert.match(surface.querySelector('[data-booking-panel="finance"]').innerHTML, /Existing payment follow-up/);
  const panel = surface.querySelector("[data-finance-panel]");
  await panel.querySelector("[data-finance-payment-follow-up-create]").dispatch("click", {});
  assert.equal(posts.length, 0, "unreviewed duplicate creation is refused before a write");
  panel.querySelector("[data-finance-payment-follow-up-reviewed]").checked = true;
  await panel.querySelector("[data-finance-payment-follow-up-create]").dispatch("click", {});
  assert.deepEqual(posts[0], { dealVersion: 3, expectedVersion: 4,
    reviewedOpenTasks: [{ id: "existing-1", version: 3 }] });
});

describe("CRM directory controllers", () => {
  const directoryOrgs = [
    { id: "org-acme", displayName: "Acme Cloud", domain: "acme.example", relationship: "talking",
      active: true, primaryPerson: null, lastTouch: "2026-10-12T10:00:00Z", openDealCount: 1, version: 1, updatedAt: "2026-10-12T00:00:00Z" },
    { id: "org-north", displayName: "Northwind Data", domain: "northwind.example", relationship: "prospect",
      active: true, primaryPerson: null, lastTouch: "2026-09-01T10:00:00Z", openDealCount: 0, version: 1, updatedAt: "2026-09-01T00:00:00Z" },
  ];
  const directoryViews = [
    { id: "builtin:companies:active", entity: "companies", name: "Active", builtin: true,
      filters: { active: "true" }, resolvedFilters: { active: "true" }, sort: { field: "name", direction: "asc" } },
    { id: "builtin:companies:stale", entity: "companies", name: "No recent contact", builtin: true,
      filters: { active: "true", lastTouchBefore: { daysAgo: 30 } },
      resolvedFilters: { active: "true", lastTouchBefore: "2026-09-17" }, sort: { field: "lastTouch", direction: "desc" } },
    { id: "view-acme", entity: "companies", name: "Acme only",
      filters: { search: "acme" }, resolvedFilters: { active: "true", search: "acme" }, sort: { field: "name", direction: "asc" } },
  ];
  function directoryRequest(url, options = {}) {
    const path = requestPath(url);
    const query = new URL(url, "http://dataops.test").searchParams;
    if (path === "/api/sponsor-crm/views") return { items: directoryViews, total: directoryViews.length };
    if (path === "/api/sponsor-crm/directory/companies") {
      let items = [...directoryOrgs];
      const search = query.get("search");
      if (search) items = items.filter((item) => item.displayName.toLowerCase().includes(search.toLowerCase()));
      const field = query.get("sort") || "name";
      const dir = query.get("direction") || (field === "lastTouch" ? "desc" : "asc");
      items.sort((left, right) => {
        const base = field === "lastTouch"
          ? String(left.lastTouch || "").localeCompare(String(right.lastTouch || ""))
          : left.displayName.localeCompare(right.displayName);
        return dir === "desc" ? -base : base;
      });
      return { items, total: items.length, nextCursor: null };
    }
    if (path === "/api/notifications") return { notifications: { items: [] } };
    throw new Error(`Unexpected request: ${url}`);
  }
  const dirRoute = (tab, params) => ({
    view: "sponsors",
    sponsorsTab: tab,
    path: `/sponsors/${tab}`,
    token: 1,
    params: new URLSearchParams(params),
  });
  const dirRows = (document) =>
    document.surface.querySelector('[data-dir-root="companies"]').querySelector("[data-dir-rows]");

  test("reverse-direction URL executes with direction and survives reload", async () => {
    const { document, finance, requests, navigations } = createHarness({
      route: dirRoute("companies", { sort: "lastTouch", dir: "asc" }),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const calls = requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies");
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url, "http://dataops.test").searchParams.get("direction"), "asc");
    assert.match(dirRows(document).innerHTML, /Northwind Data.*Acme Cloud/s, "lastTouch asc orders oldest first");
    const canonical = navigations.find((entry) => entry.path === "/sponsors/companies");
    assert.ok(canonical, "list write canonically replaces the URL");
    assert.equal(canonical.params.sort, "lastTouch");
    assert.equal(canonical.params.dir, "asc");
    const reloaded = createHarness({
      route: dirRoute("companies", canonical.params),
      request: directoryRequest,
    });
    await reloaded.finance.renderSponsorCrmSurface();
    await settle();
    const reloadCalls = reloaded.requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies");
    assert.equal(reloadCalls.length, 1);
    assert.equal(new URL(reloadCalls[0].url, "http://dataops.test").searchParams.get("direction"), "asc");
    assert.match(dirRows(reloaded.document).innerHTML, /Northwind Data.*Acme Cloud/s, "reload replays the reverse direction");
  });

  test("invalid sort URL surfaces an honest error and issues no silent default load", async () => {
    const { document, finance, requests } = createHarness({
      route: dirRoute("companies", { sort: "bogus" }),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    assert.match(dirRows(document).innerHTML, /Could not load this directory/);
    assert.equal(
      requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies").length,
      0,
      "no default query fires behind an invalid URL",
    );
  });

  test("deferred search issues only the settled query", async () => {
    const { document, finance, requests } = createHarness({
      route: dirRoute("companies", {}),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const root = document.surface.querySelector('[data-dir-root="companies"]');
    const search = root.querySelector("[data-dir-search]");
    search.value = "acme";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    search.value = "globex";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const searches = requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies")
      .map((entry) => new URL(entry.url, "http://dataops.test").searchParams.get("search"));
    assert.ok(!searches.includes("acme"), `stale search fired: ${searches.join(",")}`);
    assert.equal(searches.at(-1), "globex");
  });

  test("pipeline invalid enums surface honestly and load defaults", async () => {
    const { document, finance, requests } = createHarness({
      route: dirRoute("pipeline", { view: "bogus", sort: "nope" }),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    assert.match(
      document.surface.querySelector("[data-crm-message]").textContent,
      /Ignored invalid pipeline URL/,
      "invented enums are reported, not silently replaced",
    );
    const pipelineCalls = requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline")
      .map((entry) => new URL(entry.url, "http://dataops.test").search);
    assert.ok(pipelineCalls.length >= 1, "pipeline loads");
    assert.ok(!pipelineCalls.join("").includes("bogus"), "invented enum never reaches the API");
    assert.ok(!pipelineCalls.join("").includes("nope"), "invented sort never reaches the API");
  });

  test("selecting a saved view then clearing its search deletes the filter and unpins the view", async () => {
    const { document, finance, requests, navigations } = createHarness({
      route: dirRoute("companies", {}),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const root = document.surface.querySelector('[data-dir-root="companies"]');
    const viewsBar = root.querySelector("[data-dir-views]");
    await viewsBar.dispatch("change", {
      target: { closest: (selector) => selector === "[data-views-select]" ? { value: "view-acme" } : null },
    });
    await settle();
    let queries = requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies")
      .map((entry) => new URL(entry.url, "http://dataops.test").search);
    assert.ok(queries.at(-1).includes("search=acme"), `saved view search applies: ${queries.at(-1)}`);
    assert.match(dirRows(document).innerHTML, /Acme Cloud/, "saved view filters rows");
    assert.doesNotMatch(dirRows(document).innerHTML, /Northwind Data/);
    const search = root.querySelector("[data-dir-search]");
    search.value = "";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    queries = requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies")
      .map((entry) => new URL(entry.url, "http://dataops.test").search);
    assert.ok(!queries.at(-1).includes("search="), `cleared search disappears from query: ${queries.at(-1)}`);
    const canonical = navigations.filter((entry) => entry.path === "/sponsors/companies").at(-1);
    assert.ok(canonical && !("search" in canonical.params) && !("view" in canonical.params),
      `cleared filter unpins the view and stays out of the URL: ${JSON.stringify(canonical?.params)}`);
    assert.match(dirRows(document).innerHTML, /Acme Cloud/, "all rows return after clearing");
  });

  test("in-flight error after a newer success never paints over it", async () => {
    const gates = {};
    const { document, finance, requests } = createHarness({
      route: dirRoute("companies", {}),
      request: (url, options = {}) => {
        const path = requestPath(url);
        const query = new URL(url, "http://dataops.test").searchParams;
        if (path === "/api/sponsor-crm/directory/companies" && query.get("search") === "acme") {
          return new Promise((_, reject) => { gates.acme = () => reject(Object.assign(new Error("slow acme failed"), { status: 500 })); });
        }
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const root = document.surface.querySelector('[data-dir-root="companies"]');
    const search = root.querySelector("[data-dir-search]");
    search.value = "acme";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    search.value = "";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.match(dirRows(document).innerHTML, /Acme Cloud/, "settled rows render");
    gates.acme();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(
      dirRows(document).innerHTML,
      /Acme Cloud/,
      "late rejection never replaces newer rows with an error",
    );
    assert.doesNotMatch(dirRows(document).innerHTML, /Could not load this directory/);
  });

  test("initial missing saved view stays honest and issues no silent default load", async () => {
    const { document, finance, requests } = createHarness({
      route: dirRoute("companies", { view: "missing-view" }),
      request: directoryRequest,
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    assert.match(
      dirRows(document).innerHTML,
      /not available|Could not load this directory/,
      "missing view renders an honest resolver error",
    );
    assert.equal(
      requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies").length,
      0,
      "no default query fires behind an unresolved view",
    );
  });

  test("in-flight list response never paints over an opened record", async () => {
    const gates = {};
    const { document, finance, requests } = createHarness({
      route: dirRoute("companies", {}),
      request: (url, options = {}) => {
        const path = requestPath(url);
        const query = new URL(url, "http://dataops.test").searchParams;
        if (path === "/api/sponsor-crm/directory/companies" && query.get("search") === "north") {
          return new Promise((resolve) => { gates.north = () => resolve({ items: [directoryOrgs[1]], total: 1, nextCursor: null }); });
        }
        if (path === "/api/sponsor-crm/directory/companies/org-acme") {
          return { id: "org-acme", displayName: "Acme Cloud", domain: "acme.example", active: true, version: 1, updatedAt: "2026-10-12T00:00:00Z" };
        }
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const root = document.surface.querySelector('[data-dir-root="companies"]');
    const search = root.querySelector("[data-dir-search]");
    search.value = "north";
    await search.dispatch("input", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    await document.surface.dispatch("click", {
      target: {
        closest: (selector) => {
          if (selector === "[data-open-company]") return { dataset: { openCompany: "org-acme" } };
          return null;
        },
      },
    });
    await settle();
    gates.north();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(
      dirRows(document).innerHTML,
      /Acme Cloud/,
      "pre-search rows survive the late list response after the record open",
    );
    assert.doesNotMatch(
      dirRows(document).innerHTML,
      /Could not load this directory/,
      "late response never paints rows or errors over the record",
    );
  });

  test("deal save settling after a newer record open never refreshes or reopens", async () => {
    const gates = {};
    const pipelineDeals = [
      { id: "deal-a", organizationId: "org-1", status: "open", productKind: "one-off" },
      { id: "deal-b", organizationId: "org-1", status: "agreed", productKind: "package" },
    ];
    const { document, finance, requests } = createHarness({
      route: dirRoute("pipeline", {}),
      pipelineRows: pipelineDeals,
      request: (url, options = {}) => {
        const path = requestPath(url);
        if (path === "/api/sponsor-crm/directory/companies/org-1") {
          return { id: "org-1", displayName: "Acme Cloud", domain: "acme.example", active: true, version: 2, updatedAt: "2026-10-12T00:00:00Z" };
        }
        if (path === "/api/sponsor-crm/deals" && options.method === "POST") {
          return new Promise((resolve) => { gates.save = () => resolve({ id: "deal-a", organizationId: "org-1", status: "agreed", productKind: "one-off", version: 4 }); });
        }
        if (path === "/api/sponsor-crm/deals") return { items: pipelineDeals, total: pipelineDeals.length };
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const pipelineCalls = () => requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline").length;
    assert.equal(pipelineCalls(), 1, "pipeline loads once before the save");
    const form = document.surface.querySelector("[data-deal-dialog]").querySelector("form");
    form.formEntries = [
      ["organizationId", "org-1"], ["status", "agreed"], ["productKind", "one-off"], ["version", "3"],
    ];
    await document.surface.querySelector("[data-deal-save]").dispatch("click", {});
    await settle();
    assert.equal(
      requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/deals" && entry.options.method === "POST").length,
      1,
      "deal POST fires",
    );
    await document.surface.querySelector("[data-crm-bookings]").dispatch("click", {
      target: {
        closest: (selector) => selector === "[data-open-deal]" ? { dataset: { openDeal: "deal-b" } } : null,
      },
    });
    await settle();
    const dealDetailCalls = () => requests.filter((entry) => requestPath(entry.url).startsWith("/api/sponsor-crm/deals/")).length;
    const detailCallsBeforeSettle = dealDetailCalls();
    assert.ok(detailCallsBeforeSettle >= 1, "record B open fetches its deal");
    gates.save();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(pipelineCalls(), 1, "late save never refreshes the pipeline over record B");
    assert.equal(
      dealDetailCalls(),
      detailCallsBeforeSettle,
      "late save never reopens a deal detail",
    );
  });

  test("deal save settling after navigation to Tasks never refreshes or reopens", async () => {
    const gates = {};
    const pipelineDeals = [
      { id: "deal-a", organizationId: "org-1", status: "open", productKind: "one-off" },
    ];
    const route = dirRoute("pipeline", {});
    const { document, finance, requests } = createHarness({
      route,
      pipelineRows: pipelineDeals,
      request: (url, options = {}) => {
        const path = requestPath(url);
        if (path === "/api/sponsor-crm/deals" && options.method === "POST") {
          return new Promise((resolve) => { gates.save = () => resolve({ id: "deal-a", organizationId: "org-1", status: "agreed", productKind: "one-off", version: 4 }); });
        }
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const pipelineCalls = () => requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline").length;
    assert.equal(pipelineCalls(), 1);
    const form = document.surface.querySelector("[data-deal-dialog]").querySelector("form");
    form.formEntries = [
      ["organizationId", "org-1"], ["status", "agreed"], ["productKind", "one-off"], ["version", "3"],
    ];
    await document.surface.querySelector("[data-deal-save]").dispatch("click", {});
    await settle();
    route.view = "tasks";
    route.path = "/tasks";
    gates.save();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(pipelineCalls(), 1, "late save never refreshes after leaving for Tasks");
    assert.equal(
      requests.filter((entry) => requestPath(entry.url).startsWith("/api/sponsor-crm/deals/")).length,
      0,
      "late save never reopens a deal detail after leaving for Tasks",
    );
  });

    test("deal save settling after a tab click never refreshes or reopens", async () => {
    const gates = {};
    const pipelineDeals = [
      { id: "deal-a", organizationId: "org-1", status: "open", productKind: "one-off" },
    ];
    const { document, finance, requests } = createHarness({
      route: dirRoute("pipeline", {}),
      pipelineRows: pipelineDeals,
      request: (url, options = {}) => {
        const path = requestPath(url);
        if (path === "/api/sponsor-crm/views") return { items: [], total: 0 };
        if (path === "/api/sponsor-crm/deals" && options.method === "POST") {
          return new Promise((resolve) => { gates.save = () => resolve({ id: "deal-a", organizationId: "org-1", status: "agreed", productKind: "one-off", version: 4 }); });
        }
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    const pipelineCalls = () => requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline").length;
    const directoryCalls = () => requests.filter((entry) => requestPath(entry.url).startsWith("/api/sponsor-crm/directory/")).length;
    assert.equal(pipelineCalls(), 1);
    const form = document.surface.querySelector("[data-deal-dialog]").querySelector("form");
    form.formEntries = [
      ["organizationId", "org-1"], ["status", "agreed"], ["productKind", "one-off"], ["version", "3"],
    ];
    await document.surface.querySelector("[data-deal-save]").dispatch("click", {});
    await settle();
    await openSponsorTab(document, "companies");
    await settle();
    const companiesAfterNav = dirRows(document).innerHTML;
    assert.match(companiesAfterNav, /Acme Cloud/, "tab click loads the companies list");
    gates.save();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(pipelineCalls(), 1, "late save never refreshes the pipeline over the new tab");
    assert.equal(directoryCalls(), 1, "late save issues no list reload after the tab click");
    assert.equal(
      dirRows(document).innerHTML,
      companiesAfterNav,
      "late save never repaints rows over the new tab",
    );
  });

  test("person-record contact reassociation refreshes only that person, never the new company", async () => {
    const gates = {};
    const person = { id: "p1", organizationId: "org-1", name: "Ada", emails: ["ada@acme.example"], role: "CTO", version: 5 };
    const { document, finance, requests } = createHarness({
      route: dirRoute("people", {}),
      request: (url, options = {}) => {
        const path = requestPath(url);
        if (path === "/api/sponsor-crm/views") {
          return { items: [{ id: "builtin:people:active", entity: "people", name: "Active", builtin: true,
            filters: { active: "true" }, resolvedFilters: { active: "true" }, sort: { field: "name", direction: "asc" } }], total: 1 };
        }
        if (path === "/api/sponsor-crm/directory/people") {
          return { items: [{ ...person, companyName: "Acme Cloud", lastTouch: null }], total: 1, nextCursor: null };
        }
        if (path === "/api/sponsor-crm/contacts/p1" && (!options.method || options.method === "GET")) return { ...person };
        if (path === "/api/sponsor-crm/directory/companies/org-1") {
          return { id: "org-1", displayName: "Acme Cloud", domain: "acme.example", active: true, version: 1, updatedAt: "2026-10-12T00:00:00Z" };
        }
        if (path === "/api/sponsor-crm/contacts/p1" && options.method === "PUT") {
          return new Promise((resolve) => { gates.save = () => resolve({ ...person, organizationId: "org-new", version: 6 }); });
        }
        return directoryRequest(url, options);
      },
    });
    await finance.renderSponsorCrmSurface();
    await settle();
    await document.surface.dispatch("click", {
      target: {
        closest: (selector) => selector === "[data-open-person]" ? { dataset: { openPerson: "p1" } } : null,
      },
    });
    await settle();
    const personGets = () => requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/contacts/p1" && (!entry.options?.method || entry.options.method === "GET")).length;
    const peopleLists = () => requests.filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/people").length;
    assert.equal(personGets(), 1, "person record opens");
    const contactForm = document.surface.querySelector("[data-contact-dialog]").querySelector("form");
    contactForm.formEntries = [
      ["organizationId", "org-new"], ["contactId", "p1"], ["version", "5"],
      ["name", "Ada"], ["email", "ada@acme.example"], ["role", "CTO"],
    ];
    // The save handler awaits the deferred PUT: fire the click without
    // awaiting, settle until the gate is hit, release, then await submission.
    const submission = document.surface.querySelector("[data-contact-save]").dispatch("click", {});
    await settle();
    assert.equal(typeof gates.save, "function", "contact PUT fires");
    const peopleBefore = peopleLists();
    gates.save();
    await submission;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(personGets(), 2, "record save refreshes only the originating person");
    assert.equal(
      peopleLists(),
      peopleBefore,
      "record save never prefetches the hidden People directory",
    );
    assert.ok(
      !requests.some((entry) => requestPath(entry.url) === "/api/sponsor-crm/directory/companies/org-new"),
      "reassociation does not jump to the newly saved company",
    );
  });

  test("company-scoped pipeline view keeps organization scope in the URL and reloads it", async () => {
    const scopedRequest = (url, options = {}) => {
      if (requestPath(url) === "/api/sponsor-crm/views") return { items: [], total: 0 };
      return directoryRequest(url, options);
    };
    const first = createHarness({
      route: dirRoute("pipeline", { organizationId: "org-9" }),
      request: scopedRequest,
      setupSurface: (surface) => {
        surface.setQueryAll(
          "[data-pipeline-view],[data-pipeline-sort],[data-pipeline-owner],[data-pipeline-from],[data-pipeline-to]",
          [surface.querySelector("[data-pipeline-view]")],
        );
      },
    });
    await first.finance.renderSponsorCrmSurface();
    await settle();
    const firstQueries = first.requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline")
      .map((entry) => new URL(entry.url, "http://dataops.test").searchParams);
    assert.equal(firstQueries.length, 1, "pipeline loads once from the URL");
    assert.equal(firstQueries[0].get("organizationId"), "org-9", "company scope reaches the API on first paint");
    const viewSelect = first.document.surface.querySelector("[data-pipeline-view]");
    viewSelect.value = "all";
    await viewSelect.dispatch("change", {});
    await settle();
    const canonical = first.navigations.filter((entry) => entry.path === "/sponsors/pipeline").at(-1);
    assert.ok(canonical, "manual edit writes the canonical URL");
    assert.equal(canonical.params.organizationId, "org-9", "manual edit keeps the company scope in the URL");
    assert.equal(canonical.params.view, "all", "manual edit keeps the effective view in the URL");
    const reloaded = createHarness({
      route: dirRoute("pipeline", canonical.params),
      request: scopedRequest,
    });
    await reloaded.finance.renderSponsorCrmSurface();
    await settle();
    const reloadQueries = reloaded.requests
      .filter((entry) => requestPath(entry.url) === "/api/sponsor-crm/pipeline")
      .map((entry) => new URL(entry.url, "http://dataops.test").searchParams);
    assert.equal(reloadQueries.length, 1);
    assert.equal(reloadQueries[0].get("organizationId"), "org-9", "copied URL replays the company scope");
    assert.equal(reloadQueries[0].get("view"), "all", "copied URL replays the effective view");
  });
});
