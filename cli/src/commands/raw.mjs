import { UsageError } from "../errors.mjs";
import { jsonData, positional } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Call any portal API route directly (escape hatch)";

export const help = `dataops api - call any route the web app uses, with your credential

Usage
  dataops api <GET|POST|PUT|PATCH|DELETE> <route> [--data '{...}'|@file.json|-] [--query k=v ...]

Routes are the web app's: /api/... (work, finance, CRM, calendar), /docs, /search,
/knowledge/... (knowledge base). The response is printed as JSON. Prefer a dedicated
command when one exists; this covers views without one (bookkeeping, operating model,
document reviews).

Examples
  dataops api GET /api/operating-model
  dataops api GET /api/bookkeeping/transactions --query month=2026-10
  dataops api GET /api/document-reviews
`;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function queryPairs(value) {
  if (value === undefined) return undefined;
  const pairs = Array.isArray(value) ? value : [value];
  const query = {};
  for (const pair of pairs) {
    const text = String(pair);
    const at = text.indexOf("=");
    if (at < 1) throw new UsageError(`--query takes key=value, got "${text}".`);
    query[text.slice(0, at)] = text.slice(at + 1);
  }
  return query;
}

export async function call(args, io) {
  const usage = "dataops api <METHOD> <route> [--data JSON] [--query k=v]";
  const method = positional(args, 0, usage).toUpperCase();
  const route = positional(args, 1, usage);
  if (!METHODS.has(method)) throw new UsageError(`Unknown method ${method}. ${usage}`);
  if (!route.startsWith("/")) throw new UsageError("The route must start with /, e.g. /api/tasks.");
  const body = jsonData(args, { required: false });
  if (method === "GET" && body) throw new UsageError("GET takes --query, not --data.");
  const result = await apiFor(args).request(method, route, body ?? (method === "GET" ? undefined : {}), {
    query: queryPairs(args.query),
  });
  if (!args.json) io.print(JSON.stringify(result ?? null, null, 2));
  return result;
}
