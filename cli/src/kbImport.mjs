import { createHash } from "node:crypto";
import { UsageError } from "./errors.mjs";
import { templateTokens } from "../../frontend/src/template-placeholders.js";

/** Convert an authenticated Google Docs export into a standalone KB document. */
export function importGoogleDoc({ source, id, title, type = "reference", format = "text", bytes }) {
  let url;
  try { url = new URL(source); } catch { throw new UsageError("--source must be a Google Docs document URL"); }
  const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com" || url.username || url.password || !match || match[1] === "e") {
    throw new UsageError("--source must be an https://docs.google.com/document/d/<id> URL");
  }
  if (typeof id !== "string" || !/^[a-z][a-z0-9._-]+$/.test(id)) throw new UsageError("--id must be a stable lowercase document id");
  if (typeof title !== "string" || !title.trim() || /[\r\n]/.test(title)) throw new UsageError("--title must be a nonempty single line");
  if (!["template", "reference"].includes(type)) throw new UsageError("--type must be template or reference");
  if (!["text", "markdown"].includes(format)) throw new UsageError("--format must be text or markdown");
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new UsageError("Export must be UTF-8 text or Markdown"); }
  content = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!content.trim() || content.includes("\0")) throw new UsageError("Export must contain nonempty text");
  // Literal exports retain angle-bracket placeholders, mentions, and backticks.
  // A longer fence prevents exported text from closing its own code block.
  const tokens = type === "template" ? templateTokens(content) : [];
  if (format === "text" || type === "template") {
    const longest = (content.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 2);
    const fence = "`".repeat(longest + 1);
    content = `${fence}text\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}\n`;
  }
  if (type === "template") {
    content = `## Template\n\n${content}`;
    if (tokens.length) content += `\n## Placeholders\n\n| Placeholder | What to put there | Example |\n| --- | --- | --- |\n${tokens.map((token) => {
      const label = token.slice(1, -1).toLowerCase().replaceAll("_", " ");
      return `| \`${token}\` | Replace with the ${label}. | Your ${label} |`;
    }).join("\n")}\n`;
  }
  const provenance = `Google Docs https://docs.google.com/document/d/${match[1]}/edit; export SHA256 ${createHash("sha256").update(bytes).digest("hex")}`;
  return `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title.trim())}\ndoc_type: ${type}\nsource: ${JSON.stringify(provenance)}\n---\n\n# ${title.trim()}\n\n${content}${content.endsWith("\n") ? "" : "\n"}`;
}
