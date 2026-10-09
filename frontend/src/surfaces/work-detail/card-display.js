// Pure display helpers for the Card detail modal: human link names and
// checklist owner resolution. Kept separate so the panel module stays
// under the frontend size contract.
import { personInitials } from "../../core/identity.js";

export function humanLinkName(name) {
  if (!name || !/^https?:\/\//i.test(name)) return name;
  try {
    const url = new URL(name);
    const domain = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/$/, "");
    if (!path || path === "") return domain;
    if (domain.includes("google.com") && path.includes("/document/")) {
      return `Google doc (${domain})`;
    }
    if (domain.includes("luma.com")) {
      return `Luma event (${domain}${path})`;
    }
    if (domain.includes("meetup.com")) {
      return `Meetup event (${domain})`;
    }
    if (domain.includes("linkedin.com")) {
      return `LinkedIn (${domain}${path})`;
    }
    return `${domain}${path.length > 28 ? path.slice(0, 25) + "…" : path}`;
  } catch {
    return name;
  }
}

// Who owns a checklist row: the recorded assignee first, then a teammate
// named in the title, otherwise the operator default (Grace).
export function resolveChecklistOwnerName(task, usersById, workTaskTitle) {
  const assigned = task.assigneeId && usersById?.get(task.assigneeId);
  if (assigned?.name) return assigned.name;
  const title = workTaskTitle(task).toLowerCase();
  if (usersById) {
    for (const user of usersById.values()) {
      const firstName = String(user?.name || "").split(/\s+/)[0];
      if (firstName && title.includes(firstName.toLowerCase())) {
        return user.name;
      }
    }
    for (const user of usersById.values()) {
      if (String(user?.name || "").toLowerCase() === "grace") {
        return user.name;
      }
    }
  }
  return "";
}

export function ownerAvatar(ownerName) {
  const owner = document.createElement("span");
  owner.className = "card-task-owner";
  owner.title = ownerName;
  owner.setAttribute("aria-label", `Assigned to ${ownerName}`);
  const avatar = document.createElement("span");
  avatar.className = "account-avatar card-task-owner-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = personInitials(ownerName);
  owner.append(avatar);
  return owner;
}
