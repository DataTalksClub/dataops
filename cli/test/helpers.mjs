import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Point the CLI at an empty config dir and a fake portal before importing it. */
export function isolateConfig() {
  process.env.DATAOPS_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "dataops-cli-"));
  process.env.DATAOPS_URL = "https://portal.test";
  process.env.DATAOPS_TOKEN = "dops_test";
}

export function captureIo() {
  const out = [];
  const errors = [];
  return {
    out,
    errors,
    log: (line) => out.push(String(line)),
    error: (line) => errors.push(String(line)),
    text: () => out.join("\n"),
    json: () => JSON.parse(out.join("\n")),
  };
}

/**
 * Install a fake portal on globalThis.fetch. Routes are keyed "METHOD /path"
 * (no query string); a handler gets { query, body, url } and returns
 * { status, body } or a plain body. The portal's /work/api seam is served by
 * the same routes, and every call is recorded.
 */
export function fakePortal(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const route = parsed.pathname.startsWith("/work/api/") ? parsed.pathname.slice("/work".length) : parsed.pathname;
    const method = options.method || "GET";
    let body = options.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // leave non-JSON bodies as text
      }
    }
    const call = { method, route, rawPath: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body, headers: options.headers || {} };
    calls.push(call);
    const handler = routes[`${method} ${route}`];
    if (!handler) return new Response(JSON.stringify({ error: `no fake for ${method} ${route}` }), { status: 404 });
    const result = typeof handler === "function" ? await handler(call, calls) : handler;
    // A handler may answer with its own Response to serve raw bytes.
    if (result instanceof Response) return result;
    const wrapped = result && typeof result === "object" && "status" in result && "body" in result ? result : { status: 200, body: result };
    return new Response(wrapped.body === undefined ? "" : JSON.stringify(wrapped.body), { status: wrapped.status });
  };
  return calls;
}
