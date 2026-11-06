import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";
import {
  ensureFrontmatter,
  frontmatterRange,
  patchFrontmatterList,
  patchFrontmatterScalar,
  readFrontmatterList,
  readFrontmatterScalar,
} from "./frontmatter.js";
import { createBlockEditor } from "./block-editor.js";
import { makeBlock, parseMarkdownBlocks, serializeBlocksToMarkdown } from "./block-model.js";
import { attachEditable, focusEditable, neighbourEditable } from "./editable.js";
import { installSelectionToolbar } from "./selection-toolbar.js";
import { createTemplateViewSurface } from "../knowledge/template-view.js";

export function createDocumentRenderer(context, services) {
  const {
    apiUrl, basename, documentState, documentTitle, editor, editorView,
    fetchBacklinksForCurrentDoc, renderLoomBlock,
    renderRelatedDocsBlock, renderWarningsBlock, renderedView, request,
    setRouteTitle,
  } = context;
  const {
    fileToBase64, openLightbox, recordPublication, renderMarkdown, storeDraft, stripFrontmatter,
    resizeDocumentTitle, setMarkdownTitle, stripLeadingHeading, updateSaveState,
  } = services;
  const showFeedback = editorFeedbackFor(context);
  // Select text in a block for bold, italic, code and link.
  if (renderedView && typeof renderedView.ownerDocument?.getSelection === "function") {
    installSelectionToolbar(renderedView);
  }
  // Natural image ratios survive re-renders, so a re-rendered screenshot
  // reserves its height before the image decodes and the page does not jump.
  const imageRatios = new Map();

  function sizeImageFromCache(img, src) {
    const ratio = imageRatios.get(src);
    if (ratio) img.style.aspectRatio = ratio;
    img.addEventListener("load", () => {
      if (img.naturalWidth && img.naturalHeight) {
        imageRatios.set(src, `${img.naturalWidth} / ${img.naturalHeight}`);
      }
    });
  }

  function followLink(link) {
    const docPath = link.getAttribute("data-doc-path");
    if (docPath) {
      context.openDocument?.(docPath);
      return;
    }
    const href = link.getAttribute("href");
    if (href && href !== "#") globalThis.open?.(href, "_blank", "noopener");
  }

  /** Every text block is always editable; see editable.js. */
  function attachInlineEditor(el, options) {
    return attachEditable(el, {
      renderAtom: services.renderInlineAtom,
      resolveLink: services.resolveInlineLink,
      onActivity: services.markSaving,
      onFollowLink: followLink,
      ...options,
    });
  }

  /** Upload an image next to the current doc; resolves with its path. */
  async function uploadImage(file) {
    if (!documentState.currentDoc) return null;
    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    const isCurrentDocument = () =>
      isFresh() && documentState.currentDoc?.path === path;
    showFeedback("Uploading image…", { kind: "pending" });
    try {
      const data = await fileToBase64(file);
      if (!isCurrentDocument()) return null;
      const payload = await request(apiUrl("/images"), {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: documentState.currentDoc.revision,
          doc_path: path,
          filename: file.name,
          data,
        }),
      });
      if (!isCurrentDocument()) return null;
      recordPublication(documentState.currentDoc.revision, payload.revision);
      showFeedback(`Uploaded ${payload.absolute_path}`);
      return payload.absolute_path;
    } catch (err) {
      if (isCurrentDocument()) showFeedback(`Upload failed: ${err.message}`, { kind: "error" });
      return null;
    }
  }

  const blockEditor = createBlockEditor(context, {
    ...services,
    attachInlineEditor,
    insertImageBlocks,
    renderImageBlock,
  });

  /** Upload images and place them as image blocks at `index`. */
  async function insertImageBlocks(files, blocks, index, replaceCurrent, replace) {
    const paths = [];
    for (const file of files) {
      const src = await uploadImage(file);
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

  const templateViewSurface = createTemplateViewSurface({ clipboard: context.clipboard });

  async function toggleViewMode() {
    return enterRenderedMode();
  }

  function updateViewToggleAvailability() {}

  async function enterRenderedMode() {
    const path = documentState.currentDoc?.path;
    const isFresh = editorMutationGuard(context);
    editorView.dataset.mode = "rendered";
    renderParsedDocument();
  }

  /** Frontmatter the rendered view needs, read live from the draft text. */
  function frontmatterFromEditor() {
    const markdown = editor.value || "";
    return {
      title: readFrontmatterScalar(markdown, "title"),
      related_docs: readFrontmatterList(markdown, "related_docs"),
      training_assets: readFrontmatterList(markdown, "training_assets"),
    };
  }

  function renderParsedDocument(options = {}) {
    renderedView.classList.remove("template-view");
    let templatePreview = null;
    if (documentState.currentDoc?.docType === "template") {
      const preview = document.createElement("section");
      if (templateViewSurface.renderTemplateView(preview, stripFrontmatter(editor.value || ""))) {
        templatePreview = preview;
      }
    }
    const { bodyBlocks, focusBlockIndex = -1, focus = null } = options;
    const blocks = [];
    const fm = frontmatterFromEditor();
    const loomBlock = renderLoomBlock(fm);
    // Arrow keys move between the editable blocks inside this root.
    renderedView.dataset.editorRoot = "";

    const trail = renderDocHierarchyTrail();
    if (trail) blocks.push(trail);

    blocks.push(renderTitleBlock());
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
    // Every document renders its body as generic markdown blocks: headings,
    // lists, quotes, code, images and embeds. HTML comments (e.g. markers in
    // legacy SOP files) are skipped by the block parser, so old files render
    // cleanly and lose the comments on their next edit.
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
      const backlinksHost = document.createElement("section");
      backlinksHost.className = "block-backlinks";
      backlinksHost.id = "backlinks-host";
      blocks.push(backlinksHost);

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
    // Mirror the read path (stripFrontmatter + stripLeadingHeading): the body
    // may start with a blank line, and the leading H1/H2 renders as the page
    // title rather than a block, so it is carried separately on every write.
    const bodyAfterFm = (fmRange ? rawFull.slice(fmRange.end + 5) : rawFull).replace(/^\n+/, "");
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
      parent: readFrontmatterScalar(editor.value || "", "parent") || matchedDoc?.parent,
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
    const currentDocId = matchedDoc?.id || readFrontmatterScalar(editor.value || "", "id");
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

  function renderTitleBlock() {
    const fm = frontmatterFromEditor();
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
    // A custom doc_type comes from document frontmatter, so it is data, not
    // markup: option nodes keep its value and label inert but verbatim.
    for (const docType of types) {
      const option = document.createElement("option");
      option.value = docType;
      option.textContent = humanizeDocType(docType);
      option.selected = docType === fm.doc_type;
      type.append(option);
    }
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
    if (next === editor.value) return;
    editor.value = next;
    storeDraft();
    updateSaveState();
  }


  return {
    attachInlineEditor, emptyNote, enterRenderedMode,
    renderParsedDocument, toggleViewMode, updateViewToggleAvailability,
    uploadImage,
  };
}
