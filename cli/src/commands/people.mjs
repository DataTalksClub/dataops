import { enc, fields, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const teamSummary = "The team directory: ids to use for --assignee and --owner";
export const usersSummary = "User accounts (admin)";

export const teamHelp = `dataops team - who is on the team, with the ids work commands take

Usage
  dataops team list
  dataops team default-assignee                       Who gets new work nothing else assigns
  dataops team set-default-assignee <user-id|none>    Change it (admin); none leaves new work unassigned
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

export async function teamDefaultAssignee(args, io) {
  const api = apiFor(args);
  const settings = await api.get("/api/team-members/default-assignee");
  if (args.json) return settings;
  const { teamMembers = [] } = await api.get("/api/team-members");
  const member = teamMembers.find((candidate) => candidate.id === settings.defaultAssigneeId);
  io.print(settings.defaultAssigneeId
    ? `${member?.name || settings.defaultAssigneeId} (${settings.defaultAssigneeId})`
    : "No default assignee: new work stays unassigned.");
  return settings;
}

export async function teamSetDefaultAssignee(args, io) {
  const target = positional(args, 0, "dataops team set-default-assignee <user-id|none>");
  const api = apiFor(args);
  const current = await api.get("/api/team-members/default-assignee");
  const result = await api.put("/api/team-members/default-assignee", {
    defaultAssigneeId: target === "none" ? null : target,
    expectedVersion: current.version,
  });
  if (!args.json) {
    io.print(result.defaultAssigneeId
      ? `New work now goes to ${result.defaultAssigneeId}.`
      : "No default assignee: new work stays unassigned.");
  }
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

export const teamCommands = {
  list: teamList,
  "default-assignee": teamDefaultAssignee,
  "set-default-assignee": teamSetDefaultAssignee,
};
export const usersCommands = { list: usersList, show: usersShow };
