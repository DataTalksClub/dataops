// Inline markdown for always-editable blocks.
//
// A block's text is markdown. While it is edited it is shown as formatted
// text in a contenteditable element: bold, italic, code and links become
// real elements, and anything the editor does not model (wiki links, images,
// escapes, inline HTML) becomes an atom that keeps its exact source. Each
// element remembers the markers it came from, so reading the DOM back gives
// the original markdown byte for byte until the user changes it.

/** Lines that make a block more than inline text (lists, headings, …). */
const BLOCK_SYNTAX = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~|\||<!--|<\/?[a-z][^>]*>\s*$)/i;

export function isInlineText(markdown) {
  return String(markdown ?? "").split("\n").every((line) => !BLOCK_SYNTAX.test(line));
}

const ESCAPABLE = "\\`*_{}[]()#+-.!<>|~";

function findClosing(text, marker, from) {
  let index = text.indexOf(marker, from);
  while (index !== -1) {
    if (text[index - 1] !== "\\") return index;
    index = text.indexOf(marker, index + 1);
  }
  return -1;
}

function isWordChar(ch) {
  return Boolean(ch) && /[\p{L}\p{N}]/u.test(ch);
}

/** Split inline markdown into tokens: text, strong, em, code, link, atom. */
export function tokenizeInline(markdown) {
  const text = String(markdown ?? "");
  const tokens = [];
  let buffer = "";
  const flush = () => {
    if (buffer) tokens.push({ type: "text", text: buffer });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
      flush();
      tokens.push({ type: "atom", raw: text.slice(i, i + 2), display: text[i + 1] });
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = rest.match(/^`+/)[0];
      const close = text.indexOf(run, i + run.length);
      if (close !== -1 && close > i + run.length) {
        flush();
        tokens.push({ type: "code", marker: run, text: text.slice(i + run.length, close) });
        i = close + run.length;
        continue;
      }
    }

    if (rest.startsWith("[[")) {
      const close = text.indexOf("]]", i + 2);
      if (close !== -1) {
        flush();
        tokens.push({ type: "atom", raw: text.slice(i, close + 2), kind: "wiki" });
        i = close + 2;
        continue;
      }
    }

    if (rest.startsWith("![")) {
      const match = rest.match(/^!\[[^\]\n]*\]\([^)\n]*\)/);
      if (match) {
        flush();
        tokens.push({ type: "atom", raw: match[0], kind: "image" });
        i += match[0].length;
        continue;
      }
    }

    if (ch === "[") {
      const match = rest.match(/^\[((?:[^\[\]\n]|\[[^\]\n]*\])+)\]\(([^()\s]+(?:\([^()\s]*\))?[^()\s]*)\)/);
      if (match) {
        flush();
        tokens.push({ type: "link", href: match[2], children: tokenizeInline(match[1]) });
        i += match[0].length;
        continue;
      }
    }

    if (ch === "<") {
      const match = rest.match(/^<(?:https?:\/\/[^>\s]+|\/?[a-z][^>\n]*)>/i);
      if (match) {
        flush();
        tokens.push({ type: "atom", raw: match[0], kind: "html" });
        i += match[0].length;
        continue;
      }
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const close = findClosing(text, marker, i + 2);
      const inner = close === -1 ? "" : text.slice(i + 2, close);
      const intraword = marker === "__" && (isWordChar(text[i - 1]) || isWordChar(text[close + 2]));
      if (close !== -1 && inner && !/^\s|\s$/.test(inner) && !intraword) {
        flush();
        tokens.push({ type: "strong", marker, children: tokenizeInline(inner) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const close = findClosing(text, ch, i + 1);
      const inner = close === -1 ? "" : text.slice(i + 1, close);
      const intraword = ch === "_" && (isWordChar(text[i - 1]) || isWordChar(text[close + 1]));
      if (close !== -1 && inner && !/^\s|\s$/.test(inner) && text[close + 1] !== ch && !intraword) {
        flush();
        tokens.push({ type: "em", marker: ch, children: tokenizeInline(inner) });
        i = close + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return tokens;
}

export function tokensToMarkdown(tokens) {
  return tokens.map((token) => {
    if (token.type === "text") return token.text;
    if (token.type === "atom") return token.raw;
    if (token.type === "code") return `${token.marker}${token.text}${token.marker}`;
    if (token.type === "link") return `[${tokensToMarkdown(token.children)}](${token.href})`;
    return `${token.marker}${tokensToMarkdown(token.children)}${token.marker}`;
  }).join("");
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(href) {
  return /^(https?:|mailto:|\/|#)/i.test(href) ? href : "#";
}

/**
 * Inline markdown as HTML for a contenteditable block. `renderAtom(raw)`
 * may return display HTML for wiki links and images; the source is kept.
 */
export function inlineMarkdownToHtml(markdown, { renderAtom, resolveLink } = {}) {
  const render = (tokens) => tokens.map((token) => {
    if (token.type === "text") return escapeHtml(token.text);
    if (token.type === "code") {
      return `<code data-md="${escapeHtml(token.marker)}">${escapeHtml(token.text)}</code>`;
    }
    if (token.type === "link") {
      const resolved = resolveLink?.(token.href) || { href: safeHref(token.href) };
      const docPath = resolved.docPath ? ` data-doc-path="${escapeHtml(resolved.docPath)}"` : "";
      return `<a href="${escapeHtml(resolved.href)}" data-href="${escapeHtml(token.href)}"${docPath}>${render(token.children)}</a>`;
    }
    if (token.type === "strong") {
      return `<strong data-md="${token.marker}">${render(token.children)}</strong>`;
    }
    if (token.type === "em") return `<em data-md="${token.marker}">${render(token.children)}</em>`;
    const display = (renderAtom && renderAtom(token.raw, token)) ?? escapeHtml(token.display ?? token.raw);
    return `<span class="md-atom" contenteditable="false" data-md="${escapeHtml(token.raw)}">${display}</span>`;
  }).join("");
  return render(tokenizeInline(markdown));
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI"]);

/**
 * Read a contenteditable block (or fragment) back into markdown. Elements
 * the browser creates while editing (b, i, a, br, div) map to markdown too.
 */
export function domToInlineMarkdown(root) {
  let out = "";
  const walk = (node, isFirst) => {
    if (node.nodeType === 3) {
      out += node.nodeValue.replace(/ /g, " ").replace(/​/g, "");
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const tag = node.nodeName;
    if (tag === "BR") {
      if (node.dataset?.sentinel === undefined && !node.hasAttribute?.("data-sentinel")) out += "\n";
      return;
    }
    if (node.classList?.contains("md-atom")) {
      out += node.getAttribute("data-md") || "";
      return;
    }
    const inner = () => {
      let first = true;
      for (const child of node.childNodes) {
        walk(child, first);
        first = false;
      }
    };
    if (tag === "STRONG" || tag === "B") {
      const marker = node.getAttribute?.("data-md") || "**";
      const start = out.length;
      inner();
      const content = out.slice(start);
      out = out.slice(0, start) + (content.trim() ? `${marker}${content}${marker}` : content);
      return;
    }
    if (tag === "EM" || tag === "I") {
      const marker = node.getAttribute?.("data-md") || "*";
      const start = out.length;
      inner();
      const content = out.slice(start);
      out = out.slice(0, start) + (content.trim() ? `${marker}${content}${marker}` : content);
      return;
    }
    if (tag === "CODE") {
      const marker = node.getAttribute?.("data-md") || "`";
      const content = (node.textContent || "").replace(/​/g, "");
      if (content) out += `${marker}${content}${marker}`;
      return;
    }
    if (tag === "A") {
      const href = node.getAttribute?.("data-href") || node.getAttribute?.("href") || "";
      const start = out.length;
      inner();
      const label = out.slice(start);
      out = out.slice(0, start) + (label ? `[${label}](${href})` : "");
      return;
    }
    if (BLOCK_TAGS.has(tag) && !isFirst && out && !out.endsWith("\n")) out += "\n";
    inner();
  };
  let first = true;
  for (const child of root.childNodes) {
    walk(child, first);
    first = false;
  }
  return out;
}

/**
 * Markdown typed at the start of a block that turns it into another type:
 * "# " heading, "- " bullet, "1. " numbered, "[] " to-do, "> " quote,
 * "```" code and "---" divider.
 */
export function detectBlockShortcut(text) {
  const value = String(text ?? "");
  const rules = [
    [/^# /, "h1"],
    [/^## /, "h2"],
    [/^### /, "h3"],
    [/^[-*+] /, "bullet"],
    [/^1[.)] /, "numbered"],
    [/^\[ ?\] /, "todo"],
    [/^\[x\] /i, "todo-done"],
    [/^> /, "quote"],
    [/^```$/, "code"],
    [/^---$/, "divider"],
  ];
  for (const [re, type] of rules) {
    const match = value.match(re);
    if (match) return { type, marker: match[0], rest: value.slice(match[0].length) };
  }
  return null;
}

/**
 * Inline markdown just closed before the caret: **bold**, *italic*,
 * _italic_ and `code`. Returns where the marked text starts and its parts.
 */
export function detectInlineShortcut(textBeforeCaret) {
  const text = String(textBeforeCaret ?? "");
  const rules = [
    [/(^|[^*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "strong", "**"],
    [/(^|[^_\\\p{L}\p{N}])__([^_\s](?:[^_]*[^_\s])?)__$/u, "strong", "__"],
    [/(^|[^*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "em", "*"],
    [/(^|[^_\\\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u, "em", "_"],
    [/(^|[^`\\])`([^`]+)`$/, "code", "`"],
  ];
  for (const [re, kind, marker] of rules) {
    const match = text.match(re);
    if (match) {
      const start = match.index + match[1].length;
      return { kind, marker, start, inner: match[2] };
    }
  }
  return null;
}

/** A pasted value that is a single URL. */
export function asSingleUrl(text) {
  const value = String(text ?? "").trim();
  return /^https?:\/\/\S+$/i.test(value) ? value : null;
}
