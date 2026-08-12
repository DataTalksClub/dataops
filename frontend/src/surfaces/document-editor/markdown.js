export function createEditorMarkdown(context, services) {
  const {
    documentState, escapeHtml, openDocument, resolveDocReference,
    resolveMarkdownDocLink, visibleDocUrl,
  } = context;
  const { escapeHtmlAttr } = services;

  function resolveImageSrc(src) {
    if (!src) return "";
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith("/")) return src;
    if (!documentState.currentDoc) return src;
    // Resolve relative path against the current doc's directory; both live
    // under content/, which the frontend container serves at /content/.
    const docDir = documentState.currentDoc.path.split("/").slice(0, -1).join("/");
    const stack = docDir.split("/").filter(Boolean);
    for (const part of src.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return "/" + stack.join("/");
  }

  function stripFrontmatter(md) {
    if (!md.startsWith("---\n")) return md;
    const end = md.indexOf("\n---\n", 4);
    if (end === -1) return md;
    return md.slice(end + 5).replace(/^\n+/, "");
  }

  function stripLeadingHeading(md) {
    // Sections include their visible ## Heading line first; drop it because
    // the block header already shows the name.
    return md.replace(/^##\s+[^\n]*\n+/, "");
  }

  // ---------- Minimal markdown renderer for block bodies ----------

  function renderMarkdown(markdown) {
    const wrap = document.createElement("div");
    wrap.className = "md";
    const html = markdownToHtml(markdown || "");
    wrap.innerHTML = html;
    wrap.querySelectorAll("[data-doc-path]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const path = link.getAttribute("data-doc-path");
        if (path) openDocument(path);
      });
    });
    return wrap;
  }

  function markdownToHtml(md) {
    if (!md) return "";
    const escaped = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const lines = escaped.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      // Blockquote
      if (/^&gt;\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^&gt;\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
        continue;
      }
      // Fenced code
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // close fence
        out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
        continue;
      }
      // Numbered list
      if (/^\s*\d+\.\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*\d+\.\s/, ""));
          i++;
        }
        out.push(
          `<ol>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ol>`,
        );
        continue;
      }
      // Bulleted list
      if (/^\s*[-*]\s/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*[-*]\s/, ""));
          i++;
        }
        out.push(
          `<ul>${buf.map((b) => `<li>${inlineMd(b)}</li>`).join("")}</ul>`,
        );
        continue;
      }
      // Heading
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        const level = Math.min(6, h[1].length);
        out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
        i++;
        continue;
      }
      // Table: pipe-delimited rows with a separator row underneath.
      if (
        line.trim().startsWith("|") &&
        i + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const headerCells = splitTableRow(line);
        i += 2; // skip header + separator
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
        out.push(`<table>${thead}${tbody}</table>`);
        continue;
      }
      // Paragraph (collect until blank line)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^[#>`\-*]/.test(lines[i].trim()[0]) &&
        !/^\s*\d+\.\s/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
    }
    return out.join("\n");
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  }

  function inlineMd(text) {
    let s = text;
    // Internal wiki links: [[doc-id]] or [[doc-id|Custom label]].
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawRef, rawLabel) => {
      const ref = String(rawRef || "").trim();
      const doc = resolveDocReference(ref);
      if (!doc) {
        const label = rawLabel || ref;
        return `<span class="broken-doc-link" title="Missing doc: ${escapeHtmlAttr(ref)}">${escapeHtml(label)}</span>`;
      }
      const label = rawLabel || doc.title || ref;
      return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
    });
    // Inline image
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const resolved = resolveImageSrc(src);
      return `<img src="${resolved}" alt="${alt}" loading="lazy">`;
    });
    // Link
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const doc = resolveMarkdownDocLink(href);
      if (doc) {
        return `<a href="${visibleDocUrl(doc.path)}" data-doc-path="${escapeHtmlAttr(doc.path)}" title="${escapeHtmlAttr(doc.path)}">${escapeHtml(label)}</a>`;
      }
      const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
      const target = /^(https?:|mailto:)/i.test(href)
        ? ' target="_blank" rel="noopener"'
        : "";
      return `<a href="${safe}"${target}>${label}</a>`;
    });
    // Bold then italic
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // Inline code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }

  return {
    renderMarkdown, resolveImageSrc, stripFrontmatter, stripLeadingHeading,
  };
}
