import assert from "node:assert/strict";
import { test } from "node:test";

import { createKnowledgeFilters } from "../src/surfaces/knowledge/filters.js";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlight(text, query) {
  const { setHighlightedText } = createKnowledgeFilters({ escapeRegex }, {});
  const el = { textContent: "", innerHTML: "" };
  setHighlightedText(el, text, query);
  return el.innerHTML;
}

test("search highlighting escapes the text and never marks inside an entity", () => {
  assert.equal(
    highlight('Say "quote" & <b>', "quot"),
    "Say &quot;<mark>quot</mark>e&quot; &amp; &lt;b&gt;",
  );
  assert.equal(highlight("Tom & Jerry's", "& jerry's"), "Tom <mark>&amp;</mark> <mark>Jerry&#39;s</mark>");
});
