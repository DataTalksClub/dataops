export class ApiError extends Error {
  constructor(status, body, url) {
    const detail =
      (body && typeof body === "object" && (body.error || body.message)) ||
      (typeof body === "string" && body) ||
      `HTTP ${status}`;
    super(String(detail));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * The portal serves the work API under /work/api; a bare backend serves it at
 * /api. Callers name routes the way the frontend does and this resolves the
 * seam, trying the portal path first.
 */
export function createClient({ url, token, fetchImpl = fetch }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "No portal URL. Pass --url, set DATAOPS_URL, or run `dataops login --url ...` first.",
    );
  }

  async function call(method, route, body, options = {}) {
    const headers = { Accept: "application/json" };
    if (token && !options.anonymous) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError = null;
    for (const prefix of ["/work", ""]) {
      const target = `${base}${prefix}${route}`;
      const response = await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // A missing seam is a 404 with no JSON error body; a real 404 from the
      // API still carries one, so only the former falls through to /api.
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (
        response.status === 404 &&
        prefix === "/work" &&
        !isApiPayload(parsed)
      ) {
        lastError = new ApiError(response.status, parsed, target);
        continue;
      }
      if (!response.ok) throw new ApiError(response.status, parsed, target);
      return parsed;
    }
    throw lastError;
  }

  return {
    base,
    get: (route, options) => call("GET", route, undefined, options),
    post: (route, body, options) => call("POST", route, body ?? {}, options),
    put: (route, body, options) => call("PUT", route, body ?? {}, options),
    delete: (route, options) => call("DELETE", route, undefined, options),
  };
}

function isApiPayload(value) {
  return Boolean(value && typeof value === "object");
}
