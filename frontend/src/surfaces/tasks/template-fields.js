export function createTemplateFields(context) {
  const {
    getRuntimeState,
    markRuntimeDraftChanged,
    renderTasksSurface,
    runtimeError,
  } = context;

  function runtimeField(labelText, value, onInput, options = {}) {
    const label = document.createElement("label");
    label.className = options.wide ? "wide" : "";
    const title = document.createElement("span");
    title.textContent = labelText;
    const control = document.createElement(
      options.multiline ? "textarea" : options.select ? "select" : "input",
    );
    if (!options.multiline && !options.select)
      control.type = options.type || "text";
    if (options.select) {
      for (const choice of options.select) {
        const option = document.createElement("option");
        option.value = typeof choice === "string" ? choice : choice.value;
        option.textContent = typeof choice === "string" ? choice : choice.label;
        control.append(option);
      }
    }
    control.value = value ?? "";
    if (options.placeholder) control.placeholder = options.placeholder;
    if (options.required) control.required = true;
    if (options.min !== undefined) control.min = String(options.min);
    control.addEventListener(options.select ? "change" : "input", () => {
      const next =
        options.type === "number"
          ? control.value === ""
            ? 0
            : Number(control.value)
          : control.value;
      onInput(next);
      markRuntimeDraftChanged();
    });
    label.append(title, control);
    const error = runtimeError(options.errorKey || "");
    if (error) {
      control.setAttribute("aria-invalid", "true");
      const message = document.createElement("small");
      message.className = "runtime-field-error";
      message.textContent = error;
      label.append(message);
    }
    return label;
  }

  function runtimeCheckbox(labelText, checked, onChange) {
    const label = document.createElement("label");
    label.className = "runtime-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => {
      onChange(input.checked);
      markRuntimeDraftChanged();
    });
    label.append(input, document.createTextNode(labelText));
    return label;
  }

  function csvValues(value) {
    return String(value || "")
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function renderRuntimeMetadataFields(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-grid";
    fieldset.innerHTML = "<legend>Template details</legend>";
    fieldset.append(
      runtimeField(
        "Name",
        draft.name,
        (value) => {
          draft.name = value;
        },
        { required: true, errorKey: "name" },
      ),
      runtimeField(
        "Type",
        draft.type,
        (value) => {
          draft.type = value;
        },
        { required: true, errorKey: "type" },
      ),
      runtimeField("Emoji", draft.emoji, (value) => {
        draft.emoji = value;
      }),
      runtimeField(
        "Tags",
        (draft.tags || []).join(", "),
        (value) => {
          draft.tags = csvValues(value);
        },
        { placeholder: "newsletter, weekly" },
      ),
      runtimeField(
        "Default assignee ID",
        draft.defaultAssigneeId,
        (value) => {
          draft.defaultAssigneeId = value;
        },
        { wide: true },
      ),
    );
    return fieldset;
  }

  function renderRuntimeTriggerFields(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-grid";
    fieldset.innerHTML = "<legend>Trigger settings</legend>";
    fieldset.append(
      runtimeField(
        "Trigger type",
        draft.triggerType,
        (value) => {
          draft.triggerType = value;
        },
        { select: ["manual", "automatic"] },
      ),
      runtimeField(
        "Schedule",
        draft.triggerSchedule,
        (value) => {
          draft.triggerSchedule = value;
        },
        { placeholder: "0 9 * * 1" },
      ),
      runtimeField(
        "Lead time (days)",
        draft.triggerLeadDays,
        (value) => {
          draft.triggerLeadDays = value;
        },
        { type: "number", min: 0 },
      ),
      runtimeCheckbox("Trigger enabled", draft.triggerEnabled, (value) => {
        draft.triggerEnabled = value;
      }),
    );
    return fieldset;
  }

  function renderRuntimeCollection(title, key, items, createItem, renderItem) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-collection";
    const legend = document.createElement("legend");
    legend.textContent = title;
    fieldset.append(legend);
    items.forEach((item, index) => {
      const row = renderItem(item, index, key);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "runtime-remove-button";
      remove.textContent = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${title.toLowerCase()} item ${index + 1}`,
      );
      remove.addEventListener("click", () => {
        items.splice(index, 1);
        markRuntimeDraftChanged();
        renderTasksSurface(getAllDocuments(), "templates");
      });
      row.append(remove);
      fieldset.append(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "runtime-add-button";
    add.textContent = `Add ${title.replace(/s$/, "").toLowerCase()}`;
    add.addEventListener("click", () => {
      items.push(createItem());
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    fieldset.append(add);
    return fieldset;
  }

  function renderRuntimePhase(phase) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField("Phase ID", phase.id, (value) => {
        phase.id = value;
      }),
      runtimeField("Phase name", phase.name, (value) => {
        phase.name = value;
      }),
      runtimeField(
        "Stage",
        phase.stage || "",
        (value) => {
          phase.stage = value;
        },
        { select: ["", "preparation", "announced", "after-event", "done"] },
      ),
    );
    return row;
  }

  function renderRuntimeReference(reference) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField("Reference name", reference.name, (value) => {
        reference.name = value;
      }),
      runtimeField(
        "Reference URL",
        reference.url,
        (value) => {
          reference.url = value;
        },
        { type: "url", wide: true },
      ),
    );
    return row;
  }

  function renderRuntimeBundleLink(link) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField(
        "Bundle link name",
        link.name,
        (value) => {
          link.name = value;
        },
        { wide: true },
      ),
    );
    return row;
  }

  function renderRuntimeLineList(title, key, values, placeholder) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset";
    const legend = document.createElement("legend");
    legend.textContent = title;
    fieldset.append(
      legend,
      runtimeField(
        title,
        (values || []).join("\n"),
        (value) => {
          getRuntimeState().draft[key] = csvValues(value);
        },
        { multiline: true, placeholder, wide: true },
      ),
    );
    return fieldset;
  }

  function refIds(refs, idField) {
    return (refs || [])
      .map((ref) => ref?.[idField])
      .filter(Boolean)
      .join(", ");
  }

  function updateRefs(task, key, idField, value) {
    const existing = new Map(
      (task[key] || []).map((ref) => [ref?.[idField], ref]),
    );
    task[key] = csvValues(value).map(
      (id) => existing.get(id) || { [idField]: id },
    );
  }

  function renderRuntimeTasks(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-tasks";
    const legend = document.createElement("legend");
    legend.textContent = "Ordered tasks";
    fieldset.append(legend);
    draft.taskDefinitions.forEach((task, index) =>
      fieldset.append(renderRuntimeTask(task, index, draft.taskDefinitions)),
    );
    const add = document.createElement("button");
    add.type = "button";
    add.className = "runtime-add-button";
    add.textContent = "Add task";
    add.addEventListener("click", () => {
      draft.taskDefinitions.push({
        refId: `task-${draft.taskDefinitions.length + 1}`,
        description: "New task",
        offsetDays: 0,
      });
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    fieldset.append(add);
    const error = runtimeError("taskDefinitions");
    if (error) {
      const message = document.createElement("small");
      message.className = "runtime-field-error";
      message.textContent = error;
      fieldset.append(message);
    }
    return fieldset;
  }

  function renderRuntimeTask(task, index, tasks) {
    const card = document.createElement("fieldset");
    card.className = "runtime-task-card";
    const legend = document.createElement("legend");
    legend.textContent = `Task ${index + 1}: ${task.description || task.refId || "Untitled"}`;
    const order = document.createElement("div");
    order.className = "runtime-task-order";
    for (const [label, delta] of [
      ["Move up", -1],
      ["Move down", 1],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `${label} task ${index + 1}`);
      button.disabled = index + delta < 0 || index + delta >= tasks.length;
      button.addEventListener("click", () => {
        const nextIndex = index + delta;
        const [moved] = tasks.splice(index, 1);
        tasks.splice(nextIndex, 0, moved);
        markRuntimeDraftChanged();
        renderTasksSurface(getAllDocuments(), "templates");
        const contextualLabel =
          nextIndex === 0 && label === "Move up"
            ? "Move down"
            : nextIndex === tasks.length - 1 && label === "Move down"
              ? "Move up"
              : label;
        document
          .querySelector(
            `[aria-label="${contextualLabel} task ${nextIndex + 1}"]`,
          )
          ?.focus();
      });
      order.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "runtime-remove-button";
    remove.textContent = "Remove task";
    remove.setAttribute("aria-label", `Remove task ${index + 1}`);
    remove.addEventListener("click", () => {
      tasks.splice(index, 1);
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    order.append(remove);
    const grid = document.createElement("div");
    grid.className = "runtime-grid";
    const errorPrefix = `taskDefinitions.${index}`;
    grid.append(
      runtimeField(
        "Reference ID",
        task.refId,
        (value) => {
          task.refId = value;
        },
        { required: true, errorKey: `${errorPrefix}.refId` },
      ),
      runtimeField(
        "Day offset",
        task.offsetDays,
        (value) => {
          task.offsetDays = value;
        },
        { type: "number", errorKey: `${errorPrefix}.offsetDays` },
      ),
      runtimeField(
        "Description",
        task.description,
        (value) => {
          task.description = value;
        },
        {
          multiline: true,
          wide: true,
          required: true,
          errorKey: `${errorPrefix}.description`,
        },
      ),
      runtimeField("Phase", task.phase || "", (value) => {
        task.phase = value;
      }),
      runtimeField("Assignee ID", task.assigneeId || "", (value) => {
        task.assigneeId = value;
      }),
      runtimeField(
        "Instructions URL",
        task.instructionsUrl || "",
        (value) => {
          task.instructionsUrl = value;
        },
        { type: "url", wide: true },
      ),
      runtimeField(
        "Instruction document ID",
        task.instructionDocId || "",
        (value) => {
          task.instructionDocId = value;
        },
      ),
      runtimeField(
        "Instruction step",
        task.instructionStepId || "",
        (value) => {
          task.instructionStepId = value;
        },
      ),
      runtimeField("Systems", (task.systems || []).join(", "), (value) => {
        task.systems = csvValues(value);
      }),
      runtimeField(
        "Required bundle link",
        task.requiredLinkName || "",
        (value) => {
          task.requiredLinkName = value;
        },
      ),
      runtimeField(
        "Completion stage",
        task.stageOnComplete || "",
        (value) => {
          task.stageOnComplete = value;
        },
        { select: ["", "preparation", "announced", "after-event", "done"] },
      ),
    );
    const validation =
      task.validation && typeof task.validation === "object"
        ? task.validation
        : {};
    grid.append(
      runtimeField(
        "Validation guidance",
        typeof task.validation === "string" ? task.validation : "",
        (value) => {
          if (value) task.validation = value;
          else if (Object.keys(validation).length) task.validation = validation;
          else delete task.validation;
        },
        { wide: true },
      ),
      runtimeField(
        "Required bundle links",
        (validation.requiredBundleLinks || []).join(", "),
        (value) => {
          const links = csvValues(value);
          task.validation = { ...validation, requiredBundleLinks: links };
          if (!links.length) delete task.validation.requiredBundleLinks;
          if (!Object.keys(task.validation).length) delete task.validation;
        },
        { wide: true },
      ),
    );
    if (
      task.validation &&
      typeof task.validation === "object" &&
      Object.keys(task.validation).some((key) => key !== "requiredBundleLinks")
    ) {
      const preserved = document.createElement("small");
      preserved.className = "runtime-preserved-note";
      preserved.textContent =
        "Additional validation settings are preserved and visible in Advanced JSON.";
      grid.append(preserved);
    }
    const proof = task.proofRequirement || {
      type: "",
      label: "",
      required: true,
    };
    grid.append(
      runtimeField(
        "Proof type",
        proof.type || "",
        (value) => {
          if (!value) delete task.proofRequirement;
          else
            task.proofRequirement = {
              ...proof,
              type: value,
              required: proof.required !== false,
            };
        },
        {
          select: ["", "url", "file", "artifact", "comment", "external-status"],
        },
      ),
      runtimeField("Proof label", proof.label || "", (value) => {
        if (task.proofRequirement) task.proofRequirement.label = value;
      }),
      runtimeCheckbox("Proof required", proof.required !== false, (value) => {
        if (task.proofRequirement) task.proofRequirement.required = value;
      }),
      runtimeCheckbox("Milestone", task.isMilestone, (value) => {
        task.isMilestone = value;
      }),
      runtimeCheckbox("Required file", task.requiresFile, (value) => {
        task.requiresFile = value;
      }),
      runtimeField(
        "Artifact reference IDs",
        refIds(task.artifactRefs, "artifactId"),
        (value) => updateRefs(task, "artifactRefs", "artifactId", value),
        { wide: true },
      ),
      runtimeField(
        "Assistant job reference IDs",
        refIds(task.assistantJobRefs, "assistantJobId"),
        (value) =>
          updateRefs(task, "assistantJobRefs", "assistantJobId", value),
        { wide: true },
      ),
      runtimeField(
        "Audit event reference IDs",
        refIds(task.auditEventRefs, "auditEventId"),
        (value) => updateRefs(task, "auditEventRefs", "auditEventId", value),
        { wide: true },
      ),
      runtimeField(
        "Intake reference IDs",
        refIds(task.intakeRefs, "intakeItemId"),
        (value) => updateRefs(task, "intakeRefs", "intakeItemId", value),
        { wide: true },
      ),
    );
    card.append(legend, order, grid);
    return card;
  }

  return {
    renderRuntimeBundleLink,
    renderRuntimeCollection,
    renderRuntimeLineList,
    renderRuntimeMetadataFields,
    renderRuntimePhase,
    renderRuntimeReference,
    renderRuntimeTasks,
    renderRuntimeTriggerFields,
  };
}
