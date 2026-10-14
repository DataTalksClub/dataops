// Every Sponsors tab and record has its own path; see WORKSPACE_ROUTE_DEFINITIONS.
export const SPONSORS_TABS = Object.freeze([
  Object.freeze(["queue", "Queue"]),
  Object.freeze(["pipeline", "Pipeline"]),
  Object.freeze(["companies", "Companies"]),
  Object.freeze(["leads", "Leads"]),
  Object.freeze(["newsletters", "Newsletters"]),
  Object.freeze(["money", "Money"]),
]);

export function sponsorsPath(tab = "queue") {
  return SPONSORS_TABS.some(([id]) => id === tab) ? `/sponsors/${tab}` : "/sponsors/queue";
}

export function sponsorRecordPath(kind, id) {
  const family = { deal: "deals", company: "companies", lead: "leads", newsletter: "newsletters" }[kind];
  return `/sponsors/${family}/${encodeURIComponent(id)}`;
}
