// The block gutter (a "+" and a drag handle beside each block) and the
// block menu the handle opens. On a mouse the gutter shows on hover; on
// touch it shows for the block being edited, and a tap on the handle opens
// the menu, so nothing depends on hover.

let openMenu = null;

export function closeBlockMenu() {
  openMenu?.close();
}

/**
 * Open a menu of block actions under `anchor`.
 * `items`: [{ label, run, danger?, hint? } | "separator"]
 */
export function openBlockMenu(anchor, items, { label = "Block actions", onClose } = {}) {
  closeBlockMenu();
  const doc = globalThis.document;
  const menu = doc.createElement("div");
  menu.className = "block-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);

  const buttons = [];
  for (const item of items) {
    if (item === "separator") {
      const rule = doc.createElement("div");
      rule.className = "block-menu-separator";
      rule.setAttribute("role", "separator");
      menu.append(rule);
      continue;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `block-menu-item${item.danger ? " is-danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    const text = doc.createElement("span");
    text.textContent = item.label;
    button.append(text);
    if (item.hint) {
      const hint = doc.createElement("kbd");
      hint.className = "block-menu-hint";
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      close(false);
      item.run();
    });
    menu.append(button);
    buttons.push(button);
  }

  let active = 0;
  const focusItem = (index) => {
    if (!buttons.length) return;
    active = (index + buttons.length) % buttons.length;
    buttons[active].focus();
  };
  menu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(active - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  });

  const onOutside = (event) => {
    if (!menu.contains(event.target) && event.target !== anchor) close(false);
  };
  const onScroll = (event) => {
    if (!menu.contains(event.target)) close(false);
  };

  function close(restoreFocus) {
    if (openMenu?.menu !== menu) return;
    openMenu = null;
    doc.removeEventListener("mousedown", onOutside, true);
    globalThis.removeEventListener?.("scroll", onScroll, true);
    menu.remove();
    anchor?.setAttribute?.("aria-expanded", "false");
    if (restoreFocus) anchor?.focus?.();
    onClose?.();
  }

  doc.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const height = menu.offsetHeight || 240;
  const width = menu.offsetWidth || 220;
  const viewportHeight = globalThis.innerHeight || 800;
  const viewportWidth = globalThis.innerWidth || 1200;
  const top = rect.bottom + height + 8 > viewportHeight && rect.top > height + 8
    ? rect.top - height - 4
    : rect.bottom + 4;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  anchor?.setAttribute?.("aria-expanded", "true");
  doc.addEventListener("mousedown", onOutside, true);
  globalThis.addEventListener?.("scroll", onScroll, true);
  openMenu = { menu, close: () => close(false) };
  focusItem(0);
  return openMenu;
}

/**
 * The gutter for one block: "+" inserts below, the handle drags the block
 * and, clicked or tapped, opens its menu.
 */
export function makeBlockGutter({ addLabel = "Insert below", onAdd, onMenu, onDragStart, onDragEnd }) {
  const doc = globalThis.document;
  const gutter = doc.createElement("div");
  gutter.className = "block-gutter";
  gutter.contentEditable = "false";

  const add = doc.createElement("button");
  add.type = "button";
  add.className = "block-gutter-button block-gutter-add";
  add.title = addLabel;
  add.setAttribute("aria-label", addLabel);
  add.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
  add.addEventListener("mousedown", (event) => event.preventDefault());
  add.addEventListener("click", (event) => {
    event.stopPropagation();
    onAdd?.(add);
  });

  // A div, not a button: Firefox never starts a drag from a button.
  const handle = doc.createElement("div");
  handle.setAttribute("role", "button");
  handle.tabIndex = 0;
  handle.className = "block-gutter-button block-gutter-handle";
  handle.title = "Drag to move · click for options";
  handle.setAttribute("aria-label", "Block options");
  handle.setAttribute("aria-haspopup", "menu");
  handle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    [4, 8, 12].map((y) => `<circle cx="6" cy="${y}" r="1.1"/><circle cx="10" cy="${y}" r="1.1"/>`).join("") +
    "</svg>";
  if (onDragStart) {
    handle.draggable = true;
    handle.addEventListener("dragstart", (event) => onDragStart(event));
    handle.addEventListener("dragend", (event) => onDragEnd?.(event));
  }
  handle.addEventListener("click", (event) => {
    event.stopPropagation();
    onMenu?.(handle);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onMenu?.(handle);
  });

  gutter.append(add, handle);
  return gutter;
}
