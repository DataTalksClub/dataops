export function createCardPanel(context) {
  const {
    closeBundlePanel,
    createTaskActionButton,
    detail,
    formatMetaDate,
    formatTaskDateMeta,
    getActiveWorkspaceRoute,
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkBundle,
    isWorkspaceRouteFresh,
    labelizeWorkValue,
    loadArtifactsForBundle,
    localDocPathFromHref,
    navigateCanonicalWorkspace,
    openDocument,
    openTaskPanel,
    refreshOperationsWorkSnapshot,
    renderArtifactList,
    renderEntityLoadState,
    reportError,
    request,
    settledPayload,
    state,
    summarizeBundleProgress,
    taskRequiresApprovedArtifact,
    tasksFromWorkPayload,
    todayIsoDate,
    updateTaskStatus,
    workApiUrl,
    workBundleTitle,
    workTaskTitle,
    workflowTaskGroups,
    bundlePanelBody,
    bundlePanelTitle,
  } = context;

  function openBundlePanel(bundleId) {
    const bundle = state.workSnapshot.bundlesById?.get(bundleId);
    const path = isArchivedWorkBundle(bundle) ? "/cards/archive" : "/cards";
    return navigateCanonicalWorkspace(path, { cardId: bundleId }).ready;
  }

  async function hydrateBundlePanel(bundleId, token) {
    try {
      const [bundleResult, tasksResult, artifactsResult] =
        await Promise.allSettled([
          request(workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`)),
          request(workApiUrl(`/api/tasks`, { bundleId })),
          loadArtifactsForBundle(bundleId),
        ]);
      if (
        !isWorkspaceRouteFresh(token) ||
        detail.activeBundlePanelId !== bundleId
      )
        return;
      if (bundleResult.status === "rejected") throw bundleResult.reason;
      const bundlePayload = settledPayload(bundleResult);
      const bundle = bundlePayload && (bundlePayload.bundle || bundlePayload);
      const tasks = tasksFromWorkPayload(settledPayload(tasksResult));
      const artifacts = Array.isArray(settledPayload(artifactsResult))
        ? settledPayload(artifactsResult)
        : [];
      if (
        isWorkspaceRouteFresh(token) &&
        detail.activeBundlePanelId === bundleId
      ) {
        detail.activeBundlePanelData = { bundle, tasks, artifacts };
        renderBundlePanel();
        if (detail.activeTaskPanelTask?.bundleId === bundleId)
          renderTaskPanel();
      }
    } catch (err) {
      if (
        isWorkspaceRouteFresh(token) &&
        detail.activeBundlePanelId === bundleId
      ) {
        bundlePanelTitle.textContent =
          err.status === 404 ? "Card not found" : "Card unavailable";
        renderEntityLoadState(bundlePanelBody, {
          kind: "card",
          id: bundleId,
          status: err.status === 404 ? "not-found" : "error",
          error: err.message,
          retry: () =>
            navigateCanonicalWorkspace(
              getActiveWorkspaceRoute().path,
              getActiveWorkspaceRoute().params,
              { history: "none" },
            ),
          returnToList: () => closeBundlePanel(),
        });
      }
    }
  }

  function renderEntityLoadingState(container, kind, id) {
    const loadingState = document.createElement("section");
    loadingState.className = "entity-route-state entity-route-loading";
    loadingState.setAttribute("role", "status");
    loadingState.textContent = `Loading ${kind} ${id}…`;
    container.replaceChildren(loadingState);
  }

  function renderBundlePanel() {
    const data = detail.activeBundlePanelData;
    const bundle = data?.bundle;
    const tasks = data?.tasks || [];
    const artifacts = data?.artifacts || [];
    bundlePanelTitle.textContent = bundle ? workBundleTitle(bundle) : "Card";
    bundlePanelBody.replaceChildren();
    if (!bundle) return;

    const today = todayIsoDate();
    const progress = summarizeBundleProgress(bundle, tasks, today);
    const layout = document.createElement("div");
    layout.className = "workflow-modal-layout";
    const main = document.createElement("div");
    main.className = "workflow-modal-main";
    const sidebar = document.createElement("aside");
    sidebar.className = "workflow-modal-sidebar";
    sidebar.setAttribute("aria-label", "Card controls and status");
    const sidebarHeading = document.createElement("strong");
    sidebarHeading.className = "workflow-sidebar-heading";
    sidebarHeading.textContent = "Card";
    sidebar.append(sidebarHeading);
    layout.append(main, sidebar);
    bundlePanelBody.append(layout);

    // Stage + progress summary
    const meta = document.createElement("div");
    meta.className = "task-detail-meta workflow-detail-summary";
    const stageLabel = document.createElement("label");
    stageLabel.className = "workflow-stage-field";
    if (isArchivedWorkBundle(bundle)) {
      stageLabel.textContent = "Status";
      const completed = document.createElement("span");
      completed.className = "bundle-stage-static";
      completed.textContent = "Completed";
      stageLabel.append(completed);
    } else {
      stageLabel.textContent = "Stage ";
      const stageSelect = document.createElement("select");
      stageSelect.className = "bundle-stage-select";
      for (const stage of ["preparation", "announced", "after-event"]) {
        const opt = document.createElement("option");
        opt.value = stage;
        opt.textContent = labelizeWorkValue(stage);
        if (bundle.stage === stage) opt.selected = true;
        stageSelect.append(opt);
      }
      stageSelect.addEventListener("change", () =>
        updateBundleStage(bundle.id, stageSelect.value),
      );
      stageLabel.append(stageSelect);
    }
    sidebar.append(stageLabel);
    if (bundle.anchorDate) {
      const row = document.createElement("div");
      row.className = "workflow-sidebar-meta";
      row.append(
        document.createTextNode("Anchor "),
        formatMetaDate(bundle.anchorDate, today),
      );
      sidebar.append(row);
    }
    const progressRow = document.createElement("div");
    progressRow.className = "workflow-progress-copy";
    progressRow.textContent = progress.label;
    meta.append(progressRow);
    const riskRow = document.createElement("div");
    riskRow.className = "ops-card-chips";
    for (const chipText of [
      `Risk ${progress.risk}`,
      progress.nextDueTask
        ? `Next: ${workTaskTitle(progress.nextDueTask)}`
        : "",
      `${progress.overdue} overdue`,
      `${progress.waiting} waiting/follow-up`,
      `${progress.missingProof || 0} missing proof`,
    ].filter(Boolean)) {
      const chip = document.createElement("small");
      chip.className = "ops-card-chip";
      chip.textContent = chipText;
      riskRow.append(chip);
    }
    meta.append(riskRow);
    if (bundle.description) {
      const descRow = document.createElement("div");
      descRow.className = "workflow-description";
      descRow.textContent = bundle.description;
      meta.append(descRow);
    }
    main.append(meta);

    // Progress bar
    if (progress.total > 0) {
      const bar = document.createElement("div");
      bar.className = "ops-progress";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", progress.label);
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(progress.percent));
      const fill = document.createElement("i");
      fill.style.width = `${progress.percent}%`;
      bar.append(fill);
      main.append(bar);
    }

    // Bundle links
    if (Array.isArray(bundle.bundleLinks) && bundle.bundleLinks.length > 0) {
      const linksSection = document.createElement("div");
      linksSection.className =
        "task-history workflow-detail-section workflow-links-section";
      const linksLabel = document.createElement("div");
      linksLabel.className = "task-history-label";
      linksLabel.textContent = "Links";
      linksSection.append(linksLabel);
      for (const link of bundle.bundleLinks) {
        const linkName = link.name || link.label || "Link";
        const linkUrl = link.url || "";
        const wrap = document.createElement("div");
        wrap.className = "task-required-link";
        const label = document.createElement("label");
        label.textContent = linkName;
        const input = document.createElement("input");
        input.type = "url";
        input.value = linkUrl;
        input.placeholder = "https://...";
        input.addEventListener("change", () =>
          saveBundleLink(
            bundle.id,
            bundle.bundleLinks,
            linkName,
            input.value.trim(),
          ),
        );
        label.append(input);
        wrap.append(label);
        linksSection.append(wrap);
      }
      main.append(linksSection);
    }

    // Task checklist
    if (tasks.length > 0) {
      const checklistSection = document.createElement("div");
      checklistSection.className =
        "task-history workflow-detail-section workflow-checklist-section";
      const checklistLabel = document.createElement("div");
      checklistLabel.className = "task-history-label";
      checklistLabel.textContent = "Tasks";
      checklistSection.append(checklistLabel);
      const list = document.createElement("div");
      list.className = "task-history-list";
      for (const group of workflowTaskGroups(tasks, today)) {
        const groupTitle = document.createElement("div");
        groupTitle.className = "bundle-task-group-title";
        groupTitle.textContent = `${group.title} (${group.tasks.length})`;
        list.append(groupTitle);
        if (group.tasks.length === 0) {
          const empty = document.createElement("div");
          empty.className = "task-history-event";
          empty.textContent = group.empty;
          list.append(empty);
        } else {
          for (const task of group.tasks)
            list.append(renderBundleChecklistItem(task, bundle.id, today));
        }
      }
      checklistSection.append(list);
      main.append(checklistSection);
    }

    // References and artifact links (always shown, with add capability)
    const refsSection = document.createElement("div");
    refsSection.className =
      "task-history workflow-detail-section workflow-references-section";
    const refsLabel = document.createElement("div");
    refsLabel.className = "task-history-label";
    refsLabel.textContent = "Process references";
    refsSection.append(refsLabel);
    const refsList = document.createElement("div");
    refsList.className = "task-history-list";
    const existingRefs = Array.isArray(bundle.references)
      ? bundle.references
      : [];
    for (const ref of existingRefs) {
      const refUrl = typeof ref === "string" ? ref : ref.url || ref.link || "";
      const refName =
        typeof ref === "string" ? ref : ref.name || ref.title || refUrl;
      if (!refUrl) continue;
      const item = document.createElement("div");
      item.className = "task-history-event";
      const docPath = localDocPathFromHref(refUrl);
      if (docPath) {
        const link = document.createElement("button");
        link.type = "button";
        link.className = "task-instruction-doc-link";
        link.textContent = String(refName);
        link.addEventListener("click", () =>
          openDocument(docPath, {
            returnContext: {
              type: "workflow",
              id: bundle.id,
              title: workBundleTitle(bundle),
            },
          }),
        );
        item.append(link);
      } else {
        const link = document.createElement("a");
        link.href = String(refUrl);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = String(refName);
        item.append(link);
      }
      refsList.append(item);
    }
    refsSection.append(refsList);
    if (!refsList.children.length) {
      const empty = document.createElement("div");
      empty.className = "task-history-event";
      empty.textContent = "No internal Process Docs linked to this Card.";
      refsList.append(empty);
    }

    const assistantState = document.createElement("div");
    assistantState.className = "task-history-event";
    assistantState.textContent = state.assistantSnapshot.loaded
      ? "Assistant jobs are available from the Assistants surface when linked to this Card."
      : "Assistant jobs are not connected to this Card.";
    refsSection.append(assistantState);

    // Add artifact/reference link form
    const addRow = document.createElement("div");
    addRow.className = "task-follow-up-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Label (e.g. Podcast doc)";
    nameInput.className = "bundle-ref-name";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://...";
    urlInput.className = "bundle-ref-url";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "task-action-btn";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", () =>
      addBundleReference(
        bundle.id,
        existingRefs,
        nameInput.value.trim(),
        urlInput.value.trim(),
      ),
    );
    addRow.append(nameInput, urlInput, addBtn);
    refsSection.append(addRow);
    refsSection.append(
      renderArtifactList({
        ownerType: "bundle",
        ownerId: bundle.id,
        artifacts,
        required: false,
        onRefresh: async () => {
          detail.activeBundlePanelData = {
            ...detail.activeBundlePanelData,
            artifacts: await loadArtifactsForBundle(bundle.id),
          };
          renderBundlePanel();
        },
      }),
    );
    main.append(refsSection);
  }

  function renderBundleChecklistItem(task, bundleId, today) {
    const row = document.createElement("div");
    row.className = "bundle-checklist-item";
    const status = String(task.status || "todo").toLowerCase();
    const isDone = status === "done";
    const isWaiting = status === "waiting";
    const bundleArtifacts = detail.activeBundlePanelData?.artifacts || [];

    const missingLink = !isDone && task.requiredLinkName && !task.link;
    const missingFile =
      !isDone && task.requiresFile && !hasTaskFileEvidence(task);
    const missingArtifact =
      !isDone &&
      taskRequiresApprovedArtifact(task) &&
      !hasApprovedArtifactEvidence(task, bundleArtifacts);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute(
      "aria-label",
      `${isDone ? "Reopen" : "Complete"} ${workTaskTitle(task)}`,
    );
    checkbox.checked = isDone;
    checkbox.disabled =
      isWaiting || missingLink || missingFile || missingArtifact;
    if (checkbox.disabled && !isDone) {
      const reasons = [];
      if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
      if (missingFile) reasons.push("Upload required file");
      if (missingArtifact) reasons.push("Approve an attached artifact");
      if (isWaiting) reasons.push("Waiting task");
      checkbox.title = reasons.join("; ");
    }
    checkbox.addEventListener("change", () => {
      updateTaskStatus(task.id, isDone ? "todo" : "done");
    });

    const label = document.createElement("button");
    label.type = "button";
    label.className = `bundle-checklist-label ${isDone ? "is-done" : ""}`;
    label.dataset.taskId = task.id;
    label.textContent = workTaskTitle(task);
    label.addEventListener("click", () =>
      openTaskPanel(task.id, {
        preserveBundle: true,
        expectedBundleId: bundleId,
      }),
    );

    const dateMeta = document.createElement("small");
    dateMeta.className = "bundle-checklist-date";
    if (task.date) dateMeta.textContent = formatTaskDateMeta(task.date, today);
    if (isWaiting) dateMeta.textContent = `waiting: ${task.waitingFor || ""}`;

    if (!isDone && (missingLink || missingFile || missingArtifact)) {
      const badge = document.createElement("span");
      badge.className = "bundle-checklist-evidence";
      if (missingLink) badge.textContent += `${task.requiredLinkName} missing`;
      if (missingLink && missingFile) badge.textContent += "; ";
      if (missingFile) badge.textContent += "file missing";
      if ((missingLink || missingFile) && missingArtifact)
        badge.textContent += "; ";
      if (missingArtifact) badge.textContent += "artifact review missing";
      dateMeta.append(document.createTextNode(" "), badge);
    }
    row.append(checkbox, label, dateMeta);
    return row;
  }

  async function navigateTaskToWorkflow(task) {
    if (!task?.bundleId) return;
    const bundle = state.workSnapshot.bundlesById?.get(task.bundleId);
    const path = isArchivedWorkBundle(bundle) ? "/cards/archive" : "/cards";
    await navigateCanonicalWorkspace(path, {
      cardId: task.bundleId,
      taskId: task.id,
    }).ready;
  }

  async function addBundleReference(bundleId, currentRefs, name, url) {
    if (!url) {
      reportError("URL is required.");
      return;
    }
    const ref = { name: name || url, url };
    const updatedRefs = [...(currentRefs || []), ref];
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ references: updatedRefs }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && detail.activeBundlePanelId === bundleId) {
        detail.activeBundlePanelData = {
          ...detail.activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
    } catch (err) {
      reportError(`Could not add link: ${err.message || "request failed"}`);
    }
  }

  async function updateBundleStage(bundleId, stage) {
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ stage }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && detail.activeBundlePanelId === bundleId) {
        detail.activeBundlePanelData = {
          ...detail.activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not update stage: ${err.message || "request failed"}`);
    }
  }

  async function saveBundleLink(bundleId, currentLinks, linkName, linkValue) {
    const updatedLinks = (currentLinks || []).map((link) =>
      (link.name || link.label) === linkName
        ? { ...link, url: linkValue }
        : link,
    );
    try {
      const payload = await request(
        workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ bundleLinks: updatedLinks }),
        },
      );
      const updatedBundle = payload && (payload.bundle || payload);
      if (updatedBundle && detail.activeBundlePanelId === bundleId) {
        detail.activeBundlePanelData = {
          ...detail.activeBundlePanelData,
          bundle: updatedBundle,
        };
        renderBundlePanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not save link: ${err.message || "request failed"}`);
    }
  }

  // ---------- Notification bell ----------

  return {
    hydrateBundlePanel,
    navigateTaskToWorkflow,
    openBundlePanel,
    renderBundlePanel,
    renderEntityLoadingState,
  };
}
