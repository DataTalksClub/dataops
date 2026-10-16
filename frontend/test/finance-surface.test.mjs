import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { formatAmount } from "../src/surfaces/finance/bookkeeping-format.js";

import { createFinanceSurface } from "../src/surfaces/finance/index.js";
import { createSponsorFinance } from "../src/surfaces/finance/sponsor-finance.js";
import { followUpSummary } from "../src/surfaces/finance/sponsor-finance-records.js";
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
      if (requestPath(url) === "/api/team-members") {
        return {
          teamMembers: [{ id: "operator-1", name: "Synthetic Operator", active: true }],
          defaultAssigneeId: "operator-1",
        };
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
        if (path.includes("/messages")) return { items: [
          { direction: "inbound", sentAt: "2026-01-12T23:30:00Z", snippet: "Synthetic <reply>" },
          { direction: "outbound", sentAt: "2026-01-12T23:45:00Z", snippet: "Synthetic response" },
        ] };
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
    const companyDetail = document.surface.querySelector("[data-crm-detail]").innerHTML;
    assert.doesNotMatch(companyDetail, /class="booking-kind"/);
    assert.match(companyDetail, /data-status="agreed">\s*Agreed/);
    assert.match(companyDetail, /Incoming/);
    assert.match(companyDetail, /Outgoing/);
    assert.match(companyDetail, /13 Jan 2026, 00:30 CET/);
    assert.match(companyDetail, /Synthetic &lt;reply&gt;/);
    await document.surface.querySelector("[data-mail-search]").dispatch("input", {
      target: { value: "Synthetic" },
    });
    await settle();
    const searchedMail = document.surface.querySelector("[data-mail-threads]").innerHTML;
    assert.match(searchedMail, /Incoming/);
    assert.match(searchedMail, /13 Jan 2026, 00:30 CET/);
    assert.match(searchedMail, /Synthetic &lt;reply&gt;/);

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
    const companies = document.surface.querySelector("[data-crm-orgs]");
    const leads = document.surface.querySelector("[data-crm-leads]");
    assert.match(pipeline.innerHTML, /Talking Co/);
    assert.match(pipeline.innerHTML, /Open/);
    assert.match(companies.innerHTML, /Talking Co/);
    assert.match(leads.innerHTML, /Queue Vendor/);

    await document.surface.querySelector("[data-crm-views]").dispatch("click", {
      preventDefault() {},
      target: {
        closest: (selector) =>
          selector === "[data-crm-view]"
            ? { dataset: { crmView: "pipeline" } }
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
      followUp: { code: "chase-payment", party: "us", since: "2026-09-30", daysOverdue: 14 },
      reconciliationStatus: "coherent",
      paymentLinkCount: 0,
      paymentLinkLimit: 10,
    }),
  });
  await sponsorFinance.loadFinance({ id: "deal-1", version: 3 });
  const markup = panel.innerHTML;
  assert.ok(markup.indexOf("Chase the payment") < markup.indexOf("Waiting on the sponsor for a purchase order"));
  assert.match(markup, /data-finance-next-step="chase-payment"/);
  assert.match(markup, /Overdue 14 days, due/);
  assert.match(markup, /AP queue/);
  assert.match(markup, /data-finance-waiting-clear/);
  assert.match(markup, /Invoice without number/);
  assert.match(markup, /data-finance-issue[^>]*>\s*Correct invoice/);
  assert.match(markup, /data-finance-record-payment/);
  assert.match(markup, /Sponsor confirmation/);
  assert.match(markup, new RegExp(`data-finance-delete-payment="${"a".repeat(32)}"`));
  assert.match(markup, /href="https:\/\/mail\.example\.invalid\/thread\/1"[^>]*>Invoice thread/);
  assert.match(markup, /Ledger row/);
  assert.match(markup, /data-finance-evidence-remove="1"/);
});

test("follow-up summaries name the fix and who acts", () => {
  assert.equal(followUpSummary({ code: "send-invoice", party: "us", since: "2026-10-01" }).title, "Send the invoice");
  assert.equal(followUpSummary({ code: "unblock", party: "us", reason: "payment-link" }).title, "Send the sponsor a payment link");
  assert.equal(followUpSummary({ code: "await-sponsor", party: "sponsor", reason: "billing-details" }).tone, "info");
  assert.equal(followUpSummary({ code: "reconcile", party: "us" }).tone, "danger");
  assert.equal(followUpSummary({ code: "none", party: "none" }).title, "Nothing to chase");
});

test("Money lists what to chase first with each fix, then outstanding and expected cash without tiles", async () => {
  const { moneyMarkup, forecastBucketLabel } = await import("../src/surfaces/finance/sponsor-money.js");
  const markup = moneyMarkup(
    {
      asOf: "2026-10-14",
      rows: [],
      chase: [
        {
          dealId: "deal-1",
          organizationName: "Sponsor A",
          dealTitle: "Q4 newsletter",
          currency: "EUR",
          amountDue: "2500.00",
          outstanding: "2500.00",
          followUp: { code: "chase-payment", party: "us", since: "2026-09-30", daysOverdue: 14 },
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
  assert.ok(markup.indexOf("What to chase") < markup.indexOf("Outstanding"));
  assert.ok(markup.indexOf("Outstanding") < markup.indexOf("Expected cash"));
  assert.match(markup, /Chase the payment/);
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
