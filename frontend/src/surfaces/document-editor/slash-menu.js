const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

export const BLOCK_ICONS = {
  paragraph: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  h1: svg('<path d="M4 12h8M4 5v14M12 5v14M18 19V9l-3 2"/>'),
  h2: svg('<path d="M4 12h8M4 5v14M12 5v14"/><path d="M21 19h-4c0-2.5 4-3 4-5.5a2.5 2.5 0 0 0-5 0"/>'),
  h3: svg('<path d="M4 12h8M4 5v14M12 5v14"/><path d="M17.5 10.5c1-1 3.5-.5 3.5 1.5 0 1.2-1 1.8-2 2 1.2.2 2 1 2 2.2 0 2-2.5 2.5-3.5 1.5"/>'),
  bullet: svg(
    '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/>' +
    '<line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/>' +
    '<circle cx="4" cy="12" r="1.5" fill="currentColor"/>' +
    '<circle cx="4" cy="18" r="1.5" fill="currentColor"/>'),
  numbered: svg(
    '<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/>' +
    '<line x1="10" y1="18" x2="20" y2="18"/><path d="M4 7V5h1v4M4 9h2"/>' +
    '<path d="M6 17H4c0-.8 1.5-1.5 2-2s-.5-1-1.5-1"/>'),
  todo: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  quote: svg('<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z"/>'),
  callout: svg('<path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2zM9 21h6"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  divider: svg('<line x1="3" y1="12" x2="21" y2="12"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  embed: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>'),
  step: svg('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 7V5h1v4M4 9h2"/><path d="M4 15h2v4H4"/>'),
  prose: svg('<path d="M4 6h16M4 12h12M4 18h8"/>'),
  group: svg('<path d="M4 5h16M4 5v14h16V5"/><path d="M8 10h8M8 14h5"/>'),
  note: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  page: svg(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/>'),
};

/** Block types for documents and ordinary SOP sections. */
export const DOCUMENT_BLOCKS = [
  { type: "paragraph", title: "Text", description: "Plain text.", shortcut: "text", keywords: "paragraph p", template: "" },
  { type: "h1", title: "Heading 1", description: "Big section heading.", shortcut: "h1", keywords: "title #", template: "# " },
  { type: "h2", title: "Heading 2", description: "Medium section heading.", shortcut: "h2", keywords: "subtitle ##", template: "## " },
  { type: "h3", title: "Heading 3", description: "Small section heading.", shortcut: "h3", keywords: "###", template: "### " },
  { type: "bullet", title: "Bulleted list", description: "A simple bulleted list.", shortcut: "bullet", keywords: "ul unordered -", template: "- List item" },
  { type: "numbered", title: "Numbered list", description: "A list with numbering.", shortcut: "number", keywords: "ol ordered 1.", template: "1. List item" },
  { type: "todo", title: "To-do list", description: "Track tasks with checkboxes.", shortcut: "todo", keywords: "checkbox task []", template: "- [ ] " },
  { type: "quote", title: "Quote", description: "Capture a quote.", shortcut: "quote", keywords: "blockquote >", template: "> " },
  { type: "callout", title: "Callout", description: "Make a note stand out.", shortcut: "callout", keywords: "note tip warning", template: "> [!NOTE]\n> Note text" },
  { type: "code", title: "Code", description: "A code snippet.", shortcut: "code", keywords: "snippet ```", template: "```\n\n```" },
  { type: "divider", title: "Divider", description: "Separate blocks with a line.", shortcut: "hr", keywords: "line separator ---", template: "---" },
  { type: "image", title: "Image", description: "Upload a screenshot or image.", shortcut: "image", keywords: "screenshot picture photo upload", template: "" },
  { type: "embed", title: "Video", description: "Embed a Loom, YouTube or Vimeo video.", shortcut: "video", keywords: "embed loom youtube vimeo", template: "" },
  { type: "page", title: "Sub-page", description: "A page nested inside this one.", shortcut: "page", keywords: "subpage child", template: "" },
];

/** What can be inserted inside an SOP procedure. */
export const PROCEDURE_BLOCKS = [
  { type: "step", title: "Step", description: "A numbered procedure step.", shortcut: "step", keywords: "numbered action" },
  { type: "prose", title: "Text", description: "Free text between steps.", shortcut: "text", keywords: "paragraph prose note free" },
  { type: "group", title: "Group", description: "Start a group of steps here.", shortcut: "group", keywords: "heading section phase" },
  { type: "image", title: "Screenshot", description: "Upload a screenshot to this step.", shortcut: "image", keywords: "screenshot picture upload" },
  { type: "embed", title: "Video", description: "Embed a Loom, YouTube or Vimeo video.", shortcut: "video", keywords: "embed loom youtube vimeo" },
  { type: "todo", title: "TODO", description: "Flag missing information.", shortcut: "todo", keywords: "missing gap fixme", icon: BLOCK_ICONS.note },
];

export function filterBlockTypes(items, query) {
  const normalize = (value) => String(value || "").toLowerCase()
    .replace(/^\/+/, "").replace(/[-\s]+/g, "");
  const q = normalize(query);
  if (!q) return items;
  const starts = [];
  const contains = [];
  for (const item of items) {
    const fields = [item.title, item.shortcut, item.type, ...(item.keywords || "").split(/\s+/)]
      .map(normalize);
    if (fields.some((field) => field.startsWith(q))) starts.push(item);
    else if (fields.some((field) => field.includes(q)) || normalize(item.description).includes(q)) {
      contains.push(item);
    }
  }
  return [...starts, ...contains];
}

export function createSlashMenu({ onSelectBlockType, additionalBlockTypes = [] } = {}) {
  const BLOCK_TYPES = [
    ...DOCUMENT_BLOCKS.filter((item) => item.type !== "image" && item.type !== "embed"),
    {
      type: "step",
      title: "Procedure Step",
      description: "Add a numbered step with action and proof.",
      shortcut: "step",
      template: "1. Action step",
    },
    ...additionalBlockTypes,
  ].map((item) => ({ icon: BLOCK_ICONS[item.type] || BLOCK_ICONS.callout, ...item }));

  let menuEl = null;
  let activeIndex = 0;
  let filtered = [];
  let cleanupOpen = null;

  function isOpen() {
    return menuEl != null && menuEl.isConnected;
  }

  /**
   * Open the menu. With `inline` (an editable's slash session) the query is
   * what the user types after "/" in the block and the keyboard stays there;
   * without it the menu has its own filter field (the "+" button, the
   * newsletter composer).
   */
  function open({ targetEl, anchorRect, onSelect, onClose, initialQuery = "", inline = null, items = null } = {}) {
    close();
    const catalogue = (items || BLOCK_TYPES).map((item) => ({
      icon: BLOCK_ICONS[item.type] || BLOCK_ICONS.callout, ...item,
    }));
    menuEl = document.createElement("div");
    const openedMenu = menuEl;
    menuEl.className = `block-slash-menu${inline ? " is-inline" : ""}`;
    menuEl.style.position = "absolute";
    menuEl.setAttribute("role", "menu");
    menuEl.setAttribute("aria-label", "Insert a block");

    let filterInput = null;
    if (!inline) {
      const header = document.createElement("div");
      header.className = "slash-menu-header";
      filterInput = document.createElement("input");
      filterInput.type = "text";
      filterInput.className = "slash-menu-filter";
      filterInput.placeholder = "Filter blocks (e.g. heading, todo, list)…";
      filterInput.value = initialQuery;
      header.append(filterInput);
      menuEl.append(header);
    }

    const list = document.createElement("div");
    list.className = "slash-menu-list";
    list.setAttribute("role", "presentation");
    menuEl.append(list);

    function updateFiltered(query) {
      filtered = filterBlockTypes(catalogue, query);
      if (!inline && filtered.length === 0) filtered = catalogue;
      activeIndex = Math.max(0, Math.min(activeIndex, filtered.length - 1));
      renderList();
    }

    function renderList() {
      list.replaceChildren();
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "slash-menu-empty";
        empty.textContent = "No matching blocks";
        list.append(empty);
        return;
      }
      filtered.forEach((item, idx) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `slash-menu-item${idx === activeIndex ? " is-active" : ""}`;
        row.setAttribute("role", "menuitem");
        row.setAttribute("aria-selected", String(idx === activeIndex));
        row.tabIndex = -1;

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
        // Keep the caret in the block while the pointer picks an item.
        row.addEventListener("mousedown", (event) => event.preventDefault());
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
      const rows = list.querySelectorAll(".slash-menu-item");
      rows.forEach((it, idx) => {
        it.classList.toggle("is-active", idx === activeIndex);
        it.setAttribute("aria-selected", String(idx === activeIndex));
      });
      rows[activeIndex]?.scrollIntoView?.({ block: "nearest" });
    }

    function selectItem(item) {
      // Remove the typed "/query" while the session is still attached.
      inline?.consume?.();
      close();
      if (onSelect) onSelect(item);
      else if (onSelectBlockType) onSelectBlockType(item);
    }

    const move = (delta) => {
      if (!filtered.length) return;
      activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
      updateActiveItem();
    };
    const choose = () => {
      if (filtered[activeIndex]) selectItem(filtered[activeIndex]);
      else close();
    };

    if (filterInput) {
      filterInput.addEventListener("input", () => updateFiltered(filterInput.value));
      filterInput.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          choose();
        }
      });
    }

    const dismiss = () => {
      close();
      if (targetEl?.isConnected) targetEl.focus();
      if (onClose) onClose();
    };
    menuEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
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
    position(menuEl, list, targetEl, anchorRect, dialog);

    const focusTimer = filterInput
      ? setTimeout(() => {
        if (menuEl === openedMenu && openedMenu.isConnected) filterInput.focus();
      }, 0)
      : null;

    const onDocClick = (e) => {
      if (menuEl !== openedMenu || openedMenu.contains(e.target) || targetEl?.contains(e.target)) return;
      close();
      if (onClose) onClose();
    };
    const onDialogClose = () => close();
    const onDialogCancel = (event) => {
      event.preventDefault();
      dismiss();
    };
    // The inline menu follows its block when the page scrolls.
    const startRect = targetEl?.getBoundingClientRect?.();
    const onScroll = (event) => {
      if (openedMenu.contains(event.target) || !targetEl?.isConnected || !startRect) return;
      const now = targetEl.getBoundingClientRect();
      const anchor = anchorRect || startRect;
      const dy = now.top - startRect.top;
      const dx = now.left - startRect.left;
      position(openedMenu, list, targetEl, {
        top: anchor.top + dy, bottom: anchor.bottom + dy, left: anchor.left + dx, right: anchor.right + dx,
      }, dialog);
    };
    const outsideTimer = setTimeout(() => {
      if (menuEl === openedMenu && typeof window !== "undefined") {
        window.addEventListener("click", onDocClick);
      }
    }, 0);
    if (inline && typeof window !== "undefined") window.addEventListener("scroll", onScroll, true);
    dialog?.addEventListener("close", onDialogClose);
    dialog?.addEventListener("cancel", onDialogCancel);
    cleanupOpen = () => {
      clearTimeout(focusTimer);
      clearTimeout(outsideTimer);
      if (typeof window !== "undefined") {
        window.removeEventListener("click", onDocClick);
        window.removeEventListener("scroll", onScroll, true);
      }
      dialog?.removeEventListener("close", onDialogClose);
      dialog?.removeEventListener("cancel", onDialogCancel);
      inline?.detach?.();
    };

    inline?.attach?.({
      setQuery: (query) => {
        activeIndex = 0;
        updateFiltered(query);
        // Notion closes the menu once nothing matches for a while.
        if (!filtered.length && query.length > 3) close();
      },
      move,
      choose,
      close,
      isOpen: () => menuEl === openedMenu && openedMenu.isConnected,
    });
  }

  function position(menu, list, targetEl, anchorRect, dialog) {
    if (!targetEl) return;
    const rect = anchorRect || targetEl.getBoundingClientRect();
    let menuHeight = menu.offsetHeight || 300;
    const menuWidth = menu.offsetWidth || 300;
    const header = menu.querySelector(".slash-menu-header");

    if (dialog) {
      const dialogRect = dialog.getBoundingClientRect();
      const bodyRect = (dialog.querySelector(".dk-dialog__body") || dialog).getBoundingClientRect();
      const minTop = bodyRect.top - dialogRect.top + 4;
      const maxBottom = bodyRect.bottom - dialogRect.top - 4;
      const relTop = rect.top - dialogRect.top;
      const relBottom = rect.bottom - dialogRect.top;
      const relLeft = rect.left - dialogRect.left;
      const spaceBelow = maxBottom - relBottom - 4;
      const spaceAbove = relTop - minTop - 4;
      const downward = spaceBelow >= Math.min(menuHeight, 160) || spaceBelow >= spaceAbove;
      const available = Math.max(60, downward ? spaceBelow : spaceAbove);
      list.style.maxHeight = `${Math.min(260, Math.max(40, available - (header?.offsetHeight || 0) - 20))}px`;
      menuHeight = menu.offsetHeight || menuHeight;
      const anchoredTop = downward ? relBottom + 4 : relTop - menuHeight - 4;
      const top = Math.max(minTop, Math.min(anchoredTop, maxBottom - menuHeight));
      const left = Math.max(8, Math.min(relLeft, dialogRect.width - menuWidth - 8));
      menu.style.top = `${Math.round(top)}px`;
      menu.style.left = `${Math.round(left)}px`;
      return;
    }
    const scrollY = typeof window !== "undefined" ? window.scrollY || 0 : 0;
    const scrollX = typeof window !== "undefined" ? window.scrollX || 0 : 0;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800;
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const top = spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow
      ? rect.top + scrollY - menuHeight - 4
      : rect.bottom + scrollY + 4;
    const left = Math.min(rect.left + scrollX, viewportWidth + scrollX - menuWidth - 16);
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.max(16, Math.round(left))}px`;
  }

  function close() {
    cleanupOpen?.();
    cleanupOpen = null;
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }

  return {
    open,
    close,
    isOpen,
    BLOCK_TYPES,
  };
}
