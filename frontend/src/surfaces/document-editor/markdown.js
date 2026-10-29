import { escapeHtml, unescapeHtml } from "../../core/html.js";

export function createEditorMarkdown(context) {
  const {
    documentState, openDocument, resolveDocReference,
    resolveMarkdownDocLink, visibleDocUrl,
  } = context;

  function resolveImageSrc(src) {
    if (!src) return "";
    if (/^https?:\/\//i.test(src)) return src;
    if (src.startsWith("/")) return src;
    // Image uploads also return a repository-absolute content/ path.
    if (src.startsWith("content/")) return `/${src}`;
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

  function resolveLocalAssetHref(href) {
    if (!href || /^(https?:|mailto:|#|\/)/i.test(href)) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "";
    if (!documentState.currentDoc) return "";
    const docDir = documentState.currentDoc.path.split("/").slice(0, -1);
    const stack = [...docDir];
    for (const part of href.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    const resolved = stack.join("/");
    if (resolved.startsWith("content/")) return `/${resolved}`;
    if (resolved.startsWith("_docs/operating-model/")) {
      return `/knowledge-files/${resolved}`;
    }
    return "";
  }

  function stripFrontmatter(md) {
    if (!md.startsWith("---\n")) return md;
    const end = md.indexOf("\n---\n", 4);
    if (end === -1) return md;
    return md.slice(end + 5).replace(/^\n+/, "");
  }

  function stripLeadingHeading(md) {
    // Drop a duplicated body title. The reader already shows the document or
    // section name in its own heading, so a leading # or ## must not render
    // again. Display-only: the SOP parser still sees the original markdown.
    return md.replace(/^#{1,2}\s+[^\n]*\n+/, "");
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
    const escaped = escapeHtml(md);
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

  function docLinkMarkup(doc, labelHtml) {
    const path = escapeHtml(doc.path);
    return `<a href="${escapeHtml(visibleDocUrl(doc.path))}" data-doc-path="${path}" title="${path}">${labelHtml}</a>`;
  }

  // `text` is already escaped HTML: link targets are unescaped before they
  // are resolved, and every value is escaped exactly once on the way out.
  function inlineMd(text) {
    let s = text;
    // Internal wiki links: [[doc-id]] or [[doc-id|Custom label]].
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawRef, rawLabel) => {
      const ref = unescapeHtml(rawRef).trim();
      const doc = resolveDocReference(ref);
      if (!doc) {
        return `<span class="broken-doc-link" title="Missing doc: ${escapeHtml(ref)}">${rawLabel || escapeHtml(ref)}</span>`;
      }
      return docLinkMarkup(doc, rawLabel || escapeHtml(doc.title || ref));
    });
    // Inline image
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const resolved = resolveImageSrc(unescapeHtml(src));
      return `<img src="${escapeHtml(resolved)}" alt="${alt}" loading="lazy">`;
    });
    // Link
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, rawHref) => {
      const href = unescapeHtml(rawHref);
      const doc = resolveMarkdownDocLink(href);
      if (doc) return docLinkMarkup(doc, label);
      const safe = resolveLocalAssetHref(href) || "#";
      const target = /^(https?:|mailto:)/i.test(href)
        ? ' target="_blank" rel="noopener"'
        : "";
      return `<a href="${escapeHtml(safe)}"${target}>${label}</a>`;
    });
    // Bold then italic
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // Inline code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }

  // Display HTML for an inline construct kept verbatim in an editable block
  // (a wiki link, an image, an escape): the same rendering the reader uses.
  function renderInlineAtom(raw) {
    const escaped = escapeHtml(raw);
    if (/^\\./.test(raw)) return escaped.slice(1);
    return inlineMd(escaped);
  }

  /** Where a markdown link points, resolved the way the reader does. */
  function resolveInlineLink(href) {
    const doc = resolveMarkdownDocLink(href);
    if (doc) return { href: visibleDocUrl(doc.path), docPath: doc.path };
    return { href: resolveLocalAssetHref(href) || "#" };
  }

  return {
    renderInlineAtom, resolveInlineLink, renderMarkdown, resolveImageSrc, resolveLocalAssetHref, stripFrontmatter, stripLeadingHeading,
  };
}
