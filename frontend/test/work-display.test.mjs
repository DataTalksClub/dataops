import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { cardKind } from "../src/core/card-kind.js";
import { hasIcon, TEMPLATE_ICON_NAMES } from "../src/core/icons.js";
import { documentHref, isMailLink, linkAddress, linkLabel, linkService, linkTarget, mailAddress, opensInNewTab } from "../src/core/links.js";
import { taskMaterials, taskTitleParts } from "../src/core/task-display.js";
import { renderArtifactGroups } from "../src/surfaces/work-detail/artifact-rows.js";
import { FakeDocument, FakeElement, findAllByClass } from "./support/fake-dom.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("work display helpers", () => {
  test("draws every curated template icon and matches the backend list", () => {
    const source = readFileSync(path.join(repoRoot, "backend/src/templates/templateIcons.ts"), "utf8");
    const backendNames = [...source.matchAll(/^\s+'([a-z-]+)',$/gm)].map((match) => match[1]);
    assert.deepEqual([...TEMPLATE_ICON_NAMES], backendNames);
    for (const name of TEMPLATE_ICON_NAMES) assert.ok(hasIcon(name), name);
  });

  test("finds a card's kind by template id, then by a type tag", () => {
    const templates = [
      { id: "t1", type: "webinar", name: "Webinar", icon: "video" },
      { id: "t2", type: "podcast", name: "Podcast" },
    ];
    assert.deepEqual(cardKind({ templateId: "t1" }, templates), {
      type: "webinar", name: "Webinar", icon: "video", templateId: "t1",
    });
    assert.equal(cardKind({ tags: ["🎙️[Podcast]", "Podcast"] }, templates).icon, "card");
    assert.equal(cardKind({ tags: ["misc"] }, templates), null);
    assert.equal(cardKind({ templateId: "t1" }, []), null);
  });

  test("names links by service and short id instead of the raw URL", () => {
    assert.equal(linkTarget("https://luma.com/abc](https://luma.com/abc"), "https://luma.com/abc");
    assert.equal(linkLabel("https://luma.com/abc"), "Luma · abc");
    assert.equal(linkLabel("https://www.meetup.com/g/events/314993406/?x=1"), "Meetup · event 314993406");
    assert.equal(linkLabel("https://docs.google.com/document/d/1SVWxBsBzvG5URX2/edit"), "Google Doc · 1SVWxBsB…");
    assert.equal(linkLabel("https://www.linkedin.com/in/someone/"), "LinkedIn · someone");
    assert.equal(linkLabel("https://docs.google.com/document/d/x/edit", "Episode brief"), "Episode brief");
    assert.equal(linkService("https://www.youtube.com/watch?v=abc").icon, "play");
    assert.equal(linkService("https://example.com/a").id, "link");
  });

  test("shows a link as host plus a shortened path, and treats mailto as an email", () => {
    assert.equal(linkAddress("https://docs.google.com/document/d/1SVWxBsBzvG5URX2/edit"), "docs.google.com/…/edit");
    assert.equal(linkAddress("https://luma.com/ar4ggwep"), "luma.com/ar4ggwep");
    assert.equal(linkAddress("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(linkAddress("https://example.com/"), "example.com");
    assert.equal(isMailLink("mailto:dewang@example.com"), true);
    assert.equal(isMailLink("mailto:"), false);
    assert.equal(isMailLink("https://example.com"), false);
    assert.equal(mailAddress("mailto:dewang@example.com?subject=Hi"), "dewang@example.com");
    assert.equal(linkService("mailto:dewang@example.com").icon, "mail");
  });

  test("lists a task's materials after its process doc and instructions", () => {
    const parts = taskTitleParts("[Emails] Ask", ["podcast"], "podcast");
    assert.equal(parts.title, "Ask");
    assert.equal(parts.tag, "Emails");
    assert.deepEqual(taskTitleParts("[brief](https://docs.google.com/document/d/y/edit)").tag, "");
    const materials = taskMaterials(
      {
        instructionDocId: "sop.events.create-event",
        instructionsUrl: "https://docs.google.com/document/d/y/edit",
        materials: [
          { url: "https://docs.google.com/document/d/y/edit", label: "doc" },
          { url: "https://www.loom.com/share/abc" },
          { url: "https://github.com/o/r", label: "website" },
        ],
      },
      { resolveDoc: () => ({ title: "Create an event", path: "content/x.md" }) },
    );
    assert.deepEqual(
      materials.map((material) => [material.label, material.detail]),
      [["Create an event", "Process doc"], ["Instructions", "Google Doc"], ["Loom · abc", "Loom"], ["Website", "GitHub"]],
    );
    // A resolved process doc carries the portal address it opens at; an
    // unresolved one has no address to open.
    assert.equal(materials[0].href, "/x.md");
    assert.equal(taskMaterials({ instructionDocId: "missing" })[0].href, "");
  });

  test("addresses documents at their portal URL and marks new-tab links", () => {
    assert.equal(documentHref("content/process/podcast/guest prep.md"), "/process/podcast/guest%20prep.md");
    assert.equal(documentHref("process/x.md"), "/process/x.md");
    const previous = globalThis.document;
    globalThis.document = new FakeDocument(new FakeElement("main"));
    try {
      const plain = document.createElement("a");
      plain.textContent = "Guest prep";
      opensInNewTab(plain);
      assert.equal(plain.target, "_blank");
      assert.equal(plain.rel, "noopener noreferrer");
      assert.equal(plain.querySelector(".dk-visually-hidden").textContent, " (opens in new tab)");
      const icon = document.createElement("a");
      icon.setAttribute("aria-label", "Open Guest prep");
      opensInNewTab(icon);
      assert.equal(icon.getAttribute("aria-label"), "Open Guest prep (opens in new tab)");
      assert.equal(icon.querySelector(".dk-visually-hidden"), null);
    } finally {
      globalThis.document = previous;
    }
  });

  test("renders artifacts as grouped rows with service labels, never raw URLs", () => {
    const previous = globalThis.document;
    globalThis.document = new FakeDocument(new FakeElement("main"));
    try {
      const groups = renderArtifactGroups([
        { id: "a1", status: "approved", title: "https://luma.com/abc", storageUri: "https://luma.com/abc" },
        { id: "a2", status: "needs-review", title: "Episode brief", storageUri: "https://docs.google.com/document/d/x/edit" },
        { id: "a3", status: "approved", title: "https://www.linkedin.com/in/someone/", storageUri: "https://www.linkedin.com/in/someone/" },
        { id: "a4", status: "approved", title: "invoice.pdf", storageProvider: "s3", contentType: "application/pdf" },
      ]);
      assert.deepEqual(
        findAllByClass(groups, "artifact-group-label").map((label) => label.textContent),
        ["Documents", "Event pages", "People", "Files"],
      );
      const rows = findAllByClass(groups, "artifact-row").map((row) => [
        row.querySelector(".artifact-row-label").textContent,
        row.querySelector(".artifact-row-detail").textContent,
        row.querySelector(".task-status-badge").textContent,
      ]);
      assert.deepEqual(rows, [
        ["Episode brief (opens in new tab)", "Google Doc", "Needs review"],
        ["Luma · abc (opens in new tab)", "Luma", "Approved"],
        ["LinkedIn · someone (opens in new tab)", "LinkedIn", "Approved"],
        ["invoice.pdf", "PDF file", "Approved"],
      ]);
      assert.ok(!groups.textContent.includes("https://"));
      for (const link of groups.querySelectorAll("a.artifact-row-label")) {
        assert.equal(link.target, "_blank");
        assert.equal(link.rel, "noopener noreferrer");
      }
    } finally {
      globalThis.document = previous;
    }
  });
});
