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
  const view = surface.setQuery("[data-view]", new TestElement("select"));
  view.value = "month";
  const type = surface.setQuery("[data-type]", new TestElement("select"));
  type.value = "";
  const layers = ["activities", "public", "school", "overlay", "available"].map((name) => {
    const layer = new TestElement("input");
    layer.dataset.layer = name;
    layer.checked = true;
    surface.setQuery(`[data-layer="${name}"]`, layer);
    return layer;
  });
  surface.setQueryAll("[data-layer]", layers);
  surface.setQuery("[data-calendar-indicator]", new TestElement("span"));
  for (const selector of ["[data-prev]", "[data-today]", "[data-next]", "[data-controls-toggle]"]) {
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
  return {
    alerts,
    dayBody,
    dayClose,
    dayCloseFoot,
    dayDialog,
    daySubtitle,
    dayTitle,
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

  dialog.setQuery("[data-dialog-title]", new TestElement("h2"));
  dialog.setQuery("[data-campaign-link]", new TestElement("a"));
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
    dialog,
    form,
    slots,
    status,
    surface,
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

// A calendar entry as the API projects it from an entity.
function calendarEntry({ id, title, date, kind = "webinar", kindLabel = "Webinar", status = "announced" }) {
  return {
    id: `card:${id}`, kind, kindLabel, title, date, status,
    entity: { type: "card", id }, href: `/cards?cardId=${id}`,
  };
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
                provider: "newsletter-issues-readonly",
                startDate: "2026-08-13",
              },
              {
                category: "Alexey",
                endDate: "2026-08-13",
                label: "12:25–13:30 Tejas at DataTalks.Club Podcast",
                provider: "owner-calendar",
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
              id: "podcast-recording:episode-1", kind: "podcast-recording", kindLabel: "Podcast recording",
              title: "Community podcast · Ada Example", date: "2026-08-13", status: "booked",
              entity: { type: "podcast-episode", id: "episode-1" }, href: "/podcast?episodeId=episode-1",
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
    // An event is its entity: the chip links to the episode it comes from.
    assert.match(dom.grid.innerHTML, /<a\s+class="calendar-activity "\s+href="\/podcast\?episodeId=episode-1"\s+title="Community podcast · Ada Example \(Podcast recording\)"/);
    assert.match(dom.grid.innerHTML, /<small>Podcast recording<\/small>/);
    assert.doesNotMatch(dom.grid.innerHTML, /data-edit/);
    assert.match(dom.grid.innerHTML, /Example Holiday/);
    // The holiday marks its whole day cell, not just a chip inside it.
    assert.match(dom.grid.innerHTML, /class="calendar-day[^"]*has-public-holiday"[^>]*aria-label="Thursday, August 13, 2026, public holiday"/);
    assert.equal((dom.grid.innerHTML.match(/has-public-holiday/g) || []).length, 1);
    assert.match(dom.grid.innerHTML, /Newsletter 42/);
    // Alexey's personal events only feed slot availability; they are never items.
    assert.doesNotMatch(dom.grid.innerHTML, /Tejas at DataTalks\.Club Podcast/);
    assert.doesNotMatch(dom.grid.innerHTML, /is-owner-calendar/);
    assert.match(dom.alerts.innerHTML, /Event falls on a public holiday/);
    assert.match(dom.grid.innerHTML, /calendar-week-heading/);
    assert.match(dom.grid.innerHTML, /calendar-week-number/);
    assert.match(dom.grid.innerHTML, /<small class="iso-week">\d+<\/small>/);
    assert.match(dom.grid.innerHTML, /calendar-week is-current-week/);
    assert.match(dom.grid.innerHTML, /calendar-week-number is-current-week/);
    assert.match(dom.grid.innerHTML, /calendar-day[^"]*is-current-week/);
    expectCalendarRange(harness.requests[0], "2026-08-01", "2026-09-06");
  });

  test("renders owned Calendar planning data while an external overlay is pending", async () => {
    const dom = createCalendarDom();
    const indicator = dom.surface.setQuery("[data-calendar-indicator]", new TestElement("span"));
    let finishOverlay;
    const overlay = new Promise((resolve) => { finishOverlay = resolve; });
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => String(url).includes("/overlays") ? overlay : {
        items: [calendarEntry({ id: "pending-overlay", title: "Ready planning activity", date: "2026-08-13" })],
        holidays: [], alerts: [],
      },
    });
    const loading = harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Ready planning activity/);
    // Loading shows in the fixed toolbar slot and aria-busy, not as a status line.
    assert.equal(dom.status.textContent, "");
    assert.equal(indicator.dataset.state, "loading");
    assert.equal(indicator.title, "Loading open event slots…");
    assert.equal(dom.grid.getAttribute("aria-busy"), "true");
    finishOverlay({ items: [] });
    await loading;
    assert.equal(dom.status.textContent, "");
    assert.equal(indicator.dataset.state, "idle");
    assert.equal(dom.grid.getAttribute("aria-busy"), "false");
  });

  test("shows open slots on their own layer and flags those on holidays", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      today: "2026-08-10",
      request: async (url) => String(url).includes("/overlays")
        ? {
          items: [
            { provider: "owner-calendar", id: "owner-slot:2026-08-12:midday", startDate: "2026-08-12", endDate: "2026-08-12",
              label: "12:30 Available", category: "Available slot", isAvailableSlot: true },
            { provider: "newsletter-issues-readonly", id: "slot-open", startDate: "2026-08-13", endDate: "2026-08-13",
              label: "Issue 99", status: "planned", isAvailableSlot: true, href: "/newsletter?slotId=slot-open" },
            { provider: "newsletter-issues-readonly", id: "slot-booked", startDate: "2026-08-14", endDate: "2026-08-14",
              label: "Booked issue", status: "scheduled", isAvailableSlot: false, href: "/newsletter?slotId=slot-booked" },
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
    assert.match(html, /class="calendar-overlay is-owner-calendar is-available-slot"\s+data-open-day="2026-08-12" title="Open event slot: 12:30 Available"/);
    assert.match(html, /class="calendar-overlay is-newsletter is-available-slot is-holiday-conflict" href="\/newsletter\?slotId=slot-open" title="Free newsletter slot: Issue 99 \(conflicts with Example Holiday\)"/);
    assert.match(html, /<small>Blocked<\/small>/);
    assert.match(html, /class="calendar-overlay is-newsletter" href="\/newsletter\?slotId=slot-booked"/);

    // The Available slots chip hides open slots only; booked dates stay.
    dom.surface.querySelector('[data-layer="available"]').checked = false;
    dom.surface.querySelector('[data-layer="available"]').onchange();
    assert.doesNotMatch(dom.grid.innerHTML, /12:30 Available|Issue 99/);
    assert.match(dom.grid.innerHTML, /Booked issue/);
  });

  test("never renders personal calendar events, even vacations and flights", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      today: "2026-08-10",
      request: async (url) => String(url).includes("/overlays")
        ? {
          items: [
            { provider: "owner-calendar", id: "owner-calendar:vacation", startDate: "2026-08-10", endDate: "2026-08-11",
              label: "Vacation", category: "Alexey", slot: "all-day", isAvailableSlot: false },
            { provider: "owner-calendar", id: "owner-calendar:flight", startDate: "2026-08-13", endDate: "2026-08-13",
              label: "Flight to Lisbon", category: "Alexey", slot: "all-day", isAvailableSlot: false },
            { provider: "owner-calendar", id: "owner-slot:2026-08-12:midday", startDate: "2026-08-12", endDate: "2026-08-12",
              label: "12:30 Available", category: "Available slot", isAvailableSlot: true },
          ],
          sources: { "owner-calendar": { state: "connected" } },
        }
        : { items: [], holidays: [], alerts: [] },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    const html = dom.grid.innerHTML;
    assert.doesNotMatch(html, /Vacation|Flight to Lisbon/);
    assert.match(html, /data-day="2026-08-12"[\s\S]*?12:30 Available/);
    assert.equal((html.match(/class="calendar-overlay /g) || []).length, 1);
  });

  test("shows open event slots only from today, never on past days", async () => {
    const dom = createCalendarDom();
    dom.view.value = "week";
    const slot = (date) => ({ provider: "owner-calendar", id: `owner-slot:${date}:midday`, startDate: date, endDate: date,
      label: "12:30 Available", category: "Available slot", isAvailableSlot: true });
    const harness = createPlanningHarness({
      calendar: dom,
      today: "2026-10-14",
      // Even a slot for a past day in the response (a page left open past
      // midnight) stays off the grid.
      request: async (url) => String(url).includes("/overlays")
        ? { items: ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-16"].map(slot), sources: { "owner-calendar": { state: "connected" } } }
        : { items: [], holidays: [], alerts: [] },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    const html = dom.grid.innerHTML;
    const slotDays = [...html.matchAll(/data-open-day="([^"]+)" title="Open event slot/g)].map((match) => match[1]);
    assert.deepEqual(slotDays, ["2026-10-14", "2026-10-16"]);
  });

  test("a past week shows real items, no open slots and no slot spinner", async () => {
    const dom = createCalendarDom();
    dom.view.value = "week";
    const indicator = dom.surface.setQuery("[data-calendar-indicator]", new TestElement("span"));
    let finishOverlay;
    const harness = createPlanningHarness({
      calendar: dom,
      today: "2026-10-14",
      request: async (url) => {
        if (!String(url).includes("/overlays")) {
          return { items: [calendarEntry({ id: "past-webinar", title: "Past webinar", date: "2026-09-08" })], holidays: [], alerts: [] };
        }
        return new Promise((resolve) => { finishOverlay = resolve; });
      },
    });
    const opening = harness.surface.renderCalendarSurface();
    await nextTicks();
    finishOverlay({ items: [] });
    await opening;
    // Navigate back to the week of Monday 7 September 2026, wholly past.
    for (let week = 0; week < 4; week++) {
      const moving = dom.surface.querySelector("[data-prev]").onclick();
      await nextTicks();
      finishOverlay({ items: [] });
      await moving;
      await nextTicks();
    }
    const pastLoad = dom.surface.querySelector("[data-prev]").onclick();
    await nextTicks();
    assert.match(dom.surface.querySelector("[data-period-heading]").textContent, /Week of September 7, 2026/);
    assert.match(dom.grid.innerHTML, /Past webinar/);
    // Only the newsletter issues are still loading; there is no slot spinner.
    assert.notEqual(indicator.dataset.state, "loading");
    assert.equal(dom.grid.getAttribute("aria-busy"), "false");
    finishOverlay({ items: [
      { provider: "newsletter-issues-readonly", id: "past-issue", startDate: "2026-09-08", endDate: "2026-09-08",
        label: "Weekly #290 · Sponsor", status: "sent", isAvailableSlot: false, href: "/newsletter?issueId=past-issue" },
    ], sources: { "newsletter-issues-readonly": { state: "connected" } } });
    await pastLoad;
    await nextTicks();
    assert.match(dom.grid.innerHTML, /Weekly #290 · Sponsor/);
    assert.doesNotMatch(dom.grid.innerHTML, /Open event slot|Available/);
    assert.equal(indicator.dataset.state, "idle");
  });

  test("marks the open-slot source as not connected instead of showing an empty layer", async () => {
    const dom = createCalendarDom();
    const chip = dom.surface.setQuery('[data-layer-chip="available"]', new TestElement("label"));
    const indicator = dom.surface.setQuery("[data-calendar-indicator]", new TestElement("span"));
    const chipStatus = chip.setQuery("[data-layer-chip-status]", new TestElement("span"));
    const reason = "No calendar broker credential is available in this environment.";
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => String(url).includes("/overlays")
        ? { items: [], sources: { "owner-calendar": { state: "not-configured", reason } } }
        : { items: [], holidays: [], alerts: [] },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    assert.equal(chip.classList.contains("is-disconnected"), true);
    assert.equal(chip.title, `Alexey's calendar is not connected, so open event slots are unknown: ${reason}`);
    assert.equal(chipStatus.textContent, ` (not connected: ${reason})`);
    assert.equal(indicator.dataset.state, "warning");
    assert.equal(indicator.title, `Alexey's calendar is not connected: ${reason}`);
    assert.equal(dom.status.textContent, `Alexey's calendar is not connected: ${reason}`);

    // Hiding the layer drops the notice; the chip keeps its disconnected state.
    dom.surface.querySelector('[data-layer="available"]').checked = false;
    dom.surface.querySelector('[data-layer="available"]').onchange();
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

    // Nov 1 2026 is a Sunday: the month opens on its first workday, so the
    // previous-month week (Mon Oct 26 - Fri Oct 30) is not shown.
    dom.pickerToggle.onclick({ stopPropagation() {} });
    dom.pickerMonthBtns[10].onclick({ stopPropagation() {} });
    await nextTicks();
    assert.equal(dom.surface.querySelector("[data-period-heading]").textContent, "November 2026");
    assert.doesNotMatch(dom.grid.innerHTML, /Monday, October 26, 2026/);
    assert.doesNotMatch(dom.grid.innerHTML, /Sunday, November 1, 2026/);
    assert.doesNotMatch(dom.grid.innerHTML, /Saturday, November 7, 2026/);
    assert.match(dom.grid.innerHTML, /Monday, November 2, 2026/);
  });

  // Regression guard: weekends were removed from the calendar on purpose and
  // came back once by accident (e7642faf). Both views must stay Monday-Friday.
  test("shows exactly five weekday columns and folds weekend entries into a Friday note", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        return {
          alerts: [],
          holidays: [{ kind: "school-holiday", name: "Weekend school holiday", startDate: "2026-08-15", endDate: "2026-08-16" }],
          items: [
            calendarEntry({ id: "sat", title: "Cohort kickoff", date: "2026-08-15" }),
            calendarEntry({ id: "sun", title: "Hackathon demo", date: "2026-08-16" }),
          ],
        };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    const expectWeekdaysOnly = () => {
      const html = dom.grid.innerHTML;
      const headings = [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((match) => match[1]);
      assert.deepEqual(headings, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
      assert.doesNotMatch(html, /Saturday|Sunday/);
      const weeks = html.split(/<div class="calendar-week(?: is-current-week)?">/).slice(1);
      assert.ok(weeks.length > 0);
      for (const week of weeks) {
        assert.equal((week.match(/<section/g) || []).length, 5);
      }
      for (const [, date] of html.matchAll(/data-day="(\d{4}-\d{2}-\d{2})"/g)) {
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        assert.ok(day >= 1 && day <= 5, `${date} is a weekend day`);
      }
      // Weekend entries are not dropped: they collapse into a note on Friday.
      assert.match(html, /data-day="2026-08-14"[\s\S]*?calendar-weekend-note" data-open-day="2026-08-15"[\s\S]*?\+ weekend · 2/);
      assert.match(html, /Sat, Aug 15: Cohort kickoff/);
      assert.match(html, /Sun, Aug 16: Hackathon demo/);
      assert.doesNotMatch(html, /Weekend school holiday/);
    };
    expectWeekdaysOnly();
    dom.view.value = "week";
    await dom.view.onchange();
    await nextTicks();
    expectWeekdaysOnly();
    assert.equal((dom.grid.innerHTML.match(/<section/g) || []).length, 5);
  });

  // Aug 1 2026 is a Saturday. The grid starts on Monday Aug 3, so there is no
  // Friday in it to carry that weekend; the note goes on the first Monday.
  test("shows a month's leading weekend as a note on its first Monday", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        return {
          alerts: [],
          holidays: [],
          items: [
            calendarEntry({ id: "sat", title: "Saturday stream", date: "2026-08-01" }),
            calendarEntry({ id: "sun", title: "Sunday demo", date: "2026-08-02" }),
            calendarEntry({ id: "mid", title: "Mid-month weekend", date: "2026-08-08" }),
          ],
        };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    expectCalendarRange(harness.requests.find((entry) => new URL(entry.url).pathname === "/api/calendar-items"), "2026-08-01", "2026-09-06");
    const html = dom.grid.innerHTML;
    assert.doesNotMatch(html, /data-day="2026-08-0[12]"/);
    const monday = html.split('data-day="2026-08-03"')[1].split("<section")[0];
    assert.match(monday, /calendar-weekend-note" data-open-day="2026-08-01"[\s\S]*?\+ weekend · 2/);
    assert.match(monday, /Sat, Aug 1: Saturday stream; Sun, Aug 2: Sunday demo/);
    // Later weekends stay on their Friday; later Mondays carry no note.
    const friday = html.split('data-day="2026-08-07"')[1].split("<section")[0];
    assert.match(friday, /data-open-day="2026-08-08"[\s\S]*?\+ weekend · 1/);
    const nextMonday = html.split('data-day="2026-08-10"')[1].split("<section")[0];
    assert.doesNotMatch(nextMonday, /calendar-weekend-note/);
  });

  test("is read-only: no create or edit, events link to their entities, alerts dismiss", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      request: async (url, options) => {
        const value = new URL(url);
        if (options.method) return {};
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        return {
          alerts: [{ fingerprint: "calendar-alert", reasonCode: "school-holiday-overlap", severity: "warning", affectedIds: ["card:card-1"] }],
          holidays: [],
          items: [calendarEntry({ id: "card-1", title: "Community webinar · Ada Example", date: "2026-08-13" })],
        };
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    // No Add activity button and no activity dialog.
    assert.deepEqual(dom.surface.querySelector("[data-calendar-indicator]").insertedBefore || [], []);
    assert.doesNotMatch(dom.surface.innerHTML, /data-activity-dialog|Add activity|data-day-add-activity/);
    assert.match(dom.grid.innerHTML, /href="\/cards\?cardId=card-1"/);
    assert.match(dom.alerts.innerHTML, /Event falls in the school holidays/);
    assert.match(dom.alerts.innerHTML, /Community webinar · Ada Example — /);

    await dom.alerts.onclick({ target: { closest: () => ({ dataset: { dismiss: "calendar-alert" } }) } });
    await nextTicks();
    assert.ok(harness.requests.some((entry) => entry.options.method === "POST" && entry.url.endsWith("/alerts/calendar-alert/dismiss")));
    assert.equal(harness.requests.some((entry) => ["PUT", "DELETE"].includes(entry.options.method)), false);
  });

  test("renders load failure recovery", async () => {
    const dom = createCalendarDom();
    let failLoad = false;
    createPlanningHarness({
      calendar: dom,
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname.endsWith("/overlays")) return { items: [] };
        if (failLoad) throw new Error("Calendar offline");
        return { alerts: [], holidays: [], items: [] };
      },
    }).surface.renderCalendarSurface();
    await nextTicks();
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
    assert.equal(dom.settingsForm.elements.filterNonSlotHours.checked, true);
    assert.equal(dom.settingsForm.elements.filterDtcPlaceholders.checked, true);
    assert.equal(dom.settingsForm.elements.filterTransparent.checked, true);
    assert.equal(dom.settingsForm.elements.filterLunch.checked, true);
    assert.equal(dom.settingsForm.elements.filterBusy.checked, true);
    assert.equal(dom.settingsForm.elements.customKeywords.value, "dentist");

    // Modify settings and submit
    dom.settingsForm.elements.connectionId.value = "work-calendar";
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
    assert.equal("showAvailableSlots" in sent, false);
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
                provider: "owner-calendar",
                id: "owner-calendar:evt-morning",
                category: "Alexey",
                label: "09:30–10:30 Team sync",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "outside",
                isSlotEvent: false,
              },
              {
                provider: "owner-calendar",
                id: "owner-calendar:evt-podcast",
                category: "Alexey",
                label: "12:30–13:30 Podcast with Guest",
                startDate: "2026-08-13",
                endDate: "2026-08-13",
                slot: "midday",
                isSlotEvent: true,
              },
              {
                provider: "owner-calendar",
                id: "owner-calendar:evt-call",
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
                provider: "owner-calendar",
                id: "owner-calendar:evt-podcast",
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
            calendarEntry({ id: "activity-1", title: "Community webinar", date: "2026-08-13" }),
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
    // The event links to its Card in the same tab; owner-calendar events open Google in a new one.
    assert.match(dom.dayBody.innerHTML, /<a class="calendar-day-timeline-title" href="\/cards\?cardId=activity-1">Community webinar<\/a>/);
    assert.doesNotMatch(dom.dayBody.innerHTML, /data-edit|Edit<\/button>/);

    // Click close
    dom.dayClose.onclick();
    assert.equal(dom.dayDialog.open, false);
  });

  test("a past day's schedule lists what happened, with no slots and no calendar request", async () => {
    const dom = createCalendarDom();
    const harness = createPlanningHarness({
      calendar: dom,
      today: "2026-08-14",
      request: async (url) => String(url).includes("/overlays") ? { items: [] } : {
        alerts: [], holidays: [],
        items: [calendarEntry({ id: "past-webinar", title: "Past webinar", date: "2026-08-13" })],
      },
    });
    await harness.surface.renderCalendarSurface();
    await nextTicks();
    const before = harness.requests.length;
    await dom.grid.onclick({ target: { closest: (sel) => sel === "[data-open-day]" ? { dataset: { openDay: "2026-08-13" } } : null } });
    await nextTicks();
    assert.equal(dom.dayDialog.open, true);
    assert.equal(harness.requests.length, before, "a past day makes no overlay request");
    assert.match(dom.dayBody.innerHTML, /Past webinar/);
    assert.doesNotMatch(dom.dayBody.innerHTML, /Event Slot|Available/);
  });

  const weeklyIssue = (overrides = {}) => ({
    kind: "weekly",
    label: "Weekly #42",
    issueNumber: 42,
    slots: { primary: { sponsor: "Example Sponsor" }, secondary: {} },
    ...overrides,
  });

  test("renders one row per Newsletter issue with its slot ticks, card, links, and alerts", async () => {
    const dom = createNewsletterDom();
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async () => ({
        alerts: [{ reasonCode: "near-term-open-slot", severity: "warning", issueId: "issue-2" }],
        items: [
          weeklyIssue({
            id: "issue-1",
            planningNote: "Materials confirmed",
            publicUrl: "https://example.invalid/campaign/42",
            publicationDate: "2026-08-21",
            status: "scheduled",
            slots: { primary: { sponsor: "Example Sponsor" }, secondary: { sponsor: "Second <Sponsor>" } },
            cardId: "card-1",
            card: { id: "card-1", title: "21 Aug · #42", stage: "preparation", status: "active", anchorDate: "2026-08-20", taskCount: 6, openTaskCount: 4 },
          }),
          weeklyIssue({
            id: "issue-2",
            label: "Weekly #43",
            issueNumber: 43,
            publicationDate: "2026-08-28",
            status: "planned",
            slots: { primary: {}, secondary: {} },
            card: null,
            cardDueDate: "2026-08-20",
          }),
          {
            id: "issue-3",
            kind: "standalone",
            label: "Stand-alone newsletter",
            publicationDate: "2026-08-26",
            status: "planned",
            slots: { primary: { sponsor: "Solo Sponsor" } },
            cardId: "card-gone",
            card: null,
          },
        ],
      }),
    });
    await harness.surface.renderNewsletterSurface();
    assert.deepEqual(harness.routeTitles, ["Newsletter"]);
    assert.equal(dom.status.textContent, "");
    assert.match(dom.alerts.innerHTML, /A slot needs a sponsor soon/);
    assert.match(dom.alerts.innerHTML, /Weekly #43 — 28 Aug/);
    const html = dom.slots.innerHTML;
    assert.match(html, /title="Edit issue details"><span>Weekly #42<\/span><\/button><\/h4>/);
    // Every row's date column: the date, then kind and distance from today.
    assert.equal(html.match(/class="newsletter-relative-badge"/g).length, 3);
    for (const [kind, distance] of [["Weekly", "in 8d"], ["Weekly", "in 2w"], ["Stand-alone", "in 13d"]]) {
      assert.match(html, new RegExp(`newsletter-kind-badge">${kind}</small>\\s*<span class="newsletter-relative-badge">${distance}</span>`));
    }
    // A scheduled issue's booked slots: the sponsor (click to change) and a remove button.
    assert.match(html, /data-slot-book="primary" data-issue-id="issue-1"[^>]*title="Change sponsor"[^>]*><strong>Primary:<\/strong> Example Sponsor<\/button>/);
    assert.match(html, /<strong>Secondary:<\/strong> Second &lt;Sponsor&gt;<\/button>/);
    assert.match(html, /data-slot-release="secondary" data-issue-id="issue-1"\s+aria-label="Remove Second &lt;Sponsor&gt; from the secondary slot of Weekly #42"/);
    // Open slots are booking buttons.
    assert.match(html, /data-slot-book="primary" data-issue-id="issue-2"[^>]*><strong>Primary:<\/strong> \+ sponsor<\/button>/);
    assert.match(html, /data-slot-book="secondary" data-issue-id="issue-2"[^>]*><strong>Secondary:<\/strong> \+ sponsor<\/button>/);
    assert.doesNotMatch(html, /data-slot-release="[a-z]+" data-issue-id="issue-2"/);
    // A stand-alone issue has one slot, named Sponsor.
    assert.match(html, /data-slot-book="primary" data-issue-id="issue-3"[^>]*><strong>Sponsor:<\/strong> Solo Sponsor<\/button>/);
    assert.doesNotMatch(html, /data-slot-book="secondary" data-issue-id="issue-3"/);
    assert.doesNotMatch(html, /type="checkbox"/, "slots are buttons, not ticks");
    assert.match(html, /href="\/cards\?cardId=card-1"\s+data-open-card="card-1" title="Open card: 21 Aug · #42">/);
    assert.doesNotMatch(html, />21 Aug · #42</, "the chip does not repeat the Card title the row already shows");
    assert.match(html, /Preparation ·\s+<span class="dk-mono">4\/6<\/span> open/);
    assert.match(html, /data-card-date-mismatch><span class="newsletter-card-chip__warning-label">Card dated <\/span>\s*20 Aug/);
    assert.match(html, /Card unavailable/);
    assert.doesNotMatch(html, /Open campaign|More actions/, "the campaign link lives in the issue's details, not on the row");
    // No Card yet: when the daily run makes it, and a button to make it now.
    assert.match(html, /<span class="newsletter-card-due" data-card-due>Card in 7 days<\/span>/);
    assert.match(html, /data-create-card="issue-2"\s+aria-label="Create the card for Weekly #43 now">Create card now<\/button>/);
    assert.doesNotMatch(html, /data-create-card="issue-(1|3)"/);
    assert.doesNotMatch(html, /data-card-link|Link card/);
    const range = new URL(harness.requests[0].url).searchParams;
    assert.match(harness.requests[0].url, /\/api\/newsletter-issues\?/);
    assert.equal(range.get("from"), "2026-08-01");
    assert.equal(range.get("to"), "2027-12-31");
  });

  test("removes a slot's sponsor from the row after confirming, and again when done tasks would stay", async () => {
    const dom = createNewsletterDom();
    let issue = weeklyIssue({ id: "issue-1", version: 3, publicationDate: "2026-08-21", status: "planned" });
    const deletes = [];
    const prompts = [];
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = (message) => {
      prompts.push(message);
      return true;
    };
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (url, options = {}) => {
        if (options.method === "DELETE") {
          const body = JSON.parse(options.body);
          deletes.push({ url, body });
          if (!body.confirmSlotRemoval) {
            throw Object.assign(new Error("Releasing the slot keeps 1 completed Task"), { code: "slot-has-completed-tasks" });
          }
          issue = { ...issue, slots: { ...issue.slots, primary: {} }, version: issue.version + 1 };
          return issue;
        }
        return { alerts: [], items: [issue] };
      },
    });
    try {
      await harness.surface.renderNewsletterSurface();
      const [click] = dom.slots.listeners.get("click");
      const remove = {
        disabled: false,
        dataset: { slotRelease: "primary", issueId: "issue-1" },
        closest(selector) { return selector === "[data-slot-release]" ? this : null; },
      };
      dom.slots.contains = () => true;
      click({ target: remove, preventDefault() {} });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.match(prompts[0], /Remove Example Sponsor from the primary slot of Weekly #42\?/);
      assert.equal(prompts.length, 2, "asks again because done tasks stay");
      assert.match(String(deletes[0].url), /\/api\/newsletter-issues\/issue-1\/slots\/primary$/);
      assert.deepEqual(deletes.map(({ body }) => body), [{ version: 3 }, { version: 3, confirmSlotRemoval: true }]);
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  test("Create card now posts the issue version and reloads the row with its card", async () => {
    const dom = createNewsletterDom();
    let issue = weeklyIssue({ id: "issue-5", version: 4, publicationDate: "2026-12-07", status: "planned", card: null, cardDueDate: "2026-11-16" });
    const posts = [];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (url, options = {}) => {
        if (options.method === "POST") {
          posts.push({ url: String(url), body: JSON.parse(options.body) });
          issue = { ...issue, version: 5, cardId: "card-5", cardDueDate: null,
            card: { id: "card-5", title: "7 Dec", stage: "preparation", status: "active", anchorDate: "2026-12-07", taskCount: 3, openTaskCount: 3 } };
          return issue;
        }
        return { alerts: [], items: [issue] };
      },
    });
    await harness.surface.renderNewsletterSurface();
    assert.match(dom.slots.innerHTML, /Card in \d+ days/);
    const button = { disabled: false, dataset: { createCard: "issue-5" } };
    dom.slots.onclick({ target: { closest: (selector) => (selector === "[data-create-card]" ? button : null) } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(posts[0].url, /\/api\/newsletter-issues\/issue-5\/card$/);
    assert.deepEqual(posts[0].body, { version: 4 });
    assert.match(dom.slots.innerHTML, /href="\/cards\?cardId=card-5"/);
    assert.doesNotMatch(dom.slots.innerHTML, /data-create-card/);
  });

  test("supports Newsletter week grouping, filtering, create/edit, and slot fields", async () => {
    const dom = createNewsletterDom();
    const items = [
      weeklyIssue({
        id: "issue-1",
        label: "Weekly #7",
        issueNumber: 7,
        cardId: "card-1",
        publicationDate: "2026-08-21",
        status: "planned",
        version: 3,
        slots: { primary: { sponsor: "Sponsor A", sheetId: "NL-7" }, secondary: {} },
      }),
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (_url, options) =>
        options.method ? {} : { alerts: [], items },
    });
    await harness.surface.renderNewsletterSurface();
    // One fixed view: issues by month, no filter bar.
    assert.match(dom.slots.innerHTML, /<h3>August 2026<\/h3>/);
    assert.doesNotMatch(dom.surface.innerHTML, /Filter &amp; group|Filter & group|data-booked|data-status/);

    dom.surface.querySelector("[data-newsletter-add]").onclick();
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.form.elements.kind.value, "weekly");

    dom.slots.onclick({ target: { closest: (selector) => (selector === "[data-edit]" ? { dataset: { edit: "issue-1" } } : null) } });
    assert.equal(dom.form.elements.issueNumber.value, 7);
    assert.equal(dom.form.elements.version.value, 3);
    assert.equal(dom.form.elements.primaryDocumentUrl.value, "");
    assert.equal(dom.form.elements.kind.disabled, true);

    dom.form.elements.secondaryDocumentUrl.value = "https://docs.example.com/b";
    dom.form.formEntries = [
      ["id", "issue-1"],
      ["version", "3"],
      ["kind", "weekly"],
      ["issueNumber", "8"],
      ["publicationDate", "2026-08-22"],
      ["status", "scheduled"],
      ["secondaryDocumentUrl", "https://docs.example.com/b"],
    ];
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    const update = harness.requests.find((entry) => entry.options.method === "PUT");
    assert.match(update.url, /newsletter-issues\/issue-1$/);
    assert.deepEqual(JSON.parse(update.options.body), {
      issueNumber: 8,
      publicationDate: "2026-08-22",
      status: "scheduled",
      version: 3,
      slots: {
        primary: { sponsor: "Sponsor A", sheetId: "NL-7" },
        secondary: { documentUrl: "https://docs.example.com/b" },
      },
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
    assert.match(emptyDom.slots.innerHTML, /No newsletter issues/);
    // The empty schedule repeats the create action as a secondary button.
    assert.match(emptyDom.slots.innerHTML, /dk-button--secondary[^"]*collection-empty-action"[^>]*data-newsletter-add-first[^>]*>[\s\S]*Add the first issue/);
    assert.doesNotMatch(emptyDom.slots.innerHTML, /data-dk-create/);
    // Add issue follows the view tabs, not the page header's corner.
    const [headerHtml, bodyHtml] = emptyDom.surface.innerHTML.split('<div class="newsletter-toolbar">');
    assert.doesNotMatch(headerHtml, /Add issue/);
    assert.match(bodyHtml, /^[\s\S]*?newsletter-views[\s\S]*?<\/div>\s*<button[^>]*data-dk-create[^>]*data-newsletter-add[\s\S]*?Add issue/);
    emptyDom.slots.onclick({ target: { closest: (selector) => (selector === "[data-newsletter-add-first]" ? {} : null), classList: {} } });
    assert.equal(emptyDom.dialog.open, true);

    const failureDom = createNewsletterDom();
    let loadSucceeded = false;
    const failureHarness = createPlanningHarness({
      newsletter: failureDom,
      request: async (_url, options) => {
        if (options.method) throw new Error("Issue conflict");
        if (loadSucceeded) return { alerts: [], items: [] };
        throw new Error("Newsletter offline");
      },
    });
    await failureHarness.surface.renderNewsletterSurface();
    assert.match(failureDom.status.textContent, /Newsletter offline/);
    assert.match(failureDom.slots.innerHTML, /Newsletter schedule unavailable/);

    loadSucceeded = true;
    failureDom.dialog.showModal();
    failureDom.form.formEntries = [
      ["kind", "weekly"],
      ["publicationDate", "2026-08-30"],
    ];
    await failureDom.surface.querySelector("[data-save]").onclick({
      preventDefault() {},
    });
    assert.equal(
      failureDom.form.querySelector('[role="alert"]').textContent,
      "Could not save the issue: Issue conflict",
    );
  });

  test("filters by view tabs (All, Upcoming, Sent)", async () => {
    const dom = createNewsletterDom();
    const items = [
      weeklyIssue({ id: "issue-1", publicationDate: "2026-08-15", label: "Issue 10 Upcoming Planned", status: "planned" }),
      weeklyIssue({ id: "issue-2", publicationDate: "2026-08-20", label: "Issue 11 Drafting", status: "drafting" }),
      weeklyIssue({ id: "issue-3", publicationDate: "2026-08-25", label: "Issue 12 Scheduled", status: "scheduled" }),
      weeklyIssue({ id: "issue-4", publicationDate: "2026-08-01", label: "Issue 9 Sent", status: "sent", publicUrl: "https://example.invalid/9" }),
      weeklyIssue({ id: "issue-5", publicationDate: "2026-08-28", label: "Issue 13 In Review", status: "review" }),
    ];
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async () => ({ alerts: [], items }),
    });
    await harness.surface.renderNewsletterSurface();

    for (const label of ["Issue 10 Upcoming Planned", "Issue 11 Drafting", "Issue 12 Scheduled", "Issue 9 Sent", "Issue 13 In Review"]) {
      assert.match(dom.slots.innerHTML, new RegExp(label));
    }
    // A sent issue's slots can no longer be changed.
    // A sent issue's slots are read-only text.
    assert.doesNotMatch(dom.slots.innerHTML, /data-slot-(book|release)="[a-z]+" data-issue-id="issue-4"/);
    assert.match(dom.slots.innerHTML, /<span class="newsletter-slot__text"><strong>Primary:<\/strong> Example Sponsor<\/span>/);

    dom.viewUpcoming.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(dom.slots.innerHTML, /Issue 10 Upcoming Planned/);
    assert.match(dom.slots.innerHTML, /Issue 13 In Review/);
    assert.doesNotMatch(dom.slots.innerHTML, /Issue 9 Sent/);

    dom.viewSent.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.doesNotMatch(dom.slots.innerHTML, /Issue 10 Upcoming Planned/);
    assert.match(dom.slots.innerHTML, /Issue 9 Sent/);

    dom.viewAll.onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(dom.slots.innerHTML, /Issue 10 Upcoming Planned/);
    assert.match(dom.slots.innerHTML, /Issue 9 Sent/);
  });

  test("the issue name opens a details-only dialog that links the campaign", async () => {
    const dom = createNewsletterDom();
    let issue = {
      id: "issue-edit",
      kind: "weekly",
      publicationDate: "2026-08-25",
      publicationTime: "14:00",
      issueNumber: 16,
      label: "Weekly #16",
      status: "drafting",
      version: 3,
      publicUrl: "https://example.com/campaign-16",
      slots: { primary: { sponsor: "Example" }, secondary: {} },
    };
    let lastPutPayload = null;
    const harness = createPlanningHarness({
      newsletter: dom,
      request: async (url, options) => {
        if (options?.method === "PUT") {
          lastPutPayload = JSON.parse(options.body);
          issue = { ...issue, ...lastPutPayload };
          return issue;
        }
        return { alerts: [], items: [issue] };
      },
    });
    await harness.surface.renderNewsletterSurface();
    assert.doesNotMatch(dom.slots.innerHTML, /data-compose|Compose|data-preview|data-schedule|newsletter-overflow|More actions/);
    assert.match(dom.slots.innerHTML, /<h4><button type="button" class="newsletter-issue-edit" data-edit="issue-edit"/);

    dom.slots.onclick({
      target: {
        closest: (selector) => (selector === "[data-edit]" ? { dataset: { edit: "issue-edit" } } : null),
      },
    });
    assert.equal(dom.dialog.open, true);
    assert.equal(dom.dialog.querySelector("[data-dialog-title]").textContent, "Weekly #16");
    const campaign = dom.dialog.querySelector("[data-campaign-link]");
    assert.equal(campaign.hidden, false);
    assert.equal(campaign.href, "https://example.com/campaign-16");

    dom.form.elements.status.value = "scheduled";
    await dom.surface.querySelector("[data-save]").onclick({ preventDefault() {} });
    assert.equal(lastPutPayload.status, "scheduled");
    assert.equal(lastPutPayload.version, 3);
  });
});

function expectCalendarRange(request, from, to) {
  const range = new URL(request.url).searchParams;
  assert.equal(range.get("from"), from);
  assert.equal(range.get("to"), to);
}
