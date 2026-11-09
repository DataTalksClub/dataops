import {
  failureMessage,
  reportClientFailure,
} from "../core/guarded-fetch.js";

// Shell reads can sit behind a cold Lambda start and a large listing, so they
// get longer than the anonymous pages' 20s; writes get the full Lambda budget.
const READ_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 120000;
const MAX_REPORTS_PER_PAGE = 5;

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

export function createApiClient({
  apiBase,
  fetchImpl,
  storage,
  timeoutMs = READ_TIMEOUT_MS,
}) {
  function apiUrl(path) {
    return new URL(path, apiBase);
  }

  // Identical GETs fired by parallel snapshot jobs share one flight: the
  // request fires once and every caller awaits the same promise. Mutations
  // and blob downloads never coalesce.
  const inflightGets = new Map();

  // One failing page load fires many failing requests. Report each distinct
  // (check, status) once, capped per page, so the server's per-IP budget is
  // not spent on duplicates and no 429s show up as browser errors.
  const reported = new Set();
  function reportOnce(report) {
    const key = `${report.check} ${report.status ?? report.message}`;
    if (reported.has(key) || reported.size >= MAX_REPORTS_PER_PAGE) return;
    reported.add(key);
    reportClientFailure(report, { fetchImpl });
  }

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
    // Reads fail fast; writes and downloads may legitimately run as long as the
    // Lambda (120s) before the visitor is told it failed.
    const deadlineMs =
      String(fetchOptions.method || "GET").toUpperCase() === "GET" &&
      responseType !== "blob"
        ? timeoutMs
        : Math.max(timeoutMs, WRITE_TIMEOUT_MS);
    const checkPath = new URL(String(url), apiBase || "http://localhost").pathname;
    const what = `load ${checkPath}`;
    // Every shell request has a deadline and a visible failure: a hung API call
    // must reject with a message the surface renders, never spin forever.
    let response;
    try {
      response = await fetchImpl(url, {
        ...fetchOptions,
        headers,
        signal: fetchOptions.signal || AbortSignal.timeout(deadlineMs),
      });
    } catch (cause) {
      if (fetchOptions.signal?.aborted && cause?.name === "AbortError") throw cause;
      const status =
        cause?.name === "TimeoutError" || cause?.name === "AbortError"
          ? "timeout"
          : "network";
      reportOnce({ surface: "app-shell", check: checkPath, status: null, message: status });
      const error = new Error(failureMessage(what, status));
      error.status = status;
      throw error;
    }

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

    if (response.status >= 500) {
      reportOnce({
        surface: "app-shell",
        check: checkPath,
        status: response.status,
        message: String(payload?.error || ""),
      });
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
