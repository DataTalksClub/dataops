import { writeFileSync } from "node:fs";
import { UsageError } from "../errors.mjs";
import { enc, optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";

/** Download bytes through the authenticated client, preserving binary exports. */
export async function exportDocument(args, io, route, id, formats = ["md", "docx", "txt"]) {
  const format = optionalString(args, "format") || "md";
  if (!formats.includes(format)) throw new UsageError(`--format must be ${formats.slice(0, -1).join(", ")}, or ${formats.at(-1)}.`);
  const output = optionalString(args, "output");
  if (["docx", "pdf"].includes(format) && !output) throw new UsageError("--output PATH is required for binary export.");
  const bytes = await apiFor(args).get(route, { query: { format }, responseType: "bytes" });
  if (output) {
    writeFileSync(output, bytes);
    const result = { id, format, path: output, bytes: bytes.length };
    if (!args.json) io.print(`Saved ${output} (${bytes.length} bytes).`);
    return result;
  }
  const content = bytes.toString("utf8");
  if (!args.json) io.print(content);
  return { id, format, content };
}

export async function exportTaskDocument(args, io) {
  const id = positional(args, 0, "dataops doc export <doc-id> [--format md|docx|txt|pdf] [--output PATH]");
  return exportDocument(args, io, `/api/documents/${enc(id)}/export`, id, ["md", "txt", "docx", "pdf"]);
}
