import { renderIcon } from "../../core/icons.js";
import { LINK_GROUPS, linkLabel, linkService, opensInNewTab } from "../../core/links.js";

// Artifacts as tidy rows, grouped by what they are: documents, event pages,
// videos, people, uploaded files, other links. Each row is the service icon,
// a human label (the stored title when someone wrote one, otherwise service
// plus a short id), the service name, and the review status. A raw URL is
// never printed; it stays one hover away on the link.

const STATUS_LABELS = Object.freeze({
  draft: "Draft",
  "needs-review": "Needs review",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
  superseded: "Superseded",
});

function isOwnedFile(artifact) {
  const uri = String(artifact?.storageUri || "");
  return artifact?.storageProvider === "s3" || artifact?.storageProvider === "local-dev" ||
    uri.startsWith("s3://") || uri.startsWith("local-dev://") || !uri;
}

export function artifactDisplay(artifact) {
  if (isOwnedFile(artifact)) {
    const name = String(artifact.title || artifact.filename || "File");
    const kind = String(artifact.contentType || "").split("/").pop()?.toUpperCase() || "";
    return { group: "files", icon: "file", label: name, detail: kind ? `${kind} file` : "File", href: "" };
  }
  const service = linkService(artifact.storageUri);
  return {
    group: service.group,
    icon: service.icon,
    label: linkLabel(artifact.storageUri, artifact.title),
    detail: service.name,
    href: String(artifact.storageUri),
  };
}

export function renderArtifactGroups(artifacts, options = {}) {
  const { renderActions = () => [], openFile = () => {} } = options;
  const entries = artifacts.map((artifact) => ({ artifact, display: artifactDisplay(artifact) }));
  const present = LINK_GROUPS.filter((group) => entries.some((entry) => entry.display.group === group.id));
  const wrap = document.createElement("div");
  wrap.className = "artifact-groups";
  for (const group of present) {
    const section = document.createElement("div");
    section.className = "artifact-group";
    section.dataset.group = group.id;
    // A single group needs no heading: the section label already says
    // "Artifacts".
    if (present.length > 1) {
      const heading = document.createElement("div");
      heading.className = "artifact-group-label";
      heading.textContent = group.label;
      section.append(heading);
    }
    const list = document.createElement("ul");
    list.className = "artifact-rows";
    const members = entries
      .filter((entry) => entry.display.group === group.id)
      .sort((left, right) => left.display.label.localeCompare(right.display.label));
    for (const { artifact, display } of members) {
      list.append(renderArtifactRow(artifact, display, renderActions, openFile));
    }
    section.append(list);
    wrap.append(section);
  }
  return wrap;
}

function renderArtifactRow(artifact, display, renderActions, openFile) {
  const row = document.createElement("li");
  row.className = "artifact-row";
  row.dataset.artifactId = artifact.id;
  const icon = document.createElement("span");
  icon.className = "artifact-row-icon";
  icon.append(renderIcon(display.icon, { size: 16 }));

  const text = document.createElement("span");
  text.className = "artifact-row-text";
  let label;
  if (display.href) {
    label = document.createElement("a");
    label.href = display.href;
    label.title = display.href;
  } else {
    label = document.createElement("button");
    label.type = "button";
    label.title = `Download ${display.label}`;
    label.addEventListener("click", () => openFile(artifact));
  }
  label.className = "artifact-row-label";
  label.textContent = display.label;
  if (display.href) opensInNewTab(label);
  const detail = document.createElement("span");
  detail.className = "artifact-row-detail";
  detail.textContent = display.detail;
  text.append(label, detail);

  const status = document.createElement("span");
  const statusKey = artifact.status || "draft";
  status.className = `task-status-badge ${statusKey}`;
  status.textContent = STATUS_LABELS[statusKey] || statusKey;

  row.append(icon, text, status, ...renderActions(artifact));
  return row;
}
