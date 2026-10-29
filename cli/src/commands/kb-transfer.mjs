import { UsageError } from "../errors.mjs";
import { optionalString, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { exportDocument } from "./documents-transfer.mjs";

export async function exportKnowledgeDocument(args, io) {
  const ref = positional(args, 0, "dataops kb export <doc-id> [--format md|docx|txt] [--output PATH]");
  return exportDocument(args, io, `/docs/export?ref=${encodeURIComponent(ref)}`, ref);
}

export async function copyKnowledgeDocument(args, io) {
  const path = positional(args, 0, "dataops kb create <path> --from <doc-id> [--title T]");
  const from = optionalString(args, "from");
  if (!from) throw new UsageError("--from <doc-id> is required. Use kb write --create for new content.");
  const api = apiFor(args);
  const { revision } = await api.get("/knowledge/publication");
  const result = await api.post("/docs", { path, from, title: optionalString(args, "title"), sop: optionalString(args, "sop"), absent: true, expectedRevision: revision });
  if (!args.json) io.print(`Created ${result.path} (revision ${result.revision}).`);
  return result;
}
