export class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(
      String(this.element.className || "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  write(values) {
    this.element.className = [...values].join(" ");
  }

  add(...names) {
    const values = this.values();
    names.forEach((name) => values.add(name));
    this.write(values);
  }

  remove(...names) {
    const values = this.values();
    names.forEach((name) => values.delete(name));
    this.write(values);
  }

  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name);
    else values.delete(name);
    this.write(values);
    return enabled;
  }

  contains(name) {
    return this.values().has(name);
  }
}

function dataProperty(attribute) {
  return attribute
    .slice(5)
    .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesCompound(element, selector) {
  const attributes = [
    ...selector.matchAll(/\[([^\]=]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g),
  ];
  const withoutAttributes = selector.replace(/\[[^\]]+\]/g, "");
  const id = withoutAttributes.match(/#([\w-]+)/)?.[1];
  const classes = [...withoutAttributes.matchAll(/\.([\w-]+)/g)].map(
    (match) => match[1],
  );
  const tag = withoutAttributes.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName !== tag.toUpperCase()) return false;
  if (id && element.id !== id) return false;
  if (classes.some((name) => !element.classList.contains(name))) return false;
  for (const [, name, expected] of attributes) {
    const value = name.startsWith("data-")
      ? element.dataset[dataProperty(name)]
      : (element.getAttribute(name) ?? element[name]);
    if (expected === undefined && value === undefined) return false;
    if (expected !== undefined && String(value) !== expected) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      const compounds = part.split(/\s+/).filter(Boolean);
      if (!matchesCompound(element, compounds.at(-1))) return false;
      let ancestor = element.parentElement;
      for (let index = compounds.length - 2; index >= 0; index -= 1) {
        while (ancestor && !matchesCompound(ancestor, compounds[index])) {
          ancestor = ancestor.parentElement;
        }
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

export class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this._textContent = "";
    this._innerHTML = "";
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.isConnected = true;
    this.removed = false;
    this.focused = false;
    this.ownerDocument = null;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.selectionDirection = "none";
  }

  get textContent() {
    return (
      this._textContent +
      this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
    this._innerHTML = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
    this._textContent = "";
    this.children = [];
  }

  append(...values) {
    for (const value of values) {
      const child =
        value instanceof FakeElement ? value : new FakeTextNode(String(value));
      child.parentElement = this;
      this.children.push(child);
    }
  }

  appendChild(value) {
    this.append(value);
    return value;
  }

  replaceChildren(...values) {
    this.children = [];
    this._textContent = "";
    this._innerHTML = "";
    this.append(...values);
  }

  querySelectorAll(selector) {
    return descendants(this).filter((element) =>
      matchesSelector(element, selector),
    );
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, once: Boolean(options?.once) });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter(
        (item) => item.listener !== listener,
      ),
    );
  }

  async dispatch(type, values = {}) {
    const event = {
      preventDefault() {},
      target: this,
      currentTarget: this,
      ...values,
    };
    const listeners = [...(this.listeners.get(type) || [])];
    for (const item of listeners) {
      await item.listener(event);
      if (item.once) this.removeEventListener(type, item.listener);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name.startsWith("data-"))
      this.dataset[dataProperty(name)] = String(value);
  }

  getAttribute(name) {
    if (this.attributes.has(name)) return this.attributes.get(name);
    if (name === "id") return this.id ?? null;
    return null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[dataProperty(name)];
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    }
    this.parentElement = null;
    this.removed = true;
    this.isConnected = false;
  }

  focus() {
    this.focused = true;
    const owner = this.ownerDocument || globalThis.document;
    if (owner instanceof FakeDocument) owner.activeElement = this;
  }

  blur() {
    this.focused = false;
    const owner = this.ownerDocument || globalThis.document;
    if (owner instanceof FakeDocument && owner.activeElement === this) {
      owner.activeElement = null;
    }
  }

  setSelectionRange(start, end, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  click() {
    return this.dispatch("click");
  }

  scrollIntoView() {}
}

export class FakeTextNode extends FakeElement {
  constructor(value) {
    super("#text");
    this._textContent = value;
  }
}

export class FakeDocument {
  constructor(...roots) {
    this.roots = roots;
    this.created = [];
    this.activeElement = null;
    for (const root of roots) adoptDocument(root, this);
  }

  addRoot(root) {
    this.roots.push(root);
    adoptDocument(root, this);
  }

  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    this.created.push(element);
    return element;
  }

  createTextNode(value) {
    const node = new FakeTextNode(value);
    node.ownerDocument = this;
    return node;
  }

  querySelectorAll(selector) {
    return this.roots
      .flatMap((root) => [root, ...descendants(root)])
      .filter((element) => matchesSelector(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function adoptDocument(root, ownerDocument) {
  if (!(root instanceof FakeElement)) return;
  root.ownerDocument = ownerDocument;
  for (const child of root.children) adoptDocument(child, ownerDocument);
}

export function findByText(root, text, selector = "*") {
  return [root, ...descendants(root)].find(
    (element) =>
      (selector === "*" || element.matches(selector)) &&
      element.textContent.trim() === text,
  );
}

export function findAllByClass(root, className) {
  return [root, ...descendants(root)].filter((element) =>
    element.classList.contains(className),
  );
}

export function nextTicks(count = 2) {
  return new Promise((resolve) => {
    const tick = (remaining) => {
      if (remaining <= 0) resolve();
      else setImmediate(() => tick(remaining - 1));
    };
    tick(count);
  });
}
