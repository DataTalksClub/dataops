// The kit owns shell persistence and interaction. Routes only close navigation.
export function createPreferencesShell({
  documentRef,
  matchMedia,
  shell = globalThis.dakitShell,
}) {
  const root = documentRef.querySelector(".dk-shell");
  return {
    closeSidebar: () => shell.toggleDrawer(root, false),
    isMobileShell: () => matchMedia("(max-width: 820px)").matches,
  };
}
