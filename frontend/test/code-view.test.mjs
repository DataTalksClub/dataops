import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { highlightCode, languageForName } from "../src/core/code-highlight.js";
import { createCodeViewSurface } from "../src/surfaces/knowledge/code-view.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function kinds(fragment) {
  return fragment.children.map((node) => node.className);
}

describe("code highlight", () => {
  beforeEach(() => {
    const root = new FakeElement("div");
    globalThis.document = new FakeDocument(root);
  });

  test("tokenizes bash into comments, strings, keywords and variables", () => {
    const code = '# dry run\nexport DIR=$HOME\nif [ -f x ]; then emit --force; fi\n';
    const fragment = highlightCode(code, "bash");
    const tokens = fragment.children.filter((node) => node.className).map((node) => node.className);
    assert.deepEqual(tokens, [
      "tok-comment",
      "tok-keyword",
      "tok-variable",
      "tok-keyword",
      "tok-keyword",
      "tok-keyword",
    ]);
    // Display sugar only: the text content is byte-identical to the source.
    assert.equal(fragment.textContent, code);
  });

  test("tokenizes python and maps shell aliases to the bash spec", () => {
    const py = 'def verify():\n    # check\n    return "ok"\n';
    assert.ok(kinds(highlightCode(py, "python")).includes("tok-keyword"));
    const sh = highlightCode("echo hi # note\n", "sh");
    assert.ok(kinds(sh).includes("tok-comment"));
  });

  test("falls back to a conservative spec for unknown languages", () => {
    const text = "plain text\n# note \"quoted\" 42\n";
    const fragment = highlightCode(text, "octave");
    assert.ok(kinds(fragment).includes("tok-comment"));
    assert.equal(fragment.textContent, text);
  });

  test("guesses language from the filename when the fence has none", () => {
    assert.equal(languageForName("normalize.ps1"), "powershell");
    assert.equal(languageForName("plan.yml"), "yaml");
    assert.equal(languageForName("run.sh"), "bash");
    assert.equal(languageForName("Makefile"), "");
  });
});

describe("code view surface", () => {
  const PAYLOAD = {
    files: [
      { name: "normalize.sh", language: "bash", anchor: "file-normalize-sh" },
      { name: "verify.py", language: "python", anchor: "file-verify-py" },
    ],
    blocks: [
      {
        kind: "markdown",
        anchor: "section-1-before-you-start",
        heading: "Before you start",
        body_md: "Dry-run first.",
      },
      { kind: "file", name: "normalize.sh", language: "bash", anchor: "file-normalize-sh", code: "#!/usr/bin/env bash\nset -euo pipefail\n" },
      {
        kind: "markdown",
        anchor: "section-2-stop",
        heading: "",
        body_md: "Stop before the browser step.",
      },
      { kind: "file", name: "verify.py", language: "python", anchor: "file-verify-py", code: "print('ok')\n" },
    ],
  };

  function setup() {
    const root = new FakeElement("div");
    const doc = new FakeDocument(root);
    globalThis.document = doc;
    const surface = createCodeViewSurface({});
    return { root, doc, surface };
  }

  test("renders files in author order with anchors, languages and interleaved prose", () => {
    const { root, surface } = setup();
    surface.renderCodeView(root, structuredClone(PAYLOAD));

    assert.ok(root.classList.contains("code-view"));
    const nav = root.children[0];
    assert.equal(nav.className, "code-view-nav");
    const chips = nav.children.slice(1);
    assert.deepEqual(
      chips.map((chip) => [chip.textContent, chip.getAttribute("href")]),
      [["normalize.sh", "#file-normalize-sh"], ["verify.py", "#file-verify-py"]],
    );

    const sections = root.children.slice(1);
    assert.deepEqual(
      sections.map((section) => [section.className, section.getAttribute("id")]),
      [
        ["code-note", "section-1-before-you-start"],
        ["code-file", "file-normalize-sh"],
        ["code-note", "section-2-stop"],
        ["code-file", "file-verify-py"],
      ],
    );

    const file = sections[1];
    const [name, lang, copy] = file.children[0].children;
    assert.equal(name.textContent, "normalize.sh");
    assert.equal(lang.textContent, "bash");
    assert.equal(copy.textContent, "Copy");
    assert.equal(copy.getAttribute("aria-label"), "Copy normalize.sh");
    // Code bytes preserved exactly; highlighted tokens inside.
    const pre = file.children[1];
    assert.equal(pre.children[0].textContent, "#!/usr/bin/env bash\nset -euo pipefail\n");
    assert.ok(pre.children[0].className.includes("language-bash"));
    assert.ok(pre.children[0].children.some((node) => node.className === "tok-comment"));

    const note = sections[0];
    assert.equal(note.children[0].textContent, "Before you start");
    // Without a markdown renderer, prose degrades to plain text.
    assert.equal(note.children[1].textContent, "Dry-run first.");
  });

  test("uses the provided markdown renderer for prose blocks", () => {
    const { root, surface } = setup();
    const rendered = [];
    const renderMarkdown = (md) => {
      const node = new FakeElement("p");
      node.textContent = `md:${md}`;
      rendered.push(md);
      return node;
    };
    surface.renderCodeView(root, structuredClone(PAYLOAD), { renderMarkdown });
    const note = root.children[1];
    assert.deepEqual(rendered, ["Dry-run first.", "Stop before the browser step."]);
    assert.equal(note.children[1].children[0].textContent, "md:Dry-run first.");
  });

  test("copy writes the exact code bytes and restores the label", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { root, surface } = setup();
    const written = [];
    surface.renderCodeView(root, structuredClone(PAYLOAD), {
      clipboard: { writeText: async (text) => written.push(text) },
    });
    const copyButton = root.children[2].children[0].children[2];
    await copyButton.dispatch("click");
    assert.deepEqual(written, ["#!/usr/bin/env bash\nset -euo pipefail\n"]);
    assert.equal(copyButton.textContent, "Copied");
    mock.timers.tick(1500);
    assert.equal(copyButton.textContent, "Copy");
  });

  test("reports copy failures and the missing-clipboard case honestly", async () => {
    const { root, surface } = setup();
    surface.renderCodeView(root, structuredClone(PAYLOAD), {
      clipboard: { writeText: async () => { throw new Error("denied"); } },
    });
    const failing = root.children[2].children[0].children[2];
    await failing.dispatch("click");
    assert.equal(failing.textContent, "Copy failed");

    const bare = new FakeElement("div");
    const doc2 = new FakeDocument(bare);
    globalThis.document = doc2;
    const plain = createCodeViewSurface({});
    plain.renderCodeView(bare, structuredClone(PAYLOAD), { clipboard: null });
    const unavailable = bare.children[2].children[0].children[2];
    await unavailable.dispatch("click");
    assert.equal(unavailable.textContent, "Copy n/a");
  });

  test("does not execute anything: the view stays read-only markup", () => {
    const { root, surface } = setup();
    surface.renderCodeView(root, structuredClone(PAYLOAD));
    const elements = [];
    const walk = (node) => {
      elements.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    assert.ok(elements.length > 5);
    for (const element of elements) {
      assert.notEqual(element.tagName, "SCRIPT");
      for (const attribute of element.attributes?.keys?.() || []) {
        assert.ok(!attribute.toLowerCase().startsWith("on"), `event handler attribute: ${attribute}`);
      }
    }
  });
});
