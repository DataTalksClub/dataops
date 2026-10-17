import { sponsorRecordPath, sponsorsPath, SPONSORS_TABS } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";

// Package E directory navigation: three primary relationship tabs plus a
// secondary overflow for discovery/source/finance views. Pure model + markup;
// route registration (workspace.js, sponsor-routes.js) and surface wiring
// (sponsor-layout.js, sponsors.js) are future integration hunks, applied only
// after the coordinator releases the shared files. Every existing canonical
// URL stays reachable: this module only maps paths to tabs, never redirects.

export const CRM_PRIMARY_TABS = Object.freeze([
  Object.freeze({ id: "pipeline", label: "Pipeline" }),
  Object.freeze({ id: "companies", label: "Companies" }),
  Object.freeze({ id: "people", label: "People" }),
]);

export const CRM_MORE_LINKS = Object.freeze([
  Object.freeze({ id: "leads", label: "Lead discovery" }),
  Object.freeze({ id: "newsletters", label: "Newsletter sources" }),
  Object.freeze({ id: "money", label: "Money" }),
]);

// Canonical CRM list paths. Registered tabs go through the canonical
// sponsorsPath; "people" uses the same shape until the integration hunk
// registers it in SPONSORS_TABS.
// INTEGRATION-TODO(release): delete crmDirectoryPath/crmPersonPath and use
// sponsorsPath/sponsorRecordPath (with a "person" kind) everywhere once the
// routes hunk lands; the duplicate mapping below goes away with it.
const REGISTERED_TABS = new Set(SPONSORS_TABS.map(([id]) => id));

export function crmDirectoryPath(tab) {
  if (![...CRM_PRIMARY_TABS, ...CRM_MORE_LINKS].some((entry) => entry.id === tab)) {
    throw new Error(`Unknown CRM tab: ${tab}`);
  }
  if (REGISTERED_TABS.has(tab)) return sponsorsPath(tab);
  return `/sponsors/${tab}`;
}

export function crmPersonPath(id) {
  if (!id) throw new Error("A person id is required");
  return `/sponsors/people/${encodeURIComponent(id)}`;
}

// Maps a canonical path (no query) to its navigation tab. Record routes keep
// the tab of the list they belong to, so Back returns to a highlighted origin.
// Unknown paths return null: the nav renders with nothing marked current
// rather than guessing.
// INTEGRATION-TODO(release): workspace route definitions own tab mapping
// after the routes hunk; this helper then only serves the nav model.
export function crmTabForPath(path) {
  const clean = String(path || "").split("?")[0].split("#")[0];
  if (clean === "/sponsors" || clean === "/sponsors/pipeline") return "pipeline";
  for (const { id } of [...CRM_PRIMARY_TABS, ...CRM_MORE_LINKS]) {
    if (clean === `/sponsors/${id}`) return id;
  }
  const record = clean.match(/^\/sponsors\/(deals|companies|people|leads|newsletters)\/[^/]+$/);
  if (!record) return null;
  const family = record[1];
  if (family === "deals") return "pipeline";
  return family;
}

export function crmNavModel(currentTab) {
  const link = ({ id, label }) => ({
    id,
    label,
    href: crmDirectoryPath(id),
    current: id === currentTab,
  });
  const primary = CRM_PRIMARY_TABS.map(link);
  const more = CRM_MORE_LINKS.map(link);
  return {
    primary,
    more,
    moreCurrent: more.some((entry) => entry.current),
  };
}

// dakit tabs for the primary row; a native <details> disclosure for More so
// Lead discovery / Newsletter sources / Money stay one click away without
// crowding narrow screens. Tabs are links: modified clicks open in a new tab.
export function renderCrmNav(model, { escapeHtml }) {
  const tab = ({ id, label, href, current }) => html`<a
    class="dk-tab" href="${escapeHtml(href)}" data-crm-nav-tab="${escapeHtml(id)}"${
    current ? ' aria-current="page"' : ""
  }>${escapeHtml(label)}</a>`;
  return html`<nav class="dk-tabs crm-views" data-crm-nav aria-label="CRM">
    ${model.primary.map(tab).join("")}
    <details class="crm-more" data-crm-nav-more${model.moreCurrent ? " open" : ""}>
      <summary aria-label="More CRM views">More</summary>
      <div class="crm-more__menu">${model.more
        .map(
          ({ id, label, href, current }) => html`<a
            href="${escapeHtml(href)}" data-crm-nav-tab="${escapeHtml(id)}"${
            current ? ' aria-current="page"' : ""
          }>${escapeHtml(label)}</a>`,
        )
        .join("")}</div>
    </details>
  </nav>`;
}
