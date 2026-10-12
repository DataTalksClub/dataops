import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";
import {
  createBlockEditor,
  parseMarkdownBlocks,
  serializeBlocksToMarkdown,
} from "./block-editor.js";

export function createDocumentRenderer(context, services) {
  const {
    apiUrl, basename, documentState, documentTitle, editor, editorView,
    fetchBacklinksForCurrentDoc, renderLoomBlock,
    renderRelatedDocsBlock, renderWarningsBlock, renderedView, request,
    setRouteTitle, viewToggleButton,
  } = context;
  const {
    appendProcedureChildren, attachInlineEditor, escapeRegex, makeAttrRow,
    patchSectionInMarkdown, renderMarkdown, storeDraft, stripFrontmatter,
    resizeDocumentTitle, setMarkdownTitle, stripLeadingHeading, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);
  const blockEditor = createBlockEditor(context, services);

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

  function renderParsedDocument({ bodyBlocks, focusBlockIndex = -1 } = {}) {
    const sections = (documentState.currentParsed && documentState.currentParsed.sections) || {};
    const blocks = [];
    const fm = (documentState.currentParsed && documentState.currentParsed.frontmatter) || {};
    const loomBlock = renderLoomBlock(fm);

    const trail = renderDocHierarchyTrail();
    if (trail) blocks.push(trail);

    blocks.push(renderTitleBlock(fm));
    blocks.push(renderFrontmatterBlock(fm));
    blocks.push(renderWarningsBlock());
    if (Object.keys(sections).length === 0) {
      const rawFull = editor.value || "";
      const body = stripFrontmatter(rawFull);
      const cleanBody = stripLeadingHeading(body);
      const docBlocks = bodyBlocks || parseMarkdownBlocks(cleanBody);

      const wrap = document.createElement("div");
      wrap.className = "block-plain-body";

      if (docBlocks.length === 0) {
        const emptyBlock = document.createElement("div");
        emptyBlock.className = "notion-empty-document";
        const emptyBtn = document.createElement("button");
        emptyBtn.type = "button";
        emptyBtn.className = "notion-add-row-btn";
        emptyBtn.textContent = "+ Click or type '/' to insert text, headings, lists, or callouts…";
        emptyBtn.addEventListener("click", () => {
          blockEditor.slashMenu.open({
            targetEl: emptyBtn,
            onSelect: (item) => {
              if (item.type === "page") {
                if (services.createSubpage) services.createSubpage(documentState.currentDoc);
                else if (context.createSubpage) context.createSubpage(documentState.currentDoc);
                return;
              }
              applyBlocksChange([
                {
                  id: `blk-0-${Date.now()}`,
                  type: item.type,
                  raw: item.template || "",
                },
              ], { focusBlockIndex: 0 });
            },
          });
        });
        emptyBlock.append(emptyBtn);
        wrap.append(emptyBlock);
      } else {
        const blocksContainer = blockEditor.renderBlocksContainer({
          blocks: docBlocks,
          focusBlockIndex,
          onChange: (idx, newRaw, options = {}) => {
            docBlocks[idx] = {
              ...docBlocks[idx], ...parseMarkdownBlocks(newRaw)[0], raw: newRaw,
            };
            applyBlocksChange(docBlocks, options);
          },
          onMoveBlock: (fromIdx, toIdx) => {
            const [moved] = docBlocks.splice(fromIdx, 1);
            docBlocks.splice(toIdx, 0, moved);
            applyBlocksChange(docBlocks);
          },
          onInsertBlock: (atIdx, template) => {
            docBlocks.splice(atIdx, 0, {
              ...(parseMarkdownBlocks(template)[0] || { type: "paragraph" }),
              id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              raw: template,
            });
            applyBlocksChange(docBlocks, { focusBlockIndex: atIdx });
          },
          onDeleteBlock: (idx) => {
            docBlocks.splice(idx, 1);
            applyBlocksChange(docBlocks);
          },
        });
        wrap.append(blocksContainer);
      }

      blocks.push(wrap);
      blocks.push(loomBlock);
      blocks.push(renderRelatedDocsBlock(fm));

      const subpages = renderSubpagesBlock(documentState.currentDoc?.path);
      if (subpages) blocks.push(subpages);

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

    blocks.push(renderRelatedDocsBlock(fm));
    const backlinksHost = document.createElement("section");
    backlinksHost.className = "block-backlinks";
    backlinksHost.id = "backlinks-host";
    blocks.push(backlinksHost);
    blocks.push(loomBlock);

    const subpages = renderSubpagesBlock(documentState.currentDoc?.path);
    if (subpages) blocks.push(subpages);

    renderedView.replaceChildren(...blocks.filter(Boolean));
    // Async-fetch backlinks separately so the main render isn't blocked.
    fetchBacklinksForCurrentDoc();
  }

  function applyBlocksChange(newBlocks, { rerender = true, focusBlockIndex = -1 } = {}) {
    const rawFull = editor.value || "";
    const fmRange = _frontmatterRange(rawFull);
    const fmText = fmRange ? rawFull.slice(0, fmRange.end + 5) : "";
    const bodyAfterFm = fmRange ? rawFull.slice(fmRange.end + 5) : rawFull;
    const h1Match = bodyAfterFm.match(/^#{1,2}\s+[^\n]*\n+/);
    const headingText = h1Match ? h1Match[0] : "";
    const newBodyMarkdown = serializeBlocksToMarkdown(newBlocks);
    editor.value =
      (fmText ? fmText + (fmText.endsWith("\n") ? "" : "\n") : "") +
      headingText +
      (headingText && !headingText.endsWith("\n\n") ? "\n" : "") +
      newBodyMarkdown;
    storeDraft();
    updateSaveState();
    if (rerender) renderParsedDocument({ bodyBlocks: newBlocks, focusBlockIndex });
  }

  function renderDocHierarchyTrail() {
    const currentDoc = documentState.currentDoc;
    const path = currentDoc?.path;
    if (!path) return null;
    const nav = document.createElement("nav");
    nav.className = "doc-hierarchy-nav doc-hierarchy-trail";
    nav.setAttribute("aria-label", "Document location");
    const root = document.createElement("button");
    root.type = "button";
    root.className = "doc-trail-item doc-trail-root doc-trail-link";
    root.textContent = "Docs";
    root.addEventListener("click", () => {
      if (context.navigateCanonicalWorkspace) {
        context.navigateCanonicalWorkspace("/docs");
      }
    });
    nav.append(root);

    const allDocs = context.knowledgeState?.allDocuments || [];
    const matchedDoc = allDocs.find((d) => d.path === path);
    const ancestors = [];
    const visited = new Set();
    if (currentDoc.id) visited.add(currentDoc.id);
    if (matchedDoc?.id) visited.add(matchedDoc.id);
    visited.add(currentDoc.path);

    let curr = {
      ...matchedDoc,
      parent: documentState.currentParsed?.frontmatter?.parent || matchedDoc?.parent,
      parent_id: matchedDoc?.parent_id,
    };
    while (curr) {
      const parentRef = curr.parent_id || curr.parent || "";
      if (!parentRef) break;
      const parentDoc = allDocs.find(
        (d) => d.id === parentRef || d.path === parentRef || d.aliases?.includes(parentRef),
      );
      if (!parentDoc || visited.has(parentDoc.id) || visited.has(parentDoc.path)) break;
      visited.add(parentDoc.id);
      visited.add(parentDoc.path);
      ancestors.unshift(parentDoc);
      curr = parentDoc;
    }

    if (ancestors.length === 0) {
      const parts = path.split("/").filter((p) => Boolean(p) && p.toLowerCase() !== "content");
      for (let i = 0; i < parts.length - 1; i++) {
        const sep = document.createElement("span");
        sep.className = "doc-trail-sep";
        sep.textContent = " / ";
        const folder = document.createElement("span");
        folder.className = "doc-trail-item doc-trail-folder";
        folder.textContent = humanizeDocType(parts[i]);
        nav.append(sep, folder);
      }
    } else {
      const firstParent = ancestors[0];
      const domain = firstParent.domain || partsFirstDomain(firstParent.path);
      if (domain && domain !== "docs") {
        const sep = document.createElement("span");
        sep.className = "doc-trail-sep";
        sep.textContent = " / ";
        const folder = document.createElement("span");
        folder.className = "doc-trail-item doc-trail-folder";
        folder.textContent = humanizeDocType(domain);
        nav.append(sep, folder);
      }
      for (const ancestor of ancestors) {
        const sep = document.createElement("span");
        sep.className = "doc-trail-sep";
        sep.textContent = " / ";
        const item = document.createElement("button");
        item.type = "button";
        item.className = "doc-trail-item doc-trail-ancestor doc-trail-link";
        item.textContent = ancestor.title || basename(ancestor.path);
        item.addEventListener("click", () => {
          if (context.openDocument) context.openDocument(ancestor.path);
        });
        nav.append(sep, item);
      }
    }

    const sep = document.createElement("span");
    sep.className = "doc-trail-sep";
    sep.textContent = " / ";
    const current = document.createElement("span");
    current.className = "doc-trail-item doc-trail-current";
    current.textContent =
      documentState.currentParsed?.frontmatter?.title ||
      documentState.currentDoc?.title ||
      basename(path);
    nav.append(sep, current);
    return nav;
  }

  function partsFirstDomain(p) {
    const parts = (p || "").split("/").filter((x) => Boolean(x) && x.toLowerCase() !== "content");
    return parts.length > 1 ? parts[0] : "";
  }

  function renderSubpagesBlock(currentDocPath) {
    if (!currentDocPath) return null;
    const currentDoc = documentState.currentDoc;
    const allDocs = context.knowledgeState?.allDocuments || [];
    const matchedDoc = allDocs.find((d) => d.path === currentDocPath) || currentDoc;
    const currentDocId = matchedDoc?.id || documentState.currentParsed?.frontmatter?.id;
    const docStemPath = currentDocPath.replace(/\.md$/, "") + "/";
    const children = allDocs.filter(
      (d) =>
        d.path !== currentDocPath &&
        ((currentDocId && d.parent_id === currentDocId) ||
         (currentDocId && d.parent === currentDocId) ||
         (d.parent === currentDocPath) ||
         (d.path.startsWith(docStemPath) && !d.parent_id)),
    );

    const section = document.createElement("section");
    section.className = "doc-subpages";
    const header = document.createElement("header");
    header.className = "doc-subpages-header";
    const heading = document.createElement("h3");
    heading.textContent = "Sub-pages";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "quiet-button doc-add-subpage-btn";
    addBtn.textContent = "+ Add sub-page";
    addBtn.addEventListener("click", () => {
      if (services.createSubpage) services.createSubpage(currentDoc);
      else if (context.createSubpage) context.createSubpage(currentDoc);
    });
    header.append(heading, addBtn);
    section.append(header);

    const list = document.createElement("div");
    list.className = "doc-subpages-list";
    if (children.length === 0) {
      const empty = document.createElement("span");
      empty.className = "doc-subpages-empty";
      empty.textContent = "No sub-pages yet.";
      list.append(empty);
    } else {
      for (const child of children) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "doc-subpage-item";
        const icon = document.createElement("span");
        icon.className = "doc-subpage-icon";
        icon.textContent = "📄";
        const title = document.createElement("span");
        title.className = "doc-subpage-title";
        title.textContent = child.title || basename(child.path);
        row.append(icon, title);
        row.addEventListener("click", () => {
          if (context.openDocument) context.openDocument(child.path);
        });
        list.append(row);
      }
    }
    section.append(list);
    return section;
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

    const line = document.createElement("p");
    line.className = "fm-meta";
    line.textContent = formatFrontmatterMeta(fm);
    row.append(line);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "quiet-button fm-edit";
    editBtn.textContent = "Edit metadata";
    editBtn.title = "Edit doc metadata";
    editBtn.addEventListener("click", () => toggleFrontmatterEditor(wrap, fm));
    row.append(editBtn);

    wrap.append(row);
    return wrap;
  }

  function formatFrontmatterMeta(fm) {
    const type = humanizeDocType(fm.doc_type);
    const systems = Array.isArray(fm.systems) ? fm.systems : [];
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    const seen = new Set();
    const parts = [];
    const remember = (value) => {
      const key = String(value || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      parts.push(value);
    };
    remember(type);
    for (const value of systems) remember(value);
    for (const value of tags) remember(value);
    const stats = computeDocStats();
    if (stats) parts.push(stats);
    return parts.join(" · ");
  }

  function humanizeDocType(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "sop") return "SOP";
    return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
    header.append(title);
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
