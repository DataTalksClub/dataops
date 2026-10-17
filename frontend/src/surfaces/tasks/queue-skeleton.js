export function renderQueueUnavailableState(retryWork) {
  const wrap = document.createElement("div");
  wrap.className = "ops-queue-unavailable";
  const empty = document.createElement("p");
  empty.className = "ops-empty";
  empty.dataset.state = "unavailable";
  empty.textContent = "Live work data unavailable.";
  wrap.append(empty);
  if (typeof retryWork === "function") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "quiet-button ops-queue-retry";
    retry.textContent = "Retry loading tasks";
    retry.addEventListener("click", () => retryWork());
    wrap.append(retry);
  }
  return wrap;
}

export function renderQueueSkeleton() {
  const skeleton = document.createElement("div");
  skeleton.className = "ops-queue-skeleton";
  skeleton.setAttribute("role", "status");
  skeleton.setAttribute("aria-label", "Loading work queue");
  skeleton.setAttribute("aria-busy", "true");

  for (let i = 0; i < 6; i++) {
    const row = document.createElement("div");
    row.className = "ops-queue-skeleton-row dk-skeleton-row";
    row.setAttribute("aria-hidden", "true");

    const check = document.createElement("div");
    check.className = "ops-queue-skeleton-checkbox dk-skeleton";

    const body = document.createElement("div");
    body.className = "ops-queue-skeleton-body";

    const title = document.createElement("div");
    title.className = "ops-queue-skeleton-title dk-skeleton";

    const meta = document.createElement("div");
    meta.className = "ops-queue-skeleton-meta dk-skeleton";

    body.append(title, meta);
    row.append(check, body);
    skeleton.append(row);
  }
  return skeleton;
}
