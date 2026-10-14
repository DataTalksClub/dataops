// Read and patch the YAML frontmatter of a process doc in place.
//
// Only the keys the editor owns are touched, and each edit replaces exactly
// that key's lines, so every other field, comment and formatting choice in
// the frontmatter survives. Values are read from the markdown itself: the
// server's minimal parser does not see folded scalars or unindented lists.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function frontmatterRange(markdown) {
  const text = String(markdown ?? "");
  if (!text.startsWith("---\n")) return null;
  if (text.startsWith("---\n---\n")) return { start: 4, end: 3 };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  return { start: 4, end };
}

export function ensureFrontmatter(markdown) {
  return frontmatterRange(markdown) ? markdown : `---\n---\n${markdown}`;
}

function body(markdown) {
  const range = frontmatterRange(markdown);
  return range ? markdown.slice(range.start, Math.max(range.start, range.end)) : "";
}

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

// A key's lines: the key line plus indented continuation lines (a folded
// scalar), or `- item` lines (a block list, indented or not).
function keyPattern(key) {
  return new RegExp(`^${escapeRegex(key)}:[^\\n]*(?:\\n(?:[\\t ]+[^\\n]*|-[^\\n]*))*`, "m");
}

/** A scalar value, joining folded continuation lines with spaces. */
export function readFrontmatterScalar(markdown, key) {
  const match = body(markdown).match(keyPattern(key));
  if (!match) return "";
  const [first, ...rest] = match[0].split("\n");
  const head = first.slice(first.indexOf(":") + 1).trim();
  if (/^[>|]/.test(head)) {
    return rest.map((line) => line.trim()).filter(Boolean).join(" ");
  }
  const folded = [head, ...rest.map((line) => line.trim())].filter(Boolean).join(" ");
  return unquote(folded);
}

/** A list value from `key: [a, b]` or `key:` followed by `- item` lines. */
export function readFrontmatterList(markdown, key) {
  const match = body(markdown).match(keyPattern(key));
  if (!match) return [];
  const [first, ...rest] = match[0].split("\n");
  const head = first.slice(first.indexOf(":") + 1).trim();
  if (head.startsWith("[")) {
    const inner = head.replace(/^\[/, "").replace(/\]$/, "").trim();
    return inner ? inner.split(",").map(unquote).filter(Boolean) : [];
  }
  if (head) return [unquote(head)];
  return rest
    .map((line) => line.match(/^[\t ]*-[\t ]*(.*)$/))
    .filter(Boolean)
    .map((m) => unquote(m[1]))
    .filter(Boolean);
}

function insertAtEnd(markdown, range, formatted) {
  const before = markdown.slice(0, range.start);
  const text = markdown.slice(range.start, Math.max(range.start, range.end));
  const after = markdown.slice(range.end);
  const trimmed = !text || text.endsWith("\n") ? text : `${text}\n`;
  return `${before}${trimmed}${formatted}\n${after.replace(/^\n?/, "")}`;
}

function replaceKey(markdown, key, formatted) {
  const range = frontmatterRange(markdown);
  if (!range) return markdown;
  const re = keyPattern(key);
  const text = markdown.slice(range.start, Math.max(range.start, range.end));
  if (!re.test(text)) return insertAtEnd(markdown, range, formatted);
  return markdown.slice(0, range.start) +
    text.replace(re, () => formatted) +
    markdown.slice(Math.max(range.start, range.end));
}

export function patchFrontmatterScalar(markdown, key, value, { quoted = false } = {}) {
  const text = String(value ?? "");
  const formatted = quoted
    ? `${key}: ${JSON.stringify(text)}`
    : `${key}: ${text}`;
  return replaceKey(markdown, key, formatted);
}

const NEEDS_QUOTES = /^[\s"'&*!|>%@`#?:,[\]{}-]|[:#]\s|\s$/;

export function patchFrontmatterList(markdown, key, items) {
  const range = frontmatterRange(markdown);
  if (!range) return markdown;
  const text = markdown.slice(range.start, Math.max(range.start, range.end));
  const existing = text.match(keyPattern(key))?.[0] || "";
  // Keep the file's own list style: its item prefix and whether it quotes.
  const firstItem = existing.match(/\n([\t ]*-[\t ]+)("?)/);
  const prefix = firstItem ? firstItem[1] : "  - ";
  const quoteAll = Boolean(firstItem && firstItem[2]);
  const scalar = (v) => {
    const s = String(v);
    return quoteAll || NEEDS_QUOTES.test(s) ? JSON.stringify(s) : s;
  };
  const formatted = items && items.length
    ? `${key}:\n${items.map((v) => `${prefix}${scalar(v)}`).join("\n")}`
    : `${key}: []`;
  return replaceKey(markdown, key, formatted);
}
