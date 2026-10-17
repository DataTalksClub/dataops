export function resolveApiBase({ documentRef, windowRef }) {
  const meta = documentRef
    .querySelector('meta[name="api-base"]')
    ?.content?.trim();
  if (meta) return meta;
  try {
    return windowRef.location.origin;
  } catch {}
  return "";
}

export function createApiClient({ apiBase, fetchImpl, storage }) {
  function apiUrl(path) {
    return new URL(path, apiBase);
  }

  // Identical GETs fired by parallel snapshot jobs share one flight: the
  // request fires once and every caller awaits the same promise. Mutations
  // and blob downloads never coalesce.
  const inflightGets = new Map();

  async function request(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const coalesceKey =
      method === "GET" && options.responseType !== "blob"
        ? `GET ${String(url)}`
        : null;
    if (coalesceKey && inflightGets.has(coalesceKey)) {
      return inflightGets.get(coalesceKey);
    }
    const flight = fetchJson(url, options).finally(() => {
      if (coalesceKey && inflightGets.get(coalesceKey) === flight) {
        inflightGets.delete(coalesceKey);
      }
    });
    if (coalesceKey) inflightGets.set(coalesceKey, flight);
    return flight;
  }

  async function fetchJson(url, options = {}) {
    const token = (() => {
      try {
        return storage.getItem("dataops_token");
      } catch {
        return null;
      }
    })();
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {}),
    };
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    const { responseType, ...fetchOptions } = options;
    const response = await fetchImpl(url, {
      ...fetchOptions,
      headers,
    });

    if (response.ok && responseType === "blob") return response.blob();
    const text = await response.text();
    let payload = null;
    let parsedJson = false;
    if (text) {
      try {
        payload = JSON.parse(text);
        parsedJson = true;
      } catch {
        // Non-JSON responses are surfaced as stable HTTP errors below.
      }
    }

    if (text && !parsedJson) {
      const fallback = `HTTP ${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }`;
      const error = new Error(
        response.ok ? "Unexpected non-JSON API response" : fallback,
      );
      error.status = response.status;
      throw error;
    }

    if (!response.ok) {
      const fallback = `HTTP ${response.status}${
        response.statusText ? ` ${response.statusText}` : ""
      }`;
      const error = new Error(payload?.error || fallback);
      error.status = response.status;
      error.code = payload?.code;
      error.payload = payload;
      throw error;
    }

    return payload || {};
  }

  return { apiUrl, request };
}
