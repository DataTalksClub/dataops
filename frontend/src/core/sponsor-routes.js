// Every Sponsors tab and record has its own path; see WORKSPACE_ROUTE_DEFINITIONS.
export const SPONSORS_TABS = Object.freeze([
  Object.freeze(["pipeline", "Pipeline"]),
  Object.freeze(["companies", "Companies"]),
  Object.freeze(["people", "People"]),
  Object.freeze(["followups", "Follow-ups"]),
  Object.freeze(["leads", "Leads"]),
  Object.freeze(["newsletters", "Newsletters"]),
  Object.freeze(["money", "Money"]),
]);

export function sponsorsPath(tab = "pipeline") {
  return SPONSORS_TABS.some(([id]) => id === tab) ? `/sponsors/${tab}` : "/sponsors/pipeline";
}

export function sponsorRecordPath(kind, id) {
  const family = { deal: "deals", company: "companies", person: "people", lead: "leads", newsletter: "newsletters" }[kind];
  return `/sponsors/${family}/${encodeURIComponent(id)}`;
}
