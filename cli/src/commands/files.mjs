import { writeFileSync } from "node:fs";

import { UsageError } from "../errors.mjs";
import { enc, fields, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { uploadFile } from "./tasks.mjs";

export const filesSummary = "Task files: list, upload, download, delete";
export const artifactsSummary = "Artifacts attached to Tasks and Cards";

export const filesHelp = `dataops files - files uploaded to Tasks (e.g. file proof)

Usage
  dataops files list [--task ID] [--card ID]
  dataops files show <file-id>
  dataops files upload <task-id> <path> [--category document|image|invoice]
  dataops files download <file-id> [--output PATH]
  dataops files delete <file-id>

Uploads need durable file storage on the server; a deployment without it answers 409.
`;

export const artifactsHelp = `dataops artifacts - artifacts (drafts, outputs) linked to Tasks and Cards

Usage
  dataops artifacts list [--task ID] [--card ID] [--status S] [--type T]
  dataops artifacts show <artifact-id>
  dataops artifacts create --data '{...}'
  dataops artifacts update <artifact-id> --data '{...}'
  dataops artifacts attach <artifact-id> --data '{"taskId":"..."}'
  dataops artifacts archive <artifact-id>

--data takes a JSON object, @file.json, or - for stdin; the API validates it.
An approved artifact satisfies a Task's "artifact" proof requirement.
`;

export async function filesList(args, io) {
  const api = apiFor(args);
  const items = [];
  let cursor;
  do {
    const page = await api.get("/api/files", { query: { taskId: optionalString(args, "task"), cardId: optionalString(args, "card"), cursor } });
    items.push(...(page?.files?.items || (Array.isArray(page?.files) ? page.files : [])));
    cursor = page?.files?.nextCursor;
  } while (cursor);
  const result = { files: items };
  if (args.json) return result;
  table(io, items, [
    ["ID", (file) => file.id],
    ["TASK", (file) => file.taskId || ""],
    ["CATEGORY", (file) => file.category || ""],
    ["NAME", (file) => file.filename],
  ], "No files.");
  return result;
}

export async function filesShow(args, io) {
  const id = positional(args, 0, "dataops files show <file-id>");
  const result = await apiFor(args).get(`/api/files/${enc(id)}`);
  if (!args.json) fields(io, Object.entries(result.file || result).filter(([, value]) => typeof value !== "object"));
  return result;
}

export async function filesUpload(args, io) {
  const usage = "dataops files upload <task-id> <path> [--category C]";
  const taskId = positional(args, 0, usage);
  const path = positional(args, 1, usage);
  const result = await uploadFile(apiFor(args), taskId, path, optionalString(args, "category"));
  if (!args.json) io.print(`Uploaded ${path} to Task ${taskId}.`);
  return result;
}

export async function filesDownload(args, io) {
  const id = positional(args, 0, "dataops files download <file-id> [--output PATH]");
  const api = apiFor(args);
  const meta = await api.get(`/api/files/${enc(id)}`);
  const file = meta.file || meta;
  const output = optionalString(args, "output") || file.filename;
  if (!output) throw new UsageError("--output is required: the file has no stored name.");
  const { bytes } = await api.get(`/api/files/${enc(id)}/download`, { binary: true });
  writeFileSync(output, bytes);
  const result = { id, path: output, bytes: bytes.length };
  if (!args.json) io.print(`Saved ${output} (${bytes.length} bytes).`);
  return result;
}

export async function filesDelete(args, io) {
  const id = positional(args, 0, "dataops files delete <file-id>");
  await apiFor(args).delete(`/api/files/${enc(id)}`);
  if (!args.json) io.print(`Deleted file ${id}.`);
  return { status: "deleted", id };
}

export async function artifactsList(args, io) {
  const result = await apiFor(args).get("/api/artifacts", {
    query: {
      taskId: optionalString(args, "task"),
      cardId: optionalString(args, "card"),
      status: optionalString(args, "status"),
      type: optionalString(args, "type"),
    },
  });
  if (args.json) return result;
  const items = Array.isArray(result?.artifacts) ? result.artifacts : result?.artifacts?.items || [];
  table(io, items, [
    ["ID", (item) => item.id],
    ["TYPE", (item) => item.type || ""],
    ["STATUS", (item) => item.status || ""],
    ["TASK", (item) => item.taskId || ""],
    ["TITLE", (item) => item.title || item.name || ""],
  ], "No artifacts.");
  return result;
}

export async function artifactsShow(args, io) {
  const id = positional(args, 0, "dataops artifacts show <artifact-id>");
  const result = await apiFor(args).get(`/api/artifacts/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result.artifact || result, null, 2));
  return result;
}

export async function artifactsCreate(args, io) {
  const result = await apiFor(args).post("/api/artifacts", jsonData(args));
  if (!args.json) io.print(`Created artifact ${result?.artifact?.id || ""}.`);
  return result;
}

export async function artifactsUpdate(args, io) {
  const id = positional(args, 0, "dataops artifacts update <artifact-id> --data '{...}'");
  const result = await apiFor(args).put(`/api/artifacts/${enc(id)}`, jsonData(args));
  if (!args.json) io.print(`Updated artifact ${id}.`);
  return result;
}

export async function artifactsAttach(args, io) {
  const id = positional(args, 0, "dataops artifacts attach <artifact-id> --data '{\"taskId\":\"...\"}'");
  const result = await apiFor(args).put(`/api/artifacts/${enc(id)}/attach`, jsonData(args));
  if (!args.json) io.print(`Attached artifact ${id}.`);
  return result;
}

export async function artifactsArchive(args, io) {
  const id = positional(args, 0, "dataops artifacts archive <artifact-id>");
  const result = await apiFor(args).put(`/api/artifacts/${enc(id)}/archive`, {});
  if (!args.json) io.print(`Archived artifact ${id}.`);
  return result;
}

export const filesCommands = {
  list: filesList,
  show: filesShow,
  upload: filesUpload,
  download: filesDownload,
  delete: filesDelete,
};

export const artifactsCommands = {
  list: artifactsList,
  show: artifactsShow,
  create: artifactsCreate,
  update: artifactsUpdate,
  attach: artifactsAttach,
  archive: artifactsArchive,
};
