import { guardedFetchJson } from "./core/guarded-fetch.js";
import { createSponsorDocPage } from "./surfaces/operations/sponsor-docs.js";

async function request(path, options = {}) {
  const { response, data } = await guardedFetchJson(
    path,
    {
      ...options,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    },
    { surface: "sponsor-doc", check: `${options.method || "GET"} /api/sponsor-docs`, what: "load the document" },
  );
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
document.documentElement.dataset.pageReady = "true";
page.start();
