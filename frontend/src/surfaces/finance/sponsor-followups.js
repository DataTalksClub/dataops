import { escapeHtml as escape } from "../../core/html.js";
import { html } from "./shared.js";

export function followupsTablesMarkup({ items = [], records = [] } = {}) {
  const taskRows = items.map((item) => {
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
      <td><span class="${dueClass}">${escape(task.date || "No date")}</span></td>
      <td><span class="status-label">${escape(task.status)}</span></td>
      <td><span class="status-label">${escape(item.subjectType.replace("sponsor-", ""))}</span></td>
      <td><a href="${escape(subjectHref)}" data-open-${item.subjectType.replace("sponsor-", "")}="${escape(item.subjectId)}">${escape(item.subjectName)}</a></td>
      <td>${escape(task.description || task.title)}</td>
      <td><a href="/?taskId=${encodeURIComponent(task.id)}" class="button button--secondary button--sm">Open task</a></td>
    </tr>`;
  }).join("");
  const recordRows = records.map((record) => {
    const subjectHref = record.kind === "company"
      ? `/sponsors/companies/${encodeURIComponent(record.id)}`
      : `/sponsors/people/${encodeURIComponent(record.id)}`;
    const dueClass = record.isOverdue
      ? "status-label status-label--overdue"
      : record.isDue
        ? "status-label status-label--due"
        : "";
    return html`<tr>
      <td><span class="${dueClass}">${escape(record.follow_up_at || "No date")}</span></td>
      <td><span class="status-label">${escape(record.follow_up_status || "open")}</span></td>
      <td><span class="status-label">${escape(record.kind)}</span></td>
      <td><a href="${escape(subjectHref)}" data-open-${record.kind === "company" ? "company" : "person"}="${escape(record.id)}">${escape(record.name)}</a></td>
      <td>${escape(record.follow_up_note || "")}</td>
      <td><a href="${escape(subjectHref)}" class="button button--secondary button--sm">Open record</a></td>
    </tr>`;
  }).join("");
  if (!taskRows && !recordRows) return '<p class="crm-empty">No open follow-ups.</p>';
  return html`${recordRows ? html`<h4>Contact and company follow-ups</h4>
    <table class="crm-table">
      <thead>
        <tr>
          <th>Due</th>
          <th>Status</th>
          <th>Kind</th>
          <th>Record</th>
          <th>Note</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${recordRows}
      </tbody>
    </table>` : ""}
    ${taskRows ? html`<h4>Follow-up tasks</h4>
    <table class="crm-table">
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
        ${taskRows}
      </tbody>
    </table>` : ""}`;
}

export function createFollowupsController({ surface, api }) {
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
      const records = Array.isArray(res?.records) ? res.records : [];
      container.innerHTML = followupsTablesMarkup({ items, records });
    } catch (err) {
      container.innerHTML = `<p class="crm-error">Failed to load follow-ups: ${escape(err.message)}</p>`;
    }
  }

  surface.querySelector("[data-crm-followups-filter]")?.addEventListener("change", (e) => {
    loadFollowups(e.target.value);
  });

  return {
    loadFollowups,
  };
}
