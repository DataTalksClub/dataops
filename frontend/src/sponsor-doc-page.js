import { guardedFetchJson } from "./core/guarded-fetch.js";
import { createSponsorDocPage } from "./surfaces/operations/sponsor-docs.js";

async function request(path, options = {}) {
  const isFormData = typeof FormData === "function" && options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isFormData && !headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = "application/json";
  }
  const { response, data } = await guardedFetchJson(
    path,
    {
      ...options,
      cache: "no-store",
      headers,
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
