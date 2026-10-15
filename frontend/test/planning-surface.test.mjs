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
    this.classList = {
      classes: new Set(),
      add: (...tokens) => tokens.forEach((t) => this.classList.classes.add(t)),
      remove: (...tokens) => tokens.forEach((t) => this.classList.classes.delete(t)),
      toggle: (token, force) => {
        const has = this.classList.classes.has(token);
        const should = force !== undefined ? Boolean(force) : !has;
        if (should) this.classList.classes.add(token);
        else this.classList.classes.delete(token);
        return should;
      },
      contains: (token) => this.classList.classes.has(token),
    };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = "";
    this.style = {};
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

  prepend(...values) {
    this.children.unshift(...values);
  }

  before(...values) {
    this.insertedBefore = values;
  }

  click() {
    for (const listener of this.listeners.get("click") || []) listener({ target: this });
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

  removeAttribute(name) {
    this.attributes.delete(name);
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
    if (form.formEntries && form.formEntries.length > 0) {
      this.entries = form.formEntries;
    } else {
      this.entries = (form.elements || [])
        .filter((field) => field.name && field.value !== undefined)
        .map((field) => [field.name, field.value]);
    }
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
  form.elements.allDay.checked = true;
  form.setQuery('[role="alert"]', new TestElement("p"));
  const view = surface.setQuery("[data-view]", new TestElement("select"));
  view.value = "month";
  const type = surface.setQuery("[data-type]", new TestElement("select"));
  type.value = "";
  const layers = ["activities", "public", "school", "overlay", "alexey", "available"].map((name) => {
    const layer = new TestElement("input");
    layer.dataset.layer = name;
    layer.checked = true;
    surface.setQuery(`[data-layer="${name}"]`, layer);
    return layer;
  });
  surface.setQueryAll("[data-layer]", layers);
  for (const selector of ["[data-prev]", "[data-today]", "[data-next]", "[data-cancel]", "[data-controls-toggle]"]) {
    surface.setQuery(selector, new TestElement("button"));
  }
  const pickerToggle = surface.setQuery("[data-picker-toggle]", new TestElement("button"));
  const pickerPopover = surface.setQuery("[data-picker-popover]", new TestElement("div"));
  pickerPopover.hidden = true;
  const pickerYear = surface.setQuery("[data-picker-year]", new TestElement("span"));
  pickerYear.textContent = "2026";
  const pickerPrevYear = surface.setQuery("[data-picker-prev-year]", new TestElement("button"));
  const pickerNextYear = surface.setQuery("[data-picker-next-year]", new TestElement("button"));
  const pickerCurrentMonth = surface.setQueryAll("[data-picker-shortcut]", [Object.assign(new TestElement("button"), { dataset: { pickerShortcut: "current" } })])[0];
  const monthBtns = Array.from({ length: 12 }, (_, i) => {
    const btn = new TestElement("button");
    btn.dataset.pickerMonth = String(i);
    return btn;
  });
  surface.setQueryAll("[data-picker-month]", monthBtns);
  const settingsBtn = surface.setQuery("[data-calendar-settings]", new TestElement("button"));
  const settingsDialog = surface.setQuery("[data-settings-dialog]", new TestElement("dialog"));
  const settingsForm = settingsDialog.setQuery("form", new TestElement("form"));
  settingsForm.setQuery('[data-settings-error]', new TestElement("p"));
  const settingsCancel = settingsDialog.setQuery("[data-settings-cancel]", new TestElement("button"));
  const connectionsDatalist = settingsDialog.setQuery("#dapier-calendar-connections", new TestElement("datalist"));
  const dayDialog = surface.setQuery("[data-day-dialog]", new TestElement("dialog"));
  const dayTitle = dayDialog.setQuery("[data-day-title]", new TestElement("h2"));
  const daySubtitle = dayDialog.setQuery("[data-day-subtitle]", new TestElement("p"));
  const dayBody = dayDialog.setQuery("[data-day-body]", new TestElement("div"));
  const dayClose = dayDialog.setQuery("[data-day-close]", new TestElement("button"));
  const dayCloseFoot = dayDialog.setQuery("[data-day-close-foot]", new TestElement("button"));
  const dayAddActivity = dayDialog.setQuery("[data-day-add-activity]", new TestElement("button"));
  return {
    alerts,
    dayAddActivity,
    dayBody,
    dayClose,
    dayCloseFoot,
    dayDialog,
    daySubtitle,
    dayTitle,
    dialog,
    form,
    grid,
    layers,
    pickerCurrentMonth,
    pickerMonthBtns: monthBtns,
    pickerNextYear,
    pickerPopover,
    pickerPrevYear,
    pickerToggle,
    pickerYear,
    settingsBtn,
    settingsCancel,
    settingsDialog,
    settingsForm,
    status,
    surface,
    type,
    view,
  };
}

function createNewsletterDom() {
  const surface = new TestElement("section");
  const status = surface.setQuery('[role="status"]', new TestElement("p"));
  const alerts = surface.setQuery("[data-alerts]", new TestElement("div"));
  const slots = surface.setQuery("[data-slots]", new TestElement("div"));
  const dialog = surface.setQuery("dialog", new TestElement("dialog"));
  const form = dialog.setQuery("form", new TestElement("form"));
  form.setQuery('[role="alert"]', new TestElement("p"));

  const dialogTabs = ["details", "compose", "preview", "schedule"].map((tabName) => {
    const btn = new TestElement("button");
    btn.dataset.dialogTab = tabName;
    return btn;
  });
  dialog.setQueryAll("[data-dialog-tab]", dialogTabs);

  const dialogPanes = ["details", "compose", "preview", "schedule"].map((paneName) => {
    const pane = new TestElement("div");
    pane.dataset.pane = paneName;
    return pane;
  });
  dialog.setQueryAll("[data-pane]", dialogPanes);

  const actions = ["start-draft", "submit-review", "prompt-schedule", "prompt-send", "return-draft"].map((act) => {
    const btn = new TestElement("button");
    btn.dataset.action = act;
    dialog.setQuery(`[data-action="${act}"]`, btn);
    return btn;
  });
  dialog.setQueryAll("[data-action]", actions);

  const confirmCard = dialog.setQuery("[data-confirm-card]", new TestElement("div"));
  confirmCard.hidden = true;
  dialog.setQuery("[data-confirm-proceed]", new TestElement("button"));
  dialog.setQuery("[data-confirm-cancel]", new TestElement("button"));
  dialog.setQuery("[data-confirm-title]", new TestElement("h4"));
  dialog.setQuery("[data-confirm-message]", new TestElement("p"));
  dialog.setQuery("[data-status-banner]", new TestElement("div"));
  dialog.setQuery("[data-status-banner-badge]", new TestElement("span"));
  dialog.setQuery("[data-status-banner-text]", new TestElement("span"));
  dialog.setQuery("[data-action-bar]", new TestElement("div"));

  dialog.setQuery('[name="schedulePublicationDate"]', new TestElement("input"));
  dialog.setQuery('[name="schedulePublicationTime"]', new TestElement("input"));

  const stepperSteps = [1, 2, 3, 4, 5].map((step) => {
    const el = new TestElement("div");
    el.dataset.step = String(step);
    return el;
  });
  dialog.setQueryAll(".stepper-step", stepperSteps);

  const checkDate = dialog.setQuery("[data-check-date]", new TestElement("div"));
  const checkTime = dialog.setQuery("[data-check-time]", new TestElement("div"));
  const checkSubject = dialog.setQuery("[data-check-subject]", new TestElement("div"));
  const checkContent = dialog.setQuery("[data-check-content]", new TestElement("div"));
  const checkSponsor = dialog.setQuery("[data-check-sponsor]", new TestElement("div"));
  const checkCard = dialog.setQuery("[data-check-card]", new TestElement("div"));
  for (const c of [checkDate, checkTime, checkSubject, checkContent, checkSponsor, checkCard]) {
    c.setQuery(".check-icon", new TestElement("span"));
    c.setQuery("span:last-child", new TestElement("span"));
  }
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

  const viewAll = new TestElement("button");
  viewAll.dataset = { newsletterView: "all" };
  const viewUpcoming = new TestElement("button");
  viewUpcoming.dataset = { newsletterView: "upcoming" };
  const viewSent = new TestElement("button");
  viewSent.dataset = { newsletterView: "sent" };
  const viewButtons = [viewAll, viewUpcoming, viewSent];
  surface.setQueryAll("[data-newsletter-view]", viewButtons);

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
    viewAll,
    viewButtons,
    viewSent,
    viewUpcoming,
  };
}

function createPlanningHarness({
  calendar,
  newsletter,
  request,
  today = "2026-08-13",
} = {}) {
  const documentList = new TestElement("main");
  const created = [];
  globalThis.document = {
    createElement(tagName) {
      if (tagName !== "section") return new TestElement(tagName);
      const value = created.length === 0 && calendar ? calendar.surface : newsletter.surface;
      created.push(value);
      return value;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.FormData = TestFormData;
  const requests = [];
  const routeTitles = [];
  const surface = createPlanningSurface({
    documentList,
    escapeHtml,
    request: async (url, options = {}) => {
      const entry = { options, url: String(url) };
      requests.push(entry);
      return request(url, options, entry);
    },
    setRouteTitle: (title) => routeTitles.push(title),
    todayIsoDate: () => today,
    viewportWidth: () => 1280,
    workApiUrl: (path) => new URL(path, "http://portal.test"),
  });
  return { documentList, requests, routeTitles, surface };
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
                category: "Newsletter",
                endDate: "2026-08-13",
                href: "/newsletter",
                label: "Newsletter 42",
                provider: "newsletter-slots-readonly",
                startDate: "2026-08-13",
              },
              {
                category: "Alexey",
                endDate: "2026-08-13",
                label: "12:25–13:30 Tejas at DataTalks.Club Podcast",
                provider: "alexey-calendar",
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
    const header = dom.surface.children[0];
    assert.equal(header.className, "dk-page-header calendar-page-header");
    assert.equal(header.children[0].children[0].textContent, "Calendar");
    assert.equal(header.children[0].children[0].id, "calendar-surface-title");
    await nextTicks();
    assert.deepEqual(harness.routeTitles, ["Calendar"]);
    assert.match(dom.status.textContent, /Holiday information may be out of date/);
    assert.match(dom.status.textContent, /outside the verified holiday window/);
    assert.match(dom.grid.innerHTML, /Community podcast/);
    assert.match(dom.grid.innerHTML, /Example Holiday/);
    // The holiday marks its whole day cell, not just a chip inside it.
    assert.match(dom.grid.innerHTML, /class="calendar-day[^"]*has-public-holiday"[^>]*aria-label="Thursday, August 13, 2026, public holiday"/);
    assert.equal((dom.grid.innerHTML.match(/has-public-holiday/g) || []).length, 1);
    assert.match(dom.grid.innerHTML, /Newsletter 42/);
    assert.match(dom.grid.innerHTML, /Tejas at DataTalks\.Club Podcast/);
    assert.match(dom.grid.innerHTML, /is-alexey/);
    assert.match(dom.alerts.innerHTML, /Activity overlaps a public holiday/);
    assert.match(dom.grid.innerHTML, /calendar-week-heading/);
    assert.match(dom.grid.innerHTML, /calendar-week-number/);
    assert.match(dom.grid.innerHTML, /<small class="iso-week">\d+<\/small>/);
    assert.match(dom.grid.innerHTML, /calendar-week is-current-week/);
    assert.match(dom.grid.innerHTML, /calendar-week-number is-current-week/);
    assert.match(dom.grid.innerHTML, /calendar-day[^"]*is-current-week/);
    expectCalendarRange(harness.requests[0], "2026-07-27", "2026-09-06");

    // Toggle off Alexey's calendar layer
    dom.surface.querySelector('[data-layer="alexey"]').checked = false;
    dom.surface.querySelector('[data-layer="alexey"]').onchange();
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Newsletter 42/);
    assert.doesNotMatch(dom.grid.innerHTML, /Tejas at DataTalks\.Club Podcast/);

    // Toggle back on
    dom.surface.querySelector('[data-layer="alexey"]').checked = true;
    dom.surface.querySelector('[data-layer="alexey"]').onchange();
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Tejas at DataTalks\.Club Podcast/);
  });

  test("renders owned Calendar planning data while an external overlay is pending", async () => {
    const dom = createCalendarDom();
    let finishOverlay;
    const overlay = new Promise((resolve) => { finishOverlay = resolve; });
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => String(url).includes("/overlays") ? overlay : {
        items: [{ id: "pending-overlay", title: "Ready planning activity", allDay: true,
          startDate: "2026-08-13", endDate: "2026-08-13" }],
        holidays: [], alerts: [],
      },
    });
    const loading = harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Ready planning activity/);
    assert.match(dom.status.textContent, /Loading calendar overlays/);
    finishOverlay({ items: [] });
    await loading;
    assert.equal(dom.status.textContent, "");
  });

  test("shows open slots on their own layer and flags those on holidays", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => String(url).includes("/overlays")
        ? {
          items: [
            { provider: "alexey-calendar", id: "alexey-slot:2026-08-12:midday", startDate: "2026-08-12", endDate: "2026-08-12",
              label: "12:30 Available", category: "Available slot", isAvailableSlot: true },
            { provider: "newsletter-slots-readonly", id: "slot-open", startDate: "2026-08-13", endDate: "2026-08-13",
              label: "Issue 99", status: "open", href: "/newsletter?slotId=slot-open" },
            { provider: "newsletter-slots-readonly", id: "slot-booked", startDate: "2026-08-14", endDate: "2026-08-14",
              label: "Booked issue", status: "scheduled", href: "/newsletter?slotId=slot-booked" },
          ],
          sources: {},
        }
        : {
          items: [], alerts: [],
          holidays: [{ startDate: "2026-08-13", endDate: "2026-08-13", kind: "berlin-public-holiday", name: "Example Holiday" }],
        },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    const html = dom.grid.innerHTML;
    assert.match(html, /class="calendar-overlay is-alexey is-available-slot"\s+data-open-day="2026-08-12" title="Open event slot: 12:30 Available"/);
    assert.match(html, /class="calendar-overlay is-newsletter is-available-slot is-holiday-conflict" href="\/newsletter\?slotId=slot-open" title="Free newsletter slot: Issue 99 \(conflicts with Example Holiday\)"/);
    assert.match(html, /<small>Blocked<\/small>/);
    assert.match(html, /class="calendar-overlay is-newsletter" href="\/newsletter\?slotId=slot-booked"/);

    // The Available slots chip hides open slots only; booked dates stay.
    dom.surface.querySelector('[data-layer="available"]').checked = false;
    dom.surface.querySelector('[data-layer="available"]').onchange();
    assert.doesNotMatch(dom.grid.innerHTML, /12:30 Available|Issue 99/);
    assert.match(dom.grid.innerHTML, /Booked issue/);
    // Alexey's calendar chip no longer controls the open slots.
    dom.surface.querySelector('[data-layer="available"]').checked = true;
    dom.surface.querySelector('[data-layer="alexey"]').checked = false;
    dom.surface.querySelector('[data-layer="alexey"]').onchange();
    assert.match(dom.grid.innerHTML, /12:30 Available/);
  });

  test("marks Alexey's calendar as not connected instead of showing an empty layer", async () => {
    const dom = createCalendarDom();
    const chip = dom.surface.setQuery('[data-layer-chip="alexey"]', new TestElement("label"));
    const chipStatus = chip.setQuery("[data-layer-chip-status]", new TestElement("span"));
    const reason = "No calendar broker credential is available in this environment.";
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => String(url).includes("/overlays")
        ? { items: [], sources: { "alexey-calendar": { state: "not-configured", reason } } }
        : { items: [], holidays: [], alerts: [] },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.equal(chip.classList.contains("is-disconnected"), true);
    assert.equal(chip.title, `Alexey's calendar is not connected: ${reason}`);
    assert.equal(chipStatus.textContent, ` (not connected: ${reason})`);
    assert.equal(dom.status.textContent, `Alexey's calendar is not connected: ${reason}`);

    // Hiding the layer drops the notice; the chip keeps its disconnected state.
    dom.surface.querySelector('[data-layer="alexey"]').checked = false;
    dom.surface.querySelector('[data-layer="alexey"]').onchange();
    assert.equal(dom.status.textContent, "");
    assert.equal(chip.classList.contains("is-disconnected"), true);
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
    assert.match(dom.status.textContent, /Calendar overlays are temporarily unavailable/);
    assert.match(dom.surface.innerHTML, /Europe\/Berlin time/);

    dom.type.value = "webinar";
    dom.type.onchange();
    assert.equal(dom.grid.querySelectorAll(".calendar-item").length, 0);
    dom.layers[0].checked = false;
    dom.layers[0].onchange();
    assert.equal(dom.grid.querySelectorAll(".calendar-item").length, 0);

    dom.view.value = "week";
    await dom.view.onchange();
    await nextTicks();
    assert.match(dom.surface.querySelector("[data-period-heading]").textContent, /Week of/);
    await dom.surface.querySelector("[data-next]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-prev]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-next]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-next]").onclick();
    await nextTicks();
    await dom.surface.querySelector("[data-today]").onclick();
    await nextTicks();
    assert.equal(
      harness.requests.filter((entry) => entry.url.includes("calendar-items?")).length >= 4,
      true,
    );
    expectCalendarRange(
      harness.requests.filter(
        (entry) => new URL(entry.url).pathname === "/api/calendar-items",
      ).at(-1),
      "2026-08-10",
      "2026-08-16",
    );

    assert.equal(dom.pickerPopover.hidden, true);
    dom.pickerToggle.onclick({ stopPropagation() {} });
    assert.equal(dom.pickerPopover.hidden, false);
    assert.equal(dom.pickerToggle.getAttribute("aria-expanded"), "true");

    dom.pickerNextYear.onclick({ stopPropagation() {} });
    assert.equal(dom.pickerYear.textContent, "2027");

    dom.pickerPrevYear.onclick({ stopPropagation() {} });
    assert.equal(dom.pickerYear.textContent, "2026");

    dom.pickerMonthBtns[11].onclick({ stopPropagation() {} });
    assert.equal(dom.pickerPopover.hidden, true);
    await nextTicks();
    assert.equal(dom.surface.querySelector("[data-period-heading]").textContent, "December 2026");
    assert.match(dom.grid.innerHTML, /December 1, 2026/);

    // A month starting on Sunday includes the full week containing its first day.
    dom.pickerToggle.onclick({ stopPropagation() {} });
    dom.pickerMonthBtns[10].onclick({ stopPropagation() {} });
    await nextTicks();
    assert.equal(dom.surface.querySelector("[data-period-heading]").textContent, "November 2026");
    assert.match(dom.grid.innerHTML, /Monday, October 26, 2026/);
    assert.match(dom.grid.innerHTML, /Sunday, November 1, 2026/);
    assert.match(dom.grid.innerHTML, /Saturday, November 7, 2026/);
    assert.match(dom.grid.innerHTML, /Monday, November 2, 2026/);
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

    // Add activity sits in the calendar toolbar, ahead of the layers toggle,
    // as the page's one create action.
    const [addActivity] = dom.surface.querySelector("[data-controls-toggle]").insertedBefore;
    assert.equal(addActivity.title, "Add activity (C)");
    assert.equal(addActivity.getAttribute("aria-keyshortcuts"), "c");
    addActivity.click();
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

  test("configures and saves calendar overlay settings and connection", async () => {
    const dom = createCalendarDom();
    const calls = [];
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url, options = {}) => {
        const u = String(url);
        calls.push({ url: u, method: options.method || "GET", body: options.body });
        if (u.includes("/api/calendar-items/settings") && options.method === "PUT") {
          return {
            settings: JSON.parse(options.body),
          };
        }
        if (u.includes("/api/calendar-items/settings")) {
          return {
            settings: {
              connectionId: "google-calendar",
              showAvailableSlots: true,
              filterNonSlotHours: true,
              filterDtcPlaceholders: true,
              filterTransparent: true,
              filterLunch: true,
              filterRoutines: true,
              filterFitness: true,
              filterCampaigns: true,
              filterBusy: true,
              customKeywords: ["dentist"],
            },
            connections: [
              { connectionId: "google-calendar", title: "google-calendar (primary)" },
              { connectionId: "work-calendar", title: "work-calendar (work)" },
            ],
          };
        }
        if (u.includes("/overlays")) {
          return { items: [] };
        }
        return {
          alerts: [],
          holidays: [],
          items: [],
        };
      },
    });

    await harness.surface.renderCalendarSurface();
    await nextTicks();

    // Click settings button
    await dom.settingsBtn.onclick();
    await nextTicks();

    assert.equal(dom.settingsDialog.open, true);
    assert.equal(dom.settingsForm.elements.connectionId.value, "google-calendar");
    assert.equal(dom.settingsForm.elements.showAvailableSlots.checked, true);
    assert.equal(dom.settingsForm.elements.filterNonSlotHours.checked, true);
    assert.equal(dom.settingsForm.elements.filterDtcPlaceholders.checked, true);
    assert.equal(dom.settingsForm.elements.filterTransparent.checked, true);
    assert.equal(dom.settingsForm.elements.filterLunch.checked, true);
    assert.equal(dom.settingsForm.elements.filterBusy.checked, true);
    assert.equal(dom.settingsForm.elements.customKeywords.value, "dentist");

    // Modify settings and submit
    dom.settingsForm.elements.connectionId.value = "work-calendar";
    dom.settingsForm.elements.showAvailableSlots.checked = false;
    dom.settingsForm.elements.filterNonSlotHours.checked = false;
    dom.settingsForm.elements.filterDtcPlaceholders.checked = false;
    dom.settingsForm.elements.filterTransparent.checked = false;
    dom.settingsForm.elements.filterLunch.checked = false;
    dom.settingsForm.elements.filterBusy.checked = false;
    dom.settingsForm.elements.customKeywords.value = "dentist\nhaircut";

    await dom.settingsForm.onsubmit({ preventDefault() {} });
    await nextTicks();

    assert.equal(dom.settingsDialog.open, false);
    const putCall = calls.find((c) => c.method === "PUT" && c.url.includes("/api/calendar-items/settings"));
    assert.ok(putCall);
    const sent = JSON.parse(putCall.body);
    assert.equal(sent.connectionId, "work-calendar");
    assert.equal(sent.showAvailableSlots, false);
    assert.equal(sent.filterNonSlotHours, false);
    assert.equal(sent.filterDtcPlaceholders, false);
    assert.equal(sent.filterTransparent, false);
    assert.equal(sent.filterLunch, false);
    assert.equal(sent.filterBusy, false);
    assert.deepEqual(sent.customKeywords, ["dentist", "haircut"]);
  });

  test("opens day schedule dialog displaying full day schedule, slot availability, and other events", async () => {
    const dom = createCalendarDom();
    const requests = [];
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const u = String(url);
        requests.push(u);
        if (u.includes("/overlays?from=2026-08-13&to=2026-08-13")) {
          return {
            items: [
              {
                id: "alexey-calendar:evt-morning",
                category: "Alexey",
                label: "09:30–10:30 Team sync",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "outside",
                isSlotEvent: false,
              },
              {
                id: "alexey-calendar:evt-podcast",
                category: "Alexey",
                label: "12:30–13:30 Podcast with Guest",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "midday",
                isSlotEvent: true,
              },
              {
                id: "alexey-calendar:evt-call",
                category: "Alexey",
                label: "15:00–15:45 Partner discussion",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "outside",
                isSlotEvent: false,
              },
            ],
          };
        }
        if (u.includes("/overlays")) {
          return {
            items: [
              {
                id: "alexey-calendar:evt-podcast",
                category: "Alexey",
                label: "12:30–13:30 Podcast with Guest",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "midday",
                isSlotEvent: true,
              },
            ],
          };
        }
        return {
          alerts: [],
          holidays: [],
          items: [
            {
              id: "activity-1",
              title: "Community webinar",
              activityType: "webinar",
              status: "confirmed",
              startDate: "2026-08-13",
              endDate: "2026-08-13",
              startKey: "2026-08-13",
              endKey: "2026-08-13",
              allDay: true,
              version: 1,
            },
          ],
        };
      },
    });

    await harness.surface.renderCalendarSurface();
    await nextTicks();

    // Click on day button for 2026-08-13
    await dom.grid.onclick({
      target: {
        closest: (sel) => {
          if (sel === "[data-open-day]") return { dataset: { openDay: "2026-08-13" } };
          return null;
        },
      },
    });
    await nextTicks();

    assert.equal(dom.dayDialog.open, true);
    assert.match(dom.dayTitle.textContent, /13 August 2026/);
    assert.match(dom.daySubtitle.textContent, /2026-08-13/);

    // Verify dayBody contains slot availability & both slot and other events
    assert.match(dom.dayBody.innerHTML, /Midday Event Slot/);
    assert.match(dom.dayBody.innerHTML, /Evening Event Slot/);
    assert.match(dom.dayBody.innerHTML, /Podcast with Guest/);
    assert.match(dom.dayBody.innerHTML, /Team sync/);
    assert.match(dom.dayBody.innerHTML, /Partner discussion/);
    assert.match(dom.dayBody.innerHTML, /Community webinar/);

    // Click close
    dom.dayClose.onclick();
    assert.equal(dom.dayDialog.open, false);
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
    assert.deepEqual(harness.routeTitles, ["Newsletter"]);
    assert.equal(dom.status.textContent, "");
    assert.match(dom.alerts.innerHTML, /An open slot needs booking soon/);
    assert.match(dom.slots.innerHTML, /Community Newsletter/);
    assert.match(dom.slots.innerHTML, /Example Sponsor/);
    assert.match(dom.slots.innerHTML, /Campaign 42/);
    assert.match(dom.slots.innerHTML, /Open campaign/);
    assert.match(dom.slots.innerHTML, /Team member/);
    const range = new URL(harness.requests[0].url).searchParams;
    assert.equal(range.get("from"), "2026-08-01");
    assert.equal(range.get("to"), "2027-12-31");
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

  test("shows each slot's Card chip and offers Create card or Link card on unlinked slots", async () => {
    const dom = createNewsletterDom();
    const items = [
      {
        id: "slot-linked",
        version: 2,
        campaignLabel: "Linked issue",
        publicationDate: "2026-08-21",
        status: "drafting",
        cardId: "card-1",
        card: { id: "card-1", title: "Newsletter #42", stage: "preparation", status: "active", anchorDate: "2026-08-20", taskCount: 6, openTaskCount: 4 },
      },
      { id: "slot-free", version: 5, campaignLabel: "Free issue", publicationDate: "2026-08-28", status: "open", card: null },
      { id: "slot-gone", version: 1, campaignLabel: "Gone issue", publicationDate: "2026-09-04", status: "open", cardId: "card-gone", card: null },
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (_url, options) => (options.method ? {} : { alerts: [], items }),
    });
    await harness.surface.renderNewsletterSurface();
    const html = dom.slots.innerHTML;
    assert.match(html, /href="\/cards\?cardId=card-1"/);
    assert.match(html, /Newsletter #42/);
    assert.match(html, /Preparation ·\s+<span class="dk-mono">4\/6<\/span> open/);
    assert.match(html, /data-card-date-mismatch><span class="newsletter-card-chip__warning-label">Card dated <\/span>\s*20 Aug/);
    assert.match(html, /data-card-create="slot-free"/);
    assert.match(html, /data-card-link="slot-free"/);
    assert.match(html, /Linked card unavailable/);
    assert.doesNotMatch(html, /data-card-create="slot-linked"/);

    const createButton = { dataset: { cardCreate: "slot-free" }, getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
    dom.slots.onclick({
      target: { closest: (selector) => (selector === "[data-card-create]" ? createButton : null) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const create = harness.requests.find((entry) => entry.options.method === "POST");
    assert.match(create.url, /newsletter-slots\/slot-free\/card$/);
    assert.deepEqual(JSON.parse(create.options.body), { version: 5 });
  });

  test("renders honest Newsletter empty/failure states and retains failed form edits", async () => {
    const emptyDom = createNewsletterDom();
    const emptyHarness = createPlanningHarness({
      newsletter: emptyDom,
      request: async () => ({ alerts: [], items: [] }),
    });
    await emptyHarness.surface.renderNewsletterSurface();
    assert.match(emptyDom.slots.innerHTML, /No newsletter slots/);
    // The empty schedule repeats the create action as a secondary button.
    assert.match(emptyDom.slots.innerHTML, /dk-button--secondary[^"]*collection-empty-action"[^>]*data-newsletter-add-first[^>]*>[\s\S]*Create the first slot/);
    assert.doesNotMatch(emptyDom.slots.innerHTML, /data-dk-create/);
    // Add slot follows the view tabs, not the page header's corner.
    const [headerHtml, bodyHtml] = emptyDom.surface.innerHTML.split('<div class="newsletter-toolbar">');
    assert.doesNotMatch(headerHtml, /Add slot/);
    assert.match(bodyHtml, /^[\s\S]*?newsletter-views[\s\S]*?<\/div>\s*<button[^>]*data-dk-create[^>]*data-newsletter-add[\s\S]*?Add slot/);
    emptyDom.slots.onclick({ target: { closest: (selector) => (selector === "[data-newsletter-add-first]" ? {} : null), classList: {} } });
    assert.equal(emptyDom.dialog.open, true);

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
    assert.equal(
      failureDom.form.querySelector('[role="alert"]').textContent,
      "Could not save slot: Slot conflict",
    );
  });

  test("filters by view tabs (All, Upcoming, Sent)", async () => {
    const dom = createNewsletterDom();
    const items = [
      {
        id: "slot-1",
        publicationDate: "2026-08-15",
        campaignNumber: 10,
        campaignLabel: "Issue 10 Upcoming Open",
        status: "open",
      },
      {
        id: "slot-2",
        publicationDate: "2026-08-20",
        campaignNumber: 11,
        campaignLabel: "Issue 11 Drafting",
        status: "drafting",
        bookedByDisplayName: "Alice",
      },
      {
        id: "slot-3",
        publicationDate: "2026-08-25",
        campaignNumber: 12,
        campaignLabel: "Issue 12 Scheduled",
        status: "scheduled",
        bookedByUserId: "bob",
      },
      {
        id: "slot-4",
        publicationDate: "2026-08-01",
        campaignNumber: 9,
        campaignLabel: "Issue 9 Sent",
        status: "sent",
        publicUrl: "https://example.invalid/9",
      },
      {
        id: "slot-5",
        publicationDate: "2026-08-28",
        campaignNumber: 13,
        campaignLabel: "Issue 13 In Review",
        status: "review",
      },
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async () => ({ alerts: [], items }),
    });
    await harness.surface.renderNewsletterSurface();

    // Default "All" view shows all 5 slots
    assert.match(dom.slots.innerHTML, /Issue 10 Upcoming Open/);
    assert.match(dom.slots.innerHTML, /Issue 11 Drafting/);
    assert.match(dom.slots.innerHTML, /Issue 12 Scheduled/);
    assert.match(dom.slots.innerHTML, /Issue 9 Sent/);
    assert.match(dom.slots.innerHTML, /Issue 13 In Review/);
    assert.match(dom.slots.innerHTML, /In Review/);

    // Switch to "Upcoming" view: only open, reserved, drafting, review, scheduled
    dom.viewUpcoming.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(dom.slots.innerHTML, /Issue 10 Upcoming Open/);
    assert.match(dom.slots.innerHTML, /Issue 11 Drafting/);
    assert.match(dom.slots.innerHTML, /Issue 12 Scheduled/);
    assert.match(dom.slots.innerHTML, /Issue 13 In Review/);
    assert.doesNotMatch(dom.slots.innerHTML, /Issue 9 Sent/);

    // Switch to "Sent & Archive" view: only sent / cancelled
    dom.viewSent.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.doesNotMatch(dom.slots.innerHTML, /Issue 10 Upcoming Open/);
    assert.match(dom.slots.innerHTML, /Issue 9 Sent/);

    // Switch back to "All" view: all items visible
    dom.viewAll.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(dom.slots.innerHTML, /Issue 10 Upcoming Open/);
    assert.match(dom.slots.innerHTML, /Issue 9 Sent/);
  });

  test("supports Newsletter dialog workspace with tabs, quick actions, and markdown preview", async () => {
    const dom = createNewsletterDom();
    const items = [
      {
        id: "slot-draft",
        publicationDate: "2026-08-25",
        campaignNumber: 15,
        campaignLabel: "Issue 15 Deep Learning",
        status: "drafting",
        bookedByDisplayName: "Weights & Biases",
        planningNote: "# Subject: Deep Learning Trends\n> Preheader: Insights for engineers\n\nWelcome to Issue 15!",
      },
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async () => ({ alerts: [], items }),
    });
    await harness.surface.renderNewsletterSurface();

    // Compose quick action on card opens dialog in compose tab
    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-compose]" ? { dataset: { compose: "slot-draft" } } : null),
      },
    });
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.dialog.querySelector("[data-dialog-title]").textContent, "Compose Issue");

    // Preview quick action opens dialog in preview tab
    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-preview]" ? { dataset: { preview: "slot-draft" } } : null),
      },
    });
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.dialog.querySelector("[data-dialog-title]").textContent, "Email Preview");

    // Verify preview simulation content
    assert.equal(dom.dialog.querySelector("[data-preview-subject]").textContent, "Deep Learning Trends");
    assert.equal(dom.dialog.querySelector("[data-preview-preheader]").textContent, "Insights for engineers");
    assert.match(dom.dialog.querySelector("[data-sim-sponsor]").innerHTML, /Weights &amp; Biases/);
  });

  test("supports explicit scheduling and sending flow with confirmations and status transitions", async () => {
    const dom = createNewsletterDom();
    let slotData = {
      id: "slot-sched",
      publicationDate: "2026-08-25",
      publicationTime: "14:00",
      campaignNumber: 16,
      campaignLabel: "Issue 16 Scheduling Test",
      status: "draft",
      bookedByDisplayName: "Alexey",
      planningNote: "# Subject: Scheduled Issue\n> Preheader: Delivery test\n\nIssue 16 content ready for dispatch.",
    };
    let lastPutPayload = null;
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (url, options) => {
        if (options?.method === "PUT") {
          lastPutPayload = JSON.parse(options.body);
          slotData = { ...slotData, ...lastPutPayload };
          return slotData;
        }
        return { alerts: [], items: [slotData] };
      },
    });
    await harness.surface.renderNewsletterSurface();

    // Schedule quick action on card opens dialog in schedule tab
    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-schedule]" ? { dataset: { schedule: "slot-sched" } } : null),
      },
    });
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.dialog.querySelector("[data-dialog-title]").textContent, "Schedule & Checklist");

    // Status banner shows Draft
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "Draft");

    // Submit for Review transition
    const submitReviewBtn = dom.dialog.querySelector('[data-action="submit-review"]');
    assert.ok(submitReviewBtn);
    submitReviewBtn.onclick();
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "In Review");

    // Ready to schedule: prompt confirmation
    const promptScheduleBtn = dom.dialog.querySelector('[data-action="prompt-schedule"]');
    assert.ok(promptScheduleBtn);
    promptScheduleBtn.onclick();

    const confirmCard = dom.dialog.querySelector("[data-confirm-card]");
    assert.equal(confirmCard.hidden, false);
    assert.match(dom.dialog.querySelector("[data-confirm-message]").innerHTML, /automated dispatch/);

    // Cancel confirmation hides the card
    const cancelConfirmBtn = dom.dialog.querySelector("[data-confirm-cancel]");
    cancelConfirmBtn.onclick();
    assert.equal(confirmCard.hidden, true);

    // Prompt schedule again and confirm
    promptScheduleBtn.onclick();
    const proceedConfirmBtn = dom.dialog.querySelector("[data-confirm-proceed]");
    proceedConfirmBtn.onclick();
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "Scheduled");

    // Save scheduled slot
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    assert.equal(lastPutPayload.status, "scheduled");

    // Reopen dialog for scheduled slot and test unschedule back to draft
    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-schedule]" ? { dataset: { schedule: "slot-sched" } } : null),
      },
    });
    const returnDraftBtn = dom.dialog.querySelector('[data-action="return-draft"]');
    assert.ok(returnDraftBtn);
    assert.equal(returnDraftBtn.textContent.trim(), "Unschedule (Return to Draft)");
    returnDraftBtn.onclick();
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "Draft");

    // Save slot back to draft
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    assert.equal(lastPutPayload.status, "draft");

    // Reopen, move to review, schedule, and mark as sent
    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-schedule]" ? { dataset: { schedule: "slot-sched" } } : null),
      },
    });
    dom.dialog.querySelector('[data-action="submit-review"]').onclick();
    dom.dialog.querySelector('[data-action="prompt-schedule"]').onclick();
    dom.dialog.querySelector("[data-confirm-proceed]").onclick();
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "Scheduled");

    const promptSendBtn = dom.dialog.querySelector('[data-action="prompt-send"]');
    assert.ok(promptSendBtn);
    promptSendBtn.onclick();
    assert.equal(confirmCard.hidden, false);
    assert.match(dom.dialog.querySelector("[data-confirm-message]").innerHTML, /mark.*as sent/i);

    dom.dialog.querySelector("[data-confirm-proceed]").onclick();
    assert.equal(dom.dialog.querySelector("[data-status-banner-badge]").textContent, "Sent");

    // Save slot marked sent
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    assert.equal(lastPutPayload.status, "sent");
  });
});

function expectCalendarRange(request, from, to) {
  const range = new URL(request.url).searchParams;
  assert.equal(range.get("from"), from);
  assert.equal(range.get("to"), to);
}
