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
  test("lists each invite with its calendar, label and event id", () => {
    setup();
    const section = renderCardInvitesSection({
      calendarInvites: [
        { eventId: "evt-1", calendar: "alexey@datatalks.club", url: "https://example.com/e1", label: "original" },
        { eventId: "evt-2", calendar: "alexey.s.grigoriev@gmail.com", label: "resent" },
      ],
    });
    const rows = section.children.flatMap((child) =>
      String(child.tagName || "").toLowerCase() === "ul" ? child.children : [],
    );
    assert.equal(rows.length, 2);
    assert.match(rows[0].children[0].textContent, /alexey@datatalks\.club.*original/);
    assert.match(rows[0].children[1].textContent, /evt-1/);
    assert.match(rows[1].children[0].textContent, /alexey\.s\.grigoriev@gmail\.com.*resent/);
    assert.match(rows[1].children[1].textContent, /evt-2/);
  });

  test("renders invites without a url as plain text", () => {
    setup();
    const section = renderCardInvitesSection({
      calendarInvites: [{ eventId: "evt-9", calendar: "alexey@datatalks.club" }],
    });
    assert.match(section.children.map((child) => child.textContent).join(" "), /evt-9/);
  });
});

test("event time editor shows local time and sends arbitrary time, duration, zone and guests", async () => {
  const { doc } = setup();
  const calls = [];
  let reloaded = false;
  const form = renderCardEventTime({
    request: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); },
    workApiUrl: value => value,
    reload: async () => { reloaded = true; },
  }, { id: "card-1", guestEmails: ["guest@example.test"], eventTime: { startIso: "2026-11-09T13:30:00.000Z", timeZone: "Europe/Berlin", durationMinutes: 60 } });
  const inputs = doc.created.filter(element => element.tagName.toLowerCase() === "input");
  assert.equal(inputs[0].value, "2026-11-09T14:30");
  inputs[0].value = "2026-11-09T16:47";
  inputs[2].value = "90";
  inputs[3].value = "guest@example.test, ";
  await form.dispatch("submit");
  assert.deepEqual(calls, [{ url: "/api/cards/card-1/time", body: { at: "2026-11-09 16:47", duration: 90, tz: "Europe/Berlin", guestEmails: ["guest@example.test"] } }]);
  assert.equal(reloaded, true);
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
