import { createSponsorDocPage } from "./surfaces/operations/sponsor-docs.js";

const REQUEST_TIMEOUT_MS = 20000;

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Sponsor document request failed");
    error.status = response.status;
    error.code = data.code || "";
    error.retryAfter = Number(response.headers.get("retry-after")) || Number(data.retryAfterSeconds) || 60;
    throw error;
  }
  return data;
}

const page = createSponsorDocPage({
  documentRef: document,
  request,
  locationRef: location,
  historyRef: history,
});
document.documentElement.dataset.sdocReady = "true";
page.start();
