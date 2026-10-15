/**
 * Minimal syntax highlighting for code-view file blocks.
 *
 * Tokenizes with small per-language regex specs and builds DOM nodes directly
 * (`createTextNode` for every rune — never innerHTML), so highlighting cannot
 * inject markup and works in the fake-DOM unit tests. Unknown languages get a
 * conservative generic spec (strings, comments, numbers). This is display
 * sugar only: the code text content is always byte-identical to the source.
 */

// Keyword lists stay as readable constants (the readability lint caps lines).
const PY_KEYWORDS =
  "def class return if elif else for while break continue import from as with "
  + "try except finally raise pass lambda yield assert global nonlocal and or "
  + "not in is None True False async await";
const JS_KEYWORDS =
  "const let var function return if else for while do switch case break "
  + "continue new class extends import from export default async await try "
  + "catch finally throw typeof instanceof this null undefined true false";

const SPECS = {
  bash: [
    ["comment", /#[^\n]*/],
    ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
    ["keyword", /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|exit|set|export|source|local|shift|trap)\b/],
    ["variable", /\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[@#?*$!]/],
  ],
  powershell: [
    ["comment", /#[^\n]*/],
    ["string", /"(?:[^"\n]|`.)"|'(?:[^'\n]|''.)*'/],
    ["keyword", /\b(?:if|elseif|else|foreach|for|while|do|switch|function|return|param|begin|process|end|try|catch|finally|throw|Import-Module|Write-Output|Write-Host)\b/],
    ["variable", /\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}\n]*\}/],
  ],
  python: [
    ["comment", /#[^\n]*/],
    ["string", /"""[\s\S]*?"""|'''[\s\S]*?'''|f?"(?:[^"\\\n]|\\.)*"|f?'(?:[^'\\\n]|\\.)*'/],
    ["keyword", WORDS(PY_KEYWORDS)],
    ["literal", /\b\d+(?:\.\d+)?\b/],
  ],
  json: [
    ["keyword", /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
    ["string", /"(?:[^"\\\n]|\\.)*"/],
    ["literal", /\b(?:true|false|null)\b|\b\d+(?:\.\d+)?\b/],
  ],
  yaml: [
    ["comment", /#[^\n]*/],
    ["keyword", /^[ \t]*[-\w.$/"']+(?=\s*:)/m],
    ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'/],
    ["literal", /\b(?:true|false|null|\d+(?:\.\d+)?)\b/],
  ],
  javascript: [
    ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
    ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/],
    ["keyword", WORDS(JS_KEYWORDS)],
    ["literal", /\b\d+(?:\.\d+)?\b/],
  ],
};

/** Keyword alternation from a space-separated list (keeps specs readable). */
function WORDS(list) {
  return new RegExp(`\\b(?:${list.split(/\s+/).join("|")})\\b`);
}

// Aliases and the conservative fallback for anything else.
const ALIASES = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  terminal: "bash",
  ps1: "powershell",
  py: "python",
  js: "javascript",
  ts: "javascript",
  typescript: "javascript",
  yml: "yaml",
};

const GENERIC = [
  ["comment", /(?:#|\/\/)[^\n]*/],
  ["string", /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/],
  ["literal", /\b\d+(?:\.\d+)?\b/],
];

function specFor(language) {
  const key = ALIASES[language] || language;
  return SPECS[key] || GENERIC;
}

function combined(spec) {
  // One capturing group per alternative: which group participated names the
  // token kind. Every inner group in the specs is non-capturing.
  const source = spec.map(([, re]) => `(${re.source})`).join("|");
  return new RegExp(source, "gm");
}

/**
 * Highlight `code` for `language` and return a DocumentFragment of
 * text nodes and `span.tok-<kind>` elements. The fragment's text content is
 * exactly `code`.
 */
export function highlightCode(code, language, doc = globalThis.document) {
  const spec = specFor(language || "");
  const matcher = combined(spec);
  const fragment = doc.createDocumentFragment();
  let last = 0;
  for (const match of code.matchAll(matcher)) {
    const start = match.index;
    if (start > last) fragment.append(doc.createTextNode(code.slice(last, start)));
    const kind = kindFor(spec, match[0], match);
    const span = doc.createElement("span");
    span.className = `tok-${kind}`;
    span.textContent = match[0];
    fragment.append(span);
    last = start + match[0].length;
  }
  if (last < code.length) fragment.append(doc.createTextNode(code.slice(last)));
  return fragment;
}

function kindFor(spec, text, match) {
  // The first group that participated names the token kind.
  for (let i = 0; i < spec.length; i += 1) {
    const groupIndex = i + 1;
    if (match[groupIndex] !== undefined) return spec[i][0];
  }
  // Regexes with their own groups land here; classify by shape.
  if (/^["'`]/.test(text)) return "string";
  if (/^(#|\/\/)/.test(text)) return "comment";
  if (/^\$\{?/.test(text)) return "variable";
  return "literal";
}

/** Guess a display language from a filename when the fence has none. */
export function languageForName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const table = {
    sh: "bash",
    bash: "bash",
    ps1: "powershell",
    psm1: "powershell",
    py: "python",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "javascript",
    md: "markdown",
  };
  return table[ext] || "";
}
