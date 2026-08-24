import { bindAppDomEvents } from "../shell/dom-bindings.js";

export function bindApplicationEvents(context) {
  const {
    callbacks,
    documentRef,
    dom,
    navigationShell,
    notificationsShell,
    surfaceBridge,
    windowRef,
    workspaceState,
  } = context;
  const {
    changesSection,
    changesToggle,
    diffModal,
    editor,
    editorSaveButton,
    filtersSection,
    filterRow,
    helpClose,
    helpModal,
    lightbox,
    quickNavInput,
    searchInput,
    tasksNavButton,
  } = dom;

  const isTyping = () => {
    const active = documentRef.activeElement;
    return Boolean(
      active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable),
    );
  };

  bindAppDomEvents({
    documentRef,
    dom,
    handlers: {
      ...callbacks,
      hideLintModal: () => {
        dom.lintModal.hidden = true;
      },
      hideHelpModal: () => {
        helpModal.hidden = true;
      },
      showHelpModal: () => {
        helpModal.hidden = false;
        helpClose.focus();
      },
      scheduleCurrentBrowserLocation:
        navigationShell.scheduleCurrentBrowserLocation,
      toggleDarkMode: () =>
        callbacks.setDarkMode(!dom.body.classList.contains("dark")),
      toggleChanges: () => {
        const collapsed = changesSection.classList.toggle("is-collapsed");
        changesToggle.setAttribute("aria-expanded", String(!collapsed));
      },
      workspaceButton: (button) =>
        documentRef.dispatchEvent(
          new CustomEvent("dataops:navigate-workspace", {
            detail: {
              view:
                button.dataset.workspaceTarget ||
                button.dataset.workspaceView ||
                "home",
            },
          }),
        ),
      toggleTasksNav: () => {
        const expanded =
          tasksNavButton.getAttribute("aria-expanded") === "true";
        callbacks.setTasksNavExpanded(!expanded);
      },
      openTasksSection: (section) => {
        callbacks.navigateCanonicalWorkspace(
          callbacks.workspaceHashPath("tasks", section),
        );
      },
      navigateWorkspaceEvent: (event) =>
        callbacks.showWorkspaceSurface(event.detail?.view || "home"),
      documentTitleKeydown: (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          editor.focus();
        }
      },
      editorInput: () => {
        if (!workspaceState.documentState.currentDoc) return;
        callbacks.storeDraft();
        callbacks.updateSaveState();
      },
      searchSubmit: (event) => {
        event.preventDefault();
        callbacks.refreshDocuments();
        callbacks.closeSidebar();
      },
      searchInput: callbacks.debounce(callbacks.refreshDocuments, 250),
      toggleFilters: () => callbacks.setFiltersExpanded(filterRow.hidden),
      filtersToggle: () =>
        callbacks.setFiltersExpanded(filtersSection.open),
      createDocument: async (event) => {
        event.preventDefault();
        await callbacks.createDocument();
      },
      globalKeydown: (event) => {
        if (event.key === "Escape") callbacks.closeCustomSelects();
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          if (event.shiftKey) callbacks.saveAllDrafts();
          else if (
            workspaceState.documentState.currentDoc &&
            !editorSaveButton.disabled
          ) {
            callbacks.saveCurrentDocument();
          }
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "k"
        ) {
          event.preventDefault();
          callbacks.showLibrary();
          searchInput.focus();
          searchInput.select();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "p"
        ) {
          event.preventDefault();
          callbacks.openQuickNav();
        }
        if (
          event.key === "/" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !isTyping()
        ) {
          event.preventDefault();
          callbacks.showLibrary();
          searchInput.focus();
          searchInput.select();
        }
        const question =
          event.key === "?" || (event.key === "/" && event.shiftKey);
        if (
          question &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !isTyping()
        ) {
          event.preventDefault();
          helpModal.hidden = false;
        }
        if (event.key === "Escape" && !helpModal.hidden) {
          event.preventDefault();
          helpModal.hidden = true;
        }
        if (event.key === "Escape" && notificationsShell.isOpen()) {
          event.preventDefault();
          callbacks.closeWorkBellPanel();
        }
        if (event.key === "Escape" && callbacks.isSettingsMenuOpen()) {
          event.preventDefault();
          callbacks.closeSettingsMenu();
        }
        if (event.key === "Escape" && !diffModal.hidden) {
          event.stopPropagation();
          callbacks.closeDiff();
        }
        if (event.key === "Escape" && !lightbox.hidden) {
          event.stopPropagation();
          callbacks.closeLightbox();
        }
      },
      lightboxClick: (event) => {
        if (!event.target.closest("img")) callbacks.closeLightbox();
      },
      quickNavInput: () =>
        callbacks.updateQuickNavMatches(quickNavInput.value),
      quickNavKeydown: (event) =>
        surfaceBridge.getKnowledgeSurface().handleQuickNavKeydown(event),
    },
    windowRef,
  });
}
