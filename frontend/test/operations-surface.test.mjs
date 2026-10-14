import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createAdminSurface } from "../src/surfaces/operations/index.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function apiUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  return query.size ? `${path}?${query}` : path;
}

function jsonBody(entry) {
  return JSON.parse(entry.options.body || "{}");
}

function selectorDataset(selector) {
  const match = selector.match(/\[data-([\w-]+)(?:="([^"]+)")?\]/);
  if (!match) return null;
  return {
    name: match[1].replace(/-([a-z])/g, (_whole, letter) =>
      letter.toUpperCase(),
    ),
    value: match[2] || "",
  };
}

function decorateLazyQueries(element) {
  const lazy = new Map();
  const originalQuery = element.querySelector.bind(element);
  const originalQueryAll = element.querySelectorAll.bind(element);
  element.querySelector = (selector) => {
    const requestedData = selectorDataset(selector);
    const existing = originalQuery(selector);
    if (existing) return existing;
    if (lazy.has(selector)) return lazy.get(selector);
    const tag =
      selector === "h3"
        ? "h3"
        : selector.includes("select")
          ? "select"
          : selector.includes("input")
            ? "input"
            : selector.includes("button") || selector.includes("data-")
              ? "button"
              : "span";
    const created = decorateLazyQueries(new FakeElement(tag));
    const data = requestedData;
    if (data) {
      created.dataset[data.name] = data.value;
    }
    lazy.set(selector, created);
    return created;
  };
  element.querySelectorAll = (selector) => {
    const existing = originalQueryAll(selector);
    if (existing.length) return existing;
    if (lazy.has(`all:${selector}`)) return lazy.get(`all:${selector}`);
    const data = selectorDataset(selector);
    if (!data) return [];
    const expression = new RegExp(
      `data-${data.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="([^"]+)"`,
      "g",
    );
    const matches = [...String(element.innerHTML || "").matchAll(expression)];
    const created = matches.map((match) => {
      const node = decorateLazyQueries(new FakeElement("button"));
      node.dataset[data.name] = match[1];
      return node;
    });
    lazy.set(`all:${selector}`, created);
    return created;
  };
  return element;
}

class OperationsDocument extends FakeDocument {
  createElement(tagName) {
    return decorateLazyQueries(super.createElement(tagName));
  }
}

function honestState(title, detail) {
  const state = new FakeElement("div");
  state.className = "honest-state";
  const heading = new FakeElement("strong");
  heading.textContent = title;
  const description = new FakeElement("p");
  description.textContent = detail;
  state.append(heading, description);
  return state;
}

function createAdminHarness(options = {}) {
  const documentList = new FakeElement("main");
  const document = new OperationsDocument(documentList);
  globalThis.document = document;
  const requests = [];
  const documentRefreshes = [];
  let activeRouteToken = options.routeToken ?? 1;
  const api = createAdminSurface({
    apiUrl,
    buildOperationsWorkModel: () => ({ recurring: { configs: [] } }),
    currentOperatorIdFromPayload: (payload) => payload?.id || "",
    documentList,
    getActiveWorkspaceView: () => options.view || "users",
    getActiveWorkspaceRouteToken: () => activeRouteToken,
    isWorkspaceRouteFresh: (token) =>
      options.isRouteFresh ? options.isRouteFresh(token) : token === activeRouteToken,
    getOperationsQualitySnapshot: () => ({}),
    getOperationsRecurringSnapshot: () => ({}),
    getOperationsWorkSnapshot: () => ({}),
    listDraftPaths: () => [],
    refreshDocuments: async () => documentRefreshes.push("users"),
    renderHonestState: honestState,
    renderSurfaceHeader: (title, description) => {
      const header = new FakeElement("header");
      header.textContent = `${title}: ${description}`;
      return header;
    },
    request: async (url, requestOptions = {}) => {
      const entry = { url, options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : {};
    },
    setRouteTitle() {},
    settledPayload: (result) =>
      result.status === "fulfilled" ? result.value : null,
    showWorkspaceSurface() {},
    surfaceDescription: (surface) => `${surface} surface`,
    usersFromWorkPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.users || [],
    workApiUrl: apiUrl,
  });
  return {
    api,
    document,
    documentList,
    requests,
    documentRefreshes,
    setActiveRouteToken: (value) => {
      activeRouteToken = value;
    },
  };
}

function submitUserForm(root) {
  // The user form submits natively so Enter and the primary button share one
  // path; the test exercises that path rather than a synthetic click.
  const form = findAllByClass(root, "ops-user-form")[0];
  if (!form) throw new Error("User form is not rendered");
  return form.dispatch("submit");
}

function submitDeviceForm(root) {
  const form = findAllByClass(root, "device-form")[0];
  if (!form) throw new Error("Device form is not rendered");
  return form.dispatch("submit");
}

describe("Operations surface boundary", () => {
  test("directly imports production factories and exposes a stable Admin facade", () => {
    assert.deepEqual(Object.keys(createAdminHarness().api).sort(), [
      "refreshUsersSurface",
      "renderAdminSurface",
      "renderAdminSurfaceView",
      "renderUsersSurfaceView",
    ]);
  });

  test("renders Admin diagnostics while preserving success, empty, and failure truth", async () => {
    const harness = createAdminHarness({
      view: "admin",
      request: async (url) => {
        if (url === "/docs/process-quality") {
          return { summary: { total: 0 }, validationErrors: [] };
        }
        if (url === "/knowledge/status") {
          return { ok: true, count: 0, branch: "main" };
        }
        if (url === "/knowledge/publication") throw new Error("History offline");
        return {};
      },
    });
    harness.api.renderAdminSurfaceView([]);
    const pendingDiagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    assert.match(pendingDiagnostics.innerHTML, /Loading local validation/);
    assert.match(pendingDiagnostics.innerHTML, /Loading availability/);
    await nextTicks();
    const diagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    assert.match(diagnostics.innerHTML, /Read-only diagnostics/);
    assert.match(
      diagnostics.querySelector('[data-diagnostic="quality"] span').textContent,
      /0 quality findings; no validation errors/,
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="knowledge-status"] span')
        .textContent,
      "Daily GitHub export is current.",
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="knowledge-publication"] span')
        .textContent,
      "Unavailable: History offline",
    );
  });

  test("retries partial Admin diagnostics from its owning surface", async () => {
    let runs = 0;
    const releases = [];
    const harness = createAdminHarness({
      view: "admin",
      request: async () =>
        new Promise((resolve, reject) => {
          runs += 1;
          releases.push({ resolve, reject });
        }),
    });
    harness.api.renderAdminSurfaceView([]);
    const diagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    const summary = diagnostics.querySelector(
      ".ops-admin-diagnostics-summary",
    );
    const retry = diagnostics.querySelector(".surface-summary-retry");

    assert.equal(runs, 3);
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
    for (const { reject } of releases.splice(0))
      reject(new Error("Synthetic diagnostics outage"));
    await nextTicks(3);

    assert.equal(summary.dataset.summaryState, "unavailable");
    assert.equal(summary.getAttribute("role"), "alert");
    assert.equal(summary.getAttribute("aria-live"), "assertive");
    assert.match(summary.textContent, /0 of 3 read-only diagnostics answered/);
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(retry.getAttribute("aria-busy"), null);

    const retrying = retry.click();
    assert.equal(runs, 6);
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.match(retry.textContent, /Retrying diagnostics/);
    for (const [index, release] of releases.entries()) {
      if (index === 0)
        release.resolve({ summary: { total: 0 }, validationErrors: [] });
      else if (index === 1)
        release.resolve({ ok: true, count: 0, branch: "main" });
      else release.resolve({ commits: [{ hash: "abc" }] });
    }
    await nextTicks(4);

    assert.equal(summary.dataset.summaryState, "ready");
    assert.equal(summary.getAttribute("role"), "status");
    assert.equal(summary.getAttribute("aria-live"), "polite");
    // All three answered: the answers speak for themselves, no mechanics
    // sentence is shown.
    assert.equal(summary.hidden, true);
    assert.equal(summary.textContent, "");
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
  });

  test("reports Users load state, durable success, and row failure in the Users surface", async () => {
    let mode = "ok";
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method) {
          if (mode === "down") throw new Error("Synthetic route failure (503)");
          return { users };
        }
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users/grace" && requestOptions.method === "PATCH") {
          if (mode === "patch-fails") {
            throw new Error("Synthetic route failure (503)");
          }
          return {};
        }
        return {};
      },
    });

    harness.api.renderUsersSurfaceView();
    const loading = harness.documentList.querySelector(".surface-summary");
    assert.equal(loading.dataset.summaryState, "loading");
    assert.equal(loading.dataset.summaryId, "users");

    mode = "down";
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const outage = harness.documentList.querySelector(".surface-summary");
    assert.equal(outage.dataset.summaryState, "unavailable");
    assert.equal(
      outage.querySelector(".surface-summary-line").getAttribute("role"),
      "alert",
    );
    assert.equal(
      outage.querySelector(".surface-summary-detail").textContent,
      "Synthetic route failure (503)",
    );

    mode = "ok";
    await outage.querySelector(".surface-summary-retry").dispatch("click");
    await nextTicks();
    harness.api.renderUsersSurfaceView();
    const ready = harness.documentList.querySelector(".surface-summary");
    assert.equal(ready.dataset.summaryState, "ready");
    assert.match(ready.textContent, /2 users\./);

    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const disable = findByText(graceRow, "Disable", "button");
    await disable.click();
    await nextTicks();
    harness.api.renderUsersSurfaceView();
    const outcome = harness.documentList.querySelector(".ops-users-outcome");
    assert.equal(outcome.getAttribute("role"), "status");
    assert.match(outcome.textContent, /Grace is now disabled\./);
    assert.equal(outcome.focused, true);

    harness.api.renderUsersSurfaceView();
    assert.equal(
      harness.documentList.querySelector(".ops-users-outcome"),
      null,
      "the confirmation is shown once against the refreshed list",
    );

    mode = "patch-fails";
    const retryRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    await findByText(retryRow, "Disable", "button").click();
    await nextTicks(3);
    harness.api.renderUsersSurfaceView();
    const rowError = harness.documentList.querySelector(".ops-user-row-error");
    assert.equal(rowError.getAttribute("role"), "alert");
    assert.match(rowError.textContent, /Could not disable this account/);
    assert.match(rowError.textContent, /Select Disable to retry/);
  });

  test("confirms a saved user against the refreshed list", async () => {
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && requestOptions.method === "POST") {
          users.push({
            id: "synthetic-user",
            name: "Synthetic User",
            email: "synthetic-user@datatalks.club",
            role: "operator",
          });
          return { user: users.at(-1) };
        }
        if (url === "/api/users" && !requestOptions.method) return { users };
        if (url === "/api/me") return { id: "alexey" };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const addUser = findByText(harness.documentList, "Add user", "button");
    assert.equal(addUser.parentElement.className, "dk-page-header__actions");
    assert.equal(addUser.className, "primary-button");
    await addUser.click();
    const inputs = harness.documentList.querySelectorAll("input");
    inputs[0].value = "Synthetic User";
    inputs[1].value = "synthetic-user@datatalks.club";
    await submitUserForm(harness.documentList);
    await nextTicks(3);
    harness.api.renderUsersSurfaceView();

    const outcome = harness.documentList.querySelector(".ops-users-outcome");
    assert.equal(outcome.getAttribute("role"), "status");
    assert.match(outcome.textContent, /Synthetic User added\./);
    assert.equal(outcome.focused, true);
    assert.match(
      harness.documentList.textContent,
      /synthetic-user@datatalks.club/,
    );
  });

  test("refreshes a stale successful User mutation without replacing the current view", async () => {
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    let releasePatch;
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method)
          return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users/grace" && requestOptions.method === "PATCH") {
          return new Promise((resolve) => {
            releasePatch = () => {
              users[1] = { ...users[1], disabled: true };
              resolve({});
            };
          });
        }
        return {};
      },
    });

    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const disable = findByText(graceRow, "Disable", "button");

    const mutation = disable.click();
    assert.equal(disable.disabled, true);
    harness.setActiveRouteToken(2);
    releasePatch();
    await mutation;
    await nextTicks(3);

    const mutationIndex = harness.requests.findIndex(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH",
    );
    assert.equal(mutationIndex, 2);
    assert.deepEqual(
      harness.requests.slice(mutationIndex + 1).map((entry) => entry.url),
      ["/api/users", "/api/me"],
      "a stale success refreshes the authoritative Users snapshot",
    );
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(disable.isConnected, true);
    assert.equal(disable.disabled, true);

    harness.api.renderUsersSurfaceView();
    assert.equal(
      findAllByClass(harness.documentList, "ops-user-row")
        .find((row) => row.textContent.includes("Grace"))
        ?.textContent.includes("disabled"),
      true,
    );
    assert.equal(
      harness.documentList.querySelector(".ops-users-outcome"),
      null,
      "a stale route does not inherit this mutation's confirmation",
    );
  });

  test("refreshes authoritative User data before rendering a conflict Cancel", async () => {
    let users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method)
          return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (
          url === "/api/users/grace" &&
          requestOptions.method === "PATCH"
        ) {
          users[1] = { ...users[1], role: "admin" };
          const error = new Error("Account changed elsewhere");
          error.status = 409;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const inputsBeforeEdit = harness.document.created.filter(
      (element) => element.tagName === "INPUT",
    ).length;
    await findByText(graceRow, "Edit", "button").click();
    const editInputs = harness.document.created
      .filter((element) => element.tagName === "INPUT")
      .slice(inputsBeforeEdit);
    assert.equal(editInputs.length, 1, "only the name is an editable input");
    assert.equal(
      findAllByClass(harness.documentList, "ops-field-static")[0].textContent,
      "grace@datatalks.club",
    );
    const roleSelect = harness.document.created
      .filter((element) => element.tagName === "SELECT")
      .at(-1);
    roleSelect.value = "admin";
    await submitUserForm(harness.documentList);
    await nextTicks();

    const feedback = harness.documentList.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "conflict");
    assert.match(
      feedback.textContent,
      /Cancel to discard these changes and reload users/,
    );

    const mutationIndex = harness.requests.length - 1;
    await findByText(harness.documentList, "Cancel", "button").click();
    await nextTicks(3);
    assert.deepEqual(
      harness.requests.slice(mutationIndex + 1).map(({ url }) => url),
      ["/api/users", "/api/me"],
      "Cancel reads the account again instead of trusting stale form state",
    );
    assert.equal(findByText(harness.documentList, "Save changes", "button"), undefined);
    assert.match(
      findAllByClass(harness.documentList, "surface-summary")[0].textContent,
      /2 users\./,
    );
  });

  test("enforces Users admin denial, then validates create/edit/disable role controls", async () => {
    let users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "operator",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method) return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users" && requestOptions.method === "POST") return {};
        if (url === "/api/users/grace" && requestOptions.method === "PATCH")
          return {};
        return {};
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    assert.equal(
      findByText(harness.documentList, "Add user", "button"),
      undefined,
    );
    assert.equal(findByText(harness.documentList, "Edit", "button"), undefined);

    users = users.map((user) =>
      user.id === "alexey" ? { ...user, role: "admin" } : user,
    );
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    await findByText(harness.documentList, "Add user", "button").click();
    let create = findByText(harness.documentList, "Create user", "button");
    await submitUserForm(harness.documentList);
    const validation = findAllByClass(harness.documentList, "field-error").filter(
      (node) => !node.hidden,
    );
    assert.deepEqual(
      validation.map((node) => node.textContent),
      ["Name is required.", "Email is required."],
    );
    const inputs = harness.document.created.filter(
      (element) => element.tagName === "INPUT",
    );
    const [name, email] = inputs.slice(-2);
    assert.equal(
      inputs.some((input) => input.type === "password"),
      false,
      "sign-in is through SSO, so the form has no password field",
    );
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.equal(name.focused, true, "focus moves to the first invalid field");
    name.value = "Valeriia";
    email.value = "valeriia@datatalks.club";
    await submitUserForm(harness.documentList);
    const created = harness.requests.find(
      (entry) => entry.url === "/api/users" && entry.options.method === "POST",
    );
    assert.deepEqual(jsonBody(created), {
      name: "Valeriia",
      email: "valeriia@datatalks.club",
      role: "operator",
    });

    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const inputsBeforeEdit = harness.document.created.filter(
      (element) => element.tagName === "INPUT",
    ).length;
    await findByText(graceRow, "Edit", "button").click();
    const editInputs = harness.document.created
      .filter((element) => element.tagName === "INPUT")
      .slice(inputsBeforeEdit);
    assert.equal(editInputs.length, 1, "only the name is an editable input");
    assert.equal(
      findAllByClass(harness.documentList, "ops-field-static")[0].textContent,
      "grace@datatalks.club",
    );
    const roleSelect = harness.document.created
      .filter((element) => element.tagName === "SELECT")
      .at(-1);
    roleSelect.value = "admin";
    await submitUserForm(harness.documentList);
    const edited = harness.requests.find(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH" &&
        jsonBody(entry).role === "admin",
    );
    assert.deepEqual(jsonBody(edited), {
      name: "Grace",
      role: "admin",
    });

    harness.api.renderUsersSurfaceView();
    const refreshedGraceRow = findAllByClass(
      harness.documentList,
      "ops-user-row",
    ).find((row) => row.textContent.includes("Grace"));
    await findByText(refreshedGraceRow, "Disable", "button").click();
    const disabled = harness.requests.find(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH" &&
        jsonBody(entry).disabled === true,
    );
    assert.deepEqual(jsonBody(disabled), { disabled: true });
  });
});
