export function createKnowledgeReferences(context, services) {
  const {
    basename,
    documentState,
    renderedView,
    request,
  } = context;
  const { apiUrl, openDocument, resolveDocReference } = services;

  function visibleDocUrl(path) {
    return "/" + String(path || "").replace(/^content\//, "");
  }

  function resolveMarkdownDocLink(href) {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return null;
    if (href.startsWith("doc:")) return resolveDocReference(href.slice(4));
    const clean = href.split("#")[0].split("?")[0];
    if (!clean.endsWith(".md")) return null;
    if (clean.startsWith("/"))
      return resolveDocReference(clean.replace(/^\/+/, ""));
    if (documentState.currentDoc) {
      const docDir = documentState.currentDoc.path.split("/").slice(0, -1).join("/");
      const stack = docDir.split("/").filter(Boolean);
      for (const part of clean.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      return resolveDocReference(stack.join("/"));
    }
    return resolveDocReference(clean);
  }

  function renderGithubRawFooter(githubBaseValue, branch) {
    if (!documentState.currentDoc || !githubBaseValue) return null;
    const githubBase = githubBaseValue.replace(/\/$/, "");
    const link = document.createElement("a");
    link.className = "doc-source-footer";
    const encodedBranch = encodeURIComponent(branch).replaceAll("%2F", "/");
    link.href = `${githubBase}/blob/${encodedBranch}/${documentState.currentDoc.path}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "See on GitHub";
    return link;
  }

  async function fetchBacklinksForCurrentDoc() {
    if (!documentState.currentDoc) return;
    const host = renderedView.querySelector("#backlinks-host");
    if (!host) return;
    try {
      const url = apiUrl("/docs/backlinks");
      url.searchParams.set("path", documentState.currentDoc.path);
      const payload = await request(url);
      const links = payload.backlinks || [];
      if (links.length === 0) {
        host.hidden = true;
        return;
      }
      const head = document.createElement("h3");
      head.textContent = `Referenced by (${links.length})`;
      const list = document.createElement("ul");
      for (const link of links) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "block-backlinks-row";
        button.textContent = link.title || basename(link.path);
        button.title = link.path;
        button.addEventListener("click", () => openDocument(link.path));
        item.append(button);
        list.append(item);
      }
      host.replaceChildren(head, list);
    } catch {
      host.hidden = true;
    }
  }

  function renderRelatedDocsBlock(frontmatter) {
    const items = Array.isArray(frontmatter.related_docs)
      ? frontmatter.related_docs.filter(Boolean)
      : [];
    if (items.length === 0) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-related";
    const head = document.createElement("h3");
    head.textContent = `Related docs (${items.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const related of items) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "block-related-row";
      button.textContent = related;
      button.title = "Open related doc";
      button.addEventListener("click", () => openDocument(resolveRelatedPath(related)));
      item.append(button);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function resolveRelatedPath(value) {
    if (value.startsWith("content/") || value.startsWith("docs/")) return value;
    if (!documentState.currentDoc) return value;
    const directory = documentState.currentDoc.path
      .split("/")
      .slice(0, -1)
      .join("/");
    const stack = directory.split("/").filter(Boolean);
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return stack.join("/");
  }

  function renderWarningsBlock() {
    if (!documentState.currentWarnings.length) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-warnings";
    const head = document.createElement("h3");
    head.textContent = `Lint warnings (${documentState.currentWarnings.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const warning of documentState.currentWarnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function renderLoomBlock(frontmatter) {
    const looms = Array.isArray(frontmatter.loom)
      ? frontmatter.loom.filter(Boolean)
      : [];
    if (looms.length === 0) return null;
    const wrap = document.createElement("aside");
    wrap.className = "block-loom";
    const head = document.createElement("h3");
    head.textContent = `Loom recordings (${looms.length})`;
    wrap.append(head);
    const list = document.createElement("ul");
    for (const url of looms) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = shortLoomLabel(url);
      item.append(link);
      const embedUrl = toLoomEmbedUrl(url);
      if (embedUrl) appendLoomEmbed(item, embedUrl);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function appendLoomEmbed(item, embedUrl) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block-loom-play";
    button.textContent = "▶︎ Play inline";
    const slot = document.createElement("div");
    slot.className = "block-loom-embed";
    slot.hidden = true;
    button.addEventListener("click", () => {
      if (slot.hidden) {
        if (!slot.firstChild) {
          const frame = document.createElement("iframe");
          frame.src = embedUrl;
          frame.allowFullscreen = true;
          frame.allow = "fullscreen";
          slot.append(frame);
        }
        slot.hidden = false;
        button.textContent = "Hide";
      } else {
        slot.hidden = true;
        button.textContent = "▶︎ Play inline";
      }
    });
    item.append(" ", button, slot);
  }

  function toLoomEmbedUrl(value) {
    try {
      const url = new URL(value);
      if (!url.hostname.endsWith("loom.com")) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "share" || !parts[1]) return null;
      return `https://www.loom.com/embed/${parts[1]}`;
    } catch {
      return null;
    }
  }

  function shortLoomLabel(value) {
    try {
      const url = new URL(value);
      const id = url.pathname.split("/").filter(Boolean).pop() || "";
      if (id.length > 8) {
        return `${url.hostname.replace("www.", "")} · ${id.slice(0, 8)}…`;
      }
      return url.hostname + url.pathname;
    } catch {
      return value;
    }
  }


  return {
    fetchBacklinksForCurrentDoc,
    renderGithubRawFooter,
    renderLoomBlock,
    renderRelatedDocsBlock,
    renderWarningsBlock,
    resolveMarkdownDocLink,
    visibleDocUrl,
  };
}
