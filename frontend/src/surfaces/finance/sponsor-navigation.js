import { sponsorsPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";

// Package E directory navigation: three primary relationship tabs plus a
// secondary overflow for discovery/source/finance views. Pure model + markup
// over the canonical sponsor-routes helpers; every existing canonical URL
// stays reachable.

export const CRM_PRIMARY_TABS = Object.freeze([
  Object.freeze({ id: "pipeline", label: "Pipeline" }),
  Object.freeze({ id: "companies", label: "Companies" }),
  Object.freeze({ id: "people", label: "People" }),
]);

export const CRM_MORE_LINKS = Object.freeze([
  Object.freeze({ id: "followups", label: "Follow-ups" }),
  Object.freeze({ id: "leads", label: "Potential leads" }),
  Object.freeze({ id: "newsletters", label: "Newsletters" }),
  Object.freeze({ id: "money", label: "Money" }),
]);

export function crmNavModel(currentTab) {
  const link = ({ id, label }) => ({
    id,
    label,
    href: sponsorsPath(id),
    current: id === currentTab,
  });
  const primary = CRM_PRIMARY_TABS.map(link);
  const more = CRM_MORE_LINKS.map(link);
  return {
    primary,
    more,
    moreCurrent: more.some((entry) => entry.current),
    moreLabel: more.find((entry) => entry.current)?.label || "More",
  };
}

// dakit tabs for the primary row; a native <details> disclosure for More so
// Potential leads / Newsletters / Money stay one click away without
// crowding narrow screens. Tabs are links: modified clicks open in a new tab.
export function renderCrmNav(model, { escapeHtml }) {
  const tab = ({ id, label, href, current }) => html`<a
    class="dk-tab" href="${escapeHtml(href)}" data-crm-nav-tab="${escapeHtml(id)}"${
    current ? ' aria-current="page"' : ""
  }>${escapeHtml(label)}</a>`;
  return html`<nav class="dk-tabs crm-views" data-crm-nav aria-label="CRM">
    ${model.primary.map(tab).join("")}
    <details class="crm-more" data-crm-nav-more>
      <summary class="dk-tab" data-crm-nav-more-label aria-label="More CRM views"${
    model.moreCurrent ? ' aria-current="page"' : ""
  }>${escapeHtml(model.moreLabel)}</summary>
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
