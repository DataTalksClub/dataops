import { highlightCode, languageForName } from "../../core/code-highlight.js";

/**
 * Gist-style renderer for a parsed code view (`GET /docs` →
 * `parsed_code_view`): named file blocks in author order, each highlighted and
 * copyable, with the author's markdown interleaved between them and a file
 * navigation row. Read-only — nothing here executes code; Copy copies the
 * exact code bytes.
 */
export function createCodeViewSurface(context) {
  const { clipboard } = context;

  function renderCodeView(container, parsed, options = {}) {
    const doc = container.ownerDocument || globalThis.document;
    const renderMarkdown = options.renderMarkdown || null;
    const copy = options.clipboard || clipboard || globalThis.navigator?.clipboard || null;

    container.classList.add("code-view");
    container.replaceChildren();

    const nav = doc.createElement("nav");
    nav.className = "code-view-nav";
    const navLabel = doc.createElement("span");
    navLabel.className = "code-view-nav-label";
    navLabel.textContent = "Files";
    nav.append(navLabel);
    for (const file of parsed.files) {
      const chip = doc.createElement("a");
      chip.className = "code-view-nav-chip";
      chip.setAttribute("href", `#${file.anchor}`);
      chip.textContent = file.name;
      nav.append(chip);
    }
    container.append(nav);

    for (const block of parsed.blocks) {
      if (block.kind === "markdown") {
        container.append(renderMarkdownBlock(doc, block, renderMarkdown));
      } else {
        container.append(renderFileBlock(doc, block, copy));
      }
    }
    return container;
  }

  function renderMarkdownBlock(doc, block, renderMarkdown) {
    const note = doc.createElement("div");
    note.className = "code-note";
    note.setAttribute("id", block.anchor);
    if (block.heading) {
      const heading = doc.createElement("h3");
      heading.className = "code-note-heading";
      heading.textContent = block.heading;
      note.append(heading);
    }
    const body = doc.createElement("div");
    body.className = "code-note-body";
    if (renderMarkdown) {
      const rendered = renderMarkdown(block.body_md || "");
      if (Array.isArray(rendered)) body.append(...rendered);
      else body.append(rendered);
    } else {
      body.textContent = block.body_md || "";
    }
    note.append(body);
    return note;
  }

  function renderFileBlock(doc, block, copy) {
    const section = doc.createElement("section");
    section.className = "code-file";
    section.setAttribute("id", block.anchor);

    const header = doc.createElement("div");
    header.className = "code-file-header";
    const name = doc.createElement("code");
    name.className = "code-file-name";
    name.textContent = block.name;
    const language = block.language || languageForName(block.name) || "text";
    const chip = doc.createElement("span");
    chip.className = "code-file-lang";
    chip.textContent = language;
    const copyButton = doc.createElement("button");
    copyButton.type = "button";
    copyButton.className = "code-copy quiet-button";
    copyButton.textContent = "Copy";
    copyButton.setAttribute("aria-label", `Copy ${block.name}`);
    copyButton.addEventListener("click", () => copyFile(copyButton, block, copy));
    header.append(name, chip, copyButton);

    const pre = doc.createElement("pre");
    pre.className = "code-file-code";
    const code = doc.createElement("code");
    code.className = `language-${language}`;
    const highlighted = highlightCode(block.code, language, doc);
    code.append(...highlighted.children);
    pre.append(code);

    section.append(header, pre);
    return section;
  }

  async function copyFile(button, block, copy) {
    if (!copy || typeof copy.writeText !== "function") {
      button.textContent = "Copy n/a";
      return;
    }
    try {
      await copy.writeText(block.code);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    const timer = setTimeout(() => {
      button.textContent = "Copy";
    }, 1500);
    if (typeof timer.unref === "function") timer.unref();
  }

  return { renderCodeView };
}
