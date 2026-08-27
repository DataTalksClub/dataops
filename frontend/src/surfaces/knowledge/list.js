export function createKnowledgeList(context, services) {
  const {
    basename,
    documentList,
    documentRowTemplate,
    knowledgeState,
    searchInput,
  } = context;
  const { clearSelection, openDocument, setHighlightedText } = services;

  const LIST_LIMIT = 120;

  function renderDocuments(documents, folder) {
    documentList.classList.remove("is-operations-home");
    documentList.classList.remove("is-unified-search");
    const content = [renderFolderHeader(folder)];

    if (documents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No documents in this folder yet.";
      documentList.replaceChildren(...content, empty);
      return;
    }

    const rows = documents.slice(0, LIST_LIMIT).map(renderDocumentRow);
    if (documents.length > LIST_LIMIT) {
      const more = document.createElement("div");
      more.className = "list-more";
      more.textContent = `Showing ${LIST_LIMIT} of ${documents.length}. Refine your search to see more.`;
      rows.push(more);
    }
    documentList.replaceChildren(...content, ...rows);
  }

  function renderFolderHeader(folder) {
    const header = document.createElement("header");
    header.className = "section-header document-list-header";
    header.setAttribute("aria-label", "Document folder");

    const headingGroup = document.createElement("div");
    const scope = document.createElement("p");
    scope.className = "section-kicker";
    scope.textContent = "Folder";
    const heading = document.createElement("h3");
    heading.textContent = folder;
    headingGroup.append(scope, heading);

    const allDocs = document.createElement("button");
    allDocs.type = "button";
    allDocs.className = "quiet-button";
    allDocs.textContent = "All docs";
    allDocs.setAttribute("aria-label", "Show all docs");
    allDocs.addEventListener("click", () => clearSelection());

    header.append(headingGroup, allDocs);
    return header;
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
