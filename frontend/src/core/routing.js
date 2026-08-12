export const WORKSPACE_HASH_BY_VIEW = Object.freeze({
  home: "/",
  inbox: "/inbox",
  docs: "/processes",
  admin: "/admin",
  users: "/users",
  bookkeeping: "/bookkeeping",
  sponsors: "/sponsors",
  newsletter: "/newsletter",
  calendar: "/calendar",
  "mailing-exports": "/mailing-exports",
});

export const WORKSPACE_ROUTE_DEFINITIONS = Object.freeze({
  "/": { view: "home", tasksSection: "queue", params: [] },
  "/inbox": { view: "inbox", tasksSection: "queue", params: ["intakeId"] },
  "/tasks": {
    view: "tasks",
    tasksSection: "queue",
    params: ["taskId", "date", "bundleId", "contextBundleId"],
  },
  "/cards": { view: "tasks", tasksSection: "workflows", params: ["cardId", "taskId"] },
  "/cards/archive": { view: "tasks", tasksSection: "workflows", params: ["cardId", "taskId"] },
  "/assistants": { view: "tasks", tasksSection: "assistants", params: ["assistantJobId"] },
  "/templates": { view: "tasks", tasksSection: "templates", params: ["templateId"] },
  "/recurring": { view: "tasks", tasksSection: "templates", params: [] },
  "/artifacts": { view: "tasks", tasksSection: "artifacts", params: [] },
  "/notifications": { view: "home", tasksSection: "queue", params: [] },
  "/bookkeeping": { view: "bookkeeping", tasksSection: "queue", params: [] },
  "/sponsors": { view: "sponsors", tasksSection: "queue", params: ["bookingId"] },
  "/newsletter": { view: "newsletter", tasksSection: "queue", params: [] },
  "/calendar": { view: "calendar", tasksSection: "queue", params: [] },
  "/mailing-exports": { view: "mailing-exports", tasksSection: "queue", params: [] },
  "/processes": { view: "docs", tasksSection: "queue", params: [] },
  "/admin": { view: "admin", tasksSection: "queue", params: [] },
  "/users": { view: "users", tasksSection: "queue", params: [] },
});

export const TASKS_SECTIONS = Object.freeze([
  Object.freeze(["queue", "Queue"]),
  Object.freeze(["workflows", "Cards"]),
  Object.freeze(["templates", "Templates"]),
  Object.freeze(["assistants", "Assistants"]),
  Object.freeze(["artifacts", "Artifacts"]),
]);

export const ENTITY_VOCABULARY = Object.freeze({
  template: "Template",
  card: "Card",
  task: "Task",
});

export function tasksSectionTitle(section) {
  const titles = {
    queue: "Tasks - Work Queue",
    workflows: "Tasks - Cards",
    templates: "Tasks - Templates",
    assistants: "Tasks - Assistants",
    artifacts: "Tasks - Artifacts",
  };
  return titles[section] || "Tasks - Work Queue";
}

export function workspaceHashPath(view, tasksSection = "queue") {
  if (view === "tasks") {
    return {
      queue: "/tasks",
      workflows: "/cards",
      templates: "/templates",
      assistants: "/assistants",
      artifacts: "/artifacts",
    }[tasksSection] || "/tasks";
  }
  return WORKSPACE_HASH_BY_VIEW[view] || "/";
}

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function canonicalWorkspaceUrl(path, params = new URLSearchParams()) {
  const definition = WORKSPACE_ROUTE_DEFINITIONS[path] || WORKSPACE_ROUTE_DEFINITIONS["/"];
  const ordered = new URLSearchParams();
  for (const name of definition.params) {
    const value = params instanceof URLSearchParams ? params.get(name) : params?.[name];
    if (value) ordered.set(name, value);
  }
  const query = ordered.toString();
  return `/#${path}${query ? `?${query}` : ""}`;
}

export function parseWorkspaceHash(rawHash, location = globalThis.window?.location) {
  const raw = String(rawHash === undefined ? location?.hash || "" : rawHash || "");
  if (!raw) return { invalid: true, reason: "empty hash" };
  if (!raw.startsWith("#/") || raw.includes("#", 1)) {
    return { invalid: true, reason: "malformed hash" };
  }

  const value = raw.slice(1);
  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const rawQuery = queryIndex >= 0 ? value.slice(queryIndex + 1) : "";
  if (rawQuery.includes("?")) return { invalid: true, reason: "malformed query" };

  try {
    decodeURIComponent(rawPath);
    for (const component of rawQuery.split("&").filter(Boolean)) {
      const separator = component.indexOf("=");
      decodeURIComponent((separator >= 0 ? component.slice(0, separator) : component).replace(/\+/g, " "));
      decodeURIComponent((separator >= 0 ? component.slice(separator + 1) : "").replace(/\+/g, " "));
    }
  } catch {
    return { invalid: true, reason: "malformed encoding" };
  }

  const path = rawPath.endsWith("/") && rawPath !== "/" ? rawPath.slice(0, -1) : rawPath;
  const definition = WORKSPACE_ROUTE_DEFINITIONS[path];
  if (!definition) return { invalid: true, reason: "unknown path" };

  const incoming = new URLSearchParams(rawQuery);
  const params = new URLSearchParams();
  for (const name of definition.params) {
    const values = incoming.getAll(name);
    if (values.length > 1 || (values.length === 1 && !values[0])) {
      return { invalid: true, reason: `invalid ${name}` };
    }
    if (values[0]) params.set(name, values[0]);
  }
  if (params.has("date") && !isRealIsoDate(params.get("date"))) {
    return { invalid: true, reason: "invalid date" };
  }
  if (["/cards", "/cards/archive"].includes(path) && params.has("taskId") && !params.has("cardId")) {
    return { invalid: true, reason: "taskId requires cardId" };
  }

  const canonicalUrl = canonicalWorkspaceUrl(path, params);
  const currentUrl = `${location?.pathname || "/"}${location?.search || ""}${raw}`;
  return {
    view: definition.view,
    tasksSection: definition.tasksSection,
    path,
    params,
    canonicalUrl,
    normalized: currentUrl !== canonicalUrl,
  };
}

export function workspaceRouteFor(path, params = {}, location) {
  const visible = canonicalWorkspaceUrl(path, params);
  return parseWorkspaceHash(visible.slice(visible.indexOf("#")), location);
}
