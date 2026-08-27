import { createCollectionLoader } from "../../core/collection-loader.js";

export function createTaskEvidence(context) {
  const {
    createTaskActionButton,
    detail,
    fetchResource,
    getActiveWorkspaceRouteToken = () => 0,
    isWorkspaceRouteFresh = () => true,
    refreshTaskPanel,
    renderTaskPanel,
    request,
    scheduleAnimationFrame,
    setCardPanelFeedback,
    setTaskPanelFeedback,
    settledPayload,
    taskPanelBody,
    taskRequiresApprovedArtifact,
    workApiUrl,
  } = context;

  const taskFilesLoaders = new Map();
  const taskFilesContinuations = new Map();
  const taskFilesSettledCallbacks = new Map();

  function evidenceOwnerIsCurrent(ownerType, ownerId, token) {
    if (!isWorkspaceRouteFresh(token)) return false;
    if (ownerType === "card") return detail.activeCardPanelId === ownerId;
    return detail.activeTaskPanelId === ownerId;
  }

  function setEvidenceFeedback(ownerType, ownerId, token, feedback) {
    if (!evidenceOwnerIsCurrent(ownerType, ownerId, token)) return false;
    const setter = ownerType === "card"
      ? setCardPanelFeedback
      : setTaskPanelFeedback;
    if (typeof setter !== "function") return false;
    setter(feedback);
    return true;
  }

  function ownerMutationBusy(ownerType, ownerId) {
    if (!evidenceOwnerIsCurrent(ownerType, ownerId, getActiveWorkspaceRouteToken())) return false;
    return detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy;
  }

  function beginEvidenceMutation(ownerType, ownerId, token, feedback) {
    const ownerIsCurrent = evidenceOwnerIsCurrent(ownerType, ownerId, token);
    const ownerHasPanel = ownerType === "card"
      ? Boolean(detail.activeCardPanelId)
      : Boolean(detail.activeTaskPanelId);
    if ((!ownerIsCurrent && ownerHasPanel) ||
        (ownerIsCurrent && ownerMutationBusy(ownerType, ownerId))) {
      return false;
    }
    if (!ownerIsCurrent) return true;
    if (ownerType === "card") detail.activeCardMutationBusy = true;
    else detail.activeTaskMutationBusy = true;
    return setEvidenceFeedback(ownerType, ownerId, token, feedback);
  }

  function finishEvidenceMutation(ownerType, ownerId, token, feedback) {
    if (!evidenceOwnerIsCurrent(ownerType, ownerId, token)) return false;
    if (ownerType === "card") detail.activeCardMutationBusy = false;
    else detail.activeTaskMutationBusy = false;
    return setEvidenceFeedback(ownerType, ownerId, token, feedback);
  }

  function ownerMutationPending(ownerType, ownerId) {
    const feedback = ownerType === "card"
      ? detail.activeCardPanelFeedback
      : detail.activeTaskPanelFeedback;
    return feedback?.owner === ownerType &&
      feedback?.phase === "pending" &&
      (ownerType === "card"
        ? detail.activeCardPanelId === ownerId
        : detail.activeTaskPanelId === ownerId);
  }

  function taskFilesLoader(taskId) {
    if (!taskFilesLoaders.has(taskId)) {
      taskFilesLoaders.set(
        taskId,
        createCollectionLoader({
          request,
          createUrl: (parameters) =>
            workApiUrl("/api/files", { taskId, ...parameters }),
          collection: "files",
        }),
      );
    }
    return taskFilesLoaders.get(taskId);
  }

  function renderTaskFileSection(task, options = {}) {
    if (!task.requiresFile && !task.id) return;
    const section = document.createElement("div");
    section.className = "task-required-link";

    const label = document.createElement("label");
    label.textContent = task.requiresFile ? "Required file" : "Attach file";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.disabled = detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy ||
      ownerMutationPending("task", task.id);
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
    loadTaskFiles(task.id, fileList, options);
  }

  async function loadTaskFiles(taskId, container, options = {}) {
    const loader = taskFilesLoader(taskId);
    const onFilesSettled =
      options.onFilesSettled || taskFilesSettledCallbacks.get(taskId);
    taskFilesSettledCallbacks.set(taskId, onFilesSettled);
    let page = loader.getSnapshot();
    if (!page.loaded && !page.failed) {
      renderTaskFiles(taskId, container, page);
    }
    if (options.retry && page.cursor) {
      page = await loader.loadMore();
    } else if (!page.loaded && !page.loading && !page.loadingMore) {
      page = await loader.load();
    } else {
      page = await loader.whenSettled();
    }

    updateTaskFilesContainer(taskId, container);
    renderTaskFiles(taskId, container, page);
    onFilesSettled?.();
    return page;
  }

  function updateTaskFilesContainer(taskId, container) {
    const continuation = taskFilesContinuations.get(taskId);
    if (continuation) continuation.container = container;
  }

  async function continueTaskFiles(taskId, continuation) {
    const loader = taskFilesLoader(taskId);
    const page = await loader.loadMore();
    if (taskFilesContinuations.get(taskId) !== continuation) return;
    renderTaskFiles(taskId, continuation.container, page);
    taskFilesSettledCallbacks.get(taskId)?.();
  }

  function scheduleTaskFilesContinuation(taskId, container) {
    let continuation = taskFilesContinuations.get(taskId);
    if (!continuation) {
      continuation = { container };
      taskFilesContinuations.set(taskId, continuation);
    }
    continuation.container = container;
    if (continuation.scheduled) return;
    continuation.scheduled = true;
    scheduleAnimationFrame(() => {
      if (taskFilesContinuations.get(taskId) !== continuation) return;
      continuation.scheduled = false;
      void continueTaskFiles(taskId, continuation);
    });
  }

  function cancelTaskFilesContinuation(taskId) {
    taskFilesContinuations.delete(taskId);
  }

  async function retryTaskFiles(taskId, container) {
    const current = taskFilesLoader(taskId).getSnapshot();
    await loadTaskFiles(taskId, container, {
      retry: Boolean(current.cursor),
    });
  }

  async function refreshTaskFiles(taskId, container, token) {
    if (!evidenceOwnerIsCurrent("task", taskId, token)) return null;
    cancelTaskFilesContinuation(taskId);
    taskFilesLoaders.delete(taskId);
    let page = await loadTaskFiles(taskId, container);
    while (page?.moreAvailable && !page.failed) {
      if (!evidenceOwnerIsCurrent("task", taskId, token)) return null;
      cancelTaskFilesContinuation(taskId);
      page = await loadTaskFiles(taskId, container, { retry: true });
    }
    if (!evidenceOwnerIsCurrent("task", taskId, token)) return null;
    if (!page?.loaded || page.failed) {
      throw new Error(page?.error || "Task files could not be refreshed");
    }
    return page;
  }

  function renderTaskFiles(taskId, container, page) {
    const hasActiveTask =
      detail.activeTaskPanelTask && detail.activeTaskPanelTask.id === taskId;
    container.replaceChildren();
    if (!page.loaded && page.failed) {
      if (hasActiveTask) detail.activeTaskPanelTask._hasFiles = false;
      appendTaskFilesError(
        container,
        page.error,
        () => retryTaskFiles(taskId, container),
        { continuation: false },
      );
      return;
    }
    if (!page.loaded && !page.failed) {
      const pending = document.createElement("small");
      pending.className = "task-file-loading";
      pending.setAttribute("role", "status");
      pending.setAttribute("aria-live", "polite");
      pending.textContent = "Loading files...";
      container.append(pending);
      return;
    }
    if (page.items.length === 0) {
      if (hasActiveTask) detail.activeTaskPanelTask._hasFiles = false;
      if (page.moreAvailable && !page.failed) {
        const pending = document.createElement("small");
        pending.className = "task-file-loading";
        pending.setAttribute("role", "status");
        pending.setAttribute("aria-live", "polite");
        pending.textContent = "Loading remaining files...";
        container.append(pending);
        scheduleTaskFilesContinuation(taskId, container);
        return;
      }
      if (page.failed) {
        appendTaskFilesError(container, page.error, () =>
          retryTaskFiles(taskId, container),
        );
        return;
      }
      const empty = document.createElement("small");
      empty.className = "task-file-empty";
      empty.textContent = "No files attached.";
      container.append(empty);
      return;
    }

    for (const file of page.items) {
      const item = document.createElement("div");
      item.className = "task-file-item";
      const name = document.createElement("span");
      name.textContent = file.filename || file.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "quiet-button task-file-remove";
      remove.textContent = "Remove";
      remove.disabled = detail.activeTaskMutationBusy ||
        detail.activeCardMutationBusy ||
        detail.activeCardTemplateBusy ||
        ownerMutationPending("task", taskId);
      remove.addEventListener("click", () =>
        removeTaskFile(file.id, taskId, container),
      );
      item.append(name, remove);
      container.append(item);
    }

    if (page.moreAvailable || page.failed) {
      if (hasActiveTask) detail.activeTaskPanelTask._hasFiles = false;
    }
    if (page.moreAvailable && !page.failed) {
      const pending = document.createElement("small");
      pending.className = "task-file-loading";
      pending.setAttribute("role", "status");
      pending.setAttribute("aria-live", "polite");
      pending.textContent = "Loading remaining files...";
      container.append(pending);
      scheduleTaskFilesContinuation(taskId, container);
      return;
    }
    if (page.failed) {
      appendTaskFilesError(
        container,
        page.error,
        () => retryTaskFiles(taskId, container),
        { continuation: Boolean(page.moreAvailable) },
      );
      return;
    }

    cancelTaskFilesContinuation(taskId);
    if (hasActiveTask) {
      detail.activeTaskPanelTask._hasFiles = true;
    }
  }

  function appendTaskFilesError(
    container,
    error,
    retry,
    { continuation = true } = {},
  ) {
    const status = document.createElement("p");
    status.className = "task-file-error";
    status.setAttribute("role", "alert");
    status.setAttribute("aria-live", "assertive");
    status.textContent =
      (continuation
        ? "More files are available, but loading failed"
        : "Files could not be loaded") + (error ? `: ${error}` : ".");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.retryTaskFiles = "true";
    button.textContent = "Retry loading files";
    button.addEventListener("click", retry);
    status.append(document.createTextNode(" "), button);
    container.append(status);
  }

  async function loadArtifactsForTask(task, options = {}) {
    const results = await Promise.allSettled([
      request(workApiUrl("/api/artifacts", { taskId: task.id })),
      task.cardId
        ? request(workApiUrl("/api/artifacts", { cardId: task.cardId }))
        : Promise.resolve({ artifacts: [] }),
    ]);
    if (options.strict) {
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
    const artifacts = [];
    for (const result of results) {
      const payload = settledPayload(result);
      if (payload && Array.isArray(payload.artifacts))
        artifacts.push(...payload.artifacts);
    }
    return dedupeArtifacts(artifacts);
  }

  async function loadArtifactsForCard(cardId) {
    const payload = await request(workApiUrl("/api/artifacts", { cardId }));
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
    const token = getActiveWorkspaceRouteToken();
    if (!beginEvidenceMutation("task", taskId, token, {
      phase: "pending",
      message: "Uploading the Task file…",
      retry: () => uploadTaskFile(taskId, file),
    })) return;
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
        finishEvidenceMutation("task", taskId, token, {
          phase: "error",
          message: `Upload failed: ${msg}`,
          retry: () => uploadTaskFile(taskId, file),
        });
        return;
      }
      const uploaded = await response.json();
      if (!evidenceOwnerIsCurrent("task", taskId, token)) return;
      const container = taskPanelBody.querySelector(".task-file-list");
      if (!container) throw new Error("Task file list is unavailable for refresh");
      const refreshed = await refreshTaskFiles(taskId, container, token);
      if (!refreshed) return;
      const uploadedId = uploaded?.file?.id || uploaded?.id;
      if (
        uploadedId &&
        !refreshed.items.some((file) => file?.id === uploadedId)
      ) {
        throw new Error("Uploaded file was not present in the refreshed Task");
      }
      if (detail.activeTaskPanelTask) {
        detail.activeTaskPanelTask._hasFiles = refreshed.items.length > 0;
      }
      finishEvidenceMutation("task", taskId, token, {
        phase: "success",
        message: "File is attached in the refreshed Task.",
      });
    } catch (err) {
      finishEvidenceMutation("task", taskId, token, {
        phase: "error",
        message: `Upload failed: ${err.message || "request failed"}`,
        retry: () => uploadTaskFile(taskId, file),
      });
    }
  }

  async function removeTaskFile(fileId, taskId, container) {
    const token = getActiveWorkspaceRouteToken();
    if (!beginEvidenceMutation("task", taskId, token, {
      phase: "pending",
      message: "Removing the Task file…",
      retry: () => removeTaskFile(fileId, taskId, container),
    })) return;
    try {
      const url = workApiUrl(`/api/files/${encodeURIComponent(fileId)}`);
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok && response.status !== 204) {
        finishEvidenceMutation("task", taskId, token, {
          phase: "error",
          message: `Could not remove file: HTTP ${response.status}`,
          retry: () => removeTaskFile(fileId, taskId, container),
        });
        return;
      }
      if (!evidenceOwnerIsCurrent("task", taskId, token)) return;
      const refreshed = await refreshTaskFiles(
        taskId,
        taskPanelBody.querySelector(".task-file-list") || container,
        token,
      );
      if (!refreshed) return;
      if (refreshed.items.some((file) => file?.id === fileId)) {
        throw new Error("Removed file was still present in the refreshed Task");
      }
      finishEvidenceMutation("task", taskId, token, {
        phase: "success",
        message: "File removal is confirmed in the refreshed Task.",
      });
    } catch (err) {
      finishEvidenceMutation("task", taskId, token, {
        phase: "error",
        message: `Could not remove file: ${err.message || "request failed"}`,
        retry: () => removeTaskFile(fileId, taskId, container),
      });
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
          updateArtifactStatus(
            artifact.id,
            "approved",
            options.onRefresh,
            options.ownerType,
            options.ownerId,
          ),
        );
        approve.disabled = detail.activeTaskMutationBusy ||
          detail.activeCardMutationBusy ||
          detail.activeCardTemplateBusy ||
          ownerMutationPending(options.ownerType, options.ownerId);
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
    // Marked so a panel rerender can hand a half-typed registration back to the
    // operator instead of clearing it.
    titleInput.dataset.panelField = "artifact-title";
    if (options.ownerType === "card") {
      titleInput.dataset.cardDraftKey = "artifact-title";
    }
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    urlInput.dataset.panelField = "artifact-url";
    if (options.ownerType === "card") {
      urlInput.dataset.cardDraftKey = "artifact-url";
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Register";
    addBtn.disabled = detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy ||
      ownerMutationPending(options.ownerType, options.ownerId);
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
    const token = getActiveWorkspaceRouteToken();
    if (!options.url) {
      setEvidenceFeedback(options.ownerType, options.ownerId, token, {
        phase: "error",
        message: "Artifact URL is required.",
        focusSelector: '[data-panel-field="artifact-url"]',
      });
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
    if (options.ownerType === "card") body.cardId = options.ownerId;
    if (!beginEvidenceMutation(options.ownerType, options.ownerId, token, {
      phase: "pending",
      message: "Registering the artifact…",
      retry: () => registerExternalArtifact(options),
    })) return;
    try {
      const response = await request(workApiUrl("/api/artifacts"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!evidenceOwnerIsCurrent(options.ownerType, options.ownerId, token)) return;
      if (typeof options.onRefresh === "function") {
        const refreshed = await options.onRefresh();
        if (refreshed === false) {
          throw new Error(
            options.ownerType === "card"
              ? "Card artifacts could not be refreshed"
              : "Task artifacts could not be refreshed",
          );
        }
        assertArtifactMutationConfirmed(
          refreshed,
          response?.artifact || response,
          body,
        );
      }
      if (!evidenceOwnerIsCurrent(options.ownerType, options.ownerId, token)) return;
      finishEvidenceMutation(options.ownerType, options.ownerId, token, {
        phase: "success",
        message: options.ownerType === "card"
          ? "Artifact registration is confirmed in the refreshed Card."
          : "Artifact registration is confirmed in the refreshed Task.",
      });
    } catch (err) {
      finishEvidenceMutation(options.ownerType, options.ownerId, token, {
        phase: "error",
        message: `Could not register artifact: ${err.message || "request failed"}`,
        retry: () => registerExternalArtifact(options),
      });
    }
  }

  async function updateArtifactStatus(
    artifactId,
    status,
    onRefresh,
    ownerType = "task",
    ownerId = detail.activeTaskPanelId,
  ) {
    const token = getActiveWorkspaceRouteToken();
    if (!beginEvidenceMutation(ownerType, ownerId, token, {
      phase: "pending",
      message: "Updating the artifact…",
      retry: () => updateArtifactStatus(
        artifactId,
        status,
        onRefresh,
        ownerType,
        ownerId,
      ),
    })) return;
    try {
      const response = await request(
        workApiUrl(`/api/artifacts/${encodeURIComponent(artifactId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ status }),
        },
      );
      if (!evidenceOwnerIsCurrent(ownerType, ownerId, token)) return;
      if (typeof onRefresh === "function") {
        const refreshed = await onRefresh();
        if (refreshed === false) {
          throw new Error(
            ownerType === "card"
              ? "Card artifacts could not be refreshed"
              : "Task artifacts could not be refreshed",
          );
        }
        assertArtifactMutationConfirmed(
          refreshed,
          response?.artifact || response,
          { id: artifactId, status },
        );
      }
      if (!evidenceOwnerIsCurrent(ownerType, ownerId, token)) return;
      finishEvidenceMutation(ownerType, ownerId, token, {
        phase: "success",
        message: ownerType === "card"
          ? "Artifact status is confirmed in the refreshed Card."
          : "Artifact status is confirmed in the refreshed Task.",
      });
    } catch (err) {
      finishEvidenceMutation(ownerType, ownerId, token, {
        phase: "error",
        message: `Could not update artifact: ${err.message || "request failed"}`,
        retry: () => updateArtifactStatus(
          artifactId,
          status,
          onRefresh,
          ownerType,
          ownerId,
        ),
      });
    }
  }

  function assertArtifactMutationConfirmed(refreshed, responseArtifact, expected) {
    if (!Array.isArray(refreshed)) return;
    const expectedId = responseArtifact?.id || expected.id;
    const expectedUri = responseArtifact?.storageUri || expected.storageUri;
    const expectedTitle = responseArtifact?.title || expected.title;
    const artifact = refreshed.find((candidate) =>
      (expectedId && candidate?.id === expectedId) ||
      (expectedUri && candidate?.storageUri === expectedUri) ||
      (expectedTitle && candidate?.title === expectedTitle),
    );
    if (!artifact) {
      throw new Error("Artifact mutation was not present in the refreshed owner");
    }
    if (expected.status && artifact.status !== expected.status) {
      throw new Error("Artifact refresh did not confirm the requested status");
    }
  }

  return {
    dedupeArtifacts,
    loadArtifactsForCard,
    loadArtifactsForTask,
    renderArtifactList,
    renderTaskArtifactSection,
    renderTaskFileSection,
  };
}
