import { enc, fields, optionalString, positional, table } from "../format.mjs";
import { UsageError } from "../errors.mjs";
import { apiFor } from "../session.mjs";

export const teamSummary = "The team directory: ids to use for --assignee and --owner";
export const usersSummary = "User accounts (admin)";

export const teamHelp = `dataops team - who is on the team, with the ids work commands take

Usage
  dataops team list
  dataops team default-assignee                       Who gets new work nothing else assigns
  dataops team set-default-assignee <user-id|none>    Change it (admin); none leaves new work unassigned
  dataops team handover <user-id>                     The open work a person holds (admin)
  dataops team reassign <user-id> --to <user-id>      Hand all of it to someone else (admin)
  dataops team disable-user <user-id> [--reassign-to <user-id>] [--new-default <user-id>]
                                                      Disable an account; open work needs --reassign-to,
                                                      the default assignee needs --new-default (admin)
  dataops team enable-user <user-id>                  Re-enable a disabled account (admin)
  dataops team delete-user <user-id> [--reassign-to <user-id>] [--new-default <user-id>]
                                                      Delete a disabled account; only its name stays in
                                                      history (admin). Disable it first.

Open work is open Tasks, Cards a person owns, recurring schedules naming them,
and sponsor organizations and live deals they own. Disabling or deleting also
revokes every session and API token the person holds.
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

function describeWork(work = {}) {
  const parts = [
    [work.tasks, "open task", "open tasks"],
    [work.cards, "card", "cards"],
    [work.schedules, "schedule", "schedules"],
    [work.sponsorRecords, "sponsor record", "sponsor records"],
  ].filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "no open work";
}

export async function teamHandover(args, io) {
  const id = positional(args, 0, "dataops team handover <user-id>");
  const result = await apiFor(args).get(`/api/users/${enc(id)}/handover`);
  if (!args.json) {
    io.print(`${result.user.name}${result.user.disabled ? " (disabled)" : ""}: ${describeWork(result.openWork)}.`);
    if (result.isDefaultAssignee) io.print("Default assignee: pick a new one before disabling or deleting.");
  }
  return result;
}

export async function teamReassign(args, io) {
  const id = positional(args, 0, "dataops team reassign <user-id> --to <user-id>");
  const to = optionalString(args, "to");
  if (!to) throw new UsageError("--to is required: the active team member who takes over.");
  const result = await apiFor(args).post(`/api/users/${enc(id)}/reassign`, { reassignTo: to });
  if (!args.json) {
    io.print(`Moved ${describeWork(result.moved)} to ${result.reassignedTo}.`);
    if (Object.values(result.remaining || {}).some((count) => count > 0)) {
      io.print(`Still open: ${describeWork(result.remaining)}. Run it again.`);
    }
  }
  return result;
}

function lifecycleBody(args) {
  const body = {};
  const reassignTo = optionalString(args, "reassignTo");
  const newDefault = optionalString(args, "newDefault");
  if (reassignTo) body.reassignTo = reassignTo;
  if (newDefault) body.newDefaultAssigneeId = newDefault;
  return body;
}

export async function teamDisableUser(args, io) {
  const id = positional(args, 0, "dataops team disable-user <user-id> [--reassign-to <user-id>] [--new-default <user-id>]");
  const result = await apiFor(args).post(`/api/users/${enc(id)}/disable`, lifecycleBody(args));
  if (!args.json) {
    io.print(`Disabled ${result.user?.name || id}.`);
    if (result.moved) io.print(`Moved ${describeWork(result.moved)} to ${result.reassignedTo}.`);
    if (result.newDefaultAssigneeId) io.print(`New work now goes to ${result.newDefaultAssigneeId}.`);
    io.print(`Revoked ${result.revokedCredentials} session(s) and token(s).`);
  }
  return result;
}

export async function teamEnableUser(args, io) {
  const id = positional(args, 0, "dataops team enable-user <user-id>");
  const result = await apiFor(args).post(`/api/users/${enc(id)}/enable`, {});
  if (!args.json) io.print(`Enabled ${result.user?.name || id}.`);
  return result;
}

export async function teamDeleteUser(args, io) {
  const id = positional(args, 0, "dataops team delete-user <user-id> [--reassign-to <user-id>] [--new-default <user-id>]");
  const result = await apiFor(args).delete(`/api/users/${enc(id)}`, lifecycleBody(args));
  if (!args.json) {
    io.print(`Deleted ${result.deleted.name}; history still shows the name.`);
    if (result.moved) io.print(`Moved ${describeWork(result.moved)} to ${result.reassignedTo}.`);
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
  handover: teamHandover,
  reassign: teamReassign,
  "disable-user": teamDisableUser,
  "enable-user": teamEnableUser,
  "delete-user": teamDeleteUser,
};
export const usersCommands = { list: usersList, show: usersShow };
