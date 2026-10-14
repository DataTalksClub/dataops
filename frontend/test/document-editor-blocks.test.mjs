import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  blockText,
  convertBlock,
  liftListItem,
  makeBlock,
  mergeBlockBackward,
  parseMarkdownBlocks,
  serializeBlocksToMarkdown,
  splitBlock,
} from "../src/surfaces/document-editor/block-editor.js";
import { plainTextLength } from "../src/surfaces/document-editor/editable.js";
import {
  asSingleUrl,
  detectBlockShortcut,
  detectInlineShortcut,
  domToInlineMarkdown,
  inlineMarkdownToHtml,
  isInlineText,
  tokenizeInline,
  tokensToMarkdown,
} from "../src/surfaces/document-editor/inline-markdown.js";

// A minimal HTML reader for the well-formed markup inlineMarkdownToHtml
// produces, standing in for the browser's contenteditable DOM.
function parseHtml(html) {
  const root = { nodeType: 11, nodeName: "#fragment", childNodes: [] };
  const stack = [root];
  const decode = (text) => text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const re = /<(\/?)([a-z]+)((?:\s+[a-z-]+="[^"]*")*)\s*(\/?)>|([^<]+)/gi;
  for (const match of html.matchAll(re)) {
    const parent = stack.at(-1);
    if (match[5] !== undefined) {
      parent.childNodes.push({ nodeType: 3, nodeName: "#text", nodeValue: decode(match[5]) });
      continue;
    }
    if (match[1]) {
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const attr of match[3].matchAll(/([a-z-]+)="([^"]*)"/gi)) attrs[attr[1]] = decode(attr[2]);
    const node = {
      nodeType: 1,
      nodeName: match[2].toUpperCase(),
      childNodes: [],
      getAttribute: (name) => attrs[name] ?? null,
      hasAttribute: (name) => name in attrs,
      classList: { contains: (name) => (attrs.class || "").split(" ").includes(name) },
      get textContent() {
        const text = (n) => (n.nodeType === 3 ? n.nodeValue : n.childNodes.map(text).join(""));
        return text(this);
      },
    };
    parent.childNodes.push(node);
    if (!match[4] && node.nodeName !== "BR" && node.nodeName !== "IMG") stack.push(node);
  }
  return root;
}

const roundTrip = (markdown) =>
  domToInlineMarkdown(parseHtml(inlineMarkdownToHtml(markdown, {
    renderAtom: (raw) => `<b>${raw.length}</b>`,
  })));

describe("inline markdown", () => {
  test("formatted text reads back to the exact markdown it came from", () => {
    const samples = [
      "Plain text with no markup.",
      "Open the **dashboard** and click *New*.",
      "Use __strong__ and _emphasis_ markers as written.",
      "Run `npm test` and ``code with ` tick``.",
      "See [the folder](https://example.test/a_(b)) and [[sop.example|the SOP]].",
      "An image ![shot](../images/a.png) inline, an escape \\* and <kbd>Ctrl</kbd>.",
      "snake_case_name and 2*3*4 stay as text.",
      "Nested **bold with *italic* inside** works.",
      "Two lines\nwith a line break.",
      "Unclosed **bold and *italic stay text.",
      "Trailing spaces  and   runs.",
    ];
    for (const sample of samples) assert.equal(roundTrip(sample), sample, sample);
    for (const sample of samples) assert.equal(tokensToMarkdown(tokenizeInline(sample)), sample);
  });

  test("tokenizes formatting and keeps unmodelled syntax as atoms", () => {
    assert.deepEqual(tokenizeInline("a **b** c").map((t) => t.type), ["text", "strong", "text"]);
    assert.deepEqual(tokenizeInline("snake_case_name").map((t) => t.type), ["text"]);
    const atoms = tokenizeInline("[[x]] ![a](b.png) \\_").filter((t) => t.type === "atom");
    assert.deepEqual(atoms.map((t) => t.raw), ["[[x]]", "![a](b.png)", "\\_"]);
    assert.equal(plainTextLength("**ab** `c` [d](e) \\*"), "ab c d *".length);
  });

  test("browser-made formatting serializes to markdown", () => {
    const fragment = parseHtml('Say <b>hi</b> to <i>them</i><br>at <a href="https://x.test">x</a><div>next</div>');
    assert.equal(domToInlineMarkdown(fragment), "Say **hi** to *them*\nat [x](https://x.test)\nnext");
    assert.equal(domToInlineMarkdown(parseHtml("<strong> </strong>a​ b")), " a b");
  });

  test("detects which blocks can be edited as formatted text", () => {
    assert.equal(isInlineText("Open **it**.\nThen close it."), true);
    assert.equal(isInlineText("Intro\n- a bullet"), false);
    assert.equal(isInlineText("| a | b |\n|---|---|"), false);
    assert.equal(isInlineText("text\n<!-- sop-note -->"), false);
  });

  test("recognizes markdown shortcuts as they are typed", () => {
    assert.deepEqual(detectBlockShortcut("## "), { type: "h2", marker: "## ", rest: "" });
    assert.equal(detectBlockShortcut("- ").type, "bullet");
    assert.equal(detectBlockShortcut("1. ").type, "numbered");
    assert.equal(detectBlockShortcut("[] ").type, "todo");
    assert.equal(detectBlockShortcut("> ").type, "quote");
    assert.equal(detectBlockShortcut("```").type, "code");
    assert.equal(detectBlockShortcut("---").type, "divider");
    assert.equal(detectBlockShortcut("#hashtag"), null);
    assert.deepEqual(detectInlineShortcut("make it **bold**"), { kind: "strong", marker: "**", start: 8, inner: "bold" });
    assert.deepEqual(detectInlineShortcut("an *it*"), { kind: "em", marker: "*", start: 3, inner: "it" });
    assert.deepEqual(detectInlineShortcut("run `ls`"), { kind: "code", marker: "`", start: 4, inner: "ls" });
    assert.equal(detectInlineShortcut("snake_case_"), null);
    assert.equal(detectInlineShortcut("2 * 3 *"), null);
    assert.equal(asSingleUrl(" https://youtu.be/abc "), "https://youtu.be/abc");
    assert.equal(asSingleUrl("see https://x.test"), null);
  });
});

describe("block keyboard model", () => {
  const blocks = (markdown) => parseMarkdownBlocks(markdown);

  test("Enter splits a block; headings continue as paragraphs, to-dos as to-dos", () => {
    const list = blocks("## Heading text\n\n- [x] Done thing");
    const next = splitBlock(list, 0, "Heading", " text");
    assert.equal(next, 1);
    assert.deepEqual(list.map((b) => [b.type, b.raw]), [
      ["h2", "## Heading"],
      ["paragraph", " text"],
      ["todo", "- [x] Done thing"],
    ]);
    splitBlock(list, 2, "Done", "next");
    assert.deepEqual(list.slice(2).map((b) => b.raw), ["- [x] Done", "- [ ] next"]);
  });

  test("Backspace at the start un-formats first, then joins the block above", () => {
    const list = blocks("First paragraph.\n\n## Title");
    assert.deepEqual(mergeBlockBackward(list, 1, "Title"), { index: 1, at: "start" });
    assert.deepEqual(list.map((b) => b.raw), ["First paragraph.", "Title"]);
    assert.deepEqual(mergeBlockBackward(list, 1, "Title"), { index: 0, prefix: "First paragraph." });
    assert.deepEqual(list.map((b) => b.raw), ["First paragraph.Title"]);
    assert.equal(mergeBlockBackward(list, 0, "x"), null);
  });

  test("Backspace joins a paragraph onto the last item of a list above", () => {
    const list = blocks("- one\n- two\n\nthree");
    assert.deepEqual(mergeBlockBackward(list, 1, "three"), { index: 0, item: 1, prefix: "two" });
    assert.equal(serializeBlocksToMarkdown(list), "- one\n- twothree");
  });

  test("a divider above is removed instead of merged", () => {
    const list = blocks("Above\n\n---\n\nBelow");
    assert.deepEqual(mergeBlockBackward(list, 2, "Below"), { index: 1, at: "start" });
    assert.equal(serializeBlocksToMarkdown(list), "Above\n\nBelow");
  });

  test("a list item lifted out of a list becomes a paragraph and splits the list", () => {
    const list = blocks("- one\n- two\n  - nested\n- three");
    const at = liftListItem(list, 0, 1, "two");
    assert.equal(at, 1);
    assert.equal(serializeBlocksToMarkdown(list), "- one\n\ntwo\n\n- nested\n- three");
  });

  test("converting keeps the text and round-trips through the parser", () => {
    const paragraph = makeBlock("paragraph", "Check the **link**");
    for (const type of ["h1", "h2", "h3", "todo", "bullet", "numbered", "quote", "callout", "code"]) {
      const converted = convertBlock(paragraph, type);
      assert.equal(converted.type, type);
      assert.equal(blockText(converted), "Check the **link**", type);
      assert.equal(parseMarkdownBlocks(converted.raw)[0].type, type);
    }
    assert.equal(convertBlock(paragraph, "todo-done").raw, "- [x] Check the **link**");
    assert.equal(blockText(convertBlock(makeBlock("h2", "Title"), "paragraph")), "Title");
  });

  test("single media lines are image and embed blocks that keep their source", () => {
    const list = blocks("![Shot](a.png)\n\nhttps://www.youtube.com/watch?v=abc\n\nhttps://example.com");
    assert.deepEqual(list.map((b) => b.type), ["image", "embed", "paragraph"]);
    assert.equal(serializeBlocksToMarkdown(list), "![Shot](a.png)\n\nhttps://www.youtube.com/watch?v=abc\n\nhttps://example.com");
  });
});
