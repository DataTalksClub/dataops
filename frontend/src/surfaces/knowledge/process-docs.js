export function createProcessDocsSurface(context, services) {
  const {
    basename,
    buildOperationsWorkModel,
    buildOperationsReferenceLinks,
    buildProcessQualityModel,
    documentList,
    getDocsAvailability,
    getOperationsQualitySnapshot,
    getOperationsRecurringSnapshot,
    getOperationsWorkSnapshot,
    knowledgeState,
    listDraftPaths,
    qualityFiltersState,
    renderDocsAvailabilityState,
    renderHonestState,
    renderOperationsReference,
    renderQualityFindingRow,
    renderSurfaceHeader,
    setRouteTitle,
    showCreate,
    apiUrl,
    promptUser,
    request,
  } = context;
  const { openDocument, refreshDocuments } = services;
  const expandedDocIds = new Set();
  const knowledgeTools = context.knowledgeTools;
  const exportStatus = knowledgeTools?.querySelector("#knowledge-section");
  const filtersPopover = knowledgeTools?.querySelector("#filters-section");

  // The Filters disclosure opens as a popover over the catalog, so it closes
  // like one: a click elsewhere, or Escape (after an open select has taken
  // its own Escape), which returns focus to the Filters button.
  if (filtersPopover) {
    document.addEventListener("click", (event) => {
      if (filtersPopover.open && !filtersPopover.contains(event.target)) {
        filtersPopover.open = false;
      }
    });
    filtersPopover.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || !filtersPopover.open) return;
      event.preventDefault();
      filtersPopover.open = false;
      filtersPopover.querySelector("summary")?.focus();
    });
  }

  function buildTree(docs) {
    const byId = new Map();
    const byPath = new Map();
    for (const d of docs) {
      byId.set(d.id, { doc: d, children: [] });
      byPath.set(d.path, d);
    }
    const roots = [];
    for (const d of docs) {
      const node = byId.get(d.id);
      const parentRef = d.parent_id || d.parent || "";
      let parentNode = parentRef ? byId.get(parentRef) : null;
      if (!parentNode && parentRef && byPath.has(parentRef)) {
        const parentDoc = byPath.get(parentRef);
        parentNode = byId.get(parentDoc.id);
      }
      if (parentNode && parentNode.doc.id !== d.id) {
        parentNode.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  function isDescendant(sourceDocId, targetDocId, docs) {
    if (sourceDocId === targetDocId) return true;
    let currId = targetDocId;
    const visited = new Set();
    while (currId && !visited.has(currId)) {
      visited.add(currId);
      const doc = docs.find((d) => d.id === currId);
      if (!doc) break;
      const parentRef = doc.parent_id || doc.parent;
      if (parentRef === sourceDocId) return true;
      const parentDoc = docs.find((d) => d.id === parentRef || d.path === parentRef);
      currId = parentDoc?.id;
    }
    return false;
  }

  async function moveDocToParent(docPath, newParentId) {
    try {
      const allDocs = context.knowledgeState?.allDocuments || [];
      const doc = allDocs.find((d) => d.path === docPath);
      await request(apiUrl("/docs/move"), {
        method: "POST",
        body: JSON.stringify({
          path: docPath,
          new_parent: newParentId || null,
          expectedRevision: doc?.revision || "",
        }),
      });
      if (newParentId) expandedDocIds.add(newParentId);
      await refreshDocuments();
    } catch (err) {
      console.error("Move failed", err);
    }
  }

  async function createSubpageForDoc(parentDoc) {
    const title = (promptUser?.("Sub-page title:") || globalThis.prompt?.("Sub-page title:") || "").trim();
    if (!title) return;

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
    const parentPath = parentDoc.path;
    const lastSlash = parentPath.lastIndexOf("/");
    const parentDir = lastSlash >= 0 ? parentPath.slice(0, lastSlash) : "content";
    const parentStem = (lastSlash >= 0 ? parentPath.slice(lastSlash + 1) : parentPath).replace(/\.md$/, "");
    let newPath = `${parentDir}/${parentStem}/${slug}.md`;

    const allDocs = context.knowledgeState?.allDocuments || [];
    let counter = 1;
    while (allDocs.some((d) => d.path === newPath)) {
      counter++;
      newPath = `${parentDir}/${parentStem}/${slug}-${counter}.md`;
    }

    try {
      await request(apiUrl("/docs"), {
        method: "POST",
        body: JSON.stringify({
          path: newPath,
          title,
          doc_type: parentDoc.doc_type || "doc",
          parent: parentDoc.id || parentDoc.path,
          scaffold: "minimal",
          absent: true,
          expectedRevision: parentDoc.revision || "",
        }),
      });

      expandedDocIds.add(parentDoc.id);
      await refreshDocuments();
      openDocument(newPath);
    } catch (err) {
      console.error("Create subpage failed", err);
    }
  }

  function openMoveDialogForDoc(doc) {
    const allDocs = context.knowledgeState?.allDocuments || [];
    const candidates = [
      { id: "", title: "(Top-level / No parent)" },
      ...allDocs
        .filter((d) => d.id !== doc.id && d.path !== doc.path && !isDescendant(doc.id, d.id, allDocs))
        .map((d) => ({ id: d.id, title: d.title || basename(d.path) })),
    ];

    const modal = document.createElement("div");
    modal.className = "task-modal diff-modal doc-move-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Move document");

    const backdrop = document.createElement("div");
    backdrop.className = "task-modal-backdrop diff-backdrop";

    const panel = document.createElement("div");
    panel.className = "task-modal-panel diff-panel doc-move-panel";

    const header = document.createElement("header");
    header.className = "task-panel-header";
    const titleEl = document.createElement("strong");
    titleEl.textContent = `Move "${doc.title || basename(doc.path)}"`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "quiet-button";
    closeBtn.textContent = "Cancel";
    header.append(titleEl, closeBtn);

    const bodyEl = document.createElement("div");
    bodyEl.className = "task-panel-body doc-move-body";

    const label = document.createElement("label");
    label.className = "doc-move-label";
    label.textContent = "Select new parent page:";
    const select = document.createElement("select");
    select.className = "doc-move-select";
    candidates.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.title;
      if (doc.parent_id === c.id || doc.parent === c.id) {
        opt.selected = true;
      }
      select.append(opt);
    });
    label.append(select);
    bodyEl.append(label);

    const footer = document.createElement("div");
    footer.className = "doc-move-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "quiet-button";
    cancelBtn.textContent = "Cancel";
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "primary-button";
    confirmBtn.textContent = "Move page";
    footer.append(cancelBtn, confirmBtn);
    bodyEl.append(footer);

    panel.append(header, bodyEl);
    modal.append(backdrop, panel);
    document.body.append(modal);

    function cleanup() {
      modal.remove();
    }

    closeBtn.addEventListener("click", cleanup);
    cancelBtn.addEventListener("click", cleanup);
    backdrop.addEventListener("click", cleanup);
    confirmBtn.addEventListener("click", async () => {
      const targetId = select.value;
      cleanup();
      await moveDocToParent(doc.path, targetId);
    });
  }

  function renderTreeNode(node, depth = 0) {
    const doc = node.doc;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedDocIds.has(doc.id);

    const nodeContainer = document.createElement("div");
    nodeContainer.className = `ops-docs-tree-node${isExpanded ? " is-expanded" : ""}`;
    nodeContainer.dataset.docId = doc.id;
    nodeContainer.dataset.docPath = doc.path;

    const row = document.createElement("div");
    row.className = "ops-docs-tree-row ops-docs-catalog-row";
    row.style.setProperty("--ops-docs-depth", String(depth));
    row.setAttribute("draggable", "true");

    let childrenContainer = null;

    if (hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "ops-docs-tree-toggle";
      toggle.setAttribute(
        "aria-label",
        `${isExpanded ? "Collapse" : "Expand"} ${doc.title || basename(doc.path)}`,
      );
      toggle.setAttribute("aria-expanded", String(isExpanded));
      toggle.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const expanded = expandedDocIds.has(doc.id);
        if (expanded) {
          expandedDocIds.delete(doc.id);
          nodeContainer.classList.remove("is-expanded");
          toggle.setAttribute("aria-expanded", "false");
          if (childrenContainer) childrenContainer.hidden = true;
        } else {
          expandedDocIds.add(doc.id);
          nodeContainer.classList.add("is-expanded");
          toggle.setAttribute("aria-expanded", "true");
          if (childrenContainer) childrenContainer.hidden = false;
        }
      });
      row.append(toggle);
    } else {
      const bullet = document.createElement("span");
      bullet.className = "ops-docs-tree-bullet";
      bullet.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5"/></svg>';
      row.append(bullet);
    }

    const main = document.createElement("button");
    main.type = "button";
    main.className = "ops-docs-tree-link";
    const title = document.createElement("strong");
    title.textContent = doc.title || basename(doc.path);
    const meta = document.createElement("span");
    meta.textContent = catalogMeta(doc);
    main.append(title, meta);

    const summaryText = String(doc.summary || doc.description || "").trim();
    if (summaryText) {
      const summary = document.createElement("p");
      summary.className = "ops-docs-catalog-summary";
      summary.textContent = summaryText;
      main.append(summary);
    }
    main.addEventListener("click", () => openDocument(doc.path));
    row.append(main);

    const actions = document.createElement("div");
    actions.className = "ops-docs-tree-actions";

    const addSubBtn = document.createElement("button");
    addSubBtn.type = "button";
    addSubBtn.className = "ops-docs-tree-btn ops-docs-tree-btn-subpage";
    addSubBtn.title = "Add sub-page";
    addSubBtn.setAttribute("aria-label", "Add sub-page");
    addSubBtn.textContent = "+";
    addSubBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      createSubpageForDoc(doc);
    });

    const moveBtn = document.createElement("button");
    moveBtn.type = "button";
    moveBtn.className = "ops-docs-tree-btn ops-docs-tree-btn-move";
    moveBtn.title = "Move to another parent";
    moveBtn.setAttribute("aria-label", "Move page");
    moveBtn.textContent = "⇄";
    moveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMoveDialogForDoc(doc);
    });

    actions.append(addSubBtn, moveBtn);
    row.append(actions);

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", doc.path);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("is-dragging");
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      documentList.querySelectorAll(".ops-docs-tree-row.is-drop-target").forEach((el) => {
        el.classList.remove("is-drop-target");
      });
    });

    row.addEventListener("dragover", (e) => {
      const allDocs = context.knowledgeState?.allDocuments || [];
      const draggedPath = e.dataTransfer.getData("text/plain");
      const draggedDoc = allDocs.find((d) => d.path === draggedPath);
      if (draggedDoc && isDescendant(draggedDoc.id, doc.id, allDocs)) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("is-drop-target");
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("is-drop-target");
    });

    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("is-drop-target");
      const draggedPath = e.dataTransfer.getData("text/plain");
      if (!draggedPath || draggedPath === doc.path) return;
      const allDocs = context.knowledgeState?.allDocuments || [];
      const draggedDoc = allDocs.find((d) => d.path === draggedPath);
      if (draggedDoc && isDescendant(draggedDoc.id, doc.id, allDocs)) return;
      await moveDocToParent(draggedPath, doc.id);
    });

    nodeContainer.append(row);

    if (hasChildren) {
      childrenContainer = document.createElement("div");
      childrenContainer.className = "ops-docs-tree-children";
      childrenContainer.hidden = !isExpanded;
      for (const childNode of node.children) {
        childrenContainer.append(renderTreeNode(childNode, depth + 1));
      }
      nodeContainer.append(childrenContainer);
    }

    return nodeContainer;
  }

  function renderDocsSurface(documents) {
    const visibleDocuments = Array.isArray(documents) ? documents : [];
    const model = buildOperationsWorkModel(visibleDocuments, {
      draftPaths: listDraftPaths(),
      workSnapshot: getOperationsWorkSnapshot(),
      recurringSnapshot: getOperationsRecurringSnapshot(),
      qualitySnapshot: getOperationsQualitySnapshot(),
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setRouteTitle("Process Docs");
    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-docs";
    const header = renderSurfaceHeader("Process Docs");
    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "dk-button dk-button--primary ops-docs-create";
    createButton.textContent = "New process doc";
    createButton.addEventListener("click", () => showCreate());
    const actions = document.createElement("div");
    actions.className = "dk-page-header__actions";
    actions.append(createButton);
    header.append(actions);
    wrap.append(header);
    if (knowledgeTools) {
      const count = knowledgeTools.querySelector("#docs-catalog-count");
      if (count) count.replaceChildren(...catalogCount(visibleDocuments.length));
      wrap.append(knowledgeTools);
    }
    wrap.append(renderProcessesSurface(visibleDocuments, model));
    if (exportStatus) wrap.append(exportStatus);
    documentList.replaceChildren(wrap);
  }

  // The number is data (mono, tabular); the noun stays prose.
  function catalogCount(total) {
    const value = document.createElement("span");
    value.className = "dk-mono";
    value.textContent = String(total);
    return [value, total === 1 ? " document" : " documents"];
  }

  function renderProcessesSurface(documents, model) {
    const section = document.createElement("section");
    section.className = "ops-processes-surface";
    const quality =
      model?.quality ||
      buildProcessQualityModel(
        getOperationsQualitySnapshot(),
        getOperationsWorkSnapshot(),
      );

    const docsState = renderCatalogState(documents);
    if (docsState) section.append(docsState);

    const catalog = renderDocumentCatalog(documents);
    if (catalog) section.append(catalog);

    const existingDrilldown = documentList.querySelector(".ops-quality-drilldown");
    const wasOpen = existingDrilldown?.open === true;
    const findings = renderProcessQualityDrilldown(quality, wasOpen);
    if (findings) section.append(findings);

    const projectDocs = renderProjectDocs(documents);
    if (projectDocs) section.append(projectDocs);
    return section;
  }

  function renderDocumentCatalog(documents) {
    const visibleDocuments = Array.isArray(documents) ? documents : [];
    if (visibleDocuments.length === 0) return null;
    const list = document.createElement("section");
    list.className = "ops-docs-catalog ops-docs-tree";
    list.setAttribute("aria-label", "Process documents");
    const roots = buildTree(visibleDocuments);
    for (const rootNode of roots) {
      list.append(renderTreeNode(rootNode, 0));
    }
    return list;
  }

  function catalogMeta(doc) {
    const type = humanizeDocType(doc.doc_type);
    const domain = doc.domain ? String(doc.domain) : "";
    const parts = [];
    if (type) parts.push(type);
    if (domain && domain.toLowerCase() !== type.toLowerCase()) parts.push(domain);
    return parts.join(" · ");
  }

  function humanizeDocType(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase() === "sop") return "SOP";
    return raw.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function renderProjectDocs(documents) {
    const refs = (buildOperationsReferenceLinks(documents) || []).filter(
      (ref) => ref.href && !ref.path,
    );
    if (refs.length === 0) return null;
    const wrap = document.createElement("section");
    wrap.className = "ops-project-docs";
    wrap.setAttribute("aria-labelledby", "ops-project-docs-title");
    const header = document.createElement("header");
    header.className = "dk-section-header";
    const title = document.createElement("h2");
    title.className = "dk-section-header__title";
    title.id = "ops-project-docs-title";
    title.textContent = "Project docs";
    header.append(title);
    wrap.append(header);
    const grid = document.createElement("div");
    grid.className = "ops-reference-grid";
    for (const ref of refs) grid.append(renderOperationsReference(ref));
    wrap.append(grid);
    return wrap;
  }

  function renderCatalogState(documents) {
    const snapshot = getDocsAvailability() || {};
    const visibleDocuments = Array.isArray(documents) ? documents : [];

    if (snapshot.state === "unavailable") {
      return markLiveState(
        renderDocsAvailabilityState(snapshot),
        "unavailable",
      );
    }
    if (snapshot.state === "loaded" && Number(snapshot.documentCount || 0) === 0) {
      return markLiveState(
        renderDocsAvailabilityState(snapshot, { includeEmpty: true }),
        "empty",
      );
    }
    if (snapshot.state === "loading") {
      return renderCatalogNotice(
        "Loading Process Docs",
        "Fetching the process-document catalog…",
        "loading",
        "Work, Cards, and Tasks remain independent while the catalog loads.",
      );
    }

    const activeFilters = Object.values(knowledgeState.documentFilters || {})
      .filter(Boolean).length;
    if (
      snapshot.state === "loaded" &&
      activeFilters > 0 &&
      visibleDocuments.length === 0
    ) {
      const documentLabel =
        snapshot.documentCount === 1 ? "process document" : "process documents";
      const filterLabel =
        activeFilters === 1 ? "active metadata filter" : "active metadata filters";
      return renderCatalogNotice(
        "No Process Docs match these filters",
        `The catalog contains ${snapshot.documentCount} ${documentLabel}, but none match the ${activeFilters} ${filterLabel}.`,
        "filter-empty",
        "Open Filters and choose Clear filters to restore the full catalog.",
      );
    }
    return null;
  }

  function renderCatalogNotice(title, body, state, detail) {
    const node = renderHonestState(title, body);
    node.className = `${node.className} ops-docs-state`.trim();
    node.dataset.docsState = state;
    if (detail) {
      const note = document.createElement("small");
      note.className = "ops-docs-state-detail";
      note.textContent = detail;
      node.append(note);
    }
    return markLiveState(node, state);
  }

  function markLiveState(node, state) {
    if (!node) return node;
    node.setAttribute("role", state === "unavailable" ? "alert" : "status");
    node.setAttribute(
      "aria-live",
      state === "unavailable" ? "assertive" : "polite",
    );
    node.setAttribute("aria-atomic", "true");
    return node;
  }

  function renderProcessQualityDrilldown(quality, wasOpen = false) {
    if (!quality?.loaded || Number(quality.totalFindings || 0) === 0) return null;

    const wrap = document.createElement("details");
    wrap.className = "ops-section ops-quality-drilldown";
    wrap.setAttribute("aria-label", "Process quality findings");
    wrap.dataset.qualityState = "loaded";
    if (wasOpen) wrap.open = true;

    const summary = document.createElement("summary");
    summary.className = "ops-quality-summary";
    const total = document.createElement("strong");
    total.className = "ops-count";
    total.textContent = String(quality.totalFindings);
    summary.append(total, ` finding${quality.totalFindings === 1 ? "" : "s"}`);
    wrap.append(summary);

    if (!quality.activeWorkLoaded) {
      wrap.append(
        markLiveState(renderHonestState(
          "Live work unavailable",
          "Active Task/Card impact cannot be confirmed. Severity below reflects Template and Process Doc risk only.",
        ), "unavailable"),
      );
    }

    const filters = document.createElement("div");
    filters.className = "ops-quality-filters";
    filters.setAttribute("aria-label", "Filter quality findings");
    const findings = quality.maintainerFindings;
    const filterDefs = [
      [
        "severity",
        "Severity",
        ["", ...uniqueSorted(findings.map((finding) => finding.severity))],
      ],
      [
        "category",
        "Category",
        ["", ...uniqueSorted(findings.map((finding) => finding.category))],
      ],
      [
        "workflow",
        "Workflow",
        [
          "",
          ...uniqueSorted(
            findings
              .map((finding) => finding.workflowSlug || finding.templateId)
              .filter(Boolean),
          ),
        ],
      ],
      [
        "document",
        "Document",
        [
          "",
          ...uniqueSorted(
            findings
              .map(
                (finding) =>
                  finding.docPath || finding.docId || finding.instructionDocId,
              )
              .filter(Boolean),
          ),
        ],
      ],
    ];
    for (const [key, labelText, values] of filterDefs) {
      const label = document.createElement("label");
      label.className = "ops-quality-filter";
      label.textContent = labelText;
      const select = document.createElement("select");
      select.setAttribute("aria-label", labelText);
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value ? value : "All";
        select.append(option);
      }
      select.value = qualityFiltersState.value[key] || "";
      select.addEventListener("change", () => {
        qualityFiltersState.value = {
          ...qualityFiltersState.value,
          [key]: select.value,
        };
        refreshDocuments();
      });
      label.append(select);
      filters.append(label);
    }
    const disclosure = document.createElement("details");
    disclosure.className = "ops-quality-filters-disclosure";
    const compact = isCompactViewport();
    disclosure.open = !compact || qualityFiltersState.disclosureOpen === true;
    disclosure.addEventListener("toggle", () => {
      if (isCompactViewport()) {
        qualityFiltersState.disclosureOpen = disclosure.open;
      }
    });
    const activeFilterCount = Object.values(qualityFiltersState.value || {})
      .filter(Boolean).length;
    const disclosureSummary = document.createElement("summary");
    disclosureSummary.textContent = activeFilterCount
      ? `Filter findings · ${activeFilterCount} active`
      : "Filter findings";
    disclosure.append(disclosureSummary, filters);
    wrap.append(disclosure);

    const filtered = filterQualityFindings(findings, qualityFiltersState.value);
    const list = document.createElement("div");
    list.className = "ops-quality-list";
    if (filtered.length === 0) {
      list.append(
        markLiveState(renderHonestState(
          findings.length === 0
            ? "No findings"
            : "No findings match filters",
          findings.length === 0
            ? "Published process docs pass validation."
            : "Change filters to inspect other process quality findings.",
        ), "empty"),
      );
    } else {
      for (const finding of filtered.slice(0, 80))
        list.append(renderQualityFindingRow(finding));
      if (filtered.length > 80) {
        const more = document.createElement("p");
        more.className = "ops-empty";
        more.textContent = `Showing 80 of ${filtered.length} findings. Narrow the filters to inspect the rest.`;
        list.append(more);
      }
    }
    wrap.append(list);
    return wrap;
  }

  function filterQualityFindings(findings, filters) {
    return findings.filter((finding) => {
      if (filters.severity && finding.severity !== filters.severity) return false;
      if (filters.category && finding.category !== filters.category) return false;
      if (
        filters.workflow &&
        ![finding.workflowSlug, finding.templateId].includes(filters.workflow)
      )
        return false;
      if (
        filters.document &&
        ![finding.docPath, finding.docId, finding.instructionDocId].includes(
          filters.document,
        )
      )
        return false;
      return true;
    });
  }

  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean).map(String))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  function isCompactViewport() {
    return Boolean(
      document.defaultView?.matchMedia?.("(max-width: 820px)")?.matches,
    );
  }

  return { renderDocsSurface, renderProcessesSurface };
}
