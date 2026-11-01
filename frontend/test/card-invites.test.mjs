import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { renderCardEventTime, renderCardInvitesSection } from "../src/surfaces/work-detail/card-invites.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

function setup() {
  const root = new FakeElement("main");
  const doc = new FakeDocument(root);
  globalThis.document = doc;
  return { root, doc };
}

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

describe("card calendar invites section", () => {
  test("lists each invite by human name with a status badge and an Open link", () => {
    setup();
    const section = renderCardInvitesSection({
      calendarInvites: [
        { eventId: "evt-1", calendar: "alexey@datatalks.club", url: "https://example.com/e1", label: "original" },
        { eventId: "evt-2", calendar: "alexey.s.grigoriev@gmail.com", label: "resent" },
      ],
    });
    const rows = section.querySelectorAll(".card-invite-row");
    assert.equal(rows.length, 2);
    assert.match(rows[0].querySelector(".link-row__label").textContent, /alexey@datatalks\.club.*original/);
    assert.equal(rows[0].querySelector(".card-invite-status").textContent, "Live");
    const open = rows[0].querySelector(".card-invite-open");
    assert.equal(open.textContent, "Open in Google");
    assert.equal(open.href, "https://example.com/e1");
    assert.match(rows[1].querySelector(".link-row__label").textContent, /alexey\.s\.grigoriev@gmail\.com.*resent/);
    // The raw event id never shows as primary text, only truncated in tooltips.
    assert.doesNotMatch(section.textContent, /evt-1/);
    assert.doesNotMatch(section.textContent, /evt-2/);
    assert.match(open.title, /evt-1/);
  });

  test("renders invites without a url as plain text and marks stale rows", () => {
    setup();
    const section = renderCardInvitesSection({
      calendarInvites: [{ eventId: "evt-9", calendar: "alexey@datatalks.club", staleAt: "2026-11-01T00:00:00.000Z" }],
    });
    const row = section.querySelector(".card-invite-row");
    assert.equal(row.dataset.inviteState, "stale");
    assert.equal(row.querySelector(".card-invite-status").textContent, "Stale");
    assert.equal(row.querySelector(".link-row__text").textContent, "No Google link");
    assert.equal(row.querySelector(".card-invite-open"), null);
    assert.doesNotMatch(section.textContent, /evt-9/);
  });

  test("renders an empty state when no invites are linked", () => {
    setup();
    const section = renderCardInvitesSection({ calendarInvites: [] });
    assert.equal(section.querySelector(".card-invite-empty").textContent, "No invites linked.");
  });

  test("verify reports live/stale counts and surfaces failures", async () => {
    setup();
    const card = {
      id: "card-1",
      calendarInvites: [
        { eventId: "evt-1", calendar: "a@example.test", url: "https://example.test/e1" },
        { eventId: "evt-2", calendar: "b@example.test", url: "https://example.test/e2", staleAt: "2026-11-01T00:00:00.000Z" },
      ],
    };
    const calls = [];
    const section = renderCardInvitesSection(card, {
      request: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return {
            invites: card.calendarInvites,
            check: { state: "verified", stale: [card.calendarInvites[1]] },
          };
        }
        throw new Error("Google is unreachable");
      },
      workApiUrl: (value) => value,
    });
    const check = section.querySelector('[data-invite-action="verify"]');
    const feedback = section.querySelector(".card-invite-feedback");
    assert.equal(feedback.getAttribute("role"), "status");
    await check.dispatch("click");
    assert.deepEqual(calls, ["/api/cards/card-1/calendar-invites?verify=1"]);
    assert.equal(feedback.textContent, "Checked: 1 live, 1 stale in Google.");
    assert.equal(check.disabled, false);
    assert.equal(check.textContent, "Check in Google");
    // A failed check keeps the button usable and names the failure.
    await check.dispatch("click");
    assert.equal(feedback.textContent, "Google is unreachable");
    assert.equal(check.disabled, false);
  });

  test("unlink removes a stale invite and reports failures", async () => {
    setup();
    const stale = { eventId: "evt-1", calendar: "a@example.test", url: "https://example.test/e1", staleAt: "2026-11-01T00:00:00.000Z" };
    const card = { id: "card-1", calendarInvites: [stale] };
    const calls = [];
    let failNext = false;
    const section = renderCardInvitesSection(card, {
      request: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (failNext) throw new Error("Only the owner can unlink");
        return { removed: [stale], invites: [] };
      },
      workApiUrl: (value) => value,
    });
    const feedback = section.querySelector(".card-invite-feedback");
    const unlink = section.querySelector('[data-invite-action="unlink"]');
    assert.equal(unlink.getAttribute("aria-label"), "Unlink invite a@example.test");
    await unlink.dispatch("click");
    assert.deepEqual(calls[0], {
      url: "/api/cards/card-1/calendar-invites",
      body: { eventId: "evt-1", calendar: "a@example.test" },
    });
    assert.equal(feedback.textContent, "Invite unlinked; none remain.");
    assert.equal(section.querySelector(".card-invite-empty").textContent, "No invites linked.");
    // A failed unlink keeps the row and names the failure.
    card.calendarInvites = [stale];
    failNext = true;
    const retry = renderCardInvitesSection(card, {
      request: async () => { throw new Error("Only the owner can unlink"); },
      workApiUrl: (value) => value,
    });
    const retryFeedback = retry.querySelector(".card-invite-feedback");
    await retry.querySelector('[data-invite-action="unlink"]').dispatch("click");
    assert.equal(retryFeedback.textContent, "Only the owner can unlink");
    assert.ok(retry.querySelector(".card-invite-row"));
    // A live invite offers no unlink affordance: it moves with cards time.
    const live = renderCardInvitesSection({
      calendarInvites: [{ eventId: "evt-9", calendar: "live@example.test", url: "https://example.test/e9" }],
    });
    assert.equal(live.querySelector('[data-invite-action="unlink"]'), null);
  });
});

test("event time editor shows local time and sends arbitrary time, duration, zone and guests", async () => {
  const { doc } = setup();
  const calls = [];
  let reloaded = false;
  const form = renderCardEventTime({
    request: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        invite: { outcome: "sent", state: "synced" },
        taskClosure: { outcome: "blocked", message: 'Invite task "Create a calendar invite" remains todo: complete prerequisites first' },
      };
    },
    workApiUrl: value => value,
    reload: async () => { reloaded = true; },
  }, { id: "card-1", guestEmails: ["guest@example.test"], eventTime: { startIso: "2026-11-09T13:30:00.000Z", timeZone: "Europe/Berlin", durationMinutes: 60 } });
  const inputs = doc.created.filter(element => element.tagName === "INPUT");
  const selects = doc.created.filter(element => element.tagName === "SELECT");
  assert.equal(inputs[0].value, "2026-11-09T14:30");
  // Time zone and duration are dropdowns, not free-text inputs.
  assert.equal(selects.length, 2);
  const [tzSelect, durationSelect] = selects;
  assert.equal(tzSelect.value, "Europe/Berlin");
  assert.equal(durationSelect.value, "60");
  for (const zone of ["Europe/Berlin", "Europe/London", "UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Dubai", "Asia/Singapore", "Australia/Sydney"]) {
    assert.ok(tzSelect.children.some(option => option.value === zone), `missing time zone option ${zone}`);
  }
  for (const minutes of ["15", "30", "45", "60", "90", "120"]) {
    assert.ok(durationSelect.children.some(option => option.value === minutes), `missing duration option ${minutes}`);
  }
  assert.equal(tzSelect.required, true);
  assert.equal(tzSelect.getAttribute("aria-required"), "true");
  assert.equal(durationSelect.required, true);
  // Label for/id and hint wiring is preserved.
  const labels = doc.created.filter(element => element.tagName === "LABEL");
  const tzLabel = labels.find(label => label.htmlFor === tzSelect.id);
  assert.ok(tzLabel);
  assert.match(tzLabel.textContent, /Time zone/);
  assert.equal(tzSelect.getAttribute("aria-describedby"), `${tzSelect.id}-hint`);
  inputs[0].value = "2026-11-09T16:47";
  durationSelect.value = "90";
  inputs[1].value = "guest@example.test, ";
  await form.dispatch("submit");
  assert.deepEqual(calls, [{ url: "/api/cards/card-1/time", body: { at: "2026-11-09 16:47", duration: 90, tz: "Europe/Berlin", guestEmails: ["guest@example.test"] } }]);
  assert.equal(reloaded, true);
  const statusEl = doc.created.find(el => el.attributes?.get("role") === "status");
  assert.match(statusEl.textContent, /Invite sent\..*remains todo/);
});

test("event time editor preserves custom time zone and duration as extra options", () => {
  const { doc } = setup();
  renderCardEventTime({
    request: async () => ({}),
    workApiUrl: value => value,
    reload: async () => {},
  }, {
    id: "card-2",
    guestEmails: [],
    eventTime: { startIso: "2026-11-09T13:30:00.000Z", timeZone: "Pacific/Auckland", durationMinutes: 97 },
    templateDefinitionSnapshot: { eventPolicy: { timeZone: "Pacific/Auckland", durationMinutes: 97 } },
  });
  const selects = doc.created.filter(element => element.tagName === "SELECT");
  assert.equal(selects.length, 2);
  const [tzSelect, durationSelect] = selects;
  assert.equal(tzSelect.value, "Pacific/Auckland");
  assert.ok(tzSelect.children.some(option => option.value === "Pacific/Auckland"));
  assert.ok(tzSelect.children.some(option => option.value === "Europe/Berlin"));
  assert.equal(durationSelect.value, "97");
  assert.ok(durationSelect.children.some(option => option.value === "97"));
  assert.equal(Number(durationSelect.value), 97);
});

test("AC6: event card renders lifecycle status and Propose / Approve / Reschedule / Release buttons", async () => {
  const { doc } = setup();
  const calls = [];
  let reloaded = 0;

  renderCardEventTime(
    {
      request: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
      },
      workApiUrl: (value) => value,
      reload: async () => {
        reloaded += 1;
      },
    },
    {
      id: "card-evt-1",
      anchorDate: "2026-11-18",
      guestEmails: ["speaker@example.test"],
      templateDefinitionSnapshot: {
        eventPolicy: {
          timeZone: "Europe/Berlin",
          durationMinutes: 60,
          windows: { midday: "13:00", evening: "17:00" },
        },
      },
      eventTime: {
        status: "proposed",
        startIso: "2026-11-18T12:00:00.000Z",
        timeZone: "Europe/Berlin",
        durationMinutes: 60,
        sync: "synced",
      },
    },
  );

  const statusEl = doc.created.find((el) => el.className === "card-event-lifecycle-status");
  assert.ok(statusEl);
  assert.equal(statusEl.dataset.eventLifecycleStatus, "proposed");
  assert.match(statusEl.textContent, /Proposed \(Proposal\)/);

  const buttons = Object.fromEntries(
    doc.created
      .filter((el) => el.tagName.toLowerCase() === "button" && el.dataset?.eventAction)
      .map((el) => [el.dataset.eventAction, el]),
  );
  assert.ok(buttons.propose);
  assert.ok(buttons.approve);
  assert.ok(buttons.reschedule);
  assert.ok(buttons.release);

  assert.equal(buttons.propose.disabled, true);
  assert.equal(buttons.approve.disabled, false);
  assert.equal(buttons.reschedule.disabled, false);
  assert.equal(buttons.release.disabled, false);

  await buttons.approve.dispatch("click");
  assert.deepEqual(calls[0], {
    url: "/api/events/card-evt-1/approve",
    body: { guestEmails: ["speaker@example.test"] },
  });

  await buttons.reschedule.dispatch("click");
  assert.deepEqual(calls[1], {
    url: "/api/events/card-evt-1/reschedule",
    body: { date: "2026-11-18", time: "13:00", guestEmails: ["speaker@example.test"] },
  });

  await buttons.release.dispatch("click");
  assert.deepEqual(calls[2], {
    url: "/api/events/card-evt-1/release",
    body: {},
  });
  assert.equal(reloaded, 3);
});
