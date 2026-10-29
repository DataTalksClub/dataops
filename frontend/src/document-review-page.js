import { createDocumentReviewPanel } from "./surfaces/document-reviews.js";
const root = document.getElementById("document-review-root");
const id = decodeURIComponent(
  location.pathname.split("/").filter(Boolean).at(-1),
);
const key = `document-review:${id}`;
let token = new URLSearchParams(location.search).get("review") || "";
try {
  if (token) sessionStorage.setItem(key, token);
  else token = sessionStorage.getItem(key) || "";
} catch {}
// Keep the bearer secret out of the address bar and subsequent referrers.
history.replaceState(null, "", location.pathname);
async function request(path, options = {}) {
  const response = await fetch(`/work${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-document-review-token": token,
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Document review request failed");
  return data;
}
try {
  if (!token)
    throw new Error(
      "Open the review link supplied by your DataTalks.Club contact.",
    );
  const { document: value, reviewer } = await request(
    `/api/documents/${encodeURIComponent(id)}/review`,
  );
  const title = document.createElement("h1");
  title.textContent = value.title;
  const identity = document.createElement("p");
  identity.textContent = `Reviewing as ${reviewer.name}`;
  const content = document.createElement("pre");
  content.textContent = value.content;
  root.replaceChildren(
    title,
    identity,
    content,
    createDocumentReviewPanel({
      documentRef: document,
      request,
      documentId: id,
      reviewToken: token,
      staff: false,
    }),
  );
} catch (error) {
  root.textContent = error.message;
}
