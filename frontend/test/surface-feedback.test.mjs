import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import {
  createFormFeedback,
  renderDataSummary,
  renderSurfaceSummary,
  reportFieldValidation,
  resolveDataState,
  setControlPending,
  setFieldError,
} from "../src/surfaces/operations-overview.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

function useFakeDocument() {
  const root = new FakeElement("main");
  globalThis.document = new FakeDocument(root);
  return root;
}

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function field(tagName = "input") {
  const input = new FakeElement(tagName);
  const wrap = new FakeElement("label");
  wrap.append(input);
  return { input, wrap };
}

describe("owning-surface feedback primitives", () => {
  test("names every summary state in text and reserves alerts for outages", () => {
    useFakeDocument();
    const ready = renderSurfaceSummary({
      id: "home",
      label: "Today",
      state: "ready",
      message: "2 tasks due today.",
    });
    assert.equal(ready.dataset.summaryState, "ready");
    assert.equal(ready.dataset.summaryId, "home");
    assert.equal(ready.getAttribute("aria-label"), "Today summary");
    const line = ready.querySelector(".surface-summary-line");
    assert.equal(line.getAttribute("role"), "status");
    assert.equal(line.getAttribute("aria-live"), "polite");
    assert.equal(
      ready.querySelector(".surface-summary-state").textContent,
      "Ready",
    );

    const outage = renderSurfaceSummary({
      label: "Users",
      state: "unavailable",
      message: "Users could not be loaded.",
      detail: "Synthetic route failure (503)",
    });
    const outageLine = outage.querySelector(".surface-summary-line");
    assert.equal(outageLine.getAttribute("role"), "alert");
    assert.equal(outageLine.getAttribute("aria-live"), "assertive");
    assert.equal(
      outage.querySelector(".surface-summary-detail").textContent,
      "Synthetic route failure (503)",
    );
    assert.equal(
      outage.querySelector(".surface-summary-state").textContent,
      "Unavailable",
    );
  });

  test("blocks a duplicate retry while the retry it started is still running", async () => {
    useFakeDocument();
    let release;
    let calls = 0;
    const summary = renderSurfaceSummary({
      label: "Work Queue",
      state: "unavailable",
      message: "Tasks could not be loaded.",
      retryLabel: "Retry loading tasks",
      onRetry: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const retry = summary.querySelector(".surface-summary-retry");
    assert.equal(
      retry.getAttribute("aria-label"),
      "Retry loading tasks: Work Queue",
    );
    const running = retry.dispatch("click");
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.equal(retry.textContent, "Retry loading tasks…");
    release();
    await running;
    assert.equal(calls, 1);
    assert.equal(retry.disabled, false);
    assert.equal(retry.getAttribute("aria-busy"), null);
    assert.equal(retry.textContent, "Retry loading tasks");
  });

  test("leaves a retry pending when its control is replaced before completion", async () => {
    const root = useFakeDocument();
    let release;
    const summary = renderSurfaceSummary({
      label: "Work Queue",
      state: "unavailable",
      message: "Tasks could not be loaded.",
      retryLabel: "Retry loading tasks",
      onRetry: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    root.append(summary);
    const retry = summary.querySelector(".surface-summary-retry");
    const running = retry.dispatch("click");
    retry.remove();
    release();
    await running;

    assert.equal(retry.isConnected, false);
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.equal(retry.textContent, "Retry loading tasks…");
  });

  test("separates not-loaded, failed, partial, empty, and ready data states", () => {
    assert.equal(resolveDataState({ loaded: false, errors: [] }), "loading");
    assert.equal(
      resolveDataState({ loaded: false, errors: ["boom"] }),
      "unavailable",
    );
    assert.equal(
      resolveDataState({ loaded: true, errors: ["boom"] }),
      "partial",
    );
    assert.equal(resolveDataState({ loaded: true, empty: true }), "empty");
    assert.equal(resolveDataState({ loaded: true }), "ready");
  });

  test("offers recovery only where a retry can change the answer", () => {
    useFakeDocument();
    const messages = {
      loading: "Loading…",
      unavailable: "Unavailable.",
      empty: "Nothing here.",
      partial: "Partly loaded.",
      ready: "Loaded.",
    };
    const retry = () => {};
    const loading = renderDataSummary({ loaded: false, messages, onRetry: retry });
    assert.equal(loading.querySelector(".surface-summary-retry"), null);
    const empty = renderDataSummary({
      loaded: true,
      empty: true,
      messages,
      onRetry: retry,
    });
    assert.equal(empty.querySelector(".surface-summary-retry"), null);
    const partial = renderDataSummary({
      loaded: true,
      errors: ["half down"],
      messages,
      onRetry: retry,
    });
    assert.ok(partial.querySelector(".surface-summary-retry"));
    assert.equal(
      partial.querySelector(".surface-summary-detail").textContent,
      "half down",
    );
  });

  test("keeps pending and success polite while failures stay assertive", () => {
    useFakeDocument();
    const feedback = createFormFeedback();
    const status = feedback.node.querySelector(".form-feedback-status");
    const error = feedback.node.querySelector(".form-feedback-error");
    assert.equal(status.getAttribute("role"), "status");
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(feedback.state, "idle");

    feedback.pending("Creating task…");
    assert.equal(feedback.state, "pending");
    assert.equal(status.hidden, false);
    assert.equal(error.hidden, true);

    const failed = feedback.failure("Could not create task.");
    assert.equal(failed, error);
    assert.equal(feedback.state, "error");
    assert.equal(status.hidden, true);
    assert.equal(error.textContent, "Could not create task.");

    feedback.conflict("The record changed.");
    assert.equal(feedback.state, "conflict");
    assert.equal(error.textContent, "The record changed.");

    feedback.success("Task created.");
    assert.equal(feedback.state, "success");
    assert.equal(error.hidden, true);
    assert.equal(status.textContent, "Task created.");

    feedback.clear();
    assert.equal(feedback.state, "idle");
    assert.equal(status.hidden, true);
    assert.equal(error.hidden, true);
  });

  test("names the pending operation without stealing focus", () => {
    const button = new FakeElement("button");
    button.textContent = "Create task";
    setControlPending(button, { pending: true, pendingLabel: "Creating task…" });
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(button.textContent, "Creating task…");
    assert.equal(button.focused, false);
    setControlPending(button, { pending: false, label: "Create task" });
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute("aria-busy"), null);
    assert.equal(button.textContent, "Create task");
  });

  test("describes an invalid control with its own message and reuses one node", () => {
    useFakeDocument();
    const name = field();
    const first = setFieldError(name, "Name is required.");
    assert.equal(first.getAttribute("role"), "alert");
    assert.equal(name.input.getAttribute("aria-invalid"), "true");
    assert.equal(
      name.input.getAttribute("aria-describedby"),
      first.getAttribute("id"),
    );
    const second = setFieldError(name, "Name is still required.");
    assert.equal(second, first);
    assert.equal(name.wrap.querySelectorAll(".field-error").length, 1);

    setFieldError(name, "");
    assert.equal(first.hidden, true);
    assert.equal(name.input.getAttribute("aria-invalid"), null);
    assert.equal(name.input.getAttribute("aria-describedby"), null);
  });

  test("moves focus to the first invalid control and keeps entered values", () => {
    useFakeDocument();
    const name = field();
    const email = field();
    name.input.value = "Grace";
    email.input.value = "";
    const invalid = reportFieldValidation([
      [name, ""],
      [email, "Email is required."],
    ]);
    assert.equal(invalid, email);
    assert.equal(email.input.focused, true);
    assert.equal(name.input.focused, false);
    assert.equal(name.input.value, "Grace");
    assert.equal(
      reportFieldValidation([
        [name, ""],
        [email, ""],
      ]),
      null,
    );
  });
});

const SLICE1_MOBILE_MEDIA_QUERY = "@media (max-width: 768px)";
const SLICE1_MOBILE_BLOCK_START =
  'body[data-workspace-view="tasks"] .ops-surface-recurring .recurring-action';
const SLICE1_MOBILE_CHECKBOX_SELECTOR =
  'body[data-workspace-view="tasks"] .quick-form-label.quick-form-checkbox input';
const SLICE1_MOBILE_ORDINARY_SELECTORS = [
  SLICE1_MOBILE_BLOCK_START,
  'body[data-workspace-view="tasks"] .recurring-row-actions .task-action-btn',
  ".ops-surface-users .primary-button",
  ".ops-users-table .ops-user-actions .quiet-button",
  '.ops-user-form input:not([type="checkbox"])',
  ".ops-user-form select",
  ".ops-user-form-actions button",
  'body[data-workspace-view="tasks"] .quick-form-overlay .quiet-button',
  'body[data-workspace-view="tasks"] .quick-form-label input:not([type="checkbox"])',
  'body[data-workspace-view="tasks"] .quick-form-label select',
  'body[data-workspace-view="tasks"] .quick-form > .task-action-btn',
  'body[data-workspace-view="tasks"] .recurring-form-footer button',
  ".home-quick-action",
  ".home-task-action",
  ".home-view-all",
];

function extractBalancedBlock(source, openIndex) {
  if (source[openIndex] !== "{") {
    throw new Error("expected a CSS block starting with '{'");
  }
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  throw new Error("unbalanced CSS braces");
}

function slice1MobileControlMediaBlock(css) {
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const queryAt = css.indexOf(SLICE1_MOBILE_MEDIA_QUERY, searchFrom);
    if (queryAt === -1) {
      throw new Error(
        `missing ${SLICE1_MOBILE_MEDIA_QUERY} block beginning with ${SLICE1_MOBILE_BLOCK_START}`,
      );
    }
    const openBrace = css.indexOf("{", queryAt);
    const body = extractBalancedBlock(css, openBrace);
    if (body.trimStart().startsWith(SLICE1_MOBILE_BLOCK_START)) return body;
    searchFrom = openBrace + body.length + 2;
  }
  throw new Error(
    `missing ${SLICE1_MOBILE_MEDIA_QUERY} block beginning with ${SLICE1_MOBILE_BLOCK_START}`,
  );
}

function parseDeclarations(block) {
  const declarations = {};
  for (const part of block.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`invalid CSS declaration: ${trimmed}`);
    }
    declarations[trimmed.slice(0, colon).trim()] = trimmed
      .slice(colon + 1)
      .trim();
  }
  return declarations;
}

function parseMediaRules(block) {
  const rules = [];
  let index = 0;
  const text = block.trim();
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text.startsWith("/*", index)) {
      const commentEnd = text.indexOf("*/", index + 2);
      if (commentEnd === -1) throw new Error("unclosed CSS comment");
      index = commentEnd + 2;
      continue;
    }
    const openBrace = text.indexOf("{", index);
    if (openBrace === -1) {
      throw new Error(`expected a rule in: ${text.slice(index)}`);
    }
    const selectors = text
      .slice(index, openBrace)
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean);
    const closeBrace = openBrace + extractBalancedBlock(text, openBrace).length + 1;
    const declarations = parseDeclarations(text.slice(openBrace + 1, closeBrace));
    for (const selector of selectors) {
      rules.push({ selector, declarations });
    }
    index = closeBrace + 1;
  }
  return rules;
}

function computedContract(declarations) {
  return {
    width: declarations.width ?? null,
    height: declarations.height ?? null,
    "min-width": declarations["min-width"] ?? null,
    "min-height": declarations["min-height"] ?? null,
  };
}

describe("slice 1 mobile control CSS contract", () => {
  test("keeps every scoped 768px control at the 44px target", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rules = parseMediaRules(slice1MobileControlMediaBlock(css));
    const selectors = rules.map((rule) => rule.selector);

    assert.deepEqual(selectors, [
      ...SLICE1_MOBILE_ORDINARY_SELECTORS,
      SLICE1_MOBILE_CHECKBOX_SELECTOR,
    ]);

    for (const rule of rules) {
      const size = computedContract(rule.declarations);
      if (rule.selector === SLICE1_MOBILE_CHECKBOX_SELECTOR) {
        assert.deepEqual(size, {
          width: "44px",
          height: "44px",
          "min-width": "44px",
          "min-height": "44px",
        });
        continue;
      }
      assert.deepEqual(
        { "min-width": size["min-width"], "min-height": size["min-height"] },
        { "min-width": "44px", "min-height": "44px" },
        rule.selector,
      );
    }
  });
});
