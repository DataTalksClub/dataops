import { enc, fields, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const teamSummary = "The team directory: ids to use for --assignee and --owner";
export const usersSummary = "User accounts (admin)";

export const teamHelp = `dataops team - who is on the team, with the ids work commands take

Usage
  dataops team list
`;

export const usersHelp = `dataops users - user accounts (admin only; operators get 403)

Usage
  dataops users list
  dataops users show <user-id>

Creating and editing accounts stays in the web Users page.
`;

export async function teamList(args, io) {
  const result = await apiFor(args).get("/api/team-members");
  if (args.json) return result;
  table(io, result.teamMembers || [], [
    ["ID", (member) => member.id],
    ["ROLE", (member) => member.role || ""],
    ["ACTIVE", (member) => (member.active ? "yes" : "no")],
    ["NAME", (member) => member.name],
  ], "No team members.");
  return result;
}

export async function usersList(args, io) {
  const result = await apiFor(args).get("/api/users");
  if (args.json) return result;
  table(io, result.users || [], [
    ["ID", (user) => user.id],
    ["ROLE", (user) => user.role || ""],
    ["DISABLED", (user) => (user.disabled ? "yes" : "")],
    ["EMAIL", (user) => user.email || ""],
    ["NAME", (user) => user.name],
  ], "No users.");
  return result;
}

export async function usersShow(args, io) {
  const id = positional(args, 0, "dataops users show <user-id>");
  const result = await apiFor(args).get(`/api/users/${enc(id)}`);
  if (!args.json) fields(io, Object.entries(result.user || result).filter(([, value]) => typeof value !== "object"));
  return result;
}

export const teamCommands = { list: teamList };
export const usersCommands = { list: usersList, show: usersShow };
