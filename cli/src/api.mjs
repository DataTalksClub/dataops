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
 * JSON client for the portal; routes are the server paths (`/api/*`, `/docs`, ...).
 * `credential` optionally supplies the bearer value per call (async), which is
 * how shared-issuer sessions refresh themselves transparently.
 */
export function createClient({ url, token, credential, fetchImpl = fetch }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "No portal URL. Pass --url, set DATAOPS_URL, or run `dataops login --url ...` first.",
    );
  }

  async function call(method, route, body, options = {}) {
    const headers = { Accept: "application/json" };
    const value = options.anonymous ? null : await (credential ? credential() : token);
    if (value) headers.Authorization = `Bearer ${value}`;
    Object.assign(headers, options.headers);
    let payload;
    if (options.rawBody !== undefined) {
      payload = options.rawBody;
      if (options.contentType) headers["Content-Type"] = options.contentType;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const address = `${base}${withQuery(route, options.query)}`;
    let response;
    try {
      response = await fetchImpl(address, { method, headers, body: payload, redirect: "manual" });
    } catch (error) {
      throw new NetworkError(address, error);
    }
    if (response.ok && options.responseType === "bytes") {
      return Buffer.from(await response.arrayBuffer());
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) throw new ApiError(response.status, parsed, address);
    return parsed;
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
