import { html } from "./shared.js";

export function createSponsorLeads(context) {
  const { api, escapeHtml, humanizeOptionLabel, message, surface, openDialog } = context;
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
        try {
          await api(`/leads/${encodeURIComponent(lead.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ version: lead.version, status: leadStatus }),
          });
        } catch (error) {
          if (leadStatus === "converted" && error.status === 409 && error.payload?.candidates) {
            const dialog = surface.querySelector("[data-convert-dialog]");
            const form = dialog.querySelector("form");
            form.elements.leadId.value = lead.id;
            form.elements.version.value = String(lead.version);
            form.elements.organizationId.innerHTML = (error.payload.candidates || [])
              .map(
                (item) =>
                  html`<option value="${escapeHtml(item.id)}">
                    ${escapeHtml(item.displayName)}${item.domain ? html` · ${escapeHtml(item.domain)}` : ""}
                  </option>`,
              )
              .join("");
            if (openDialog) openDialog(dialog);
            else dialog.showModal();
            return;
          }
          throw error;
        }
        await loadLeads();
      }, "Could not update lead");
    };
    const convert = async (body) => {
      await api(`/leads/${encodeURIComponent(body.leadId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: Number(body.version),
          status: "converted",
          organizationId: body.organizationId || undefined,
          createNew: body.createNew === true,
        }),
      });
      surface.querySelector("[data-convert-dialog]").close();
      await loadLeads();
    };
    surface.querySelector("[data-convert-existing]")?.addEventListener("click", (event) => {
      event.preventDefault();
      const form = surface.querySelector("[data-convert-dialog] form");
      fail(async () => {
        await convert({
          leadId: form.elements.leadId.value,
          version: form.elements.version.value,
          organizationId: form.elements.organizationId.value,
        });
      }, "Could not convert lead");
    });
    surface.querySelector("[data-convert-new]")?.addEventListener("click", (event) => {
      event.preventDefault();
      const form = surface.querySelector("[data-convert-dialog] form");
      fail(async () => {
        await convert({
          leadId: form.elements.leadId.value,
          version: form.elements.version.value,
          createNew: true,
        });
      }, "Could not convert lead");
    });
  }

  return { loadLeads, wireLeadControls };
}
