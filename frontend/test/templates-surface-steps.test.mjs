import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FakeDocument, FakeElement, nextTicks } from "./support/fake-dom.mjs";

const root = new FakeElement("main");
globalThis.document = new FakeDocument(root);

const { createTemplatesSurface } = await import("../src/surfaces/tasks/templates.js");
const { templateStepBindings } = await import("../src/surfaces/tasks/template-steps.js");

const DOCS = {
  "sop.events.meetup.create-events-in-meetup-com": {
    title: "Create events in Meetup.com",
    path: "content/03-programs/sops/create-events-in-meetup-com.md",
  },
  "template.programs.remind-guest": {
    title: "Remind guest",
    path: "content/03-programs/templates/remind-guest.md",
  },
  "sop.unrelated.global-doc": { title: "Unrelated", path: "content/x/unrelated.md" },
};
const resolveDocReference = (id) => DOCS[id] || null;

const TEMPLATE = {
  id: "tpl-1",
  name: "Workshop",
  triggerType: "manual",
  // A Template-wide doc list that must never leak into a step's bindings.
  sourceDocIds: ["sop.unrelated.global-doc"],
  taskDefinitions: [
    {
      refId: "create-events-meetup",
      description: "Create event on Meetup Berlin",
      offsetDays: -23,
      browserRequirement: "required",
      instructionDocId: "sop.events.meetup.create-events-in-meetup-com",
      instructionStepId: "12",
      tools: ["meetup"],
      closure: { successCriteria: "Meetup URL attached" },
    },
    {
      refId: "remind-guest",
      description: "Remind the guest",
      offsetDays: -7,
      instructionDocId: "template.programs.remind-guest",
    },
  ],
};

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}
const byClass = (node, name) => walk(node).filter((el) => el.classList?.contains?.(name));

function renderSurface() {
  const surface = createTemplatesSurface({
    countLabel: (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`,
    getAllDocuments: () => [],
    getWorkspaceEntityState: () => ({ kind: "template", id: "tpl-1", status: "ready" }),
    isWorkspaceRouteFresh: () => true,
    navigateCanonicalWorkspace: () => {},
    openQuickWorkflowForm: () => {},
    renderHonestState: (title) => { const el = new FakeElement("div"); el.textContent = title; return el; },
    renderEntityLoadState: () => {},
    renderTasksSurface: () => {},
    request: async () => ({ templates: [TEMPLATE] }),
    refreshOperationsWorkSnapshot: async () => {},
    resolveDocReference,
    setWorkspaceEntityState: () => {},
    state: { workSnapshot: { cards: [] } },
    workApiUrl: (path) => path,
  });
  return surface;
}

describe("template step bindings", () => {
  test("a step binds exactly its own process doc, never the Template-wide list", () => {
    const bindings = templateStepBindings(TEMPLATE.taskDefinitions[0], resolveDocReference);
    assert.deepEqual(bindings.processDoc, {
      id: "sop.events.meetup.create-events-in-meetup-com",
      title: "Create events in Meetup.com",
      href: "/03-programs/sops/create-events-in-meetup-com.md",
    });
    assert.deepEqual(bindings.templates, []);
    assert.equal(bindings.instructionStepId, "12");
  });

  test("a template.* instruction doc is the step's template binding", () => {
    const bindings = templateStepBindings(TEMPLATE.taskDefinitions[1], resolveDocReference);
    assert.equal(bindings.processDoc, null);
    assert.deepEqual(bindings.templates.map((t) => t.href), ["/03-programs/templates/remind-guest.md"]);
  });
});

describe("templates surface Steps", () => {
  test("Steps heading, browser icon beside the name, due offset kept, row opens its bindings in place", async () => {
    const surface = renderSurface();
    await surface.refreshRuntimeTemplates();
    surface.setRuntimeTemplateRoute({ tasksSection: "templates", params: new URLSearchParams("templateId=tpl-1") }, { templateId: "tpl-1" });
    const section = surface.renderTemplatesSurface();
    root.replaceChildren(section);

    const headings = walk(section).filter((el) => el.tagName?.toLowerCase() === "h5");
    assert.ok(headings.some((el) => el.textContent === "Steps"));
    assert.ok(!walk(section).some((el) => el._textContent === "What a new card runs"));

    const [meetup, remind] = byClass(section, "runtime-template-step");
    const name = byClass(meetup, "runtime-template-step-name")[0];
    const icon = byClass(name, "runtime-template-step-browser")[0];
    assert.ok(icon, "browser icon sits inside the step name");
    assert.equal(icon.getAttribute("aria-label"), "Browser required");
    assert.equal(byClass(meetup, "runtime-template-step-due")[0].textContent.includes("Browser required"), false);
    assert.match(byClass(meetup, "runtime-template-step-due")[0].textContent, /23/);
    assert.equal(byClass(remind, "runtime-template-step-browser").length, 0);

    const toggle = byClass(meetup, "runtime-template-step-toggle")[0];
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    toggle.click();
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const detail = byClass(meetup, "runtime-template-step-detail")[0];
    const links = walk(detail).filter((el) => el.tagName?.toLowerCase() === "a");
    assert.deepEqual(links.map((a) => a.href), ["/03-programs/sops/create-events-in-meetup-com.md"]);
    assert.match(detail.textContent, /Create events in Meetup\.com · step 12/);
    assert.doesNotMatch(detail.textContent, /Unrelated/);
    assert.match(detail.textContent, /Meetup URL attached/);

    byClass(remind, "runtime-template-step-toggle")[0].click();
    const remindLinks = walk(byClass(remind, "runtime-template-step-detail")[0])
      .filter((el) => el.tagName?.toLowerCase() === "a");
    assert.deepEqual(remindLinks.map((a) => a.href), ["/03-programs/templates/remind-guest.md"]);
  });

  test("the Templates list scroll is restored after the rebuilt list is attached", async () => {
    const surface = renderSurface();
    await surface.refreshRuntimeTemplates();
    const first = surface.renderTemplatesSurface();
    const list = walk(first).find((el) => el.className === "dk-split__scroll");
    list.scrollTop = 480;
    for (const { listener } of list.listeners.get("scroll") || []) listener({ type: "scroll" });
    const second = surface.renderTemplatesSurface();
    const rebuilt = walk(second).find((el) => el.className === "dk-split__scroll");
    rebuilt.scrollTop = 0;
    root.replaceChildren(second);
    await nextTicks(3);
    assert.equal(rebuilt.scrollTop, 480);
  });
});
