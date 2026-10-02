export function createKnowledgeMenus(context) {
  const { deleteCurrentDoc, docMenuButton, documentState, openHistory, renameCurrentDoc, viewportWidth } = context;

  function openDocMenu() {
    if (!documentState.currentDoc) return;

    const existing = document.querySelector(".doc-menu-popover");
    if (existing) {
      existing.remove();
      return;
    }

    const popover = document.createElement("div");
    popover.className = "doc-menu-popover";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "doc-menu-item";
    renameBtn.textContent = "Rename…";
    renameBtn.addEventListener("click", () => {
      popover.remove();
      renameCurrentDoc();
    });
    popover.append(renameBtn);

    const historyBtn = document.createElement("button");
    historyBtn.type = "button";
    historyBtn.className = "doc-menu-item";
    historyBtn.textContent = "History";
    historyBtn.addEventListener("click", () => {
      popover.remove();
      openHistory();
    });
    popover.append(historyBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "doc-menu-item is-danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      popover.remove();
      deleteCurrentDoc();
    });
    popover.append(delBtn);

    const rect = docMenuButton.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.right = `${viewportWidth() - rect.right}px`;
    document.body.append(popover);

    const closeOnOutside = (event) => {
      if (!popover.contains(event.target) && event.target !== docMenuButton) {
        popover.remove();
        document.removeEventListener("click", closeOnOutside, true);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", closeOnOutside, true);
    }, 0);
  }

  return { openDocMenu };
}
