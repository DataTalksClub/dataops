import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";
import {
  ensureFrontmatter,
  frontmatterRange,
  patchFrontmatterList,
  patchFrontmatterScalar,
  readFrontmatterList,
  readFrontmatterScalar,
} from "./frontmatter.js";
import { procedureHeading, setProcedureHeading } from "./procedure-model.js";
import { sizeImageFromCache } from "./procedure-renderer.js";
import { createBlockEditor } from "./block-editor.js";
import { makeBlock, parseMarkdownBlocks, serializeBlocksToMarkdown } from "./block-model.js";
import { focusEditable, neighbourEditable } from "./editable.js";
import { installSelectionToolbar } from "./selection-toolbar.js";
import { createCodeViewSurface } from "../knowledge/code-view.js";
import { createTemplateViewSurface } from "../knowledge/template-view.js";

export function createDocumentRenderer(context, services) {
  const {
    apiUrl, basename, documentState, documentTitle, editor, editorView,
    fetchBacklinksForCurrentDoc, renderLoomBlock,
    renderRelatedDocsBlock, renderWarningsBlock, renderedView, request,
    setRouteTitle, viewToggleButton,
  } = context;
  const {
    appendProcedureChildren, attachInlineEditor, commitProcedure,
    patchSectionInMarkdown, readProcedureModel, renderMarkdown, storeDraft, stripFrontmatter,
    resizeDocumentTitle, setMarkdownTitle, stripLeadingHeading, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);
  // Select text in a block for bold, italic, code and link.
  if (renderedView && typeof renderedView.ownerDocument?.getSelection === "function") {
    installSelectionToolbar(renderedView);
  }
  const blockEditor = createBlockEditor(context, {
    ...services,
    insertImageBlocks,
    renderImageBlock,
  });

  /** Upload images and place them as image blocks at `index`. */
  async function insertImageBlocks(files, blocks, index, replaceCurrent, replace) {
    const paths = [];
    for (const file of files) {
      const src = await services.uploadImage(file);
      if (src) paths.push(src);
    }
    if (!paths.length) return;
    const images = paths.map((src) => makeBlock("image", `![](${src})`));
    const first = replaceCurrent ? index : index + 1;
    blocks.splice(first, replaceCurrent ? 1 : 0, ...images);
    blocks.splice(first + images.length, 0, makeBlock("paragraph", ""));
    replace({ index: first + images.length, at: "start" });
  }

  function renderImageBlock(block) {
    const match = block.raw.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    const figure = document.createElement("figure");
    figure.className = "block-screenshot block-image";
    const media = document.createElement("div");
    media.className = "block-screenshot-media";
    const img = document.createElement("img");
    img.src = services.resolveImageSrc(match ? match[2] : "");
    img.alt = match ? match[1] : "";
    img.loading = "lazy";
    sizeImageFromCache(img, img.src);
    img.addEventListener("click", () => services.openLightbox(img.src, img.alt));
    media.append(img);
    figure.append(media);
    return figure;
  }

  const DOC_TYPES = [
    "sop", "checklist", "template", "reference", "playbook", "prompt",
  ];

  const codeViewSurface = createCodeViewSurface({});
  const templateViewSurface = createTemplateViewSurface({ clipboard: context.clipboard });
  let codeViewRequest = 0;

  async function fetchCodeViewPayload(codeViewPath) {
    const url = apiUrl("/docs");
    url.searchParams.set("path", codeViewPath);
    return request(url);
  }

  async function toggleViewMode() {
    if (!documentState.currentDoc) return;
    if (documentState.currentDoc.docType === "code-view" && documentState.currentDoc.sopDoc?.path) {
      return context.openDocument(documentState.currentDoc.sopDoc.path);
    }
    if (editorView.dataset.mode === "code") {
      return enterRenderedMode();
    }
    return enterCodeViewMode();
  }

  /** Show the linked SOP's alternate code view (or the open code-view doc). */
  async function enterCodeViewMode() {
    const doc = documentState.currentDoc;
    if (!doc) return;
    const openedPath = doc.path;
    const requestId = ++codeViewRequest;
    const isFresh = editorMutationGuard(context);
    editorView.dataset.mode = "code";
    let problem = doc.codeViewError || doc.parseCodeError || "";
    let payload =
      doc.docType === "code-view" ? documentState.currentParsedCodeView : null;
    if (!payload && doc.codeView?.path) {
      try {
        const fetched = await fetchCodeViewPayload(doc.codeView.path);
        if (!isFresh() || documentState.currentDoc?.path !== openedPath ||
            requestId !== codeViewRequest || editorView.dataset.mode !== "code") return;
        problem = fetched.code_view_error || fetched.parse_code_error || "";
        payload = fetched.parsed_code_view || null;
      } catch (error) {
        if (!isFresh() || documentState.currentDoc?.path !== openedPath ||
            requestId !== codeViewRequest || editorView.dataset.mode !== "code") return;
        problem = error.message || "The linked code view could not be loaded.";
      }
    }
    renderedView.replaceChildren();
    renderedView.classList.remove("code-view", "template-view");
    renderedView.dataset.editorRoot = "";
    if (payload && !problem) {
      codeViewSurface.renderCodeView(renderedView, payload, { renderMarkdown });
    } else {
      const note = document.createElement("div");
      note.className = "code-view-unavailable";
      note.setAttribute("role", problem ? "alert" : "status");
      note.textContent = problem || (doc.codeView
        ? "The linked code view could not be loaded."
        : "No code view is linked to this document.");
      renderedView.append(note);
    }
    resizeDocumentTitle();
    updateViewToggleAvailability();
  }

  async function enterRenderedMode() {
    codeViewRequest += 1;
    const path = documentState.currentDoc?.path;
    const isFresh = editorMutationGuard(context);
    editorView.dataset.mode = "rendered";
    updateViewToggleAvailability();
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
        body: JSON.stringify({
          content: editor.value,
          kind: documentState.currentDoc?.docType === "code-view" ? "code-view" : "sop",
        }),
      });
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      if (documentState.currentDoc?.docType === "code-view") {
        documentState.currentParsedCodeView = payload.parsed_code_view || null;
        documentState.currentDoc.parseCodeError = payload.error || null;
      } else if (payload.parsed) documentState.currentParsed = payload.parsed;
    } catch {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
    }
  }

  function updateViewToggleAvailability() {
    // The toggle switches between the normal document view and the Gist-style
    // code view. It appears when the open doc IS a code view or has one linked
    // (GET /docs → code_view); otherwise there is nothing to switch to.
    const doc = documentState.currentDoc;
    const available =
      !!doc && (!!doc.codeView || doc.docType === "code-view" || !!doc.codeViewError);
    viewToggleButton.hidden = !available;
    viewToggleButton.textContent =
      doc?.docType === "code-view" && doc.sopDoc ? "SOP view" :
        editorView.dataset.mode === "code" ? "Document view" : "Code view";
    if (doc && editorView.dataset.mode !== "rendered" && editorView.dataset.mode !== "code") {
      enterRenderedMode();
    }
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
      documentState.currentParsedCodeView = payload.parsed_code_view || null;
      if (documentState.currentDoc) {
        documentState.currentDoc.docType = payload.doc_type || documentState.currentDoc.docType;
        documentState.currentDoc.codeView = payload.code_view || null;
        documentState.currentDoc.sopDoc = payload.sop_doc || null;
        documentState.currentDoc.codeViewError = payload.code_view_error || null;
        documentState.currentDoc.parseCodeError = payload.parse_code_error || null;
      }
      updateViewToggleAvailability();
    } catch {
      if (!isFresh() || documentState.currentDoc?.path !== path) return;
      documentState.currentParsed = null;
    }
  }

  function renderParsedDocument(options = {}) {
    renderedView.classList.remove("code-view", "template-view");
    // A code-view document renders as its Gist-style body — files in author
    // order, read-only — instead of the SOP block view.
    if (
      documentState.currentDoc?.docType === "code-view" &&
      documentState.currentParsedCodeView
    ) {
      editorView.dataset.mode = "rendered";
      renderedView.replaceChildren();
      renderedView.dataset.editorRoot = "";
      codeViewSurface.renderCodeView(renderedView, documentState.currentParsedCodeView, {
        renderMarkdown,
      });
      updateViewToggleAvailability();
      return;
    }
    let templatePreview = null;
    if (documentState.currentDoc?.docType === "template") {
      const preview = document.createElement("section");
      if (templateViewSurface.renderTemplateView(preview, stripFrontmatter(editor.value || ""))) {
        templatePreview = preview;
      }
    }
    const { bodyBlocks, focusBlockIndex = -1, focus = null } = options;
    const sections = (documentState.currentParsed && documentState.currentParsed.sections) || {};
    const blocks = [];
    const fm = (documentState.currentParsed && documentState.currentParsed.frontmatter) || {};
    const loomBlock = renderLoomBlock(fm);
    // Arrow keys move between the editable blocks inside this root.
    renderedView.dataset.editorRoot = "";

    const trail = renderDocHierarchyTrail();
    if (trail) blocks.push(trail);

    blocks.push(renderTitleBlock(fm));
    blocks.push(renderFrontmatterBlock());
    blocks.push(renderWarningsBlock());
    const headerLength = blocks.length;
    const keepDocumentOpen = renderedView.querySelector(".template-document")?.open ||
      options.focusBlockIndex >= 0 || !!options.focus;
    const commitBlocks = () => {
      if (!templatePreview) {
        renderedView.replaceChildren(...blocks.filter(Boolean));
        return;
      }
      const supplemental = document.createElement("details");
      supplemental.className = "template-document";
      supplemental.open = keepDocumentOpen;
      const summary = document.createElement("summary");
      summary.textContent = "Full document and sending instructions";
      supplemental.append(summary, ...blocks.slice(headerLength).filter(Boolean));
      renderedView.replaceChildren(...blocks.slice(0, headerLength).filter(Boolean), templatePreview, supplemental);
    };
    if (Object.keys(sections).length === 0) {
      const rawFull = editor.value || "";
      const body = stripFrontmatter(rawFull);
      const cleanBody = stripLeadingHeading(body);
      const docBlocks = bodyBlocks || parseMarkdownBlocks(cleanBody);
      if (docBlocks.length === 0) docBlocks.push(makeBlock("paragraph", ""));

      const wrap = document.createElement("div");
      wrap.className = "block-plain-body";
      wrap.append(blockEditor.renderBlocksContainer({
        blocks: docBlocks,
        focusBlockIndex,
        focus,
        onChange: (idx, newRaw, options = {}) => {
          docBlocks[idx] = {
            ...docBlocks[idx], ...(parseMarkdownBlocks(newRaw)[0] || {}), id: docBlocks[idx].id, raw: newRaw,
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
        onReplaceBlocks: (next, options = {}) => applyBlocksChange(next, options),
      }));

      blocks.push(wrap);
      blocks.push(loomBlock);
      blocks.push(renderRelatedDocsBlock(fm));

      const subpages = renderSubpagesBlock(documentState.currentDoc?.path);
      if (subpages) blocks.push(subpages);

      commitBlocks();
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
    const sectionFocus = (name) => (focus && focus.section === name ? focus : null);
    for (const name of order) {
      if (sections[name]) {
        blocks.push(renderSectionBlock(name, sections[name], sectionFocus(name)));
        seen.add(name);
      }
    }
    for (const [name, sec] of Object.entries(sections)) {
      if (seen.has(name)) continue;
      blocks.push(renderSectionBlock(name, sec, sectionFocus(name)));
    }

    blocks.push(renderRelatedDocsBlock(fm));
    const backlinksHost = document.createElement("section");
    backlinksHost.className = "block-backlinks";
    backlinksHost.id = "backlinks-host";
    blocks.push(backlinksHost);
    blocks.push(loomBlock);

    const subpages = renderSubpagesBlock(documentState.currentDoc?.path);
    if (subpages) blocks.push(subpages);

    commitBlocks();
    // Async-fetch backlinks separately so the main render isn't blocked.
    fetchBacklinksForCurrentDoc();
  }

  function refreshTemplatePreview() {
    if (documentState.currentDoc?.docType !== "template") return;
    const preview = renderedView.querySelector(".template-view");
    if (!preview) return;
    if (!templateViewSurface.renderTemplateView(preview, stripFrontmatter(editor.value || ""))) {
      const note = document.createElement("p");
      note.setAttribute("role", "status");
      note.textContent = "Template preview unavailable. Check the Template fence in the full document.";
      preview.replaceChildren(note);
    }
  }

  function applyBlocksChange(newBlocks, { rerender = true, focusBlockIndex = -1, focus = null } = {}) {
    const rawFull = editor.value || "";
    const fmRange = frontmatterRange(rawFull);
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
    if (rerender) renderParsedDocument({ bodyBlocks: newBlocks, focusBlockIndex, focus });
    else refreshTemplatePreview();
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
    root.textContent = "Process Docs";
    root.addEventListener("click", () => {
      if (context.navigateCanonicalWorkspace) {
        context.navigateCanonicalWorkspace("/docs");
      }
    });

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

    const middle = [];
    const folder = (label) => {
      const item = document.createElement("span");
      item.className = "doc-trail-item doc-trail-folder";
      item.textContent = label;
      return item;
    };
    if (ancestors.length === 0) {
      const parts = path.split("/").filter((p) => Boolean(p) && p.toLowerCase() !== "content");
      for (const part of parts.slice(0, -1)) middle.push(folder(humanizeDocType(part)));
    } else {
      const domain = ancestors[0].domain || partsFirstDomain(ancestors[0].path);
      if (domain && domain !== "docs") middle.push(folder(humanizeDocType(domain)));
      for (const ancestor of ancestors) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "doc-trail-item doc-trail-ancestor doc-trail-link";
        item.textContent = ancestor.title || basename(ancestor.path);
        item.addEventListener("click", () => {
          if (context.openDocument) context.openDocument(ancestor.path);
        });
        middle.push(item);
      }
    }
    // A long folder path collapses to "Process Docs / … / folder / page";
    // the full path stays available as a tooltip. Parent pages are links
    // and always show.
    let shown = middle;
    if (ancestors.length === 0 && middle.length > 2) {
      const ellipsis = document.createElement("span");
      ellipsis.className = "doc-trail-item doc-trail-ellipsis";
      ellipsis.textContent = "…";
      ellipsis.title = middle.map((item) => item.textContent).join(" / ");
      shown = [ellipsis, middle.at(-1)];
    }

    const current = document.createElement("span");
    current.className = "doc-trail-item doc-trail-current";
    current.textContent =
      readFrontmatterScalar(editor.value || "", "title") ||
      documentState.currentParsed?.frontmatter?.title ||
      documentState.currentDoc?.title ||
      basename(path);
    nav.append(root);
    for (const item of [...shown, current]) {
      const sep = document.createElement("span");
      sep.className = "doc-trail-sep";
      sep.textContent = " / ";
      nav.append(sep, item);
    }
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

    if (children.length === 0) return null;

    const section = document.createElement("section");
    section.className = "doc-subpages";
    const header = document.createElement("header");
    header.className = "doc-subpages-header";
    const heading = document.createElement("h3");
    heading.textContent = "Sub-pages";
    header.append(heading);
    section.append(header);

    const list = document.createElement("div");
    list.className = "doc-subpages-list";
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
    section.append(list);
    return section;
  }

  function emptyNote(text) {
    const div = document.createElement("div");
    div.className = "rendered-empty";
    div.textContent = text;
    return div;
  }

  function renderTitleBlock(parsedFm) {
    const fm = { ...parsedFm, title: readFrontmatterScalar(editor.value || "", "title") || parsedFm.title };
    const fallback = documentState.currentDoc ? basename(documentState.currentDoc.path) : "";
    const wrap = document.createElement("div");
    wrap.className = "block-title-wrap";
    const h1 = document.createElement("h1");
    h1.className = "block-title";
    attachInlineEditor(h1, {
      getValue: () => fm.title || fallback,
      commit: (value) => applyTitleEdit(fm, value),
      plain: true,
      multiline: false,
      singleLine: true,
      placeholder: "Untitled",
      // Enter in the title moves into the page body, like Notion.
      onEnterNewBlock: () => focusEditable(
        renderedView.querySelector(".block-plain-body [data-editable], .block-section [data-editable]"),
        "start",
      ),
    });
    wrap.append(h1);
    return wrap;
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

  function renderFrontmatterBlock() {
    const markdown = editor.value || "";
    const fm = {
      doc_type: readFrontmatterScalar(markdown, "doc_type"),
      summary: readFrontmatterScalar(markdown, "summary"),
      tags: readFrontmatterList(markdown, "tags"),
      systems: readFrontmatterList(markdown, "systems"),
    };
    const list = document.createElement("dl");
    list.className = "doc-properties";
    list.setAttribute("aria-label", "Properties");

    const row = (label, valueEl) => {
      const wrap = document.createElement("div");
      wrap.className = "doc-property";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.append(valueEl);
      wrap.append(dt, dd);
      list.append(wrap);
    };

    const type = document.createElement("select");
    type.className = "doc-property-select";
    type.setAttribute("aria-label", "Doc type");
    const types = DOC_TYPES.includes(fm.doc_type) || !fm.doc_type
      ? DOC_TYPES
      : [fm.doc_type, ...DOC_TYPES];
    type.innerHTML = types.map(
      (t) => `<option value="${t}"${t === fm.doc_type ? " selected" : ""}>${humanizeDocType(t)}</option>`,
    ).join("");
    type.addEventListener("change", () => applyFrontmatterEdit(fm, { doc_type: type.value }));
    row("Type", type);

    const summary = document.createElement("div");
    summary.className = "doc-property-text";
    summary.textContent = fm.summary || "";
    attachInlineEditor(summary, {
      getValue: () => fm.summary || "",
      commit: (value) => applyFrontmatterEdit(fm, { summary: value.trim() }),
      restore: () => {
        summary.textContent = fm.summary || "";
      },
      multiline: false,
      singleLine: true,
      placeholder: "Add a summary",
    });
    row("Summary", summary);

    row("Tags", makeChipListEditor(fm, "tags", "Add a tag"));
    row("Systems", makeChipListEditor(fm, "systems", "Add a system"));
    return list;
  }

  function humanizeDocType(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "sop") return "SOP";
    return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function makeChipListEditor(fm, key, placeholder) {
    const wrap = document.createElement("div");
    wrap.className = "doc-chips";
    const chips = Array.isArray(fm[key]) ? [...fm[key]] : [];
    const save = () => applyFrontmatterEdit(fm, { [key]: [...chips] });

    const render = (focusInput = false, draft = "") => {
      wrap.replaceChildren();
      chips.forEach((value, index) => {
        const chip = document.createElement("span");
        chip.className = "doc-chip";
        const label = document.createElement("span");
        label.className = "doc-chip-label";
        label.textContent = value;
        label.title = "Edit";
        // Tapping a chip moves it into the input for editing; on touch this
        // is also how a chip is removed (the remove button is desktop-only).
        label.addEventListener("click", () => {
          chips.splice(index, 1);
          save();
          render(true, value);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "doc-chip-remove";
        remove.setAttribute("aria-label", `Remove ${value}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          chips.splice(index, 1);
          save();
          render(true);
        });
        chip.append(label, remove);
        wrap.append(chip);
      });
      const input = document.createElement("input");
      input.type = "text";
      input.className = "doc-chip-input";
      input.placeholder = chips.length ? "" : placeholder;
      input.setAttribute("aria-label", placeholder);
      const add = () => {
        const value = input.value.trim().replace(/,$/, "");
        if (!value || chips.includes(value)) return false;
        chips.push(value);
        save();
        render(true);
        return true;
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          add();
        } else if (event.key === "Backspace" && !input.value && chips.length) {
          chips.pop();
          save();
          render(true);
        } else if (event.key === "Escape") {
          input.value = "";
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        add();
      });
      input.value = draft;
      wrap.append(input);
      if (focusInput) {
        input.focus();
        if (draft) input.select?.();
      }
    };
    render();
    return wrap;
  }

  function applyFrontmatterEdit(fm, updates) {
    let next = ensureFrontmatter(editor.value);
    if ("doc_type" in updates) next = patchFrontmatterScalar(next, "doc_type", updates.doc_type);
    if ("summary" in updates) {
      next = patchFrontmatterScalar(next, "summary", updates.summary, { quoted: true });
    }
    if ("tags" in updates) next = patchFrontmatterList(next, "tags", updates.tags);
    if ("systems" in updates) next = patchFrontmatterList(next, "systems", updates.systems);
    Object.assign(fm, updates);
    if (documentState.currentParsed) {
      documentState.currentParsed.frontmatter = {
        ...(documentState.currentParsed.frontmatter || {}),
        ...updates,
      };
    }
    if (next === editor.value) return;
    editor.value = next;
    storeDraft();
    updateSaveState();
  }

  function renderSectionBlock(name, section, focus = null) {
    const block = document.createElement("section");
    block.className = "block-section";
    block.dataset.section = name;
    const structured = name === "procedure" && section.raw === false;
    const procedure = structured ? readProcedureModel() : null;

    const header = document.createElement("header");
    header.className = "block-section-header";
    const title = document.createElement("h2");
    const headingText = () => (procedure
      ? procedureHeading(procedure)
      : headingFromBody(section.body_md)) || humanSectionName(name);
    attachInlineEditor(title, {
      getValue: headingText,
      commit: (value) => {
        if (!value.trim()) return;
        if (procedure) {
          setProcedureHeading(procedure, value);
          commitProcedure(procedure, { rerender: false });
        } else {
          applySectionHeadingEdit(name, section, value);
        }
      },
      plain: true,
      multiline: false,
      singleLine: true,
      placeholder: humanSectionName(name),
      onEnterNewBlock: () => focusEditable(neighbourEditable(title, 1), "start"),
    });
    header.append(title);
    block.append(header);

    const body = document.createElement("div");
    body.className = "block-section-body";

    if (structured) {
      appendProcedureChildren(body, procedure);
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
      // Ordinary sections are block lists: each paragraph, bullet and to-do
      // is its own editable block.
      const sectionBlocks = parseMarkdownBlocks(stripLeadingHeading(section.body_md || ""));
      if (sectionBlocks.length === 0) sectionBlocks.push(makeBlock("paragraph", ""));
      const write = (next, options = {}) => {
        applySectionBodyEdit(name, section, serializeBlocksToMarkdown(next), false);
        if (options.rerender !== false) {
          renderParsedDocument({ focus: options.focus ? { ...options.focus, section: name } : null });
        }
      };
      body.append(blockEditor.renderBlocksContainer({
        blocks: sectionBlocks,
        focus,
        onChange: (idx, newRaw, options = {}) => {
          sectionBlocks[idx] = {
            ...sectionBlocks[idx], ...(parseMarkdownBlocks(newRaw)[0] || {}), id: sectionBlocks[idx].id, raw: newRaw,
          };
          write(sectionBlocks, options);
        },
        onMoveBlock: (fromIdx, toIdx) => {
          const [moved] = sectionBlocks.splice(fromIdx, 1);
          sectionBlocks.splice(toIdx, 0, moved);
          write(sectionBlocks);
        },
        onInsertBlock: (atIdx, template) => {
          sectionBlocks.splice(atIdx, 0, makeBlock("paragraph", template));
          write(sectionBlocks, { focus: { index: atIdx, at: "end" } });
        },
        onDeleteBlock: (idx) => {
          sectionBlocks.splice(idx, 1);
          write(sectionBlocks);
        },
        onReplaceBlocks: (next, options = {}) => write(next, options),
      }));
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
    refreshTemplatePreview();
  }

  function applySectionBodyEdit(name, section, newBody, isRaw) {
    // Reconstruct the body_md for the section (with the visible heading on top
    // for non-raw sections; raw sections are opaque).
    let combined;
    if (isRaw) {
      combined = newBody;
    } else {
      const heading = `## ${headingFromBody(section.body_md) || humanSectionName(name)}`;
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
    refreshTemplatePreview();
  }

  function humanSectionName(name) {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }


  return {
    emptyNote, enterRenderedMode, humanSectionName, refreshParsedFromApi,
    renderParsedDocument, renderSectionBlock, toggleViewMode,
    updateViewToggleAvailability,
  };
}
