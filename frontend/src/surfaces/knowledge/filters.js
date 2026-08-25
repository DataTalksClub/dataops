export function createKnowledgeFilters(context, services) {
  const {
    customSelects,
    domainFilter,
    escapeRegex,
    filterCount,
    getActiveWorkspaceRoute,
    knowledgeState,
    navigateCanonicalWorkspace,
    systemFilter,
    tagFilter,
    typeFilter,
  } = context;

  const DOCUMENT_FILTERS = [
    ["domain", domainFilter],
    ["type", typeFilter],
    ["system", systemFilter],
    ["tag", tagFilter],
  ];

  function filterDocuments(documents) {
    return documents.filter((doc) => {
      const filters = knowledgeState.documentFilters;
      if (filters.domain && doc.domain !== filters.domain) return false;
      if (filters.type && doc.doc_type !== filters.type) return false;
      if (
        filters.system &&
        !(Array.isArray(doc.systems) && doc.systems.includes(filters.system))
      )
        return false;
      if (
        filters.tag &&
        !(Array.isArray(doc.tags) && doc.tags.includes(filters.tag))
      )
        return false;
      return true;
    });
  }

  function onFilterChange() {
    for (const [name, select] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = select.value;
    }
    updateFilterSummary();
    const activePath = getActiveWorkspaceRoute()?.path;
    const historyMode = activePath === "/processes" ? "replace" : "push";
    navigateCanonicalWorkspace(
      "/processes",
      documentFilterParams(),
      { history: historyMode, preserveDocumentComposer: true },
    );
  }

  function activeFilterCount() {
    return Object.values(knowledgeState.documentFilters).filter(Boolean)
      .length;
  }

  function documentFilterParams() {
    const params = new URLSearchParams();
    for (const [name] of DOCUMENT_FILTERS) {
      const value = knowledgeState.documentFilters[name];
      if (value) params.set(name, value);
    }
    return params;
  }

  function updateFilterControls() {
    for (const [name, select] of DOCUMENT_FILTERS) {
      select.value = knowledgeState.documentFilters[name];
      const entry = customSelects.find((item) => item.select === select);
      if (entry) updateCustomSelect(entry.root);
    }
  }

  function restoreDocumentFilters(params = new URLSearchParams()) {
    for (const [name] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = params.get(name) || "";
    }
    updateFilterControls();
    updateFilterSummary();
  }

  function clearDocumentFilters() {
    for (const [name] of DOCUMENT_FILTERS) {
      knowledgeState.documentFilters[name] = "";
    }
    updateFilterControls();
    updateFilterSummary();
    navigateCanonicalWorkspace("/processes", documentFilterParams(), {
      history: getActiveWorkspaceRoute()?.path === "/processes"
        ? "replace"
        : "push",
      preserveDocumentComposer: true,
    });
  }

  function searchFilterParams(url) {
    const filters = knowledgeState.documentFilters;
    if (filters.domain) url.searchParams.set("domain", filters.domain);
    if (filters.type) url.searchParams.set("doc_type", filters.type);
    if (filters.system) url.searchParams.set("system", filters.system);
    if (filters.tag) url.searchParams.set("tag", filters.tag);
    return url;
  }

  function updateFilterSummary() {
    const count = activeFilterCount();
    filterCount.hidden = count === 0;
    filterCount.textContent = count ? String(count) : "";
    filterCount.setAttribute("aria-label", `${count} active filters`);
  }

  function enhanceSelect(select) {
    const root = document.createElement("div");
    root.className = "custom-select";

    const button = document.createElement("button");
    button.className = "custom-select-button";
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    const arrow = document.createElement("span");
    arrow.className = "custom-select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    button.append(label, arrow);

    const menu = document.createElement("div");
    menu.className = "custom-select-menu";
    menu.setAttribute("role", "listbox");

    const commit = (value) => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      updateCustomSelect(root);
      closeCustomSelects();
      button.focus();
    };

    const renderOptions = () => {
      menu.replaceChildren(
        ...[...select.options].map((option) => {
          const item = document.createElement("button");
          item.className = "custom-select-option";
          item.type = "button";
          item.tabIndex = -1;
          item.setAttribute("role", "option");
          item.dataset.value = option.value;
          item.textContent = option.textContent;
          item.addEventListener("click", (event) => {
            event.stopPropagation();
            commit(option.value);
          });
          return item;
        }),
      );
    };

    renderOptions();

    const openMenu = () => {
      closeCustomSelects();
      root.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      const items = [...menu.querySelectorAll(".custom-select-option")];
      const selectedIdx = items.findIndex(
        (el) => el.dataset.value === select.value,
      );
      items[Math.max(0, selectedIdx)]?.focus();
    };

    const closeMenu = () => {
      closeCustomSelects();
      button.focus();
    };

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (root.classList.contains("is-open")) closeMenu();
      else openMenu();
    });

    button.addEventListener("keydown", (event) => {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
    });

    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll(".custom-select-option")];
      const idx = items.indexOf(document.activeElement);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        items[Math.min(items.length - 1, Math.max(0, idx) + 1)]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[Math.max(0, (idx < 0 ? items.length : idx) - 1)]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (idx >= 0) commit(items[idx].dataset.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      } else if (event.key === "Tab") {
        closeCustomSelects();
      }
    });

    root.append(button, menu);
    select.classList.add("native-select");
    select.after(root);
    customSelects.push({ root, select, label, button, renderOptions });
    updateCustomSelect(root);
  }

  function setSelectOptions(select, values, allLabel = "All") {
    const previous = knowledgeState.documentFilters[
      DOCUMENT_FILTERS.find(([, element]) => element === select)?.[0]
    ] || "";
    const items = [
      new Option(allLabel, ""),
      ...values.map((v) => new Option(humanizeOptionLabel(v), v)),
    ];
    select.replaceChildren(...items);
    select.value = values.includes(previous) ? previous : "";

    const entry = customSelects.find((c) => c.select === select);
    if (entry) {
      entry.renderOptions();
      updateCustomSelect(entry.root);
    }
  }

  function humanizeOptionLabel(value) {
    return value
      .split(/[-_]/)
      .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join(" ");
  }

  function populateFilterOptions() {
    const domains = [
      ...new Set(knowledgeState.allDocuments.map((d) => d.domain).filter(Boolean)),
    ].sort();
    const types = [
      ...new Set(knowledgeState.allDocuments.map((d) => d.doc_type).filter(Boolean)),
    ].sort();
    const systems = [
      ...new Set(knowledgeState.allDocuments.flatMap((d) => d.systems || []).filter(Boolean)),
    ].sort();
    const tags = [
      ...new Set(knowledgeState.allDocuments.flatMap((d) => d.tags || []).filter(Boolean)),
    ].sort();
    setSelectOptions(domainFilter, domains);
    setSelectOptions(typeFilter, types);
    setSelectOptions(systemFilter, systems);
    setSelectOptions(tagFilter, tags);
    updateFilterSummary();
  }

  function updateCustomSelect(root) {
    const item = customSelects.find((entry) => entry.root === root);
    if (!item) return;

    const selected = item.select.selectedOptions[0];
    item.label.textContent = selected?.textContent || "";
    item.root.querySelectorAll(".custom-select-option").forEach((option) => {
      const isSelected = option.dataset.value === item.select.value;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-selected", String(isSelected));
    });
  }

  function closeCustomSelects() {
    customSelects.forEach(({ root, button }) => {
      root.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
    });
  }

  function setHighlightedText(el, text, query) {
    const safe = String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    if (!query) {
      el.textContent = text;
      return;
    }
    const tokens = query.split(/\s+/).filter(Boolean).map(escapeRegex);
    if (tokens.length === 0) {
      el.textContent = text;
      return;
    }
    const re = new RegExp(`(${tokens.join("|")})`, "gi");
    el.innerHTML = safe.replace(re, "<mark>$1</mark>");
  }

  return {
    clearDocumentFilters,
    closeCustomSelects,
    enhanceSelect,
    filterDocuments,
    humanizeOptionLabel,
    onFilterChange,
    populateFilterOptions,
    restoreDocumentFilters,
    searchFilterParams,
    setHighlightedText,
    updateFilterSummary,
  };
}
