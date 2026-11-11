import { renderIcon } from "../../core/icons.js";
import { documentHref, opensInNewTab } from "../../core/links.js";
import { browserRequirementParts } from "../../core/task-display.js";

// A step's own bindings, read from its definition and nothing else: the
// process document it runs (`instructionDocId`, optionally one numbered step
// inside it) and any template documents. A `template.*` instruction document
// is the step's template binding; it never borrows from the Template-wide
// process-docs list.
export function templateStepBindings(task, resolveDocReference = () => null) {
  const bind = (id) => {
    const doc = id ? resolveDocReference(id) : null;
    return { id, title: doc?.title || id, href: doc?.path ? documentHref(doc.path) : "" };
  };
  const docId = typeof task?.instructionDocId === "string" ? task.instructionDocId.trim() : "";
  const isTemplateDoc = /^(text-)?template\./.test(docId);
  return {
    processDoc: docId && !isTemplateDoc ? bind(docId) : null,
    templates: docId && isTemplateDoc ? [bind(docId)] : [],
    instructionStepId: task?.instructionStepId ? String(task.instructionStepId) : "",
    instructionsUrl: typeof task?.instructionsUrl === "string" ? task.instructionsUrl : "",
  };
}

// The Templates Steps list. Open rows persist across surface rerenders, keyed
// by template and step ref.
export function createTemplateSteps({ appendDefinition, dayOffsetLabel, humanize, resolveDocReference = () => null }) {
  const openStepRefs = new Set();

  // One Steps row: the name (with a browser glyph when the step needs an
  // interactive browser) and its due offset on the right. The row opens in
  // place to show that step's own instructions and settings, so the Steps
  // list and the Templates list both stay where they are.
  function renderTemplateStep(template, task) {
    const key = `${template.id}:${task.refId || task.description || ""}`;
    const item = document.createElement("li");
    item.className = "runtime-template-step";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "runtime-template-step-toggle";
    const name = document.createElement("strong");
    name.className = "runtime-template-step-name";
    name.append(document.createTextNode(task.description || task.refId || "Untitled task"));
    const browser = browserRequirementParts(task.browserRequirement);
    if (task.browserRequirement === "required") {
      const icon = renderIcon(browser.icon, { size: 14 });
      icon.classList.add("runtime-template-step-browser");
      icon.setAttribute("role", "img");
      icon.setAttribute("aria-label", browser.label);
      icon.removeAttribute("aria-hidden");
      const title = document.createElement("title");
      title.textContent = browser.label;
      icon.append(title);
      name.append(document.createTextNode(" "), icon);
    }
    const meta = document.createElement("span");
    meta.className = "runtime-template-step-due";
    meta.textContent = dayOffsetLabel(task.offsetDays, task.anchor);
    toggle.append(name, meta);
    const open = openStepRefs.has(key);
    toggle.setAttribute("aria-expanded", String(open));
    item.append(toggle);
    let detail = open ? renderTemplateStepDetail(task) : null;
    if (detail) item.append(detail);
    toggle.addEventListener("click", () => {
      const next = !openStepRefs.has(key);
      if (next) openStepRefs.add(key);
      else openStepRefs.delete(key);
      toggle.setAttribute("aria-expanded", String(next));
      if (next) {
        detail = renderTemplateStepDetail(task);
        item.append(detail);
      } else if (detail) {
        detail.remove();
        detail = null;
      }
    });
    return item;
  }

  function appendStepLink(list, label, binding, suffix = "") {
    const value = document.createElement(binding.href ? "a" : "span");
    value.textContent = `${binding.title}${suffix}`;
    if (binding.href) {
      value.href = binding.href;
      value.title = binding.id;
      opensInNewTab(value);
    }
    const term = document.createElement("dt");
    term.textContent = label;
    const desc = document.createElement("dd");
    desc.append(value);
    list.append(term, desc);
  }

  function renderTemplateStepDetail(task) {
    const detail = document.createElement("dl");
    detail.className = "runtime-template-definition runtime-template-step-detail";
    const bindings = templateStepBindings(task, resolveDocReference);
    if (bindings.processDoc) {
      appendStepLink(
        detail,
        "Process doc",
        bindings.processDoc,
        bindings.instructionStepId ? ` · step ${bindings.instructionStepId}` : "",
      );
    } else if (!bindings.templates.length) {
      appendDefinition(detail, "Process doc", task.instructionExemptReason || "None bound to this step");
    }
    for (const template of bindings.templates) appendStepLink(detail, "Template", template);
    if (bindings.instructionsUrl) {
      appendStepLink(detail, "Instructions", {
        id: bindings.instructionsUrl,
        title: bindings.instructionsUrl,
        href: bindings.instructionsUrl,
      });
    }
    const browser = browserRequirementParts(task.browserRequirement);
    if (browser.classified) appendDefinition(detail, "Browser", browser.label);
    if (task.ownerRole) appendDefinition(detail, "Owner role", humanize(task.ownerRole));
    if (task.taskKind) appendDefinition(detail, "Kind", humanize(task.taskKind));
    if (Array.isArray(task.tools) && task.tools.length) appendDefinition(detail, "Tools", task.tools.join(", "));
    if (Array.isArray(task.requires) && task.requires.length) appendDefinition(detail, "Requires", task.requires.join(", "));
    if (Array.isArray(task.dependsOn) && task.dependsOn.length) appendDefinition(detail, "After", task.dependsOn.join(", "));
    if (task.optionalGroup) appendDefinition(detail, "Optional group", task.optionalGroup);
    if (task.requiredLinkName) appendDefinition(detail, "Card link", task.requiredLinkName);
    if (task.closure?.successCriteria) appendDefinition(detail, "Done when", task.closure.successCriteria);
    return detail;
  }

  return { renderTemplateStep };
}
