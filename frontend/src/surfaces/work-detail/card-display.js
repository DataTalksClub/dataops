// Pure display helpers for the Card detail modal: human link names and
// checklist owner resolution. Kept separate so the panel module stays
// under the frontend size contract.
import { personAvatar } from "../../core/identity.js";

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

// The Task's assignee. No guessing from the title or a default person: an
// unassigned Task shows no avatar.
export function resolveChecklistOwner(task, usersById) {
  const assigned = task.assigneeId && usersById?.get(task.assigneeId);
  return assigned?.name ? assigned : null;
}

export function ownerAvatar(person) {
  const owner = document.createElement("span");
  owner.className = "card-task-owner";
  owner.title = person.name;
  owner.setAttribute("role", "img");
  owner.setAttribute("aria-label", `Assigned to ${person.name}`);
  owner.append(personAvatar(person, { className: "card-task-owner-avatar" }));
  return owner;
}
