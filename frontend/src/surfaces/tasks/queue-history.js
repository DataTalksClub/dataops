import { fetchAllWorkPages, tasksFromWorkPayload } from "../../core/workspace.js";

const HISTORY_VISIBLE_LIMIT = 12;

export function createQueueHistory({ request, workApiUrl, openTaskPanel, cleanTaskTitle, queueDueLabel }) {
  let historyOpen = false;
  let historyTasks = [];
  let historyLoaded = false;
  let historyLoading = false;
  let historyError = "";
  let historyLimit = HISTORY_VISIBLE_LIMIT;
  function renderQueueHistory(doneTasks, today, rerender) {
    const details = document.createElement("details");
    details.className = "ops-queue-history";
    details.open = historyOpen;
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = "Completed history";
    const count = document.createElement("span");
    count.className = "dk-mono";
    count.dataset.queueCount = historyLoaded ? "loaded" : "known";
    count.textContent = historyLoaded ? String(doneTasks.length) : "View";
    summary.append(label, count);
    details.append(summary);
    details.addEventListener("toggle", () => {
      historyOpen = details.open;
      if (historyOpen && !historyLoaded && !historyLoading && !historyError) loadHistory();
    });
    async function loadHistory() {
      historyLoading = true;
      historyError = "";
      rerender();
      try {
        const rawTasks = await fetchAllWorkPages({ request, workApiUrl, path: "/api/tasks?status=done" });
        historyTasks = tasksFromWorkPayload({ tasks: rawTasks });
        historyLoaded = true;
      } catch (err) {
        historyError = err?.message || "Request failed";
      } finally {
        historyLoading = false;
        rerender();
      }
    }
    const rows = document.createElement("div");
    rows.className = "ops-queue-history-list";
    const note = document.createElement("p");
    note.className = "ops-empty";
    note.setAttribute("role", historyError ? "alert" : "status");
    note.textContent = historyLoading ? "Loading completed tasks…"
      : historyError ? `Could not load completed history: ${historyError}`
      : historyLoaded && !doneTasks.length ? "No completed tasks match these filters."
      : "Completed tasks stay here after they leave your active queue.";
    rows.append(note);
    if (historyError) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button";
      retry.textContent = "Retry completed history";
      retry.addEventListener("click", loadHistory);
      rows.append(retry);
    }
    const sorted = doneTasks.slice().sort((left, right) =>
      String(right.completedAt || right.updatedAt || right.date || "").localeCompare(
        String(left.completedAt || left.updatedAt || left.date || "")));
    for (const task of sorted.slice(0, historyLimit)) rows.append(renderQueueHistoryRow(task, today));
    if (sorted.length > historyLimit) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "quiet-button";
      more.textContent = `Show more completed tasks (${sorted.length - historyLimit})`;
      more.addEventListener("click", () => { historyLimit += HISTORY_VISIBLE_LIMIT; rerender(); });
      rows.append(more);
    }
    details.append(rows);
    return details;
  }

  function renderQueueHistoryRow(task, today) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-history-row";
    button.dataset.taskId = task.id;
    button.setAttribute("aria-label", `Open task ${cleanTaskTitle(task)}`);
    button.addEventListener("click", () => openTaskPanel(task.id));
    const title = document.createElement("strong");
    title.textContent = cleanTaskTitle(task);
    const meta = document.createElement("span");
    const completed = String(task.completedAt || task.date || "").slice(0, 10);
    meta.textContent = completed
      ? `Done · ${queueDueLabel(completed, today)}`
      : "Done";
    button.append(title, meta);
    return button;
  }

  return {
    render: renderQueueHistory,
    tasks: () => historyTasks,
    invalidate: () => { historyLoaded = false; },
    remove: (id) => { historyTasks = historyTasks.filter((task) => task.id !== id); },
  };
}
