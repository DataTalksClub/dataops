import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { renderCardInvitesSection } from "../src/surfaces/work-detail/card-invites.js";
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
