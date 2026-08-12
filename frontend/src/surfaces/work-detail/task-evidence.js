export function createTaskEvidence(context) {
  const {
    createTaskActionButton,
    detail,
    fetchResource,
    refreshTaskPanel,
    renderTaskPanel,
    reportError,
    request,
    settledPayload,
    taskPanelBody,
    taskRequiresApprovedArtifact,
    workApiUrl,
  } = context;

  function renderTaskFileSection(task) {
    if (!task.requiresFile && !task.id) return;
    const section = document.createElement("div");
    section.className = "task-required-link";

    const label = document.createElement("label");
    label.textContent = task.requiresFile ? "Required file" : "Attach file";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0])
        uploadTaskFile(task.id, fileInput.files[0]);
    });
    label.append(fileInput);
    section.append(label);

    // Show existing files
    const fileList = document.createElement("div");
    fileList.className = "task-file-list";
    section.append(fileList);

    taskPanelBody.append(section);
    loadTaskFiles(task.id, fileList);
  }

  async function loadTaskFiles(taskId, container) {
    try {
      const payload = await request(workApiUrl("/api/files", { taskId }));
      const files = Array.isArray(payload) ? payload : payload.files || [];
      const hasActiveTask =
        detail.activeTaskPanelTask && detail.activeTaskPanelTask.id === taskId;
      const hadFiles = Boolean(
        hasActiveTask && detail.activeTaskPanelTask._hasFiles,
      );
      container.replaceChildren();
      if (files.length === 0) {
        if (hasActiveTask) detail.activeTaskPanelTask._hasFiles = false;
        if (hadFiles && detail.activeTaskPanelId === taskId) {
          renderTaskPanel();
          return;
        }
        const empty = document.createElement("small");
        empty.className = "task-file-empty";
        empty.textContent = "No files attached.";
        container.append(empty);
        return;
      }
      if (hasActiveTask) {
        detail.activeTaskPanelTask._hasFiles = true;
        if (!hadFiles && detail.activeTaskPanelId === taskId) {
          renderTaskPanel();
          return;
        }
      }
      for (const file of files) {
        const item = document.createElement("div");
        item.className = "task-file-item";
        const name = document.createElement("span");
        name.textContent = file.filename || file.id;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "quiet-button task-file-remove";
        remove.textContent = "Remove";
        remove.addEventListener("click", () =>
          removeTaskFile(file.id, taskId, container),
        );
        item.append(name, remove);
        container.append(item);
      }
    } catch {
      container.replaceChildren();
      const empty = document.createElement("small");
      empty.className = "task-file-empty";
      empty.textContent = "Could not load files.";
      container.append(empty);
    }
  }

  async function loadArtifactsForTask(task) {
    const results = await Promise.allSettled([
      request(workApiUrl("/api/artifacts", { taskId: task.id })),
      task.bundleId
        ? request(workApiUrl("/api/artifacts", { bundleId: task.bundleId }))
        : Promise.resolve({ artifacts: [] }),
    ]);
    const artifacts = [];
    for (const result of results) {
      const payload = settledPayload(result);
      if (payload && Array.isArray(payload.artifacts))
        artifacts.push(...payload.artifacts);
    }
    return dedupeArtifacts(artifacts);
  }

  async function loadArtifactsForBundle(bundleId) {
    const payload = await request(workApiUrl("/api/artifacts", { bundleId }));
    return dedupeArtifacts(
      Array.isArray(payload?.artifacts) ? payload.artifacts : [],
    );
  }

  function renderTaskArtifactSection(task) {
    taskPanelBody.append(
      renderArtifactList({
        ownerType: "task",
        ownerId: task.id,
        artifacts: detail.activeTaskPanelArtifacts,
        required: taskRequiresApprovedArtifact(task),
        onRefresh: () => refreshTaskPanel(task.id),
      }),
    );
  }

  async function uploadTaskFile(taskId, file) {
    const formData = new FormData();
    formData.append("taskId", taskId);
    formData.append("category", "document");
    formData.append("file", file);
    try {
      const response = await fetchResource(workApiUrl("/api/files"), {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const text = await response.text();
        let msg = `HTTP ${response.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {}
        reportError(`Upload failed: ${msg}`);
        return;
      }
      await response.json();
      if (detail.activeTaskPanelTask)
        detail.activeTaskPanelTask._hasFiles = true;
      renderTaskPanel();
    } catch (err) {
      reportError(`Upload failed: ${err.message || "request failed"}`);
    }
  }

  async function removeTaskFile(fileId, taskId, container) {
    try {
      const url = workApiUrl(`/api/files/${encodeURIComponent(fileId)}`);
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        reportError(`Could not remove file: HTTP ${response.status}`);
        return;
      }
      loadTaskFiles(taskId, container);
    } catch (err) {
      reportError(`Could not remove file: ${err.message || "request failed"}`);
    }
  }

  function dedupeArtifacts(artifacts) {
    const seen = new Set();
    const out = [];
    for (const artifact of artifacts || []) {
      if (!artifact || typeof artifact !== "object" || !artifact.id) continue;
      if (seen.has(artifact.id)) continue;
      seen.add(artifact.id);
      out.push(artifact);
    }
    return out;
  }

  function renderArtifactList(options) {
    const section = document.createElement("div");
    section.className = "task-history";
    const label = document.createElement("div");
    label.className = "task-history-label";
    label.textContent = options.required ? "Artifact proof" : "Artifacts";
    section.append(label);

    const list = document.createElement("div");
    list.className = "task-history-list";
    const artifacts = options.artifacts || [];
    if (artifacts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-history-event";
      empty.textContent = options.required
        ? "No approved artifact attached."
        : "No artifacts registered.";
      list.append(empty);
    }
    for (const artifact of artifacts) {
      const item = document.createElement("div");
      item.className = "task-history-event";
      const link = document.createElement("a");
      link.href = artifact.storageUri || "#";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = artifact.title || artifact.storageUri || artifact.id;
      item.append(link);
      const status = document.createElement("span");
      status.className = `task-status-badge ${artifact.status || "draft"}`;
      status.textContent = artifact.status || "draft";
      item.append(document.createTextNode(" "), status);
      if (artifact.status !== "approved" && artifact.status !== "archived") {
        const approve = createTaskActionButton("Approve", async () =>
          updateArtifactStatus(artifact.id, "approved", options.onRefresh),
        );
        item.append(document.createTextNode(" "), approve);
      }
      list.append(item);
    }
    section.append(list);

    const addRow = document.createElement("div");
    addRow.className = "task-follow-up-row";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Artifact title";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Register";
    addBtn.addEventListener("click", () =>
      registerExternalArtifact({
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        title: titleInput.value.trim(),
        url: urlInput.value.trim(),
        onRefresh: options.onRefresh,
      }),
    );
    addRow.append(titleInput, urlInput, addBtn);
    section.append(addRow);
    return section;
  }

  async function registerExternalArtifact(options) {
    if (!options.url) {
      reportError("Artifact URL is required.");
      return;
    }
    const body = {
      type: "external-link",
      title: options.title || options.url,
      storageUri: options.url,
      storageProvider: "external-url",
      dataClass: "internal",
      sourceType: "manual-link",
      status: "needs-review",
    };
    if (options.ownerType === "task") body.taskId = options.ownerId;
    if (options.ownerType === "bundle") body.bundleId = options.ownerId;
    try {
      await request(workApiUrl("/api/artifacts"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (typeof options.onRefresh === "function") await options.onRefresh();
    } catch (err) {
      reportError(
        `Could not register artifact: ${err.message || "request failed"}`,
      );
    }
  }

  async function updateArtifactStatus(artifactId, status, onRefresh) {
    try {
      await request(
        workApiUrl(`/api/artifacts/${encodeURIComponent(artifactId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ status }),
        },
      );
      if (typeof onRefresh === "function") await onRefresh();
    } catch (err) {
      reportError(
        `Could not update artifact: ${err.message || "request failed"}`,
      );
    }
  }

  return {
    dedupeArtifacts,
    loadArtifactsForBundle,
    loadArtifactsForTask,
    renderArtifactList,
    renderTaskArtifactSection,
    renderTaskFileSection,
  };
}
