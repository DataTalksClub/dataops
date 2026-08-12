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

  async function request(url, options = {}) {
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
    const response = await fetchImpl(url, {
      ...options,
      headers,
    });

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
