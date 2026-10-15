// A hover card: a small non-modal panel of detail about the thing a link
// names, shown while the pointer rests on the link or keyboard focus sits on
// it, and opened by an explicit toggle on touch, where nothing hovers.
//
// Portable on purpose (no app state, dakit tokens only) so it can move into
// dakit as a primitive. The card is inserted right after the trigger, so Tab
// walks from the trigger into the card and on into the rest of the page, and
// it is positioned `fixed` against the viewport, so a clipping list does not
// cut it off and nothing around it shifts.
//
//   attachHovercard(link, { label, render, toggle: infoButton });
//
// `toggle` is an optional button that opens and closes the card by click or
// tap; it carries the ARIA disclosure state. Show it where there is no hover.
//
// `render()` returns the card's content: a node, or a promise of one (loaded
// on first open; cache inside `render` to make reopening instant).

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 200;
const GAP_PX = 6;
const EDGE_PX = 8;

let openCard = null;
let sequence = 0;

export function attachHovercard(trigger, options = {}) {
  const {
    label = "Details",
    render,
    openDelay = OPEN_DELAY_MS,
    closeDelay = CLOSE_DELAY_MS,
    className = "",
    toggle: toggleButton = null,
  } = options;
  const id = `dk-hovercard-${(sequence += 1)}`;
  let card = null;
  let openTimer = null;
  let closeTimer = null;
  let anchor = trigger;
  let renderToken = 0;

  function setExpanded(value) {
    toggleButton?.setAttribute("aria-expanded", String(value));
  }
  if (toggleButton) {
    toggleButton.setAttribute("aria-haspopup", "dialog");
    toggleButton.setAttribute("aria-controls", id);
    setExpanded(false);
    toggleButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
  }

  function clearTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = null;
  }

  function isOpen() {
    return Boolean(card && !card.hidden);
  }

  function build() {
    card = document.createElement("div");
    card.id = id;
    card.className = ["dk-hovercard", className].filter(Boolean).join(" ");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", label);
    card.hidden = true;
    card.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") cancelClose();
    });
    card.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") scheduleClose();
    });
    card.addEventListener("focusout", onFocusOut);
    // An overlay: its clicks are its own, never the row or list under it.
    card.addEventListener("click", (event) => event.stopPropagation());
  }

  // Below the anchor when it fits, else above; when neither side fits, the
  // roomier side, with the card scrolling inside the space it has.
  function place() {
    if (!card || card.hidden) return;
    const box = anchor.getBoundingClientRect?.();
    if (!box) return;
    const viewportWidth = globalThis.innerWidth || 0;
    const viewportHeight = globalThis.innerHeight || 0;
    card.style.maxHeight = "";
    const width = card.offsetWidth || 320;
    const height = card.offsetHeight || 0;
    const left = Math.max(EDGE_PX, Math.min(box.left, viewportWidth - width - EDGE_PX));
    const spaceBelow = viewportHeight - box.bottom - GAP_PX - EDGE_PX;
    const spaceAbove = box.top - GAP_PX - EDGE_PX;
    const below = height <= spaceBelow || spaceBelow >= spaceAbove;
    const room = below ? spaceBelow : spaceAbove;
    if (height > room) card.style.maxHeight = `${Math.max(0, Math.floor(room))}px`;
    const shown = Math.min(height, room);
    const top = below ? box.bottom + GAP_PX : box.top - GAP_PX - shown;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  async function fill() {
    const token = (renderToken += 1);
    const loading = document.createElement("p");
    loading.className = "dk-hovercard__loading";
    loading.textContent = "Loading…";
    card.replaceChildren(loading);
    let content;
    try {
      content = await render?.();
    } catch {
      content = null;
    }
    if (token !== renderToken || !card) return;
    if (!content) {
      const failed = document.createElement("p");
      failed.className = "dk-hovercard__loading";
      failed.textContent = "Details are unavailable right now.";
      content = failed;
    }
    card.replaceChildren(content);
    place();
  }

  function open(options = {}) {
    clearTimers();
    if (openCard && openCard !== api) openCard.close();
    anchor = options.anchor || trigger;
    if (!card) build();
    if (!card.parentElement) trigger.after(card);
    if (isOpen()) return;
    card.hidden = false;
    setExpanded(true);
    openCard = api;
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("pointerdown", onOutside, true);
    globalThis.addEventListener?.("scroll", onViewportChange, true);
    globalThis.addEventListener?.("resize", onViewportChange);
    place();
    void fill();
  }

  function close(options = {}) {
    clearTimers();
    if (!isOpen()) return;
    const hadFocus = card.contains(document.activeElement);
    card.hidden = true;
    card.remove();
    setExpanded(false);
    if (openCard === api) openCard = null;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("pointerdown", onOutside, true);
    globalThis.removeEventListener?.("scroll", onViewportChange, true);
    globalThis.removeEventListener?.("resize", onViewportChange);
    if (hadFocus || options.restoreFocus) (options.focusTarget || trigger).focus?.();
  }

  function toggle(options = {}) {
    if (isOpen()) close(options);
    else open(options);
  }

  function scheduleOpen() {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (isOpen() || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      open();
    }, openDelay);
  }

  function scheduleClose() {
    clearTimeout(openTimer);
    openTimer = null;
    if (!isOpen() || closeTimer) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      close();
    }, closeDelay);
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  function within(node) {
    return Boolean(
      node &&
        (trigger.contains(node) || card?.contains(node) || anchor.contains?.(node) || toggleButton?.contains(node)),
    );
  }

  function onFocusOut(event) {
    if (!within(event.relatedTarget)) scheduleClose();
  }

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const active = document.activeElement;
    close({
      restoreFocus: card.contains(active) || active === trigger || active === toggleButton,
      focusTarget: active === toggleButton ? toggleButton : trigger,
    });
  }

  function onOutside(event) {
    if (!within(event.target)) close();
  }

  function onViewportChange(event) {
    if (event?.type === "scroll" && card?.contains(event.target)) return;
    close();
  }

  trigger.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "touch") scheduleOpen();
  });
  trigger.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") scheduleClose();
  });
  trigger.addEventListener("focus", () => {
    // Keyboard focus only: a mouse click focuses the link too, and that
    // click is navigating away.
    let keyboard = true;
    try {
      keyboard = trigger.matches(":focus-visible");
    } catch {}
    if (keyboard) scheduleOpen();
  });
  trigger.addEventListener("blur", (event) => {
    if (!within(event.relatedTarget)) scheduleClose();
  });

  const api = { open, close, toggle, isOpen, element: () => card };
  return api;
}
