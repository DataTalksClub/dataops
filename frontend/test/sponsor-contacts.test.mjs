import assert from "node:assert/strict";
import { test } from "node:test";

import { createSponsorContactEditor } from "../src/surfaces/finance/sponsor-contacts.js";
import { escapeHtml, FakeNode, installFormData } from "./support/fake-record-dom.mjs";

installFormData();

function editorHarness({ contacts = [], companies = [], routes = {}, context: extra = {} } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    const handler = routes[`${options.method || "GET"} ${path}`];
    if (!handler) throw new Error(`Unexpected API call: ${path}`);
    if (typeof handler === "function") return handler({ path, body: options.body ? JSON.parse(options.body) : undefined });
    return handler;
  };
  const surface = new FakeNode("section");
  const dialog = surface.setQuery("[data-contact-dialog]", new FakeNode("dialog"));
  const form = dialog.setQuery("form", new FakeNode("form"));
  const opened = [];
  const saved = [];
  const captured = [];
  const editor = createSponsorContactEditor({
    api,
    surface,
    getContacts: () => contacts,
    getOrganizations: () => companies,
    safe: async (action) => action(),
    openDialog: () => opened.push(true),
    afterSave: async (organizationId, saveContext) => saved.push([organizationId, saveContext]),
    captureSaveContext: () => {
      const snapshot = { view: "people", at: calls.length };
      captured.push(snapshot);
      return snapshot;
    },
    ...extra,
  });
  return { api, surface, dialog, form, calls, opened, saved, captured, editor };
}

const ada = {
  id: "p1",
  organizationId: "c1",
  name: "Ada",
  emails: ["ada@acme.example"],
  primary: true,
  role: "CTO",
  linkedin: "https://www.linkedin.com/in/ada",
  telegram: "@ada",
  notes: "Prefers email.",
  lastContactedAt: "2026-10-09T14:35:22Z",
  version: 2,
};

test("opening a known contact fills the form with full precision intact", async () => {
  const { form, opened, editor } = editorHarness({ contacts: [ada] });
  const returned = await editor.open({ id: "p1" });
  assert.equal(returned.id, "p1");
  assert.deepEqual(opened, [true]);
  assert.equal(form.elements.name.value, "Ada");
  assert.equal(form.elements.email.value, "ada@acme.example");
  assert.equal(form.elements.role.value, "CTO");
  assert.equal(form.elements.linkedin.value, "https://www.linkedin.com/in/ada");
  assert.equal(form.elements.contactId.value, "p1");
  assert.equal(form.elements.version.value, 2);
  assert.equal(form.elements.primary.checked, true);
  // Date input shows the day; the full timestamp is preserved for the save.
  assert.equal(form.elements.lastContactedAt.value, "2026-10-09");
  assert.equal(form.elements.lastContactedAt.dataset.original, "2026-10-09T14:35:22Z");
});

test("unknown contacts load exactly by ID without a directory read", async () => {
  const calls = [];
  const { editor } = editorHarness({ contacts: [], routes: { "GET /contacts/p9": ada } });
  const api = async (path) => { calls.push(path); return ada; };
  const surface = new FakeNode("section");
  const dialog = surface.setQuery("[data-contact-dialog]", new FakeNode("dialog"));
  dialog.setQuery("form", new FakeNode("form"));
  const solo = createSponsorContactEditor({
    api, surface, getContacts: () => [], getOrganizations: () => [{ id: "c1", displayName: "Acme" }, { id: "c2", displayName: "Beta" }], safe: async (action) => action(),
    openDialog: () => {}, afterSave: async () => {},
  });
  const returned = await solo.open({ id: "p9" });
  assert.equal(returned.id, "p1");
  assert.deepEqual(calls, ["/contacts/p9"]);
  void editor;
});

test("unchanged dates preserve full stored precision on save", async () => {
  const { form, calls, saved, captured, editor, surface } = editorHarness({
    contacts: [ada],
    routes: { "PUT /contacts/p1": (({ body }) => ({ ...ada, ...body, version: 3 })) },
  });
  await editor.open({ id: "p1" });
  form.formEntries = [
    ["organizationId", "c1"], ["contactId", "p1"], ["version", "2"], ["name", "Ada"],
    ["email", "ada@acme.example"], ["role", "CTO"], ["linkedin", ""], ["telegram", ""],
    ["notes", ""], ["lastContactedAt", "2026-10-09"],
  ];
  form.elements.primary.checked = true;
  await surface.querySelector("[data-contact-save]").dispatch("click", {});
  const put = calls.find(({ method }) => method === "PUT");
  assert.equal(put.body.lastContactedAt, "2026-10-09T14:35:22Z", "untouched date keeps full precision");
  assert.equal(saved[0][0], "c1");
  assert.strictEqual(saved[0][1], captured[0], "same captured context object reaches afterSave");
});

test("save context is captured before the request settles and passed through", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { form, editor, surface, saved, captured } = editorHarness({
    contacts: [ada],
    routes: {
      "PUT /contacts/p1": async ({ body }) => {
        await gate;
        return { ...ada, ...body, version: 3 };
      },
    },
  });
  await editor.open({ id: "p1" });
  form.formEntries = [
    ["organizationId", "c1"], ["contactId", "p1"], ["version", "2"], ["name", "Ada"],
    ["email", "ada@acme.example"], ["role", ""], ["linkedin", ""], ["telegram", ""],
    ["notes", ""], ["lastContactedAt", "2026-10-09"],
  ];
  const pending = surface.querySelector("[data-contact-save]").dispatch("click", {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(captured.length, 1, "context captured synchronously at submit, before the API settles");
  release();
  await pending;
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], "c1");
  assert.equal(saved[0][1], captured[0], "exact same context object reaches afterSave");
});

test("failed save keeps the typed form and never calls afterSave", async () => {
  const errors = [];
  const { form, editor, surface, saved } = editorHarness({
    contacts: [ada],
    routes: { "PUT /contacts/p1": async () => { throw new Error("version conflict"); } },
    context: {
      safe: async (action) => {
        try {
          await action();
        } catch (error) {
          errors.push(error.message);
        }
      },
    },
  });
  await editor.open({ id: "p1" });
  form.formEntries = [
    ["organizationId", "c1"], ["contactId", "p1"], ["version", "2"], ["name", "Ada Changed"],
    ["email", "ada@acme.example"], ["role", "CTO"], ["linkedin", ""], ["telegram", ""],
    ["notes", ""], ["lastContactedAt", "2026-10-09"],
  ];
  await surface.querySelector("[data-contact-save]").dispatch("click", {});
  assert.deepEqual(saved, [], "no afterSave on rejection");
  assert.deepEqual(errors, ["version conflict"], "operator sees the failure");
  assert.equal(Object.fromEntries(form.formEntries).name, "Ada Changed", "typed draft retained for retry");
});

test("changed dates send the new day and cleared dates send null", async () => {
  const seen = [];
  const { form, editor, surface } = editorHarness({
    contacts: [ada],
    routes: { "PUT /contacts/p1": (({ body }) => { seen.push(body.lastContactedAt); return { ...ada }; }) },
  });
  await editor.open({ id: "p1" });
  const entries = (date) => [
    ["organizationId", "c1"], ["contactId", "p1"], ["version", "2"], ["name", "Ada"],
    ["email", "ada@acme.example"], ["role", ""], ["linkedin", ""], ["telegram", ""],
    ["notes", ""], ["lastContactedAt", date],
  ];
  form.formEntries = entries("2026-10-10");
  await surface.querySelector("[data-contact-save]").dispatch("click", {});
  form.formEntries = entries("");
  await surface.querySelector("[data-contact-save]").dispatch("click", {});
  assert.deepEqual(seen, ["2026-10-10", null]);
});

test("company chooser stays usable on edit and follows into the hidden field", async () => {
  const companies = [{ id: "c1", displayName: "Acme" }, { id: "c2", displayName: "Northwind" }];
  const { form, editor } = editorHarness({ contacts: [ada], companies });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.equal(picker.disabled, false, "chooser usable while editing");
  assert.equal(picker.value, "c1", "current company preselected");
  assert.equal(form.elements.organizationId.value, "c1");
  picker.value = "c2";
  await picker.dispatch("change", {});
  assert.equal(form.elements.organizationId.value, "c2", "hidden field follows the chooser");
});

test("reassociation submits the selected org with version intact", async () => {
  const puts = [];
  const { form, editor, saved, surface, captured } = editorHarness({
    contacts: [ada],
    companies: [{ id: "c1", displayName: "Acme" }, { id: "c2", displayName: "Northwind" }],
    routes: { "PUT /contacts/p1": (({ body }) => { puts.push(body); return { ...ada, ...body, version: 3 }; }) },
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  picker.value = "c2";
  await picker.dispatch("change", {});
  form.formEntries = [
    ["organizationId", "c2"], ["contactId", "p1"], ["version", "2"], ["name", "Ada"],
    ["email", "ada@acme.example"], ["role", ""], ["linkedin", ""], ["telegram", ""],
    ["notes", ""], ["lastContactedAt", ""],
  ];
  await surface.querySelector("[data-contact-save]").dispatch("click", {});
  assert.equal(puts[0].organizationId, "c2", "selected org submitted");
  assert.equal(puts[0].version, 2, "optimistic version preserved, no silent overwrite");
  assert.deepEqual(saved, [["c2", captured[0]]]);
  assert.equal(captured[0].view, "people");
});

test("unknown current association stays honest and selectable", async () => {
  const { form, editor } = editorHarness({
    contacts: [{ ...ada, organizationId: "cx" }],
    companies: [{ id: "c1", displayName: "Acme" }],
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.match(picker.innerHTML, /value="cx"/, "unknown org kept as a labeled option");
  assert.match(picker.innerHTML, /Current company \(cx\)/, "no invented display name");
  assert.equal(picker.value, "cx");
});

test("chooser escapes option values and labels", async () => {
  const { form, editor } = editorHarness({ contacts: [ada] });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" }, { companies: [{ id: 'x"onmouseover="y', displayName: "<b>Bold</b>" }] });
  assert.doesNotMatch(picker.innerHTML, /<b>Bold<\/b>/);
  assert.match(picker.innerHTML, /&lt;b&gt;Bold&lt;\/b&gt;/);
  assert.doesNotMatch(picker.innerHTML, /x"onmouseover/);
  assert.match(picker.innerHTML, /x&quot;onmouseover/);
});

test("cold open fetches one bounded company page for real alternatives", async () => {
  const fetched = [];
  const { form, editor } = editorHarness({
    contacts: [{ ...ada, organizationId: "c1" }],
    companies: [],
    routes: {
      "GET /directory/companies?limit=50&active=true": (({ }) => {
        fetched.push(true);
        return { items: [{ id: "c1", displayName: "Acme" }, { id: "c9", displayName: "Northwind" }], nextCursor: "more" };
      }),
    },
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.equal(fetched.length, 1, "exactly one bounded lookup, never a directory scan");
  assert.match(picker.innerHTML, /Northwind/, "cold editor offers a real alternative");
  assert.equal(picker.value, "c1", "current stays preselected");
});

test("chooser lookup failure degrades to the cached current entry", async () => {
  const { form, editor } = editorHarness({
    contacts: [{ ...ada, organizationId: "c1" }],
    companies: [],
    routes: { "GET /directory/companies?limit=50&active=true": (() => { throw new Error("down"); }) },
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.match(picker.innerHTML, /Current company \(c1\)/, "chooser stays usable on lookup failure");
  assert.equal(picker.value, "c1");
});

test("failed lookup surfaces an honest notice; reopening retries", async () => {
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  try {
    let attempts = 0;
    const { form, editor } = editorHarness({
      contacts: [{ ...ada, organizationId: "c1" }],
      routes: {
        "GET /directory/companies?limit=50&active=true": () => {
          attempts += 1;
          if (attempts === 1) throw new Error("directory down");
          return { items: [{ id: "c1", displayName: "Acme" }, { id: "c9", displayName: "Northwind" }] };
        },
      },
    });
    const picker = new FakeNode("select");
    form.setQuery("[data-contact-org-picker]", picker);
    await editor.open({ id: "p1" });
    const hinted = (picker.afterSiblings || []).find((node) => node.tagName === "P");
    assert.ok(hinted, "chooser-unavailable notice shown instead of implying complete alternatives");
    assert.match(hinted.textContent, /cached and current choices only|current company only/i);
    assert.equal(hinted.children.filter((node) => node.tagName === "BUTTON").length, 0, "no async retry controller inside the notice");
    assert.equal(form.elements.organizationId.value, "c1", "save still works with the current association");
    await editor.open({ id: "p1" });
    assert.match(picker.innerHTML, /Northwind/, "reopen retries the bounded lookup and offers real alternatives");
    assert.equal((picker.afterSiblings || []).filter((node) => node.tagName === "P").length, 0, "notice clears after success");
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});

test("archived and inactive cached companies stay out unless currently associated", async () => {
  const { form, editor } = editorHarness({
    contacts: [{ ...ada, organizationId: "c1" }],
    companies: [
      { id: "c1", displayName: "Acme" },
      { id: "dead", displayName: "Gone Co", archivedAt: "2026-01-01T00:00:00Z" },
      { id: "quiet", displayName: "Quiet Inc", active: false },
    ],
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.doesNotMatch(picker.innerHTML, /Gone Co|Quiet Inc/, "inactive alternatives excluded");
  assert.match(picker.innerHTML, /Acme/, "current association retained");
});

test("inactive current association is retained with its real name", async () => {
  const { form, editor } = editorHarness({
    contacts: [{ ...ada, organizationId: "quiet" }],
    companies: [
      { id: "c1", displayName: "Acme" },
      { id: "quiet", displayName: "Quiet Inc", active: false },
    ],
  });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ id: "p1" });
  assert.match(picker.innerHTML, /Quiet Inc/, "inactive current association keeps its real name");
  assert.equal(picker.value, "quiet");
});

test("new contacts preset the org with the chooser visible; blank opens the chooser", async () => {
  const companies = [{ id: "c1", displayName: "Acme" }, { id: "c2", displayName: "Beta" }];
  const { form, editor } = editorHarness({ companies });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ organizationId: "c1" });
  assert.equal(form.elements.organizationId.value, "c1");
  assert.equal(picker.value, "c1");
  assert.equal(picker.disabled, false, "chooser stays usable even with a preset");
  await editor.open({});
  assert.equal(picker.disabled, false);
  assert.match(picker.innerHTML, /Acme/);
  assert.match(picker.innerHTML, /Beta/);
});

test("clicking an edit affordance opens that contact", async () => {
  const { surface, opened, editor } = editorHarness({ contacts: [ada] });
  const button = new FakeNode("button");
  await surface.dispatch("click", { closestPatch: { "[data-edit-contact]": { dataset: { editContact: "p1" } } } });
  assert.deepEqual(opened, [true]);
  void button;
  void editor;
});

test("contact editing never exposes a send affordance", async () => {
  const { dialog } = editorHarness({ contacts: [ada] });
  assert.doesNotMatch(dialog.innerHTML || "", /data-(draft|approve|suppress|evaluate)/);
  const source = await import("node:fs").then((fs) => fs.readFileSync(
    new URL("../src/surfaces/finance/sponsor-contacts.js", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /data-(draft-suggestion|review-draft|create-review|approve-message|suppress-address|cancel-attempt|reconcile-attempt|evaluate-communications)/);
  void escapeHtml;
});
