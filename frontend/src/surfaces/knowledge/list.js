export function createKnowledgeList(context, services) {
  const {
    basename,
    clearSelectionButton,
    documentList,
    documentRowTemplate,
    knowledgeState,
    libraryTitle,
    searchInput,
  } = context;
  const { openDocument, setHighlightedText } = services;

  const LIST_LIMIT = 120;

  function renderDocuments(documents, folder) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setLibraryHeadingVisibility(true);
    libraryTitle.textContent = folder;
    clearSelectionButton.hidden = false;

    if (documents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No documents in this folder yet.";
      documentList.replaceChildren(empty);
      return;
    }

    const rows = documents.slice(0, LIST_LIMIT).map(renderDocumentRow);
    if (documents.length > LIST_LIMIT) {
      const more = document.createElement("div");
      more.className = "list-more";
      more.textContent = `Showing ${LIST_LIMIT} of ${documents.length}. Refine your search to see more.`;
      rows.push(more);
    }
    documentList.replaceChildren(...rows);
  }

  function setLibraryHeadingVisibility(visible) {
    const heading = libraryTitle.parentElement?.parentElement;
    if (!heading) return;
    heading.hidden = !visible;
    heading.classList.toggle("is-visible", visible);
  }

  function renderDocumentRow(doc) {
    const row = documentRowTemplate.content.firstElementChild.cloneNode(true);
    const query = searchInput.value.trim();
    setHighlightedText(
      row.querySelector("h3"),
      doc.title || basename(doc.path),
      query,
    );
    setHighlightedText(
      row.querySelector("p"),
      doc.description || doc.summary || "No summary yet.",
      query,
    );
    row.querySelector(".doc-path").textContent = doc.path;
    row.querySelector(".doc-domain").textContent = doc.domain || "docs";
    row.querySelector(".doc-type").textContent = doc.doc_type || "doc";

    row.addEventListener("click", () => openDocument(doc.path));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDocument(doc.path);
      }
    });

    return row;
  }

  return { renderDocuments };
}
