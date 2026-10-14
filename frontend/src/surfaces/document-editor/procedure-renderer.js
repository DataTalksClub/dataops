import { editorFeedbackFor, editorMutationGuard } from "./feedback.js";
import {
  insertAfter,
  newScreenshot,
  newStep,
  removeItem,
  setGroupTitle,
  setProseBody,
  setScreenshotField,
  setStepBody,
  setTodoText,
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

  function appendProcedureChildren(container) {
    const model = readProcedureModel();
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
      commitProcedure(model, { focus: { stepId: step.id } });
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
      multiline: false,
      singleLine: true,
      placeholder: "Group title",
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
      multiline: false,
      singleLine: true,
      placeholder: "Describe the image for screen readers",
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
    if (!documentState.currentDoc) return;
    const path = documentState.currentDoc.path;
    const isFresh = editorMutationGuard(context);
    const isCurrentDocument = () =>
      isFresh() && documentState.currentDoc?.path === path;
    showFeedback("Uploading image…", { kind: "pending" });
    try {
      const data = await fileToBase64(file);
      if (!isCurrentDocument()) return;
      const payload = await request(apiUrl("/images"), {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: documentState.currentDoc.revision,
          doc_path: path,
          filename: file.name,
          data,
        }),
      });
      if (!isCurrentDocument()) return;
      services.recordPublication(documentState.currentDoc.revision, payload.revision);
      step.screenshots.push(newScreenshot(payload.absolute_path));
      commitProcedure(model);
      showFeedback(`Uploaded ${payload.absolute_path}`);
    } catch (err) {
      if (!isCurrentDocument()) return;
      showFeedback(`Upload failed: ${err.message}`, { kind: "error" });
    }
  }

  return {
    addScreenshot, appendProcedureChildren, renderGroupBlock,
    renderStepBlock,
  };
}

export function toVideoEmbed(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id) return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (host.endsWith("youtube.com") && u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id) return { src: `https://www.youtube.com/embed/${id}`, kind: "youtube" };
    }
    if (host === "vimeo.com") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id) return { src: `https://player.vimeo.com/video/${id}`, kind: "vimeo" };
    }
    if (host === "loom.com") {
      const match = u.pathname.match(/^\/(?:share|embed)\/([a-z0-9]+)/i);
      if (match) return { src: `https://www.loom.com/embed/${match[1]}`, kind: "loom" };
    }
  } catch {}
  return null;
}
