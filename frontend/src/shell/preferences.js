const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createPreferencesShell({
  body,
  documentRef,
  getMobileWorkBellButton,
  HTMLElementClass,
  matchMedia,
  mobileMenuButton,
  pageShell,
  sidebar,
  sidebarExpandButton,
  sidebarScrim,
  storage,
  themeToggleButton,
}) {
  let lastSidebarOpener = null;

  function setDarkMode(on) {
    body.classList.toggle("dark", on);
    syncThemeToggleLabel(on);
    try {
      storage.setItem("dtc-theme", on ? "dark" : "light");
    } catch {}
  }

  function syncThemeToggleLabel(on = body.classList.contains("dark")) {
    themeToggleButton.title = on
      ? "Switch to light mode"
      : "Switch to dark mode";
    const label = themeToggleButton.querySelector(".settings-theme-label");
    if (label) label.textContent = on ? "Light mode" : "Dark mode";
    else themeToggleButton.textContent = on ? "Light mode" : "Dark mode";
    themeToggleButton.setAttribute("aria-label", themeToggleButton.title);
    themeToggleButton.setAttribute("aria-pressed", String(on));
  }

  function restoreDarkMode() {
    try {
      setDarkMode(storage.getItem("dtc-theme") === "dark");
    } catch {
      setDarkMode(false);
    }
  }

  function setSidebarCollapsed(collapsed) {
    body.classList.toggle("sidebar-collapsed", collapsed);
    sidebarExpandButton.hidden = !collapsed;
    try {
      storage.setItem("dtc-sidebar-collapsed", collapsed ? "1" : "0");
    } catch {}
  }

  function restoreSidebarCollapsed() {
    try {
      if (storage.getItem("dtc-sidebar-collapsed") === "1") {
        setSidebarCollapsed(true);
      }
    } catch {}
  }

  function isMobileShell() {
    return matchMedia("(max-width: 820px)").matches;
  }

  function syncSidebarShellState() {
    const open = body.classList.contains("sidebar-open");
    const mobileWorkBellButton = getMobileWorkBellButton();
    if (!isMobileShell()) {
      body.classList.remove("sidebar-open");
      sidebarScrim.hidden = true;
      mobileMenuButton.setAttribute("aria-expanded", "false");
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
      sidebar.removeAttribute("aria-hidden");
      sidebar.inert = false;
      pageShell.inert = false;
      if (mobileWorkBellButton) mobileWorkBellButton.inert = false;
      documentRef.removeEventListener("keydown", handleSidebarKeydown);
      return;
    }
    sidebarScrim.hidden = !open;
    mobileMenuButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      sidebar.removeAttribute("aria-hidden");
      sidebar.inert = false;
    } else {
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
      sidebar.setAttribute("aria-hidden", "true");
      sidebar.inert = true;
    }
    pageShell.inert = open;
    if (mobileWorkBellButton) mobileWorkBellButton.inert = open;
  }

  function openSidebar() {
    lastSidebarOpener =
      documentRef.activeElement instanceof HTMLElementClass
        ? documentRef.activeElement
        : mobileMenuButton;
    body.classList.add("sidebar-open");
    syncSidebarShellState();
    documentRef.addEventListener("keydown", handleSidebarKeydown);
    sidebar.querySelector(FOCUSABLE_SELECTOR)?.focus();
  }

  function closeSidebar() {
    if (!body.classList.contains("sidebar-open")) return;
    body.classList.remove("sidebar-open");
    syncSidebarShellState();
    documentRef.removeEventListener("keydown", handleSidebarKeydown);
    const focusTarget = lastSidebarOpener?.isConnected
      ? lastSidebarOpener
      : mobileMenuButton;
    if (focusTarget instanceof HTMLElementClass) focusTarget.focus();
    lastSidebarOpener = null;
  }

  function handleSidebarKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebar();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [
      ...sidebar.querySelectorAll(FOCUSABLE_SELECTOR),
    ].filter((element) => element.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = documentRef.activeElement;
    if (event.shiftKey && (active === first || !sidebar.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !sidebar.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    closeSidebar,
    isMobileShell,
    openSidebar,
    restoreDarkMode,
    restoreSidebarCollapsed,
    setDarkMode,
    setSidebarCollapsed,
    syncSidebarShellState,
    syncThemeToggleLabel,
  };
}
