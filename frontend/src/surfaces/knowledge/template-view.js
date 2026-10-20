import { parseTemplatePlaceholders, templateTokens } from "../../template-placeholders.js";

let panelSequence = 0;

/** Read-only preview. Clipboard content always comes from the parser, never the DOM. */
export function createTemplateViewSurface({ clipboard } = {}) {
  function renderTemplateView(container, markdown, { renderMarkdown } = {}) {
    const parsed = parseTemplatePlaceholders(markdown);
    if (!parsed.variants.length) return false;
    const doc = container.ownerDocument || globalThis.document;
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    container.classList.add("template-view");
    container.replaceChildren(make("p", "template-view-hint", "Select a placeholder to see what to put there. Copy keeps the placeholders for you to replace."));
    const definitions = new Map(parsed.placeholders.map((entry) => [entry.name, entry]));
    for (const variant of parsed.variants) container.append(renderVariant(variant, definitions, make, doc, parsed.variants.length > 1));
    if (parsed.issues.length) {
      const warning = make("div", "template-view-warning", `Check this template: ${parsed.issues.map((issue) => issue.message).join(" ")}`);
      warning.setAttribute("role", "alert");
      container.append(warning);
    }
    if (renderMarkdown) {
      const source = make("details", "template-document");
      source.append(make("summary", "", "Full document and sending instructions"));
      const rendered = renderMarkdown(markdown);
      if (Array.isArray(rendered)) source.append(...rendered);
      else source.append(rendered);
      container.append(source);
    }
    return true;
  }

  function renderVariant(variant, definitions, make, doc, multiple) {
    const section = make("section", "template-variant");
    const header = make("div", "template-view-header");
    const title = make("h2", "template-view-heading", variant.label);
    const copy = make("button", "quiet-button", multiple ? `Copy ${variant.label}` : "Copy template");
    copy.type = "button";
    const status = make("span", "template-copy-status");
    status.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        const target = clipboard || globalThis.navigator?.clipboard;
        if (!target?.writeText) throw new Error("Clipboard unavailable");
        await target.writeText(variant.body);
        status.textContent = "Template copied";
      } catch {
        status.textContent = "Copy failed. Select the template text to copy it.";
      }
    });
    header.append(title, copy, status);
    const layout = make("div", "template-view-layout");
    const body = make("pre", "template-view-body");
    body.setAttribute("aria-label", multiple ? `${variant.label} body` : "Template body");
    const panel = make("aside", "template-placeholder-panel");
    panel.setAttribute("id", `template-placeholder-panel-${++panelSequence}`);
    panel.setAttribute("aria-label", multiple ? `${variant.label} placeholder details` : "Placeholder details");
    panel.setAttribute("aria-live", "polite");
    const show = (entry, token) => {
      panel.replaceChildren(
        make("h3", "template-placeholder-name", token),
        make("p", "", entry?.description || "No description provided. Check the document before using this placeholder."),
      );
      if (entry?.example) panel.append(make("h4", "template-example-label", "Example"), make("p", "template-placeholder-example", entry.example));
    };
    panel.append(make("p", "", "Placeholder explanations and examples appear here."));
    const tokens = new Set(templateTokens(variant.body));
    const textNode = (value) => (typeof doc.createTextNode === "function" ? doc.createTextNode(value) : value);
    let offset = 0;
    for (const match of variant.body.matchAll(/<[A-Z][A-Z0-9_]*>/g)) {
      if (!tokens.has(match[0])) continue;
      const entry = definitions.get(match[0]);
      body.append(textNode(variant.body.slice(offset, match.index)));
      const chip = make("button", "template-placeholder-chip", match[0]);
      chip.type = "button";
      chip.setAttribute("aria-label", `Explain ${match[0]}`);
      chip.setAttribute("aria-controls", panel.getAttribute("id"));
      chip.setAttribute("title", entry ? `${entry.description}\nExample: ${entry.example}` : "No description provided");
      chip.addEventListener("click", () => show(entry, match[0]));
      chip.addEventListener("focus", () => show(entry, match[0]));
      body.append(chip);
      offset = match.index + match[0].length;
    }
    body.append(textNode(variant.body.slice(offset)));
    layout.append(body, panel);
    section.append(header, layout);
    return section;
  }
  return { renderTemplateView };
}
