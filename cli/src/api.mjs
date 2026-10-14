export class ApiError extends Error {
  constructor(status, body, url) {
    const detail =
      (body && typeof body === "object" && (body.error || body.message)) ||
      (typeof body === "string" && body.trim().slice(0, 200)) ||
      `HTTP ${status}`;
    super(String(detail));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.code = body && typeof body === "object" && typeof body.code === "string" ? body.code : "";
  }
}

/** Append defined query values; arrays repeat the key. */
export function withQuery(route, query) {
  if (!query) return route;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const text = params.toString();
  if (!text) return route;
  return `${route}${route.includes("?") ? "&" : "?"}${text}`;
}

/**
 * The portal serves the work API under /work/api; a bare backend serves it at
 * /api. Callers name `/api/*` routes the way the frontend does and this
 * resolves the seam, trying the portal path first. Docs routes (`/docs`,
 * `/search`, `/knowledge/*`) live at the same path on both, so they are called
 * directly: under `/work` the portal would answer with the web app instead.
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
    let payload;
    if (options.rawBody !== undefined) {
      payload = options.rawBody;
      if (options.contentType) headers["Content-Type"] = options.contentType;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const target = withQuery(route, options.query);
    const prefixes = target.startsWith("/api/") ? ["/work", ""] : [""];

    let lastError = null;
    for (const prefix of prefixes) {
      const address = `${base}${prefix}${target}`;
      let response;
      try {
        response = await fetchImpl(address, { method, headers, body: payload, redirect: "manual" });
      } catch (error) {
        throw new NetworkError(address, error);
      }
      if (options.binary && response.ok) {
        return {
          bytes: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers?.get?.("content-type") || "",
          disposition: response.headers?.get?.("content-disposition") || "",
        };
      }
      // A missing seam is a 404 with no JSON error body; a real 404 from the
      // API still carries one, so only the former falls through to /api.
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (response.status === 404 && prefix === "/work" && !isApiPayload(parsed)) {
        lastError = new ApiError(response.status, parsed, address);
        continue;
      }
      if (!response.ok) throw new ApiError(response.status, parsed, address);
      return parsed;
    }
    throw lastError;
  }

  return {
    base,
    get: (route, options) => call("GET", route, undefined, options),
    post: (route, body, options) => call("POST", route, body ?? {}, options),
    put: (route, body, options) => call("PUT", route, body ?? {}, options),
    patch: (route, body, options) => call("PATCH", route, body ?? {}, options),
    delete: (route, body, options) => call("DELETE", route, body, options),
    request: call,
  };
}

export class NetworkError extends Error {
  constructor(url, cause) {
    super(`Could not reach ${url}: ${cause?.cause?.code || cause?.message || cause}`);
    this.name = "NetworkError";
  }
}

function isApiPayload(value) {
  return Boolean(value && typeof value === "object");
}
