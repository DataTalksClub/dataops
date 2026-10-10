import { html } from "./shared.js";

export function createSponsorLeads(context) {
  const { api, escapeHtml, humanizeOptionLabel, message, surface } = context;
  let leads = [];
  let leadStatusFilter = "";

  const fail = async (action, label) => {
    try {
      await action();
    } catch (error) {
      message.textContent = `${label}: ${error.message}`;
    }
  };

  function drawLeads() {
    const container = surface.querySelector("[data-crm-leads]");
    if (!leads.length) {
      container.innerHTML = html`<div class="honest-state">
        <strong>No potential leads</strong>
        <p>
          Newsletter sponsor sightings forwarded for review will appear here.
        </p>
      </div>`;
      return;
    }
    container.innerHTML = leads.map((item) => leadCard(item)).join("");
  }

  function leadCard(item) {
    const sponsor = item.sponsor || {};
    const newsletter = item.newsletter || {};
    const link = sponsor.url
      ? html`<a href="${escapeHtml(sponsor.url)}">${escapeHtml(sponsor.url)}</a>`
      : "";
    const source = [link, escapeHtml(newsletter.name || "Unknown newsletter")]
      .filter(Boolean)
      .join(" · ");
    return html`<article class="crm-lead-row">
      <div>
        <strong>${escapeHtml(sponsor.name || "Unnamed sponsor")}</strong
        ><span class="status-label"
          >${escapeHtml(humanizeOptionLabel(item.status))}</span
        >
        <p>${source}${newsletter.subject ? html` · ${escapeHtml(newsletter.subject)}` : ""}</p>
        ${sponsor.blurb ? html`<p>${escapeHtml(sponsor.blurb)}</p>` : ""}
        ${sponsor.context ? html`<p class="muted">${escapeHtml(sponsor.context)}</p>` : ""}
      </div>
      <div class="row-actions">
        ${leadAction(item.id, "triaged", "Triage")}
        ${leadAction(item.id, "converted", "Convert")}
        ${leadAction(item.id, "ignored", "Ignore")}
      </div>
    </article>`;
  }

  function leadAction(id, status, label) {
    return html`<button
      data-lead-status="${status}"
      data-lead-id="${escapeHtml(id)}"
    >
      ${label}</button
    >`;
  }

  async function loadLeads() {
    const container = surface.querySelector("[data-crm-leads]");
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (leadStatusFilter) query.set("status", leadStatusFilter);
      const result = await api(`/leads?${query}`);
      leads = result.items || [];
      drawLeads();
    } catch (error) {
      container.innerHTML = html`<div class="honest-state">
        <strong>Could not load potential leads.</strong>
        <p>
          ${escapeHtml(error.message)}
          <button type="button" data-retry-leads>Retry</button>
        </p>
      </div>`;
    }
  }

  function wireLeadControls() {
    surface
      .querySelector("[data-crm-lead-status]")
      .addEventListener("input", (event) => {
        leadStatusFilter = event.target.value || "";
        fail(loadLeads, "Could not load potential leads");
      });
    surface.querySelector("[data-crm-leads]").onclick = (event) => {
      if (event.target.closest("[data-retry-leads]")) {
        fail(loadLeads, "Could not load potential leads");
        return;
      }
      const transition = event.target.closest("[data-lead-status]");
      if (!transition) return;
      const lead = leads.find((item) => item.id === transition.dataset.leadId);
      if (!lead) return;
      const { leadStatus } = transition.dataset;
      fail(async () => {
        await api(`/leads/${encodeURIComponent(lead.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ version: lead.version, status: leadStatus }),
        });
        await loadLeads();
      }, "Could not update lead");
    };
  }

  return { loadLeads, wireLeadControls };
}
