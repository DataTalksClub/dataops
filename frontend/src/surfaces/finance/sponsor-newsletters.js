import { html } from "./shared.js";

const HEALTH_LABELS = {
  overdue: "Overdue",
  missing: "No issues yet",
  pending: "Signup pending",
  waiting: "Waiting for first issue",
  current: "Current",
  paused: "Paused",
  unsubscribed: "Unsubscribed",
};

export function filterNewsletters(items, healthFilter) {
  if (!healthFilter) return items;
  if (healthFilter === "attention") {
    return items.filter((item) => ["overdue", "missing", "pending"].includes(item.health));
  }
  return items.filter((item) => item.health === healthFilter);
}

export function createSponsorNewsletters(context) {
  const { api, escapeHtml, humanizeOptionLabel, message, surface, openDialog } = context;
  let newsletters = [];
  let healthFilter = "";

  const fail = async (action, label) => {
    try {
      await action();
    } catch (error) {
      message.hidden = false;
      message.textContent = `${label}: ${error.message}`;
    }
  };

  function shown() {
    return filterNewsletters(newsletters, healthFilter);
  }

  function drawNewsletters() {
    const container = surface.querySelector("[data-crm-newsletters]");
    const rows = shown();
    if (!newsletters.length) {
      container.innerHTML = html`<div class="honest-state">
        <strong>No newsletters yet</strong>
        <p>
          Track the titles that arrive at newsletter@dtcdev.click, then check
          this list when a send cadence goes quiet.
        </p>
      </div>`;
      return;
    }
    if (!rows.length) {
      container.innerHTML = html`<div class="honest-state">
        <strong>No newsletters match this filter</strong>
        <p>Clear the health filter to see the full catalog.</p>
      </div>`;
      return;
    }
    container.innerHTML = rows.map((item) => newsletterCard(item)).join("");
  }

  function newsletterCard(item) {
    const senders = Array.isArray(item.senders) ? item.senders.join(", ") : "";
    const received = item.lastReceivedAt
      ? `Last issue ${String(item.lastReceivedAt).slice(0, 10)}`
      : "Never received";
    const link = item.url
      ? html`<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>`
      : "";
    return html`<article class="crm-lead-row crm-newsletter-row">
      <div class="crm-lead-body">
        <div class="crm-lead-header">
          <strong class="crm-lead-name">${escapeHtml(item.name || "Untitled")}</strong>
          <span class="status-label" data-health="${escapeHtml(item.health || "")}"
            >${escapeHtml(HEALTH_LABELS[item.health] || humanizeOptionLabel(item.health))}</span
          >
        </div>
        <p class="crm-lead-source">
          ${escapeHtml(item.cadence || "")}${item.cadence ? " · " : ""}${escapeHtml(received)}
          ${link ? html` · ${link}` : ""}
        </p>
        ${senders ? html`<p class="crm-lead-context muted">${escapeHtml(senders)}</p>` : ""}
        ${item.lastSubject ? html`<p class="crm-lead-blurb">${escapeHtml(item.lastSubject)}</p>` : ""}
      </div>
      <div class="row-actions crm-lead-actions">
        <button type="button" data-edit-newsletter="${escapeHtml(item.id)}">Edit</button>
      </div>
    </article>`;
  }

  function fillForm(item) {
    const form = surface.querySelector("[data-newsletter-dialog] form");
    form.elements.newsletterId.value = item?.id || "";
    form.elements.version.value = item ? String(item.version) : "";
    form.elements.name.value = item?.name || "";
    form.elements.url.value = item?.url || "";
    form.elements.senders.value = Array.isArray(item?.senders) ? item.senders.join(", ") : "";
    form.elements.cadence.value = item?.cadence || "Weekly";
    form.elements.expectedIntervalDays.value = item?.expectedIntervalDays || 7;
    form.elements.subscriptionStatus.value = item?.subscriptionStatus || "subscribed";
    form.elements.notes.value = item?.notes || "";
    form.querySelector("[role='alert']").textContent = "";
  }

  function payload(form) {
    const senders = String(form.elements.senders.value || "")
      .split(/[,;\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      senders,
      cadence: form.elements.cadence.value.trim(),
      expectedIntervalDays: Number(form.elements.expectedIntervalDays.value),
      subscriptionStatus: form.elements.subscriptionStatus.value,
      notes: form.elements.notes.value.trim(),
    };
  }

  async function loadNewsletters() {
    const container = surface.querySelector("[data-crm-newsletters]");
    try {
      const result = await api("/newsletters?limit=100");
      newsletters = result.items || [];
      drawNewsletters();
    } catch (error) {
      container.innerHTML = html`<div class="honest-state">
        <strong>Could not load newsletters.</strong>
        <p>
          ${escapeHtml(error.message)}
          <button type="button" data-retry-newsletters>Retry</button>
        </p>
      </div>`;
    }
  }

  function wireNewsletterControls() {
    surface.querySelector("[data-crm-newsletter-health]").addEventListener("input", (event) => {
      healthFilter = event.target.value || "";
      drawNewsletters();
    });
    surface.querySelector("[data-add-newsletter]").addEventListener("click", () => {
      fillForm(null);
      openDialog(surface.querySelector("[data-newsletter-dialog]"));
    });
    surface.querySelector("[data-crm-newsletters]").addEventListener("click", (event) => {
      if (event.target.closest("[data-retry-newsletters]")) {
        fail(loadNewsletters, "Could not load newsletters");
        return;
      }
      const edit = event.target.closest("[data-edit-newsletter]");
      if (!edit) return;
      const item = newsletters.find((row) => row.id === edit.dataset.editNewsletter);
      if (!item) return;
      fillForm(item);
      openDialog(surface.querySelector("[data-newsletter-dialog]"));
    });
    surface.querySelector("[data-newsletter-save]").addEventListener("click", (event) => {
      event.preventDefault();
      const form = surface.querySelector("[data-newsletter-dialog] form");
      const alert = form.querySelector("[role='alert']");
      fail(async () => {
        try {
          const body = payload(form);
          const id = form.elements.newsletterId.value;
          if (id) {
            await api(`/newsletters/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                ...body,
                version: Number(form.elements.version.value),
              }),
            });
          } else {
            await api("/newsletters", { method: "POST", body: JSON.stringify(body) });
          }
          surface.querySelector("[data-newsletter-dialog]").close();
          await loadNewsletters();
        } catch (error) {
          alert.textContent = error.message;
          throw error;
        }
      }, "Could not save newsletter");
    });
  }

  return { loadNewsletters, wireNewsletterControls };
}
