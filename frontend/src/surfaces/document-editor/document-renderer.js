import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";

export function createDocumentRenderer(context, services, editorState) {
  const {
    apiUrl, basename, documentState, documentTitle, editor, editorView,
    fetchBacklinksForCurrentDoc, renderGithubRawFooter, renderLoomBlock,
    renderRelatedDocsBlock, renderWarningsBlock, renderedView, request,
    setRouteTitle, viewToggleButton,
  } = context;
  const {
    appendProcedureChildren, attachInlineEditor, escapeRegex, makeAttrRow,
    patchSectionInMarkdown, renderMarkdown, storeDraft, stripFrontmatter,
    resizeDocumentTitle, setMarkdownTitle, stripLeadingHeading, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);

  const DOC_TYPES = [
    "sop", "checklist", "template", "reference", "playbook", "prompt",
  ];

  function toggleViewMode() {
    if (!documentState.currentDoc) return;
    enterRenderedMode();
  }

  async function enterRenderedMode() {
    const path = documentState.currentDoc?.path;
    const isFresh = editorMutationGuard(context);
    editorView.dataset.mode = "rendered";
    viewToggleButton.hidden = true;
    // If the user edited in raw mode without saving, re-parse the current
    // textarea content so the block view reflects the latest draft.
    if (documentState.currentDoc && editor.value && editor.value !== documentState.lastSavedContent) {
      await reparseEditorContent();
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
    }
    renderParsedDocument();
  }

  async function reparseEditorContent() {
    const path = documentState.currentDoc?.path;
    const isFresh = editorMutationGuard(context);
    try {
      const payload = await request(apiUrl("/parse"), {
        method: "POST",
        body: JSON.stringify({ content: editor.value }),
      });
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      if (payload.parsed) documentState.currentParsed = payload.parsed;
    } catch {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
    }
  }

  function exitRenderedMode() {
    editorView.dataset.mode = "raw";
    viewToggleButton.hidden = true;
    renderedView.replaceChildren();
    resizeDocumentTitle();
  }

  function updateViewToggleAvailability() {
    // Show the toggle for any open doc — structured SOPs render as blocks,
    // others render the full body as plain markdown.
    const available = !!documentState.currentDoc;
    viewToggleButton.hidden = true;
    if (available && editorView.dataset.mode !== "rendered") enterRenderedMode();
  }

  async function refreshParsedFromApi() {
    if (!documentState.currentDoc) return;
    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    try {
      const url = apiUrl("/docs");
      url.searchParams.set("path", path);
      const payload = await request(url);
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      documentState.currentParsed = payload.parsed || null;
      updateViewToggleAvailability();
    } catch {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      documentState.currentParsed = null;
    }
  }

  function renderParsedDocument() {
    const sections = (documentState.currentParsed && documentState.currentParsed.sections) || {};
    const blocks = [];
    const fm = (documentState.currentParsed && documentState.currentParsed.frontmatter) || {};
    const loomBlock = renderLoomBlock(fm);
    blocks.push(renderTitleBlock(fm));
    blocks.push(renderFrontmatterBlock(fm));
    blocks.push(renderRelatedDocsBlock(fm));
    blocks.push(renderWarningsBlock());
    if (Object.keys(sections).length === 0) {
      // Plain markdown (template, reference, etc.) — render the body as one
      // big rendered block, no editing controls.
      const body = stripFrontmatter(editor.value || "");
      const wrap = document.createElement("div");
      wrap.className = "block-plain-body";
      wrap.append(renderMarkdown(stripLeadingHeading(body)));
      blocks.push(wrap);
      blocks.push(loomBlock);
      blocks.push(renderGithubRawFooter(editorState.githubBase, editorState.gitBranch));
      renderedView.replaceChildren(...blocks.filter(Boolean));
      return;
    }

    const order = [
      "summary",
      "prerequisites",
      "procedure",
      "validation",
      "troubleshooting",
      "references",
    ];
    const seen = new Set();
    for (const name of order) {
      if (sections[name]) {
        blocks.push(renderSectionBlock(name, sections[name]));
        seen.add(name);
      }
    }
    for (const [name, sec] of Object.entries(sections)) {
      if (seen.has(name)) continue;
      blocks.push(renderSectionBlock(name, sec));
    }

    const backlinksHost = document.createElement("section");
    backlinksHost.className = "block-backlinks";
    backlinksHost.id = "backlinks-host";
    blocks.push(backlinksHost);
    blocks.push(loomBlock);
    blocks.push(renderGithubRawFooter(editorState.githubBase, editorState.gitBranch));

    renderedView.replaceChildren(...blocks.filter(Boolean));
    // Async-fetch backlinks separately so the main render isn't blocked.
    fetchBacklinksForCurrentDoc();
  }

  function emptyNote(text) {
    const div = document.createElement("div");
    div.className = "rendered-empty";
    div.textContent = text;
    return div;
  }

  function renderTitleBlock(fm) {
    const wrap = document.createElement("div");
    wrap.className = "block-title-wrap";
    const h1 = document.createElement("h1");
    h1.className = "block-title";
    h1.textContent =
      fm.title || (documentState.currentDoc ? basename(documentState.currentDoc.path) : "Untitled");
    attachInlineEditor(h1, {
      getValue: () => fm.title || "",
      commit: (value) => applyTitleEdit(fm, value),
      restore: () => {
        h1.textContent =
          fm.title || (documentState.currentDoc ? basename(documentState.currentDoc.path) : "Untitled");
      },
      multiline: true,
      singleLine: true,
      autoSize: true,
      commitOnEnter: true,
      editorClass: "block-title-editor",
      showHint: false,
    });
    wrap.append(h1);
    const stats = computeDocStats();
    if (stats) {
      const meta = document.createElement("div");
      meta.className = "block-title-stats";
      meta.textContent = stats;
      wrap.append(meta);
    }
    return wrap;
  }

  function computeDocStats() {
    if (!documentState.currentParsed) return "";
    const proc = documentState.currentParsed.sections?.procedure;
    if (!proc || proc.raw) return "";
    let steps = 0;
    let groups = (proc.groups || []).length;
    let shots = 0;
    for (const g of proc.groups || []) {
      steps += (g.steps || []).length;
      for (const s of g.steps || []) shots += (s.screenshots || []).length;
    }
    for (const s of proc.flat_steps || []) {
      steps += 1;
      shots += (s.screenshots || []).length;
    }
    const parts = [];
    if (steps) parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
    if (groups) parts.push(`${groups} group${groups === 1 ? "" : "s"}`);
    if (shots) parts.push(`${shots} screenshot${shots === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  function applyTitleEdit(fm, newTitle) {
    const title = newTitle.trim();
    if (!title) return;
    fm.title = title;
    // Update frontmatter scalar and body H1.
    let next = patchFrontmatterScalar(editor.value, "title", title, {
      quoted: true,
    });
    next = setMarkdownTitle(next, title);
    editor.value = next;
    if (documentState.currentDoc) {
      documentTitle.value = title;
      resizeDocumentTitle();
      setRouteTitle(title);
    }
    storeDraft();
    updateSaveState();
  }

  function renderFrontmatterBlock(fm) {
    if (!fm) fm = {};
    const wrap = document.createElement("div");
    wrap.className = "fm-block";

    const row = document.createElement("div");
    row.className = "fm-row";

    if (fm.doc_type) row.append(pill("type", fm.doc_type));
    if (Array.isArray(fm.systems)) {
      for (const s of fm.systems) row.append(pill("system", s));
    }
    if (Array.isArray(fm.tags)) {
      for (const t of fm.tags) row.append(pill("tag", t));
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "fm-edit";
    editBtn.textContent = row.children.length ? "Edit" : "+ Metadata";
    editBtn.title = "Edit doc metadata";
    editBtn.addEventListener("click", () => toggleFrontmatterEditor(wrap, fm));
    row.append(editBtn);

    wrap.append(row);
    return wrap;
  }

  function toggleFrontmatterEditor(wrap, fm) {
    const existing = wrap.querySelector(".fm-editor");
    if (existing) {
      existing.remove();
      return;
    }
    const editor = document.createElement("form");
    editor.className = "fm-editor";

    const docTypeRow = makeAttrRow("Doc type");
    const sel = document.createElement("select");
    sel.innerHTML = DOC_TYPES.map(
      (t) =>
        `<option value="${t}"${t === fm.doc_type ? " selected" : ""}>${t}</option>`,
    ).join("");
    docTypeRow.append(sel);
    editor.append(docTypeRow);

    const summaryRow = makeAttrRow("Summary");
    const sumInput = document.createElement("textarea");
    sumInput.rows = 2;
    sumInput.value = fm.summary || "";
    summaryRow.append(sumInput);
    editor.append(summaryRow);

    const tagsRow = makeAttrRow("Tags");
    const tagsEditor = makeChipListEditor(
      Array.isArray(fm.tags) ? fm.tags.slice() : [],
    );
    tagsRow.append(tagsEditor.element);
    editor.append(tagsRow);

    const systemsRow = makeAttrRow("Systems");
    const systemsEditor = makeChipListEditor(
      Array.isArray(fm.systems) ? fm.systems.slice() : [],
    );
    systemsRow.append(systemsEditor.element);
    editor.append(systemsRow);

    const actionsRow = document.createElement("div");
    actionsRow.className = "block-step-attr-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet-button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => editor.remove());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "Apply";
    actionsRow.append(cancel, save);
    editor.append(actionsRow);

    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const updates = {
        doc_type: sel.value,
        summary: sumInput.value.trim(),
        tags: tagsEditor.getValues(),
        systems: systemsEditor.getValues(),
      };
      applyFrontmatterEdit(fm, updates);
      editor.remove();
    });

    wrap.append(editor);
  }

  function makeChipListEditor(initial) {
    const wrap = document.createElement("div");
    wrap.className = "fm-chips-editor";
    const chips = [...initial];

    const render = () => {
      wrap.replaceChildren();
      for (let i = 0; i < chips.length; i++) {
        const chip = document.createElement("span");
        chip.className = "fm-chip";
        chip.textContent = chips[i];
        const x = document.createElement("button");
        x.type = "button";
        x.className = "fm-chip-x";
        x.textContent = "×";
        x.addEventListener("click", () => {
          chips.splice(i, 1);
          render();
        });
        chip.append(x);
        wrap.append(chip);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.className = "fm-chip-input";
      input.placeholder = "+ Add";
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          const v = input.value.trim().replace(/,$/, "");
          if (v) {
            chips.push(v);
            render();
            // Refocus the (new) input element.
            wrap.querySelector(".fm-chip-input")?.focus();
          }
        } else if (event.key === "Backspace" && !input.value && chips.length) {
          chips.pop();
          render();
          wrap.querySelector(".fm-chip-input")?.focus();
        }
      });
      wrap.append(input);
    };
    render();
    return { element: wrap, getValues: () => chips.slice() };
  }

  function applyFrontmatterEdit(fm, updates) {
    let next = editor.value;
    next = patchFrontmatterScalar(next, "doc_type", updates.doc_type);
    next = patchFrontmatterScalar(next, "summary", updates.summary, {
      quoted: true,
    });
    next = patchFrontmatterList(next, "tags", updates.tags);
    next = patchFrontmatterList(next, "systems", updates.systems);
    editor.value = next;
    if (documentState.currentParsed && documentState.currentParsed.frontmatter) {
      Object.assign(documentState.currentParsed.frontmatter, {
        doc_type: updates.doc_type,
        summary: updates.summary,
        tags: updates.tags,
        systems: updates.systems,
      });
    }
    storeDraft();
    updateSaveState();
    renderParsedDocument();
  }

  function _frontmatterRange(markdown) {
    if (!markdown.startsWith("---\n")) return null;
    const end = markdown.indexOf("\n---\n", 4);
    if (end === -1) return null;
    return { start: 4, end };
  }

  function patchFrontmatterScalar(markdown, key, value, options = {}) {
    const range = _frontmatterRange(markdown);
    if (!range) return markdown;
    const body = markdown.slice(range.start, range.end);
    const before = markdown.slice(0, range.start);
    const after = markdown.slice(range.end);
    const re = new RegExp(`^${escapeRegex(key)}:\\s*.*$`, "m");
    const formatted = options.quoted
      ? `${key}: "${(value || "").replace(/"/g, '\\"')}"`
      : `${key}: ${value}`;
    if (re.test(body)) {
      return before + body.replace(re, formatted) + after;
    }
    // Insert at end of frontmatter.
    const trimmed = body.endsWith("\n") ? body : body + "\n";
    return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
  }

  function patchFrontmatterList(markdown, key, items) {
    const range = _frontmatterRange(markdown);
    if (!range) return markdown;
    const before = markdown.slice(0, range.start);
    const body = markdown.slice(range.start, range.end);
    const after = markdown.slice(range.end);

    // Match either `key: [...]` inline OR `key:\n  - item\n  - item`.
    const blockRe = new RegExp(
      `^${escapeRegex(key)}:[\\t ]*(?:\\[[^\\]]*\\])?(?:\\n[\\t ]+-[^\\n]*)*`,
      "m",
    );
    const formatted =
      items && items.length
        ? `${key}:\n` +
          items.map((v) => `  - ${JSON.stringify(String(v))}`).join("\n")
        : `${key}: []`;
    if (blockRe.test(body)) {
      return before + body.replace(blockRe, formatted) + after;
    }
    const trimmed = body.endsWith("\n") ? body : body + "\n";
    return before + trimmed + formatted + "\n" + after.replace(/^\n?/, "");
  }

  function pill(kind, text) {
    const span = document.createElement("span");
    span.className = `fm-pill fm-pill-${kind}`;
    span.textContent = text;
    return span;
  }

  function renderSectionBlock(name, section) {
    const block = document.createElement("section");
    block.className = "block-section";
    block.dataset.section = name;

    const header = document.createElement("header");
    header.className = "block-section-header";
    const label = document.createElement("span");
    label.className = "block-section-label";
    label.textContent = "Section";
    const title = document.createElement("h2");
    title.textContent =
      headingFromBody(section.body_md) || humanSectionName(name);
    attachInlineEditor(title, {
      getValue: () => headingFromBody(section.body_md) || humanSectionName(name),
      commit: (value) => applySectionHeadingEdit(name, section, value),
      restore: () => {
        title.textContent =
          headingFromBody(section.body_md) || humanSectionName(name);
      },
      multiline: false,
      editorClass: "block-section-title-editor",
    });
    header.append(label, title);
    block.append(header);

    const body = document.createElement("div");
    body.className = "block-section-body";

    if (name === "procedure" && section.raw === false) {
      appendProcedureChildren(body, section);
    } else if (section.raw === true) {
      body.append(renderMarkdown(section.body_md || ""));
      body.classList.add("is-raw");
      attachInlineEditor(body, {
        getValue: () => section.body_md || "",
        commit: (value) => applySectionBodyEdit(name, section, value, true),
        restore: () => {
          body.replaceChildren(renderMarkdown(section.body_md || ""));
          body.classList.add("is-raw");
        },
        multiline: true,
      });
    } else {
      body.append(renderMarkdown(stripLeadingHeading(section.body_md || "")));
      attachInlineEditor(body, {
        getValue: () => stripLeadingHeading(section.body_md || ""),
        commit: (value) => applySectionBodyEdit(name, section, value, false),
        restore: () =>
          body.replaceChildren(
            renderMarkdown(stripLeadingHeading(section.body_md || "")),
          ),
        multiline: true,
      });
    }

    block.append(body);
    return block;
  }

  function headingFromBody(bodyMd) {
    if (!bodyMd) return "";
    const m = bodyMd.match(/^##\s+(.+)$/m);
    return m ? m[1].trim() : "";
  }

  function applySectionHeadingEdit(name, section, newHeading) {
    const heading = newHeading.trim() || humanSectionName(name);
    const restOfBody = stripLeadingHeading(section.body_md || "");
    section.body_md = `## ${heading}\n\n${restOfBody}`.replace(/\n+$/, "");
    const updated = patchSectionInMarkdown(editor.value, name, section.body_md);
    if (updated == null) {
      showFeedback(`Could not locate section ${name}; heading not saved.`, {
        kind: "error",
      });
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function applySectionBodyEdit(name, section, newBody, isRaw) {
    // Reconstruct the body_md for the section (with the visible heading on top
    // for non-raw sections; raw sections are opaque).
    let combined;
    if (isRaw) {
      combined = newBody;
    } else {
      const heading = `## ${humanSectionName(name)}`;
      const trimmed = newBody.replace(/^\n+/, "");
      combined = `${heading}\n\n${trimmed}`;
    }
    section.body_md = combined;

    const updated = patchSectionInMarkdown(editor.value, name, combined);
    if (updated == null) {
      showFeedback(`Could not locate section ${name}; edit not saved.`, {
        kind: "error",
      });
      return;
    }
    editor.value = updated;
    storeDraft();
    updateSaveState();
  }

  function humanSectionName(name) {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }


  return {
    emptyNote, enterRenderedMode, humanSectionName, patchFrontmatterList,
    patchFrontmatterScalar, pill, refreshParsedFromApi,
    renderParsedDocument, renderSectionBlock, toggleViewMode,
    updateViewToggleAvailability,
  };
}
