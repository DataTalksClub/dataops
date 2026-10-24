import { html } from "./shared.js";

export function createFollowupsController({ surface, api, escapeHtml }) {
  async function loadFollowups(filter = "all") {
    const container = surface.querySelector("[data-crm-followups-content]");
    if (!container) return;
    container.innerHTML = "<p>Loading follow-ups…</p>";
    try {
      const query = new URLSearchParams();
      if (filter === "due") query.set("due", "true");
      if (filter === "overdue") query.set("overdue", "true");
      const res = await api(`/followups?${query.toString()}`);
      const items = Array.isArray(res?.items) ? res.items : [];
      if (!items.length) {
        container.innerHTML = '<p class="crm-empty">No open follow-up tasks.</p>';
        return;
      }
      const rows = items.map((item) => {
        const task = item.task;
        const subjectHref = item.subjectType === "sponsor-company"
          ? `/sponsors/companies/${encodeURIComponent(item.subjectId)}`
          : item.subjectType === "sponsor-person"
            ? `/sponsors/people/${encodeURIComponent(item.subjectId)}`
            : `/sponsors/deals/${encodeURIComponent(item.subjectId)}`;
        const dueClass = item.isOverdue
          ? "status-label status-label--overdue"
          : item.isDue
            ? "status-label status-label--due"
            : "";
        return html`<tr>
          <td><span class="${dueClass}">${escapeHtml(task.date || "No date")}</span></td>
          <td><span class="status-label">${escapeHtml(task.status)}</span></td>
          <td><span class="status-label">${escapeHtml(item.subjectType.replace("sponsor-", ""))}</span></td>
          <td><a href="${escapeHtml(subjectHref)}" data-open-${item.subjectType.replace("sponsor-", "")}="${escapeHtml(item.subjectId)}">${escapeHtml(item.subjectName)}</a></td>
          <td>${escapeHtml(task.description || task.title)}</td>
          <td><a href="/?taskId=${encodeURIComponent(task.id)}" class="button button--secondary button--sm">Open task</a></td>
        </tr>`;
      }).join("");
      container.innerHTML = html`<table class="crm-table">
        <thead>
          <tr>
            <th>Due</th>
            <th>Status</th>
            <th>Subject Type</th>
            <th>Subject</th>
            <th>Description</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>`;
    } catch (err) {
      container.innerHTML = `<p class="crm-error">Failed to load follow-ups: ${escapeHtml(err.message)}</p>`;
    }
  }

  surface.querySelector("[data-crm-followups-filter]")?.addEventListener("change", (e) => {
    loadFollowups(e.target.value);
  });

  return {
    loadFollowups,
  };
}
