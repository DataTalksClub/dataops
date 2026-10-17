import assert from "node:assert/strict";
import { test } from "node:test";

import { createSponsorContactEditor } from "../src/surfaces/finance/sponsor-contacts.js";
import { escapeHtml, FakeNode, installFormData } from "./support/fake-record-dom.mjs";

installFormData();

function editorHarness({ contacts = [], companies = [], routes = {} } = {}) {
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
  const editor = createSponsorContactEditor({
    api,
    surface,
    getContacts: () => contacts,
    getOrganizations: () => companies,
    safe: async (action) => action(),
    openDialog: () => opened.push(true),
    afterSave: async (organizationId) => saved.push(organizationId),
  });
  return { api, surface, dialog, form, calls, opened, saved, editor };
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
    api, surface, getContacts: () => [], safe: async (action) => action(),
    openDialog: () => {}, afterSave: async () => {},
  });
  const returned = await solo.open({ id: "p9" });
  assert.equal(returned.id, "p1");
  assert.deepEqual(calls, ["/contacts/p9"]);
  void editor;
});

test("unchanged dates preserve full stored precision on save", async () => {
  const { form, calls, saved, editor, surface } = editorHarness({
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
  assert.deepEqual(saved, ["c1"]);
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

test("new contacts preset the org and hide the picker; blank opens the chooser", async () => {
  const companies = [{ id: "c1", displayName: "Acme" }, { id: "c2", displayName: "Beta" }];
  const { form, editor } = editorHarness({ companies });
  const picker = new FakeNode("select");
  form.setQuery("[data-contact-org-picker]", picker);
  await editor.open({ organizationId: "c1" });
  assert.equal(form.elements.organizationId.value, "c1");
  assert.equal(picker.value, "c1");
  assert.equal(picker.disabled, true);
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
