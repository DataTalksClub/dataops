export function createKnowledgeMenus(context) {
  const {
    apiUrl,
    diffBody,
    diffClose,
    diffModal,
    diffTitle,
    deleteCurrentDoc,
    docMenuButton,
    documentState,
    emptyNote,
    renameCurrentDoc,
    request,
    viewportWidth,
  } = context;

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
      showDocHistory(documentState.currentDoc.path);
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

  async function showDocHistory(path) {
    diffTitle.textContent = `History · ${path}`;
    diffBody.replaceChildren();
    diffBody.append(emptyNote("Loading…"));
    diffModal.hidden = false;
    diffClose?.focus?.();

    try {
      const url = apiUrl("/git/log");
      url.searchParams.set("path", path);
      const payload = await request(url);
      const commits = payload.commits || [];
      if (commits.length === 0) {
        diffBody.replaceChildren(emptyNote("No commits found."));
        return;
      }

      const rows = commits.map((commit) => {
        const row = document.createElement("div");
        row.className = "diff-line diff-ctx";
        row.textContent = `${commit.sha}  ${commit.date}  ${commit.author}  ${commit.subject}`;
        return row;
      });
      diffBody.replaceChildren(...rows);
    } catch (error) {
      diffBody.replaceChildren(emptyNote(`History failed: ${error.message}`));
    }
  }

  return { openDocMenu };
}
