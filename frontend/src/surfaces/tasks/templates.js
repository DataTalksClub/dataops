import { createTemplateFields } from "./template-fields.js";

export function createTemplatesSurface(context) {
  const {
    addBeforeUnloadListener,
    confirmDialog,
    countLabel,
    debounce,
    escapeHtml,
    getActiveTasksSection,
    getActiveWorkspaceRoute,
    getAllDocuments,
    getWorkspaceEntityState,
    isOperationsHomeVisible,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    openQuickWorkflowForm,
    referenceCountLabel,
    renderEntityLoadState,
    renderHonestState,
    renderTasksSurface,
    renderWorkflowTemplateCard,
    request,
    setStatus,
    setWorkspaceEntityState,
    workApiUrl,
  } = context;
  let runtimeState = {
    loaded: false,
    templates: [],
    selectedId: null,
    search: "",
    error: "",
    isAdmin: false,
    draft: null,
    baseline: null,
    editorState: "clean",
    feedback: "",
    fieldErrors: {},
    conflict: null,
  };
  const {
    renderRuntimeCardLink,
    renderRuntimeCollection,
    renderRuntimeLineList,
    renderRuntimeMetadataFields,
    renderRuntimePhase,
    renderRuntimeReference,
    renderRuntimeTasks,
    renderRuntimeTriggerFields,
  } = createTemplateFields({
    getRuntimeState: () => runtimeState,
    markRuntimeDraftChanged,
    renderTasksSurface,
    runtimeError,
  });

  function renderTemplatesSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-split-surface";
    section.append(renderRuntimeTemplateAdmin());
    const support = document.createElement("div");
    support.className = "runtime-template-support";
    const templates = document.createElement("div");
    templates.className = "ops-section";
    const templateHeader = document.createElement("div");
    templateHeader.className = "ops-section-header";
    const templateTitle = document.createElement("h3");
    templateTitle.textContent = "Templates";
    const templateMeta = document.createElement("span");
    const manualTemplates = model.templates.filter(
      (template) => !template.recurring,
    );
    templateMeta.textContent = `${countLabel(manualTemplates.length, "template")} available`;
    templateHeader.append(templateTitle, templateMeta);
    templates.append(templateHeader);
    const grid = document.createElement("div");
    grid.className = "ops-template-grid";
    for (const template of manualTemplates)
      grid.append(renderWorkflowTemplateCard(template));
    if (!grid.children.length)
      grid.append(
        renderHonestState(
          "No manual templates indexed",
          "Process docs remain available under Processes.",
        ),
      );
    templates.append(grid);
    support.append(templates);
    section.append(support);
    return section;
  }

  const RUNTIME_TEMPLATE_FIELDS = [
    "name",
    "type",
    "emoji",
    "tags",
    "defaultAssigneeId",
    "phases",
    "sourceDocIds",
    "references",
    "cardLinkDefinitions",
    "triggerType",
    "triggerSchedule",
    "triggerLeadDays",
    "triggerEnabled",
    "taskDefinitions",
  ];

  function runtimeTemplateDefinition(template) {
    const editable = editableRuntimeTemplate(template);
    return {
      name: editable.name || "",
      type: editable.type || "",
      emoji: editable.emoji || "",
      tags: [...(editable.tags || [])],
      defaultAssigneeId: editable.defaultAssigneeId || "",
      phases: structuredClone(editable.phases || []),
      sourceDocIds: [...(editable.sourceDocIds || [])],
      references: structuredClone(editable.references || []),
      cardLinkDefinitions: structuredClone(
        editable.cardLinkDefinitions || [],
      ),
      triggerType: editable.triggerType || "manual",
      triggerSchedule: editable.triggerSchedule || "",
      triggerLeadDays: Number(editable.triggerLeadDays || 0),
      triggerEnabled: editable.triggerEnabled !== false,
      taskDefinitions: structuredClone(editable.taskDefinitions || []),
    };
  }

  function newRuntimeTemplateDraft() {
    return runtimeTemplateDefinition({
      name: "New card template",
      type: "workflow",
      triggerType: "manual",
      triggerEnabled: true,
      taskDefinitions: [
        { refId: "first-task", description: "First task", offsetDays: 0 },
      ],
    });
  }

  function runtimeDraftDirty() {
    return (
      Boolean(runtimeState.draft && runtimeState.baseline) &&
      JSON.stringify(runtimeState.draft) !==
        JSON.stringify(runtimeState.baseline)
    );
  }

  function setRuntimeEditorState(state, feedback = "") {
    runtimeState.editorState = state;
    runtimeState.feedback = feedback;
    const status = document.querySelector("[data-template-save-state]");
    if (status) {
      status.dataset.state = state;
      status.textContent = runtimeTemplateStateLabel();
    }
    const feedbackNode = document.querySelector(".runtime-template-feedback");
    if (feedbackNode) {
      feedbackNode.textContent = feedback;
      feedbackNode.classList.toggle(
        "is-error",
        [
          "validation",
          "permission-error",
          "network-error",
          "conflict",
          "delete-blocked",
        ].includes(state),
      );
    }
  }

  function runtimeTemplateStateLabel() {
    const labels = {
      clean:
        runtimeState.selectedId === "__new__"
          ? "Not yet saved"
          : "No unsaved changes",
      dirty: "Unsaved changes",
      saving: "Saving…",
      saved: "Saved",
      validation: "Fix validation errors",
      "permission-error": "Permission error",
      "network-error": "Save failed",
      conflict: "Conflict — draft preserved",
      "delete-blocked": "Delete blocked",
    };
    return labels[runtimeState.editorState] || "Saved";
  }

  function markRuntimeDraftChanged() {
    runtimeState.conflict = null;
    runtimeState.fieldErrors = {};
    document
      .querySelectorAll(".runtime-field-error")
      .forEach((message) => message.remove());
    document
      .querySelectorAll(".runtime-template-form [aria-invalid='true']")
      .forEach((control) => control.removeAttribute("aria-invalid"));
    setRuntimeEditorState(runtimeDraftDirty() ? "dirty" : "clean");
    const advanced = document.querySelector(".runtime-template-json");
    if (advanced) advanced.value = JSON.stringify(runtimeState.draft, null, 2);
  }

  async function confirmLeaveRuntimeDraft() {
    if (!runtimeDraftDirty()) return true;
    const confirmed = await confirmDialog(
      "This runtime template has unsaved changes. Leave without saving them?",
      { okText: "Leave", danger: true },
    );
    if (!confirmed) return false;
    runtimeState.draft = null;
    runtimeState.baseline = null;
    runtimeState.conflict = null;
    runtimeState.fieldErrors = {};
    runtimeState.editorState = "clean";
    runtimeState.feedback = "";
    return true;
  }

  addBeforeUnloadListener((event) => {
    if (!runtimeDraftDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  async function refreshRuntimeTemplates(options = {}) {
    try {
      const [payload, me] = await Promise.all([
        request(workApiUrl("/api/templates")),
        request(workApiUrl("/api/me")).catch(() => ({})),
      ]);
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: true,
        templates: Array.isArray(payload) ? payload : payload.templates || [],
        isAdmin: me?.user?.role === "admin",
        error: "",
      };
    } catch (error) {
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: false,
        error: error.message || "Runtime templates could not be loaded",
      };
    }
    if (
      options.rerender &&
      getActiveTasksSection() === "templates" &&
      isOperationsHomeVisible()
    ) {
      renderTasksSurface(getAllDocuments(), "templates");
    }
  }

  function editableRuntimeTemplate(template) {
    const editable = {};
    for (const field of RUNTIME_TEMPLATE_FIELDS) {
      if (template?.[field] !== undefined) editable[field] = template[field];
    }
    return editable;
  }

  function runtimeError(key) {
    return runtimeState.fieldErrors[key] || "";
  }

  function validateRuntimeTemplateDraft(draft) {
    const errors = {};
    if (!String(draft.name || "").trim()) errors.name = "Name is required.";
    if (!String(draft.type || "").trim()) errors.type = "Type is required.";
    if (!Array.isArray(draft.taskDefinitions) || !draft.taskDefinitions.length)
      errors.taskDefinitions = "Add at least one task.";
    (draft.taskDefinitions || []).forEach((task, index) => {
      if (!String(task.refId || "").trim())
        errors[`taskDefinitions.${index}.refId`] = "Reference ID is required.";
      if (!String(task.description || "").trim())
        errors[`taskDefinitions.${index}.description`] =
          "Description is required.";
      if (!Number.isFinite(Number(task.offsetDays)))
        errors[`taskDefinitions.${index}.offsetDays`] =
          "Day offset must be a number.";
    });
    return errors;
  }

  function renderRuntimeTemplateAdmin() {
    const section = document.createElement("section");
    section.className = "ops-section runtime-template-admin";
    section.classList.toggle("has-selection", Boolean(runtimeState.selectedId));
    const header = document.createElement("div");
    header.className = "ops-section-header";
    header.innerHTML = `<div><h3>Template administration</h3><span>Templates define the tasks used when a Card is created.</span></div>`;
    if (runtimeState.isAdmin) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "primary-button";
      add.textContent = "New runtime template";
      add.addEventListener("click", async () => {
        if (!(await confirmLeaveRuntimeDraft())) return;
        navigateCanonicalWorkspace(
          "/templates",
          {},
          { entity: { templateId: "__new__" } },
        );
      });
      header.append(add);
    }
    section.append(header);

    if (runtimeState.error) {
      section.append(
        renderHonestState("Runtime templates unavailable", runtimeState.error),
      );
      return section;
    }
    if (!runtimeState.loaded) {
      section.append(
        renderHonestState(
          "Loading runtime templates",
          "Fetching the current database-backed template definitions.",
        ),
      );
      return section;
    }

    const search = document.createElement("input");
    search.type = "search";
    search.className = "runtime-template-search";
    search.placeholder = "Search runtime templates";
    search.value = runtimeState.search;
    search.addEventListener(
      "input",
      debounce(() => {
        runtimeState.search = search.value.trim().toLowerCase();
        renderTasksSurface(getAllDocuments(), "templates");
      }, 150),
    );
    section.append(search);

    const layout = document.createElement("div");
    layout.className = "runtime-template-layout";
    layout.classList.toggle("is-detail", Boolean(runtimeState.selectedId));
    const list = document.createElement("div");
    list.className = "runtime-template-list";
    const templates = runtimeState.templates.filter((template) => {
      const haystack = [
        template.name,
        template.type,
        template.triggerType,
        ...(template.tags || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !runtimeState.search || haystack.includes(runtimeState.search);
    });
    if (!templates.length)
      list.append(
        renderHonestState(
          "No runtime templates match",
          "Create a template or broaden the search.",
        ),
      );
    for (const template of templates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `runtime-template-row ${template.id === runtimeState.selectedId ? "is-selected" : ""}`;
      button.innerHTML = `
        <strong>
          ${escapeHtml(
            template.emoji
              ? `${template.emoji} ${template.name}`
              : template.name || "Unnamed template",
          )}
        </strong>
        <span>
          ${escapeHtml(template.type || "untyped")}
          · ${countLabel((template.taskDefinitions || []).length, "task")}
          · ${escapeHtml(template.triggerType || "manual")}
        </span>
      `;
      button.addEventListener("click", async () => {
        if (template.id === runtimeState.selectedId) return;
        if (!(await confirmLeaveRuntimeDraft())) return;
        navigateCanonicalWorkspace("/templates", { templateId: template.id });
      });
      list.append(button);
    }
    layout.append(list, renderRuntimeTemplateEditor());
    section.append(layout);
    return section;
  }

  function renderRuntimeTemplateBackButton() {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "runtime-mobile-back";
    back.textContent = "Back to template list";
    back.addEventListener("click", async () => {
      if (!(await confirmLeaveRuntimeDraft())) return;
      runtimeState.draft = null;
      runtimeState.baseline = null;
      runtimeState.conflict = null;
      runtimeState.editorState = "clean";
      runtimeState.feedback = "";
      runtimeState.fieldErrors = {};
      await navigateCanonicalWorkspace(
        "/templates",
        {},
        {
          restoreFocus: { kind: "runtime-template-list" },
        },
      ).ready;
    });
    return back;
  }

  function appendRuntimeDefinitionRow(list, labelText, valueText) {
    const term = document.createElement("dt");
    term.textContent = labelText;
    const value = document.createElement("dd");
    value.textContent = valueText || "None";
    list.append(term, value);
  }

  function renderRuntimeTemplateReadOnly(selected) {
    const view = document.createElement("div");
    view.className = "runtime-template-readonly";
    const header = document.createElement("header");
    const title = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = selected.emoji
      ? `${selected.emoji} ${selected.name}`
      : selected.name || selected.id;
    const guidance = document.createElement("p");
    guidance.textContent =
      "Read-only definition. Admin permission is required to change it.";
    title.append(heading, guidance);
    const start = document.createElement("button");
    start.type = "button";
    start.className = "primary-button";
    start.textContent = "Create card";
    start.addEventListener("click", () =>
      openQuickWorkflowForm({
        template: {
          ...selected,
          templateId: selected.id,
          title: selected.name,
        },
      }),
    );
    header.append(title, start);

    const definition = document.createElement("dl");
    definition.className = "runtime-template-definition";
    appendRuntimeDefinitionRow(definition, "Type", selected.type || "untyped");
    appendRuntimeDefinitionRow(
      definition,
      "Trigger",
      [selected.triggerType || "manual", selected.triggerSchedule]
        .filter(Boolean)
        .join(" · "),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Tasks",
      countLabel((selected.taskDefinitions || []).length, "task"),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Tags",
      (selected.tags || []).join(", "),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Default assignee",
      selected.defaultAssigneeId || "Unassigned",
    );
    appendRuntimeDefinitionRow(
      definition,
      "Source documents",
      (selected.sourceDocIds || []).join(", "),
    );

    const tasks = document.createElement("section");
    const taskHeading = document.createElement("h5");
    taskHeading.textContent = "Ordered tasks";
    const taskList = document.createElement("ol");
    taskList.className = "runtime-template-readonly-tasks";
    for (const task of selected.taskDefinitions || []) {
      const item = document.createElement("li");
      const description = document.createElement("strong");
      description.textContent =
        task.description || task.refId || "Untitled task";
      const meta = document.createElement("span");
      meta.textContent = [
        task.refId,
        `day ${Number(task.offsetDays || 0) >= 0 ? "+" : ""}${Number(task.offsetDays || 0)}`,
        task.phase,
        task.isMilestone ? "milestone" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      item.append(description, meta);
      taskList.append(item);
    }
    if (!taskList.children.length) {
      const empty = document.createElement("li");
      empty.textContent =
        "No task definitions. This Template cannot create a useful Card yet.";
      taskList.append(empty);
    }
    tasks.append(taskHeading, taskList);

    const references = document.createElement("section");
    const referencesHeading = document.createElement("h5");
    referencesHeading.textContent = "References and required links";
    const referencesBody = document.createElement("p");
    referencesBody.textContent =
      [
        ...(selected.references || []).map(
          (reference) => reference.name || reference.url,
        ),
        ...(selected.cardLinkDefinitions || []).map((link) => link.name),
      ]
        .filter(Boolean)
        .join(" · ") || "None configured";
    references.append(referencesHeading, referencesBody);
    view.append(header, definition, tasks, references);
    return view;
  }

  function renderRuntimeTemplateEditor() {
    const editor = document.createElement("div");
    editor.className = "runtime-template-editor";
    const workspaceEntityState = getWorkspaceEntityState();
    if (
      workspaceEntityState?.kind === "template" &&
      ["not-found", "error"].includes(workspaceEntityState.status)
    ) {
      renderEntityLoadState(editor, {
        ...workspaceEntityState,
        retry: () => {
          const route = getActiveWorkspaceRoute();
          navigateCanonicalWorkspace(route.path, route.params, {
            history: "none",
          });
        },
        returnToList: () => {
          navigateCanonicalWorkspace("/templates");
        },
      });
      return editor;
    }
    const creating = runtimeState.selectedId === "__new__";
    const selected = runtimeState.templates.find(
      (template) => template.id === runtimeState.selectedId,
    );
    if (!creating && !selected) {
      editor.append(
        renderHonestState(
          runtimeState.isAdmin ? "Template editor" : "Runtime templates",
          runtimeState.isAdmin
            ? "Select a runtime template to edit its complete validated definition."
            : "Operators can inspect and instantiate templates. Template administration is restricted to admins.",
        ),
      );
      return editor;
    }
    if (!runtimeState.isAdmin) {
      editor.append(
        renderRuntimeTemplateBackButton(),
        renderRuntimeTemplateReadOnly(selected),
      );
      return editor;
    }
    if (!runtimeState.draft) {
      runtimeState.draft = creating
        ? newRuntimeTemplateDraft()
        : runtimeTemplateDefinition(selected);
      runtimeState.baseline = structuredClone(runtimeState.draft);
    }
    const value = runtimeState.draft;
    editor.append(renderRuntimeTemplateBackButton());
    const heading = document.createElement("h4");
    heading.textContent = creating
      ? "New runtime template"
      : `Edit ${selected.name || selected.id}`;
    const guidance = document.createElement("p");
    guidance.textContent =
      "Use the structured fields below. Task order becomes the Card checklist order; Advanced JSON is a read-only review of the normalized draft.";
    const saveState = document.createElement("span");
    saveState.className = "runtime-template-save-state";
    saveState.dataset.templateSaveState = "";
    saveState.dataset.state = runtimeState.editorState;
    saveState.setAttribute("role", "status");
    saveState.setAttribute("aria-live", "polite");
    saveState.textContent = runtimeTemplateStateLabel();

    const form = document.createElement("div");
    form.className = "runtime-template-form";
    form.append(
      renderRuntimeMetadataFields(value),
      renderRuntimeTriggerFields(value),
    );
    form.append(
      renderRuntimeCollection(
        "Phases",
        "phases",
        value.phases,
        () => ({ id: "new-phase", name: "New phase", stage: "preparation" }),
        renderRuntimePhase,
      ),
    );
    form.append(
      renderRuntimeLineList(
        "Source document IDs",
        "sourceDocIds",
        value.sourceDocIds,
        "One document ID per line",
      ),
    );
    form.append(
      renderRuntimeCollection(
        "References",
        "references",
        value.references,
        () => ({ name: "New reference", url: "" }),
        renderRuntimeReference,
      ),
    );
    form.append(
      renderRuntimeCollection(
        "Card links",
        "cardLinkDefinitions",
        value.cardLinkDefinitions,
        () => ({ name: "New link" }),
        renderRuntimeCardLink,
      ),
    );
    form.append(renderRuntimeTasks(value));

    const advanced = document.createElement("details");
    advanced.className = "runtime-template-advanced";
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Advanced JSON";
    const textarea = document.createElement("textarea");
    textarea.className = "runtime-template-json";
    textarea.readOnly = true;
    textarea.setAttribute(
      "aria-label",
      "Normalized runtime template JSON (read only)",
    );
    textarea.value = JSON.stringify(value, null, 2);
    advanced.append(advancedSummary, textarea);
    const feedback = document.createElement("p");
    feedback.className = "runtime-template-feedback";
    feedback.setAttribute("role", "alert");
    feedback.textContent = runtimeState.feedback;
    feedback.classList.toggle(
      "is-error",
      [
        "validation",
        "permission-error",
        "network-error",
        "conflict",
        "delete-blocked",
      ].includes(runtimeState.editorState),
    );
    const actions = document.createElement("div");
    actions.className = "runtime-template-actions";
    const destructiveActions = document.createElement("div");
    destructiveActions.className = "runtime-template-destructive";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.textContent = creating ? "Create template" : "Save template";
    save.disabled = runtimeState.editorState === "saving";
    save.addEventListener("click", async () => {
      const errors = validateRuntimeTemplateDraft(value);
      runtimeState.fieldErrors = errors;
      if (Object.keys(errors).length) {
        setRuntimeEditorState(
          "validation",
          "Review the highlighted fields before saving.",
        );
        renderTasksSurface(getAllDocuments(), "templates");
        document
          .querySelector(".runtime-field-error")
          ?.closest("label, fieldset")
          ?.querySelector("input, textarea, select")
          ?.focus();
        return;
      }
      if (runtimeState.editorState === "saving") return;
      setRuntimeEditorState(
        "saving",
        creating ? "Creating template…" : "Saving template…",
      );
      save.disabled = true;
      const payload = runtimeTemplateDefinition(value);
      if (!creating) payload.expectedVersion = selected.version;
      try {
        const response = await request(
          workApiUrl(
            creating
              ? "/api/templates"
              : `/api/templates/${encodeURIComponent(selected.id)}`,
          ),
          {
            method: creating ? "POST" : "PUT",
            body: JSON.stringify(payload),
          },
        );
        const saved = response.template || response;
        runtimeState.templates = runtimeState.templates
          .filter((item) => item.id !== saved.id)
          .concat(saved);
        runtimeState.selectedId = saved.id;
        runtimeState.draft = runtimeTemplateDefinition(saved);
        runtimeState.baseline = structuredClone(runtimeState.draft);
        runtimeState.conflict = null;
        runtimeState.fieldErrors = {};
        runtimeState.editorState = "saved";
        runtimeState.feedback = `Saved version ${saved.version}.`;
        setStatus(
          creating ? "Runtime template created." : "Runtime template saved.",
        );
        if (runtimeState.selectedId) {
          await navigateCanonicalWorkspace(
            "/templates",
            { templateId: runtimeState.selectedId },
            { hydrate: false },
          ).ready;
        }
      } catch (error) {
        save.disabled = false;
        if (error.status === 409) {
          runtimeState.conflict = error.payload || {};
          setRuntimeEditorState(
            "conflict",
            `A newer server version${error.payload?.currentVersion ? ` (${error.payload.currentVersion})` : ""} exists. Your draft is preserved.`,
          );
          renderTasksSurface(getAllDocuments(), "templates");
        } else {
          setRuntimeEditorState(
            [401, 403].includes(error.status)
              ? "permission-error"
              : "network-error",
            error.message || "Template save failed. Your draft is preserved.",
          );
        }
      }
    });
    actions.append(save);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel changes";
    cancel.addEventListener("click", async () => {
      if (
        runtimeDraftDirty() &&
        !(await confirmDialog("Discard the unsaved template changes?", {
          okText: "Discard",
          danger: true,
        }))
      )
        return;
      runtimeState.draft = structuredClone(runtimeState.baseline);
      runtimeState.fieldErrors = {};
      runtimeState.conflict = null;
      runtimeState.editorState = "clean";
      runtimeState.feedback = "";
      renderTasksSurface(getAllDocuments(), "templates");
    });
    actions.append(cancel);
    if (runtimeState.editorState === "conflict" && !creating) {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Reload server version";
      reload.addEventListener("click", async () => {
        if (
          !(await confirmDialog(
            "Replace this local draft with the current server version?",
            { okText: "Reload", danger: true },
          ))
        )
          return;
        const response = await request(
          workApiUrl(`/api/templates/${encodeURIComponent(selected.id)}`),
        );
        const current = response.template || response;
        runtimeState.templates = runtimeState.templates.map((item) =>
          item.id === current.id ? current : item,
        );
        runtimeState.draft = runtimeTemplateDefinition(current);
        runtimeState.baseline = structuredClone(runtimeState.draft);
        runtimeState.editorState = "clean";
        runtimeState.feedback = `Reloaded version ${current.version}.`;
        runtimeState.conflict = null;
        renderTasksSurface(getAllDocuments(), "templates");
      });
      actions.append(reload);
    }
    if (!creating) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "Delete template";
      remove.addEventListener("click", async () => {
        if (
          !(await confirmDialog(
            `Delete runtime template “${selected.name || selected.id}”? Referenced templates cannot be deleted.`,
            { okText: "Delete", danger: true },
          ))
        )
          return;
        try {
          await request(
            workApiUrl(`/api/templates/${encodeURIComponent(selected.id)}`),
            {
              method: "DELETE",
              body: JSON.stringify({ expectedVersion: selected.version }),
            },
          );
          runtimeState.selectedId = null;
          runtimeState.draft = null;
          runtimeState.baseline = null;
          setStatus("Runtime template deleted.");
          await navigateCanonicalWorkspace("/templates").ready;
        } catch (error) {
          if (error.payload?.code === "template_in_use") {
            const categories = Object.entries(
              error.payload.references?.categories || {},
            )
              .map(([name, count]) => referenceCountLabel(name, count))
              .join(", ");
            setRuntimeEditorState(
              "delete-blocked",
              `This template is still referenced${categories ? ` by ${categories}` : ""}. Remove those references before deleting.`,
            );
          } else if (error.status === 409) {
            runtimeState.conflict = error.payload || {};
            setRuntimeEditorState(
              "conflict",
              "The template changed before deletion. Your draft is preserved.",
            );
            renderTasksSurface(getAllDocuments(), "templates");
          } else {
            setRuntimeEditorState(
              [401, 403].includes(error.status)
                ? "permission-error"
                : "network-error",
              error.message || "Template deletion failed",
            );
          }
        }
      });
      destructiveActions.append(remove);
    }
    const editorHeader = document.createElement("header");
    editorHeader.append(heading, saveState);
    editor.append(editorHeader, guidance, actions, feedback, form, advanced);
    if (destructiveActions.children.length) editor.append(destructiveActions);
    return editor;
  }

  async function resolveTemplateRouteEntity(route, token) {
    await refreshRuntimeTemplates({ token });
    if (!isWorkspaceRouteFresh(token)) return;
    const templateId = route.params.get("templateId");
    if (!templateId) {
      setWorkspaceEntityState(null);
      renderTasksSurface(getAllDocuments(), "templates");
      return;
    }
    let template = runtimeState.templates.find(
      (candidate) => candidate.id === templateId,
    );
    if (!template) {
      try {
        const payload = await request(
          workApiUrl(`/api/templates/${encodeURIComponent(templateId)}`),
        );
        if (!isWorkspaceRouteFresh(token)) return;
        template = payload.template || payload;
        runtimeState.templates = [template, ...runtimeState.templates];
      } catch (error) {
        if (!isWorkspaceRouteFresh(token)) return;
        setWorkspaceEntityState({
          kind: "template",
          id: templateId,
          status: error.status === 404 ? "not-found" : "error",
          error: error.message,
        });
      }
    }
    if (template) {
      setWorkspaceEntityState({
        kind: "template",
        id: templateId,
        status: "ready",
      });
    }
    runtimeState.selectedId = templateId;
    renderTasksSurface(getAllDocuments(), "templates");
  }

  function setRuntimeTemplateRoute(route, entity) {
    runtimeState.selectedId =
      route?.tasksSection === "templates"
        ? (entity?.templateId ?? route.params.get("templateId"))
        : null;
  }

  return {
    confirmLeaveRuntimeDraft,
    getRuntimeTemplateState: () => runtimeState,
    refreshRuntimeTemplates,
    renderTemplatesSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  };
}
