import { createCollectionLoader } from "../../core/collection-loader.js";
import { html } from "./shared.js";

export function createMailingExportsSurface(context) {
  const { documentList, escapeHtml, request, todayIsoDate, workApiUrl } =
    context;

  async function renderMailingExportsSurface() {
    const surface = document.createElement("section");
    surface.className = "mailing-exports-surface";
    surface.innerHTML = html`<header>
        <div>
          <h2>Mailing-list exports</h2>
          <p>
            Private account-wide audiences archives. Mailchimp permits one
            export at a time and one completed export per 24 hours.
          </p>
        </div>
        <button
          type="button"
          class="quiet-button"
          aria-label="Refresh mailing export data"
          data-refresh
        >Refresh</button>
      </header>
      <p role="status" aria-live="polite">Loading export configurations…</p>
      <div data-configs></div>
      <section aria-labelledby="mailing-history-heading">
        <h3 id="mailing-history-heading">Run history</h3>
        <div data-history></div>
      </section>`;
    documentList.replaceChildren(surface);
    const status = surface.querySelector('[role="status"]');
    const configsRoot = surface.querySelector("[data-configs]");
    const historyRoot = surface.querySelector("[data-history]");
    const api = (path = "", options = {}) =>
      request(workApiUrl(`/api/mailing-exports${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    let configs = [];
    let latestConfigs = null;
    let configsGeneration = 0;
    const exportsLoader = createCollectionLoader({
      request: async (url) => {
        const requestGeneration = configsGeneration;
        const result = await api(String(url));
        if (!Array.isArray(result.configs)) {
          throw new Error("Mailing export response was invalid");
        }
        if (requestGeneration === configsGeneration) {
          latestConfigs = result.configs;
        }
        return result;
      },
      createUrl: ({ cursor, limit }) => {
        const query = new URLSearchParams({ limit: String(limit) });
        if (cursor) query.set("cursor", cursor);
        return `?${query}`;
      },
      collection: "exports",
    });
    let exportState = exportsLoader.getSnapshot();
    const actionCopy = {
      wait: "Wait for the provider, then refresh or advance this run.",
      retry: "Retry this run with the same key.",
      "fix-authorization": "Fix provider authorization, then retry.",
      "fix-storage": "Fix private storage access, then retry.",
      "fix-task-link":
        "Fix the recurring-task link; the archive remains stored.",
      download: "Archive ready for a private five-minute download.",
    };
    const formatTime = (value) =>
      value
        ? new Date(value).toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "Not yet";
    const actionRunKey = (run) =>
      run &&
      ["requested", "pending", "failed"].includes(run.status) &&
      run.runKey
        ? run.runKey
        : todayIsoDate();

    function historyMarkup(runs) {
      if (!runs.length) {
        if (
          exportState.loading ||
          exportState.loadingMore ||
          exportState.moreAvailable ||
          exportState.failed
        ) {
          return "";
        }
        return html`<div class="honest-state" data-export-state="empty">
            <strong>No export runs yet</strong>
            <p>Start an enabled configuration to create durable history.</p>
          </div>`;
      }
      return runs
        .map(
          (run) =>
            html`<article class="mailing-export-history">
                <strong
                  >${escapeHtml(run.account)} · ${escapeHtml(run.status)}</strong
                ><span
                  >${escapeHtml(run.scopeLabel)} · requested
                  ${escapeHtml(formatTime(run.requestedAt))}${
                    run.completedAt
                      ? ` · completed ${escapeHtml(formatTime(run.completedAt))}`
                      : ""
                  }</span
                >
              </article>`,
        )
        .join("");
    }

    function runCard(config, run) {
      const state = run?.status || "empty";
      const next = run?.nextAction
        ? actionCopy[run.nextAction]
        : "Start the first account-wide audiences export.";
      return html`<article
        class="mailing-export-card"
        data-export-state="${escapeHtml(state)}"
      >
        <header>
          <div>
            <h3>${escapeHtml(config.account)}</h3>
            <p>
              ${escapeHtml(config.scopeLabel)} · ${escapeHtml(config.provider)}
            </p>
          </div>
          <span class="mailing-export-status">${escapeHtml(state)}</span>
        </header>
        <dl>
          <div>
            <dt>Requested</dt>
            <dd>${formatTime(run?.requestedAt)}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>${formatTime(run?.completedAt)}</dd>
          </div>
          <div>
            <dt>Recurring task</dt>
            <dd>
              ${escapeHtml(run?.taskId ? `${run.taskLinkStatus || "pending"} · ${run.taskId}` : "Not configured")}
            </dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>${escapeHtml(run?.artifactId || "Not created")}</dd>
          </div>
        </dl>
        ${run?.errorMessage ? html`<p class="mailing-export-error" role="alert"><strong>${escapeHtml(run.errorCode)}</strong> · ${escapeHtml(run.errorMessage)}</p>` : ""}
        <p>
          ${escapeHtml(next)}${run?.retryAfter ? ` Earliest retry: ${escapeHtml(formatTime(run.retryAfter))}.` : ""}
        </p>
        <div class="mailing-export-actions">
          <button
            type="button"
            class="primary-button"
            data-run="${escapeHtml(config.id)}"
            data-run-key="${escapeHtml(actionRunKey(run))}"
          >
            ${run && run.status !== "completed" ? "Advance / retry" : "Start daily export"}</button
          >${run?.status === "completed" && run.artifactId
            ? html`<button
                type="button"
                class="quiet-button"
                data-download="${escapeHtml(run.artifactId)}"
              >Download ZIP</button>`
            : ""}
        </div>
      </article>`;
    }

    async function load() {
      const refreshButton = surface.querySelector("[data-refresh]");
      refreshButton.disabled = true;
      refreshButton.setAttribute("aria-busy", "true");
      status.textContent = "Loading export configurations…";
      configsGeneration += 1;
      latestConfigs = null;
      try {
        const snapshot = await exportsLoader.load();
        configs = latestConfigs || [];
        exportState = snapshot;
        drawExports();
      } catch (error) {
        status.textContent = `Could not load mailing-list exports: ${error.message}`;
        if (!exportState.loaded) drawExports();
      } finally {
        refreshButton.disabled = false;
        refreshButton.removeAttribute("aria-busy");
      }
    }

    function sortedRuns() {
      return [...exportState.items].sort(
        (left, right) =>
          right.requestedAt.localeCompare(left.requestedAt) ||
          left.id.localeCompare(right.id),
      );
    }

    function continuationMarkup() {
      if (exportState.loading || exportState.loadingMore) {
        return html`<p class="honest-state" role="status">
            ${
              exportState.loadingMore
                ? "Loading more export history…"
                : "Loading export history…"
            }
          </p>`;
      }
      if (exportState.failed && exportState.moreAvailable) {
        return html`<div class="honest-state">
            <strong role="alert"
              >More export history is available, but loading failed:
              ${escapeHtml(exportState.error)}</strong
            ><button type="button" class="quiet-button" data-load-history>
              Retry next page</button
            >
          </div>`;
      }
      if (exportState.moreAvailable) {
        return html`<div class="honest-state">
            <span>More export history is available.</span>
            <button type="button" class="quiet-button" data-load-history>
              Load more</button
            >
          </div>`;
      }
      if (exportState.failed) {
        return html`<div class="honest-state">
            <strong role="alert">Export history is unavailable:
              ${escapeHtml(exportState.error)}</strong
            ><button type="button" class="quiet-button" data-load-history-retry>
              Retry</button
            >
          </div>`;
      }
      return html`<p class="honest-state">All export history loaded.</p>`;
    }

    function drawConfigs() {
      const runs = sortedRuns();
      if (exportState.failed && latestConfigs === null) {
        configsRoot.innerHTML = html`<div
          class="honest-state"
          data-export-state="failure"
        >
          <strong>Exports unavailable</strong>
          <p>${escapeHtml(exportState.error)} Retry with Refresh.</p>
        </div>`;
        return;
      }
      if (!configs.length) {
        configsRoot.innerHTML = html`<div
          class="honest-state"
          data-export-state="no-config"
        >
          <strong>No export configurations</strong>
          <p>
            Add an enabled provider configuration through the approved deploy
            mechanism. No secret values belong in the portal.
          </p>
        </div>`;
        return;
      }
      configsRoot.innerHTML = configs
        .map((config) =>
          runCard(
            config,
            runs.find((run) => run.configId === config.id),
          ),
        )
        .join("");
    }

    function drawExports() {
      const runs = sortedRuns();
      drawConfigs();
      historyRoot.innerHTML =
        `${historyMarkup(runs)}${continuationMarkup()}`;
      status.textContent = exportState.failed && latestConfigs === null
        ? `Could not load mailing-list exports: ${exportState.error}`
        : configs.length
          ? `${
              configs.length
            } export configuration${configs.length === 1 ? "" : "s"} loaded.${
              exportState.failed
                ? ` Export history is incomplete: ${exportState.error}`
                : exportState.moreAvailable
                  ? " More export history is available."
                  : " All export history loaded."
            }`
          : "No export configurations are enabled.";
    }

    surface.querySelector("[data-refresh]").addEventListener("click", load);
    historyRoot.addEventListener("click", (event) => {
      if (event.target.closest("[data-load-history]")) {
        void (async () => {
          const pendingPage = exportsLoader.loadMore();
          exportState = exportsLoader.getSnapshot();
          drawExports();
          exportState = await pendingPage;
          drawExports();
        })();
        return;
      }
      if (event.target.closest("[data-load-history-retry]")) {
        void load();
      }
    });
    configsRoot.addEventListener("click", async (event) => {
      const run = event.target.closest("[data-run]");
      const download = event.target.closest("[data-download]");
      if (run) {
        run.disabled = true;
        run.setAttribute("aria-busy", "true");
        status.textContent = "Requesting or advancing the durable export run…";
        try {
          await api("/run", {
            method: "POST",
            body: JSON.stringify({
              configId: run.dataset.run,
              runKey: run.dataset.runKey,
            }),
          });
          await load();
        } catch (error) {
          status.textContent = `Could not advance export: ${error.message}`;
          run.disabled = false;
          run.removeAttribute("aria-busy");
        }
      }
      if (download) {
        download.disabled = true;
        download.setAttribute("aria-busy", "true");
        status.textContent = "Preparing a private five-minute download…";
        try {
          const result = await request(
            workApiUrl(
              `/api/artifacts/${encodeURIComponent(download.dataset.download)}/download`,
            ),
          );
          const link = document.createElement("a");
          link.href = result.downloadUrl;
          link.target = "_blank";
          link.rel = "noopener";
          link.click();
          status.textContent =
            "Private download prepared. The link expires in five minutes.";
        } catch (error) {
          status.textContent = `Could not prepare download: ${error.message}`;
        } finally {
          download.disabled = false;
          download.removeAttribute("aria-busy");
        }
      }
    });
    await load();
  }

  return { renderMailingExportsSurface };
}
