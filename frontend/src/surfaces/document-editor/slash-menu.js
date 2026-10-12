const BLOCK_ICONS = {
  paragraph:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  h1:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h8M4 5v14M12 5v14M18 19V9l-3 2"/></svg>',
  h2:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h8M4 5v14M12 5v14"/>' +
    '<path d="M21 19h-4c0-2.5 4-3 4-5.5a2.5 2.5 0 0 0-5 0"/></svg>',
  h3:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h8M4 5v14M12 5v14"/>' +
    '<path d="M17.5 10.5c1-1 3.5-.5 3.5 1.5 0 1.2-1 1.8-2 2 1.2.2 2 1 2 2.2 0 2-2.5 2.5-3.5 1.5"/></svg>',
  bullet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/>' +
    '<line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>' +
    '<circle cx="4" cy="6" r="1.5" fill="currentColor"/>' +
    '<circle cx="4" cy="12" r="1.5" fill="currentColor"/>' +
    '<circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>',
  numbered:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="10" y1="6" x2="20" y2="6"/>' +
    '<line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/>' +
    '<path d="M4 7V5h1v4M4 9h2"/><path d="M6 17H4c0-.8 1.5-1.5 2-2s-.5-1-1.5-1"/></svg>',
  todo:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/>' +
    '<path d="m8 12 3 3 5-6"/></svg>',
  callout:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2zM9 21h6"/></svg>',
  code:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 18 22 12 16 6"/>' +
    '<polyline points="8 6 2 12 8 18"/></svg>',
  divider:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"/></svg>',
  step:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 18 10 18 10 14 14 14 14 10 18 10 18 6"/></svg>',
};

export function createSlashMenu({ onSelectBlockType } = {}) {
  const BLOCK_TYPES = [
    {
      type: "paragraph",
      title: "Text",
      description: "Just start writing with plain text.",
      icon: BLOCK_ICONS.paragraph,
      shortcut: "p",
      template: "",
    },
    {
      type: "h1",
      title: "Heading 1",
      description: "Big section heading.",
      icon: BLOCK_ICONS.h1,
      shortcut: "h1",
      template: "# Heading 1",
    },
    {
      type: "h2",
      title: "Heading 2",
      description: "Medium section heading.",
      icon: BLOCK_ICONS.h2,
      shortcut: "h2",
      template: "## Heading 2",
    },
    {
      type: "h3",
      title: "Heading 3",
      description: "Small section heading.",
      icon: BLOCK_ICONS.h3,
      shortcut: "h3",
      template: "### Heading 3",
    },
    {
      type: "bullet",
      title: "Bulleted List",
      description: "Create a bulleted list.",
      icon: BLOCK_ICONS.bullet,
      shortcut: "bullet",
      template: "- List item",
    },
    {
      type: "numbered",
      title: "Numbered List",
      description: "Create a numbered list.",
      icon: BLOCK_ICONS.numbered,
      shortcut: "number",
      template: "1. List item",
    },
    {
      type: "todo",
      title: "To-do List",
      description: "Track tasks with a to-do list.",
      icon: BLOCK_ICONS.todo,
      shortcut: "todo",
      template: "- [ ] To-do item",
    },
    {
      type: "callout",
      title: "Callout",
      description: "Highlight important context or notes.",
      icon: BLOCK_ICONS.callout,
      shortcut: "callout",
      template: "> [!NOTE]\n> Note text",
    },
    {
      type: "code",
      title: "Code Block",
      description: "Capture code with syntax formatting.",
      icon: BLOCK_ICONS.code,
      shortcut: "code",
      template: "```\n// code here\n```",
    },
    {
      type: "divider",
      title: "Divider",
      description: "Visually divide blocks with a line.",
      icon: BLOCK_ICONS.divider,
      shortcut: "hr",
      template: "---",
    },
    {
      type: "step",
      title: "Procedure Step",
      description: "Add a numbered step with action and proof.",
      icon: BLOCK_ICONS.step,
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
        icon.innerHTML = item.icon;

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
    updateFiltered(initialQuery);

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
