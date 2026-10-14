import { focusEditable, neighbourEditable } from "./editable.js";
import { toVideoEmbed } from "./embeds.js";
import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";
import {
  convertItem,
  flowOf,
  groupsOf,
  insertAfter,
  joinGroupAbove,
  mergeIntoPrevious,
  newProse,
  newScreenshot,
  newStep,
  newTodo,
  previousFlowItem,
  removeItem,
  setGroupTitle,
  setProseBody,
  setScreenshotField,
  setStepBody,
  setTodoText,
  splitStep,
  startGroupAt,
  todosOf,
} from "./procedure-model.js";

// Natural image ratios survive re-renders, so a re-rendered screenshot
// reserves its height before the image decodes and the page does not jump.
const imageRatios = new Map();

export function sizeImageFromCache(img, src) {
  const ratio = imageRatios.get(src);
  if (ratio) img.style.aspectRatio = ratio;
  img.addEventListener("load", () => {
    if (img.naturalWidth && img.naturalHeight) {
      imageRatios.set(src, `${img.naturalWidth} / ${img.naturalHeight}`);
    }
  });
}

export function createProcedureRenderer(context, services, editorState) {
  const {
    apiUrl, documentState, renderedView, request, showUndoToast,
  } = context;
  const {
    attachInlineEditor, commitProcedure, fileToBase64, openLightbox,
    readProcedureModel, renderMarkdown, resolveImageSrc, restoreProcedure,
    snapshotProcedure,
  } = services;
  const showFeedback = editorFeedbackFor(context);

  /** Where an item will be after a re-render (see focusProcedureItem). */
  function focusOf(model, item, extra = {}) {
    if (item.kind === "step") return { kind: "step", id: item.id, ...extra };
    if (item.kind === "group") return { kind: "group", index: groupsOf(model).indexOf(item), ...extra };
    if (item.kind === "todo") return { kind: "todo", index: todosOf(model).indexOf(item), ...extra };
    const prose = flowOf(model).filter((entry) => entry.kind === "prose");
    return { kind: "prose", index: prose.indexOf(item), ...extra };
  }

  /**
   * The Notion keyboard model for a step or a free-text block: Enter splits,
   * Backspace at the start joins the block above, Tab/Shift+Tab join or
   * start a group (steps only).
   */
  function flowKeyboard(item, model) {
    const setBody = item.kind === "step" ? setStepBody : setProseBody;
    return {
      onSplit: (before, after) => {
        if (item.kind === "step" && !before.trim() && !after.trim()) {
          // Enter on an empty step leaves the numbered list, like Notion.
          const prose = convertItem(model, item, "prose");
          commitProcedure(model, { focus: focusOf(model, prose, { at: "start" }) });
          return;
        }
        let created;
        if (item.kind === "step") {
          created = splitStep(model, item, before, after);
        } else {
          setBody(item, before);
          created = insertAfter(model, item, newProse(after));
        }
        commitProcedure(model, { focus: focusOf(model, created, { at: "start" }) });
      },
      onMergePrevious: (text) => {
        setBody(item, text);
        const merged = mergeIntoPrevious(model, item, text);
        if (!merged) return;
        commitProcedure(model, {
          focus: focusOf(model, merged.target, { prefix: merged.target.body.slice(0, merged.caret) }),
        });
      },
      onDeleteBlock: () => {
        const previous = previousFlowItem(model, item);
        const steps = flowOf(model).filter((entry) => entry.kind === "step");
        if (item.kind === "step" && steps.length === 1) return;
        removeItem(model, item);
        commitProcedure(model, { focus: previous ? focusOf(model, previous, { at: "end" }) : null });
      },
      onIndent: item.kind === "step" ? () => {
        if (!joinGroupAbove(model, item)) return;
        commitProcedure(model, { focus: focusOf(model, item, { at: "end" }) });
      } : undefined,
      onOutdent: item.kind === "step" ? () => {
        const group = startGroupAt(model, item);
        if (!group) return;
        commitProcedure(model, { focus: focusOf(model, group, { select: true }) });
      } : undefined,
      onFiles: item.kind === "step" ? (files) => {
        for (const file of files) addScreenshot(item, model, file);
      } : undefined,
    };
  }

  function appendProcedureChildren(container, parsedModel = null) {
    const model = parsedModel || readProcedureModel();
    if (!model) return null;
    const todos = todosOf(model);
    if (todos.length) container.append(renderTodoBlock(model, todos));
    for (const item of model.items) {
      if (item.kind === "group") container.append(renderGroupBlock(item, model));
      else if (item.kind === "step") container.append(renderStepBlock(item, model));
      else if (item.kind === "prose") container.append(renderProseBlock(item, model));
    }
    container.append(renderAddStepRow(model));
    return model;
  }

  function renderAddStepRow(model) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-add-row";
    button.textContent = "Add a step";
    button.addEventListener("click", () => {
      const step = insertAfter(model, null, newStep(""));
      commitProcedure(model, { focus: focusOf(model, step, { at: "start" }) });
    });
    return button;
  }

  function renderTodoBlock(model, todos) {
    const block = document.createElement("aside");
    block.className = "block-todos";
    const list = document.createElement("ul");
    for (const todo of todos) {
      const li = document.createElement("li");
      li.className = "block-todo-item";
      li.dataset.uid = todo.uid;
      const label = document.createElement("span");
      label.className = "block-todo-label";
      label.textContent = "TODO";
      const text = document.createElement("span");
      text.className = "block-todo-text";
      text.textContent = todo.text;
      attachInlineEditor(text, {
        getValue: () => todo.text,
        commit: (value) => {
          setTodoText(todo, value);
          commitProcedure(model, { rerender: false });
        },
        restore: () => {
          text.textContent = todo.text;
        },
        multiline: false,
        singleLine: true,
        placeholder: "Describe what is missing",
        onSplit: (before, after) => {
          setTodoText(todo, before);
          const created = insertAfter(model, todo, newTodo(after));
          commitProcedure(model, { focus: focusOf(model, created, { at: "start" }) });
        },
        onDeleteBlock: () => {
          const index = todosOf(model).indexOf(todo);
          removeItem(model, todo);
          const previous = todosOf(model)[Math.max(0, index - 1)];
          commitProcedure(model, { focus: previous ? focusOf(model, previous, { at: "end" }) : null });
        },
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "block-todo-delete";
      del.title = "Remove TODO";
      del.setAttribute("aria-label", "Remove TODO");
      del.textContent = "×";
      del.addEventListener("click", () => {
        const snapshot = snapshotProcedure();
        removeItem(model, todo);
        commitProcedure(model);
        showUndoToast("TODO removed.", () => restoreProcedure(snapshot));
      });
      li.append(label, text, del);
      list.append(li);
    }
    block.append(list);
    return block;
  }

  function renderGroupBlock(group, model) {
    const block = document.createElement("section");
    block.className = "block-group";
    block.dataset.uid = group.uid;

    const header = document.createElement("header");
    header.className = "block-group-header doc-block";
    const title = document.createElement("h3");
    title.className = "block-group-title";
    title.textContent = group.title || "";
    attachInlineEditor(title, {
      getValue: () => group.title || "",
      commit: (value) => {
        setGroupTitle(group, value);
        commitProcedure(model, { rerender: false });
      },
      restore: () => {
        title.textContent = group.title || "";
      },
      plain: true,
      multiline: false,
      singleLine: true,
      placeholder: "Group title",
      onEnterNewBlock: () => {
        const first = block.querySelector(".block-step-body, .block-prose-body");
        if (first) focusEditable(first, "start");
      },
      // Backspace at the start of a group heading joins it to the group above.
      onMergePrevious: () => {
        const first = group.children.find((child) => child.kind === "step");
        if (!first || !joinGroupAbove(model, first)) return;
        commitProcedure(model, { focus: focusOf(model, first, { at: "start" }) });
      },
    });
    header.append(title);
    block.append(header);

    for (const child of group.children) {
      if (child.kind === "step") block.append(renderStepBlock(child, model));
      else if (child.kind === "prose") block.append(renderProseBlock(child, model));
    }
    return block;
  }

  function renderStepBlock(step, model) {
    const block = document.createElement("article");
    block.className = "block-step doc-block";
    block.dataset.stepId = String(step.id);
    block.dataset.uid = step.uid;
    const remember = () => {
      editorState.lastFocusedStep = step;
      editorState.lastFocusedProcedure = model;
    };
    block.addEventListener("focusin", remember);
    block.addEventListener("click", remember);

    const num = document.createElement("span");
    num.className = "block-step-num";
    num.textContent = `${step.number}.`;
    block.append(num);

    const main = document.createElement("div");
    main.className = "block-step-main";

    const body = document.createElement("div");
    body.className = "block-step-body";
    body.append(renderMarkdown(step.body || ""));
    attachInlineEditor(body, {
      getValue: () => step.body || "",
      commit: (value) => {
        setStepBody(step, value);
        commitProcedure(model, { rerender: false });
      },
      restore: () => body.replaceChildren(renderMarkdown(step.body || "")),
      multiline: true,
      placeholder: "Describe this step",
      ...flowKeyboard(step, model),
    });
    main.append(body);

    const meta = stepMeta(step);
    if (meta) {
      const line = document.createElement("div");
      line.className = "block-step-meta";
      line.textContent = meta;
      main.append(line);
    }

    for (const shot of step.screenshots) main.append(renderScreenshot(shot, step, model));
    for (const embed of extractVideoEmbeds(step.body || "")) main.append(renderVideoEmbed(embed));
    block.append(main);
    return block;
  }

  function stepMeta(step) {
    const attrs = step.attrs || {};
    const parts = [];
    if (attrs.action) parts.push(attrs.action);
    if (attrs.tool) parts.push(attrs.tool);
    if (Array.isArray(attrs.systems)) parts.push(...attrs.systems);
    return parts.join(" · ");
  }

  function renderProseBlock(prose, model) {
    const block = document.createElement("div");
    block.className = "block-prose doc-block";
    block.dataset.uid = prose.uid;
    const body = document.createElement("div");
    body.className = "block-prose-body";
    body.append(renderMarkdown(prose.body || ""));
    attachInlineEditor(body, {
      getValue: () => prose.body || "",
      commit: (value) => {
        setProseBody(prose, value);
        commitProcedure(model, { rerender: false });
      },
      restore: () => body.replaceChildren(renderMarkdown(prose.body || "")),
      multiline: true,
      placeholder: "Write a note",
      ...flowKeyboard(prose, model),
    });
    block.append(body);
    return block;
  }

  function renderScreenshot(shot, step, model) {
    const figure = document.createElement("figure");
    figure.className = "block-screenshot";
    figure.dataset.uid = shot.uid;

    const media = document.createElement("div");
    media.className = "block-screenshot-media";
    if (shot.src) {
      const img = document.createElement("img");
      const src = resolveImageSrc(shot.src);
      img.src = src;
      img.alt = shot.alt || "";
      img.loading = "lazy";
      sizeImageFromCache(img, src);
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        openLightbox(img.src, shot.caption || shot.alt || "");
      });
      media.append(img);
    }

    const tools = document.createElement("div");
    tools.className = "block-screenshot-tools";
    if (!shot.caption) {
      const captionTool = document.createElement("button");
      captionTool.type = "button";
      captionTool.className = "block-screenshot-tool";
      captionTool.textContent = "Caption";
      captionTool.addEventListener("click", (event) => {
        event.stopPropagation();
        figure.classList.add("is-caption-visible");
        caption.click?.();
        caption.focus?.();
      });
      tools.append(captionTool);
    }
    const altToggle = document.createElement("button");
    altToggle.type = "button";
    altToggle.className = "block-screenshot-tool";
    altToggle.textContent = "Alt text";
    altToggle.setAttribute("aria-pressed", "false");
    altToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const visible = figure.classList.toggle("is-alt-visible");
      altToggle.setAttribute("aria-pressed", String(visible));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "block-screenshot-tool";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete screenshot");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      const snapshot = snapshotProcedure();
      step.screenshots = step.screenshots.filter((s) => s !== shot);
      step.shotsReordered = true;
      commitProcedure(model);
      showUndoToast("Screenshot deleted.", () => restoreProcedure(snapshot));
    });
    tools.append(altToggle, del);
    media.append(tools);
    figure.append(media);

    const caption = document.createElement("figcaption");
    caption.className = "block-screenshot-caption";
    caption.textContent = shot.caption || "";
    attachInlineEditor(caption, {
      getValue: () => shot.caption || "",
      commit: (value) => {
        setScreenshotField(shot, "caption", value);
        commitProcedure(model, { rerender: false });
      },
      restore: () => {
        caption.textContent = shot.caption || "";
      },
      multiline: true,
      placeholder: "Add a caption",
      onEnterNewBlock: () => focusEditable(neighbourEditable(caption, 1), "start"),
    });
    figure.append(caption);

    const alt = document.createElement("div");
    alt.className = "block-screenshot-alt";
    alt.textContent = shot.alt || "";
    attachInlineEditor(alt, {
      getValue: () => shot.alt || "",
      commit: (value) => {
        setScreenshotField(shot, "alt", value);
        commitProcedure(model, { rerender: false });
      },
      restore: () => {
        alt.textContent = shot.alt || "";
      },
      plain: true,
      multiline: false,
      singleLine: true,
      placeholder: "Describe the image for screen readers",
      onEnterNewBlock: () => focusEditable(neighbourEditable(alt, 1), "start"),
    });
    figure.append(alt);
    return figure;
  }

  function extractVideoEmbeds(text) {
    const embeds = [];
    const seen = new Set();
    for (const match of text.matchAll(/\bhttps?:\/\/[^\s)\]]+/g)) {
      const url = match[0].replace(/[.,;]+$/, "");
      if (seen.has(url)) continue;
      const embed = toVideoEmbed(url);
      if (embed) {
        seen.add(url);
        embeds.push(embed);
      }
    }
    return embeds;
  }

  function renderVideoEmbed(embed) {
    const wrap = document.createElement("div");
    wrap.className = "block-video-embed";
    const iframe = document.createElement("iframe");
    iframe.src = embed.src;
    iframe.allow = "fullscreen; autoplay; encrypted-media";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    wrap.append(iframe);
    return wrap;
  }

  async function addScreenshot(step, model, file) {
    const src = await uploadImage(file);
    if (!src) return;
    step.screenshots.push(newScreenshot(src));
    commitProcedure(model);
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
      services.recordPublication(documentState.currentDoc.revision, payload.revision);
      showFeedback(`Uploaded ${payload.absolute_path}`);
      return payload.absolute_path;
    } catch (err) {
      if (isCurrentDocument()) showFeedback(`Upload failed: ${err.message}`, { kind: "error" });
      return null;
    }
  }

  return {
    addScreenshot, appendProcedureChildren, renderGroupBlock,
    renderStepBlock, uploadImage,
  };
}
