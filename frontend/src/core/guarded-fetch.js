// Shared rule: a failed or timed-out request must show the visitor what failed
// and what to do, and must be reported to the server so the team notices
// without anyone having to tell us. Expected outcomes (4xx) are not reported.

export const REQUEST_TIMEOUT_MS = 20000;

export function reportClientFailure(report, { fetchImpl = globalThis.fetch, locationRef = globalThis.location } = {}) {
  try {
    const result = fetchImpl("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ ...report, page: locationRef?.pathname || "" }),
    });
    result?.catch?.(() => {});
  } catch {
    // Reporting is best effort; the visitor-facing error is already shown.
  }
}

export function failureMessage(what, status) {
  const cause = status === "timeout"
    ? "it took too long to respond"
    : status === "network"
      ? "the connection failed"
      : `the server returned an error (${status})`;
  return `Could not ${what}: ${cause}. Reload the page to try again. The DataTalks.Club team has been notified.`;
}

/**
 * fetch + JSON with a timeout. Resolves to the parsed body, or throws an Error
 * whose `status` is the HTTP status, "timeout" or "network". Timeouts, network
 * failures and 5xx are reported to the server and carry a ready-to-show message.
 */
export async function guardedFetchJson(path, options = {}, { surface, check, what, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch, locationRef } = {}) {
  let response;
  try {
    response = await fetchImpl(path, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    const status = cause?.name === "TimeoutError" || cause?.name === "AbortError" ? "timeout" : "network";
    const error = new Error(failureMessage(what, status));
    error.status = status;
    reportClientFailure({ surface, check, status: null, message: status }, { fetchImpl, locationRef });
    throw error;
  }
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (response.status >= 500) {
    const error = new Error(failureMessage(what, response.status));
    error.status = response.status;
    reportClientFailure({ surface, check, status: response.status, message: String(data.error || "") }, { fetchImpl, locationRef });
    throw error;
  }
  return { response, data };
}
