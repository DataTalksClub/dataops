import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createPlanningSurface } from "../src/surfaces/planning.js";

const originalDocument = globalThis.document;
const originalFormData = globalThis.FormData;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalFormData === undefined) delete globalThis.FormData;
  else globalThis.FormData = originalFormData;
});

class TestElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.checked = false;
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = "";
    this.listeners = new Map();
    this.open = false;
    this.queries = new Map();
    this.queryLists = new Map();
    this.textContent = "";
    this.value = "";
    if (this.tagName === "FORM") this.initializeForm();
  }

  initializeForm() {
    const values = [];
    const named = new Map();
    this.elements = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property !== "string" || property in target) {
          return Reflect.get(target, property, receiver);
        }
        if (!named.has(property)) {
          const input = new TestElement("input");
          input.name = property;
          named.set(property, input);
          target.push(input);
        }
        return named.get(property);
      },
    });
    this.formEntries = [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...values) {
    this.children.push(...values);
  }

  close() {
    this.open = false;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector) {
    if (!this.queries.has(selector)) {
      this.queries.set(selector, new TestElement(selector === "form" ? "form" : "div"));
    }
    return this.queries.get(selector);
  }

  querySelectorAll(selector) {
    return this.queryLists.get(selector) || [];
  }

  replaceChildren(...values) {
    this.children = values;
    this.innerHTML = "";
    this.textContent = "";
  }

  reset() {
    this.formEntries = [];
    for (const field of this.elements || []) field.value = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setQuery(selector, value) {
    this.queries.set(selector, value);
    return value;
  }

  setQueryAll(selector, values) {
    this.queryLists.set(selector, values);
    return values;
  }

  showModal() {
    this.open = true;
  }
}

class TestFormData {
  constructor(form) {
    this.entries = form.formEntries || [];
  }

  [Symbol.iterator]() {
    return this.entries[Symbol.iterator]();
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

function nextTicks(count = 3) {
  return new Promise((resolve) => {
    const tick = (remaining) => {
      if (remaining <= 0) resolve();
      else setImmediate(() => tick(remaining - 1));
    };
    tick(count);
  });
}

function createCalendarDom() {
  const surface = new TestElement("section");
  const status = surface.setQuery('[role="status"]', new TestElement("p"));
  const grid = surface.setQuery("[data-calendar]", new TestElement("div"));
  const alerts = surface.setQuery("[data-alerts]", new TestElement("div"));
  const dialog = surface.setQuery("dialog", new TestElement("dialog"));
  const form = dialog.setQuery("form", new TestElement("form"));
  form.setQuery('[role="alert"]', new TestElement("p"));
  const view = surface.setQuery("[data-view]", new TestElement("select"));
  view.value = "month";
  const type = surface.setQuery("[data-type]", new TestElement("select"));
  type.value = "";
  const layers = ["activities", "public", "school", "overlay"].map((name) => {
    const layer = new TestElement("input");
    layer.dataset.layer = name;
    layer.checked = true;
    surface.setQuery(`[data-layer="${name}"]`, layer);
    return layer;
  });
  surface.setQueryAll("[data-layer]", layers);
  for (const selector of ["[data-prev]", "[data-today]", "[data-next]", "[data-add]", "[data-cancel]"]) {
    surface.setQuery(selector, new TestElement("button"));
  }
  return { alerts, dialog, form, grid, layers, status, surface, type, view };
}

function createNewsletterDom() {
  const surface = new TestElement("section");
  const status = surface.setQuery('[role="status"]', new TestElement("p"));
  const alerts = surface.setQuery("[data-alerts]", new TestElement("div"));
  const slots = surface.setQuery("[data-slots]", new TestElement("div"));
  const dialog = surface.setQuery("dialog", new TestElement("dialog"));
  const form = dialog.setQuery("form", new TestElement("form"));
  form.setQuery('[role="alert"]', new TestElement("p"));
  const from = surface.setQuery("[data-from]", new TestElement("input"));
  const to = surface.setQuery("[data-to]", new TestElement("input"));
  const view = surface.setQuery("[data-view]", new TestElement("select"));
  view.value = "month";
  const filterStatus = surface.setQuery("[data-status]", new TestElement("select"));
  filterStatus.value = "";
  const booked = surface.setQuery("[data-booked]", new TestElement("select"));
  booked.value = "";
  const filters = [from, to, view, filterStatus, booked];
  surface.setQueryAll(".newsletter-filters input,.newsletter-filters select", filters);
  surface.setQuery("[data-newsletter-add]", new TestElement("button"));
  surface.setQuery("[data-save]", new TestElement("button"));
  return {
    alerts,
    booked,
    dialog,
    filterStatus,
    filters,
    form,
    from,
    slots,
    status,
    surface,
    to,
    view,
  };
}

function createPlanningHarness({ calendar, newsletter, request } = {}) {
  const documentList = new TestElement("main");
  const created = [];
  globalThis.document = {
    createElement(tagName) {
      if (tagName !== "section") return new TestElement(tagName);
      const value = created.length === 0 && calendar ? calendar.surface : newsletter.surface;
      created.push(value);
      return value;
    },
  };
  globalThis.FormData = TestFormData;
  const requests = [];
  const pageTitles = [];
  const surface = createPlanningSurface({
    documentList,
    escapeHtml,
    request: async (url, options = {}) => {
      const entry = { options, url: String(url) };
      requests.push(entry);
      return request(url, options, entry);
    },
    setPageTitle: (...args) => pageTitles.push(args),
    workApiUrl: (path) => new URL(path, "http://portal.test"),
  });
  return { documentList, pageTitles, requests, surface };
}

describe("Planning surface production behavior", () => {
  test("renders Calendar activities, holiday layers, overlays, and alerts honestly", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname.endsWith("/overlays")) {
          return {
            items: [
              {
                endDate: "2026-08-13",
                href: "/#/newsletter",
                label: "Newsletter 42",
                startDate: "2026-08-13",
              },
            ],
          };
        }
        return {
          alerts: [
            {
              fingerprint: "alert-1",
              reasonCode: "public-holiday-overlap",
              severity: "warning",
            },
          ],
          holidayMetadata: { outOfHorizon: true, stale: true },
          holidays: [
            {
              endDate: "2026-08-13",
              kind: "berlin-public-holiday",
              name: "Example Holiday",
              startDate: "2026-08-13",
            },
          ],
          items: [
            {
              activityType: "podcast-live",
              endKey: "2026-08-13",
              id: "activity-1",
              startKey: "2026-08-13",
              status: "confirmed",
              title: "Community podcast",
            },
          ],
        };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.deepEqual(harness.pageTitles, [["Calendar", "Operations calendar"]]);
    assert.match(dom.status.textContent, /Holiday information may be out of date/);
    assert.match(dom.status.textContent, /outside the verified holiday window/);
    assert.match(dom.grid.innerHTML, /Community podcast/);
    assert.match(dom.grid.innerHTML, /Example Holiday/);
    assert.match(dom.grid.innerHTML, /Newsletter 42/);
    assert.match(dom.alerts.innerHTML, /Activity overlaps a public holiday/);
    assert.match(dom.grid.innerHTML, /ISO week numbers/);
  });

  test("keeps Calendar usable when overlays fail and exposes filter and period controls", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname.endsWith("/overlays")) throw new Error("Overlay unavailable");
        return { alerts: [], holidays: [], items: [] };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.match(dom.status.textContent, /Newsletter dates are temporarily unavailable/);
    assert.match(dom.grid.innerHTML, /No matching activities/);

    dom.type.value = "webinar";
    dom.type.onchange();
    assert.match(dom.grid.innerHTML, /No matching activities/);
    dom.layers[0].checked = false;
    dom.layers[0].onchange();
    assert.match(dom.grid.innerHTML, /0 activities/);

    dom.view.value = "week";
    await dom.view.onchange();
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Seven-day planning view/);
    await dom.surface.querySelector("[data-next]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-prev]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-today]").onclick();
    await nextTicks();
    assert.equal(
      harness.requests.filter((entry) => entry.url.includes("calendar-items?")).length >= 4,
      true,
    );
  });

  test("creates, edits, and dismisses Calendar data through canonical mutation contracts", async () => {
    const dom = createCalendarDom();
    let activities = [
      {
        activityType: "webinar",
        endDate: "2026-08-13",
        endKey: "2026-08-13",
        id: "activity-1",
        notes: "Review agenda",
        startDate: "2026-08-13",
        startKey: "2026-08-13",
        status: "tentative",
        title: "Community webinar",
        version: 2,
      },
    ];
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url, options) => {
        const value = new URL(url);
        if (options.method) return {};
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        return {
          alerts: [
            {
              fingerprint: "calendar-alert",
              reasonCode: "school-holiday-overlap",
              severity: "warning",
            },
          ],
          holidays: [],
          items: activities,
        };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();

    dom.surface.querySelector("[data-add]").onclick();
    assert.equal(dom.dialog.open, true);
    assert.notEqual(dom.form.elements.startDate.value, "");
    dom.surface.querySelector("[data-cancel]").onclick();
    assert.equal(dom.dialog.open, false);

    dom.grid.onclick({
      target: {
        closest: () => ({ dataset: { edit: "activity-1" } }),
      },
    });
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.form.elements.title.value, "Community webinar");
    assert.equal(dom.form.elements.version.value, 2);

    dom.form.formEntries = [
      ["id", "activity-1"],
      ["version", "2"],
      ["title", "Updated webinar"],
      ["activityType", "webinar"],
      ["status", "confirmed"],
      ["startDate", "2026-08-13"],
      ["endDate", "2026-08-13"],
    ];
    await dom.form.onsubmit({ preventDefault() {} });
    await nextTicks();
    const update = harness.requests.find(
      (entry) => entry.options.method === "PUT",
    );
    assert.match(update.url, /calendar-items\/activity-1$/);
    assert.deepEqual(JSON.parse(update.options.body), {
      activityType: "webinar",
      allDay: true,
      endDate: "2026-08-13",
      startDate: "2026-08-13",
      status: "confirmed",
      timeZone: "Europe/Berlin",
      title: "Updated webinar",
      version: 2,
    });

    await dom.alerts.onclick({
      target: {
        closest: () => ({ dataset: { dismiss: "calendar-alert" } }),
      },
    });
    await nextTicks();
    assert.equal(
      harness.requests.some(
        (entry) =>
          entry.options.method === "POST" &&
          entry.url.endsWith("/alerts/calendar-alert/dismiss"),
      ),
      true,
    );
    activities = [];
  });

  test("retains Calendar form input on mutation failure and renders load failure recovery", async () => {
    const dom = createCalendarDom();
    let failLoad = false;
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url, options) => {
        const value = new URL(url);
        if (options.method) throw new Error("Version conflict");
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        if (failLoad) throw new Error("Calendar offline");
        return { alerts: [], holidays: [], items: [] };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    dom.dialog.showModal();
    dom.form.formEntries = [
      ["title", "Retained activity"],
      ["startDate", "2026-08-13"],
      ["endDate", "2026-08-13"],
    ];
    await dom.form.onsubmit({ preventDefault() {} });
    assert.equal(dom.dialog.open, true);
    assert.equal(
      dom.form.querySelector('[role="alert"]').textContent,
      "Could not save activity: Version conflict",
    );

    failLoad = true;
    await dom.view.onchange();
    await nextTicks();
    assert.match(dom.status.textContent, /Calendar offline/);
    assert.match(dom.grid.innerHTML, /Calendar unavailable/);
  });

  test("renders grouped Newsletter slots, safe booking labels, links, and alerts", async () => {
    const dom = createNewsletterDom();
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async () => ({
        alerts: [
          {
            reasonCode: "near-term-open-unbooked",
            severity: "warning",
          },
        ],
        items: [
          {
            bookedByDisplayName: "Example Sponsor",
            campaignLabel: "Community Newsletter",
            campaignNumber: 42,
            id: "slot-1",
            planningNote: "Materials confirmed",
            publicUrl: "https://example.invalid/campaign/42",
            publicationDate: "2026-08-21",
            status: "scheduled",
          },
          {
            bookedByUserId: "user-example",
            campaignLabel: "Follow-up Newsletter",
            id: "slot-2",
            publicationDate: "2026-08-28",
            status: "drafting",
          },
        ],
      }),
    });
    await harness.surface.renderNewsletterSurface();
    assert.deepEqual(harness.pageTitles, [["Newsletter", "Newsletter planner"]]);
    assert.equal(dom.status.textContent, "Newsletter schedule ready.");
    assert.match(dom.alerts.innerHTML, /An open slot needs booking soon/);
    assert.match(dom.slots.innerHTML, /Community Newsletter/);
    assert.match(dom.slots.innerHTML, /Example Sponsor/);
    assert.match(dom.slots.innerHTML, /Campaign 42/);
    assert.match(dom.slots.innerHTML, /Open campaign/);
    assert.match(dom.slots.innerHTML, /Team member/);
    assert.equal(harness.requests[0].url.includes("from="), true);
    assert.equal(harness.requests[0].url.includes("to="), true);
  });

  test("supports Newsletter week grouping, filtering, create/edit, and numeric mutation fields", async () => {
    const dom = createNewsletterDom();
    const items = [
      {
        cardId: "card-1",
        campaignLabel: "Weekly update",
        campaignNumber: 7,
        id: "slot-1",
        publicationDate: "2026-08-21",
        status: "reserved",
        version: 3,
      },
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (_url, options) =>
        options.method ? {} : { alerts: [], items },
    });
    await harness.surface.renderNewsletterSurface();
    dom.view.value = "week";
    await dom.view.onchange();
    assert.match(dom.slots.innerHTML, /week/);
    dom.filterStatus.value = "reserved";
    await dom.filterStatus.onchange();
    assert.equal(
      harness.requests.at(-1).url.includes("status=reserved"),
      true,
    );

    dom.surface.querySelector("[data-newsletter-add]").onclick();
    assert.equal(dom.dialog.open, true);
    dom.slots.onclick({
      target: {
        closest: () => ({ dataset: { edit: "slot-1" } }),
      },
    });
    assert.equal(dom.form.elements.campaignLabel.value, "Weekly update");
    assert.equal(dom.form.elements.version.value, 3);

    dom.form.formEntries = [
      ["id", "slot-1"],
      ["version", "3"],
      ["campaignNumber", "8"],
      ["campaignLabel", "Updated weekly update"],
      ["publicationDate", "2026-08-22"],
      ["status", "scheduled"],
    ];
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    const update = harness.requests.find(
      (entry) => entry.options.method === "PUT",
    );
    assert.match(update.url, /newsletter-slots\/slot-1$/);
    assert.deepEqual(JSON.parse(update.options.body), {
      campaignLabel: "Updated weekly update",
      campaignNumber: 8,
      publicationDate: "2026-08-22",
      status: "scheduled",
      version: 3,
    });
    assert.equal(dom.dialog.open, false);
  });

  test("renders honest Newsletter empty/failure states and retains failed form edits", async () => {
    const emptyDom = createNewsletterDom();
    const emptyHarness = createPlanningHarness({
      newsletter: emptyDom,
      request: async () => ({ alerts: [], items: [] }),
    });
    await emptyHarness.surface.renderNewsletterSurface();
    assert.match(emptyDom.slots.innerHTML, /No newsletter slots/);

    const failureDom = createNewsletterDom();
    let loadSucceeded = false;
    const failureHarness = createPlanningHarness({
      newsletter: failureDom,
      request: async (_url, options) => {
        if (options.method) throw new Error("Slot conflict");
        if (loadSucceeded) return { alerts: [], items: [] };
        throw new Error("Newsletter offline");
      },
    });
    await failureHarness.surface.renderNewsletterSurface();
    assert.match(failureDom.status.textContent, /Newsletter offline/);
    assert.match(failureDom.slots.innerHTML, /Newsletter schedule unavailable/);

    loadSucceeded = true;
    await failureDom.filterStatus.onchange();
    failureDom.dialog.showModal();
    failureDom.form.formEntries = [
      ["campaignLabel", "Retained slot"],
      ["publicationDate", "2026-08-30"],
    ];
    await failureDom.surface.querySelector("[data-save]").onclick({
      preventDefault() {},
    });
    assert.equal(failureDom.dialog.open, true);
    assert.equal(
      failureDom.form.querySelector('[role="alert"]').textContent,
      "Could not save slot: Slot conflict",
    );
  });
});
