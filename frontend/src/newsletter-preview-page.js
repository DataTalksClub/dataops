import { guardedFetchJson } from "./core/guarded-fetch.js";
import { createNewsletterEmailReview } from "./surfaces/operations/newsletter-email-review.js";

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
    { surface: "newsletter-preview", check: `${options.method || "GET"} /api/newsletter-issues`, what: "load the email" },
  );
  if (!response.ok) {
    const error = new Error(data.error || "Newsletter preview request failed");
    error.status = response.status;
    error.payload = data;
    error.code = data.code || "";
    error.retryAfter = Number(response.headers.get("retry-after")) || Number(data.retryAfterSeconds) || 60;
    throw error;
  }
  return data;
}

const page = createNewsletterEmailReview({
  documentRef: document,
  request,
  locationRef: location,
});
document.documentElement.dataset.pageReady = "true";
page.start();
