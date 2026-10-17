/**
 * Minimal DOM fake for record/activity/person controller tests.
 * Covers only what the new modules touch: querySelector stubbing,
 * listeners + dispatch, closest matching, focus flags, and form elements.
 */

export class FakeNode {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.clicked = false;
    this.selectedOptions = [];
    this.options = [];
    this.listeners = new Map();
    this.queries = new Map();
    this.queryLists = new Map();
    this.closestMap = new Map();
    if (this.tagName === "FORM") {
      const named = new Map();
      this.elements = new Proxy([], {
        get: (target, property, receiver) => {
          if (typeof property !== "string" || property in target) {
            return Reflect.get(target, property, receiver);
          }
          if (!named.has(property)) named.set(property, new FakeNode("input"));
          return named.get(property);
        },
      });
      this.formEntries = [];
    }
  }

  setQuery(selector, element) {
    this.queries.set(selector, element);
    return element;
  }

  setQueryAll(selector, elements) {
    this.queryLists.set(selector, elements);
    return elements;
  }

  querySelector(selector) {
    if (!this.queries.has(selector)) this.queries.set(selector, new FakeNode("div"));
    return this.queries.get(selector);
  }

  querySelectorAll(selector) {
    return this.queryLists.get(selector) || [];
  }

  setClosest(selector, element) {
    this.closestMap.set(selector, element);
    return element;
  }

  closest(selector) {
    return this.closestMap.get(selector) || null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }

  async dispatch(type, event = {}) {
    const target = new FakeNode("button");
    Object.assign(target, event.targetPatch || {});
    for (const [selector, element] of Object.entries(event.closestPatch || {})) {
      target.setClosest(selector, element);
    }
    const normalized = { preventDefault() {}, target, currentTarget: this, ...event, target };
    for (const listener of this.listeners.get(type) || []) await listener(normalized);
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
  }

  reset() {
    if (this.elements) {
      for (const key of Object.keys(this.elements)) {
        if (typeof this.elements[key]?.value === "string") this.elements[key].value = "";
      }
    }
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** api stub: route `${METHOD} ${path}` (or path prefix) to handlers. */
export function createApiStub(routes = {}, calls = []) {
  return async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : undefined });
    const handler = routes[`${method} ${path}`]
      || Object.entries(routes).find(([key]) => key.endsWith("*") && `${method} ${path}`.startsWith(key.slice(0, -1)))?.[1];
    if (!handler) throw new Error(`Unexpected API call: ${method} ${path}`);
    if (typeof handler === "function") return handler({ method, path, body: options.body ? JSON.parse(options.body) : undefined, calls });
    if (handler instanceof Error) throw handler;
    return handler;
  };
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
