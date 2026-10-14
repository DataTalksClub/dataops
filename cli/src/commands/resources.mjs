import { table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Required-resource ids Tasks use in requires (youtube, luma, ...)";

export const help = `dataops resources - the systems a Task can require (accounts or access)

Usage
  dataops resources list

A Task's requires lists the resource ids it cannot be done without. Declare what
you have access to with DATAOPS_CAPABILITIES=youtube,luma (or --can-do) and
\`dataops tasks list\` shows only the Tasks you can actually do.
`;

export async function list(args, io) {
  const result = await apiFor(args).get("/api/resources");
  if (args.json) return result;
  table(io, result.resources || [], [
    ["ID", (resource) => resource.id],
    ["NAME", (resource) => resource.name],
    ["ACCESS", (resource) => resource.access],
  ], "No resources.");
  return result;
}

export const commands = { list };
