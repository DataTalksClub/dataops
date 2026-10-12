export function createSlashMenu({ onSelectBlockType } = {}) {
  const BLOCK_TYPES = [
    {
      type: "paragraph",
      title: "Text",
      description: "Just start writing with plain text.",
      icon: "📝",
      shortcut: "p",
      template: "",
    },
    {
      type: "h1",
      title: "Heading 1",
      description: "Big section heading.",
      icon: "📌",
      shortcut: "h1",
      template: "# Heading 1",
    },
    {
      type: "h2",
      title: "Heading 2",
      description: "Medium section heading.",
      icon: "📍",
      shortcut: "h2",
      template: "## Heading 2",
    },
    {
      type: "h3",
      title: "Heading 3",
      description: "Small section heading.",
      icon: "🏷️",
      shortcut: "h3",
      template: "### Heading 3",
    },
    {
      type: "bullet",
      title: "Bulleted List",
      description: "Create a bulleted list.",
      icon: "📋",
      shortcut: "bullet",
      template: "- List item",
    },
    {
      type: "numbered",
      title: "Numbered List",
      description: "Create a numbered list.",
      icon: "🔢",
      shortcut: "number",
      template: "1. List item",
    },
    {
      type: "todo",
      title: "To-do List",
      description: "Track tasks with a to-do list.",
      icon: "☑️",
      shortcut: "todo",
      template: "- [ ] To-do item",
    },
    {
      type: "callout",
      title: "Callout",
      description: "Highlight important context or notes.",
      icon: "💡",
      shortcut: "callout",
      template: "> [!NOTE]\n> Note text",
    },
    {
      type: "code",
      title: "Code Block",
      description: "Capture code with syntax formatting.",
      icon: "💻",
      shortcut: "code",
      template: "```\n// code here\n```",
    },
    {
      type: "divider",
      title: "Divider",
      description: "Visually divide blocks with a line.",
      icon: "➖",
      shortcut: "hr",
      template: "---",
    },
    {
      type: "step",
      title: "Procedure Step",
      description: "Add a numbered step with action and proof.",
      icon: "🪜",
      shortcut: "step",
      template: "1. Action step",
    },
  ];

  let menuEl = null;
  let activeIndex = 0;
  let filtered = [...BLOCK_TYPES];
  let currentTargetEl = null;

  function isOpen() {
    return menuEl != null && menuEl.isConnected;
  }

  function open({ targetEl, anchorRect, onSelect, onClose, initialQuery = "" } = {}) {
    close();
    currentTargetEl = targetEl;
    menuEl = document.createElement("div");
    menuEl.className = "block-slash-menu";
    menuEl.setAttribute("role", "menu");
    menuEl.setAttribute("aria-label", "Block types");

    const header = document.createElement("div");
    header.className = "slash-menu-header";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "slash-menu-filter";
    filterInput.placeholder = "Filter blocks (e.g. heading, todo, list)…";
    filterInput.value = initialQuery;
    header.append(filterInput);
    menuEl.append(header);

    const list = document.createElement("div");
    list.className = "slash-menu-list";
    list.setAttribute("role", "presentation");
    menuEl.append(list);

    function updateFiltered(query) {
      const q = String(query || "").trim().toLowerCase();
      filtered = BLOCK_TYPES.filter(
        (item) =>
          !q ||
          item.title.toLowerCase().includes(q) ||
          item.shortcut.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.type.toLowerCase().includes(q),
      );
      if (filtered.length === 0) {
        filtered = BLOCK_TYPES;
      }
      activeIndex = Math.max(0, Math.min(activeIndex, filtered.length - 1));
      renderList();
    }

    function renderList() {
      list.replaceChildren();
      filtered.forEach((item, idx) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `slash-menu-item${idx === activeIndex ? " is-active" : ""}`;
        row.setAttribute("role", "menuitem");
        row.setAttribute("aria-selected", String(idx === activeIndex));

        const icon = document.createElement("span");
        icon.className = "slash-menu-icon";
        icon.textContent = item.icon;

        const info = document.createElement("div");
        info.className = "slash-menu-info";
        const title = document.createElement("strong");
        title.textContent = item.title;
        const desc = document.createElement("span");
        desc.textContent = item.description;
        info.append(title, desc);

        const shortcut = document.createElement("kbd");
        shortcut.className = "slash-menu-shortcut";
        shortcut.textContent = `/${item.shortcut}`;

        row.append(icon, info, shortcut);
        row.addEventListener("mouseenter", () => {
          activeIndex = idx;
          updateActiveItem();
        });
        row.addEventListener("click", (e) => {
          e?.stopPropagation?.();
          selectItem(item);
        });
        list.append(row);
      });
    }

    function updateActiveItem() {
      const items = list.querySelectorAll(".slash-menu-item");
      items.forEach((it, idx) => {
        it.classList.toggle("is-active", idx === activeIndex);
        it.setAttribute("aria-selected", String(idx === activeIndex));
      });
      items[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }

    function selectItem(item) {
      close();
      if (onSelect) onSelect(item);
      else if (onSelectBlockType) onSelectBlockType(item);
    }

    filterInput.addEventListener("input", () => {
      updateFiltered(filterInput.value);
    });

    filterInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % filtered.length;
        updateActiveItem();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
        updateActiveItem();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (filtered[activeIndex]) selectItem(filtered[activeIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
        if (onClose) onClose();
      }
    });

    const dialog = targetEl?.closest?.("dialog");
    const root =
      dialog ||
      targetEl?.ownerDocument?.body ||
      globalThis.document?.body ||
      targetEl?.parentElement ||
      targetEl;
    if (root) root.append(menuEl);

    // Position menu near target element, flipping upward if needed
    if (targetEl) {
      const rect = anchorRect || targetEl.getBoundingClientRect();
      menuEl.style.position = "absolute";
      const menuHeight = menuEl.offsetHeight || 300;
      const menuWidth = menuEl.offsetWidth || 300;

      if (dialog) {
        const dialogRect = dialog.getBoundingClientRect();
        const relTop = rect.top - dialogRect.top;
        const relBottom = rect.bottom - dialogRect.top;
        const relLeft = rect.left - dialogRect.left;
        const spaceBelow = dialogRect.bottom - rect.bottom;
        const spaceAbove = rect.top - dialogRect.top;

        let top;
        if (spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow) {
          top = Math.max(8, relTop - menuHeight - 4);
        } else {
          top = Math.min(dialogRect.height - menuHeight - 8, relBottom + 4);
        }
        const left = Math.max(8, Math.min(relLeft, dialogRect.width - menuWidth - 8));
        menuEl.style.top = `${Math.round(top)}px`;
        menuEl.style.left = `${Math.round(left)}px`;
        dialog.addEventListener("close", () => close(), { once: true });
      } else {
        const scrollY = typeof window !== "undefined" ? window.scrollY || 0 : 0;
        const scrollX = typeof window !== "undefined" ? window.scrollX || 0 : 0;
        const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
        const spaceBelow = viewportHeight - rect.bottom;
        const spaceAbove = rect.top;

        let top;
        if (spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow) {
          top = rect.top + scrollY - menuHeight - 4;
        } else {
          top = rect.bottom + scrollY + 4;
        }
        menuEl.style.top = `${Math.round(top)}px`;
        menuEl.style.left = `${Math.max(16, Math.round(rect.left + scrollX))}px`;
      }
    }
    updateFiltered(initialQuery);
    setTimeout(() => filterInput.focus(), 10);

    const onDocClick = (e) => {
      if (!menuEl || menuEl.contains(e.target) || targetEl?.contains(e.target)) return;
      close();
      if (onClose) onClose();
    };
    setTimeout(() => {
      if (typeof window !== "undefined") {
        window.addEventListener("click", onDocClick, { once: true });
      }
    }, 50);
  }

  function close() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    currentTargetEl = null;
  }

  return {
    open,
    close,
    isOpen,
    BLOCK_TYPES,
  };
}
