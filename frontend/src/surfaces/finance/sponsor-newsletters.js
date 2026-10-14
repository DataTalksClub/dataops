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

const ISSUE_SOURCES = { inbox: "Inbox", "public-archive": "Archive" };

function shortDate(value) {
  const iso = String(value || "").slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value || "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

/** One line for a newsletter row: what arrived and which sponsors it carried. */
export function newsletterIssueSummary(stats) {
  if (!stats?.issueCount) return "No issues recorded yet";
  const issues = `${stats.issueCount} ${stats.issueCount === 1 ? "issue" : "issues"} · last ${shortDate(stats.lastIssueAt)}`;
  if (!stats.sponsors?.length) return `${issues} · no sponsors found`;
  const names = stats.sponsors.slice(0, 4).map((item) => item.name).join(", ");
  const more = stats.sponsors.length > 4 ? ` +${stats.sponsors.length - 4} more` : "";
  return `${issues} · ${stats.sponsors.length} ${stats.sponsors.length === 1 ? "sponsor" : "sponsors"}: ${names}${more}`;
}

export function createSponsorNewsletters(context) {
  const {
    api,
    escapeHtml,
    humanizeOptionLabel,
    message,
    surface,
    openDialog,
    newsletterPath,
    recordPath,
    listPath,
    navigate,
    renderEntityLoadState,
  } = context;
  let newsletters = [];
  let healthFilter = "";
  let openId = null;

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
    const href = newsletterPath(item.id);
    const received = item.lastReceivedAt
      ? `Last issue ${String(item.lastReceivedAt).slice(0, 10)}`
      : "Never received";
    const link = item.url
      ? html`<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>`
      : "";
    return html`<article class="crm-lead-row crm-newsletter-row">
      <div class="crm-lead-body">
        <div class="crm-lead-header">
          <a class="crm-lead-name crm-newsletter-link" href="${escapeHtml(href)}" data-open-newsletter="${escapeHtml(item.id)}"
            >${escapeHtml(item.name || "Untitled")}</a
          >
          <span class="status-label" data-health="${escapeHtml(item.health || "")}"
            >${escapeHtml(HEALTH_LABELS[item.health] || humanizeOptionLabel(item.health))}</span
          >
        </div>
        <p class="crm-lead-source">
          ${escapeHtml(item.cadence || "")}${item.cadence ? " · " : ""}${escapeHtml(received)}
          ${link ? html` · ${link}` : ""}
        </p>
        <p class="crm-newsletter-issues" data-newsletter-issues>${escapeHtml(newsletterIssueSummary(item.issues))}</p>
        ${senders ? html`<p class="crm-lead-context muted">${escapeHtml(senders)}</p>` : ""}
        ${item.lastSubject ? html`<p class="crm-lead-blurb">${escapeHtml(item.lastSubject)}</p>` : ""}
      </div>
      <div class="row-actions crm-lead-actions">
        <button type="button" data-edit-newsletter="${escapeHtml(item.id)}">Edit</button>
      </div>
    </article>`;
  }

  function sponsorChip(sponsor) {
    const status = html`<span class="status-label" data-status="${escapeHtml(sponsor.status || "")}"
      >${escapeHtml(humanizeOptionLabel(sponsor.status || "new"))}</span
    >`;
    const company = sponsor.organizationId
      ? html` <a href="${escapeHtml(recordPath("company", sponsor.organizationId))}" data-open-route>Company</a>`
      : "";
    return html`<li class="crm-issue-sponsor">
      <a href="${escapeHtml(recordPath("lead", sponsor.leadId))}" data-open-route>${escapeHtml(sponsor.name || "Unnamed sponsor")}</a>
      ${status}${company}
    </li>`;
  }

  function issueRow(issue) {
    const title = issue.url
      ? html`<a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${escapeHtml(issue.title)}</a>`
      : escapeHtml(issue.title);
    const sponsors = issue.sponsors.length
      ? html`<ul class="crm-issue-sponsors">${issue.sponsors.map(sponsorChip).join("")}</ul>`
      : html`<p class="crm-issue-none muted">No sponsor found</p>`;
    return html`<li class="crm-issue-row" data-issue-id="${escapeHtml(issue.id)}">
      <div class="crm-issue-head">
        <span class="crm-issue-date">${escapeHtml(shortDate(issue.publishedAt))}</span>
        <span class="crm-issue-title">${title}</span>
        <span class="status-label" data-source="${escapeHtml(issue.source)}"
          >${escapeHtml(ISSUE_SOURCES[issue.source] || issue.source)}</span
        >
      </div>
      ${sponsors}
    </li>`;
  }

  function detailMarkup(item, issues) {
    const stats = item.issues || {};
    const withSponsors = (stats.issueCount || 0) - (stats.issuesWithoutSponsors || 0);
    const link = item.url
      ? html`<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.url)}</a>`
      : "";
    return html`<article class="crm-newsletter-detail">
      <header class="crm-newsletter-detail-head">
        <button type="button" class="crm-newsletter-back" data-close-newsletter>← Newsletters</button>
        <div>
          <h4 class="crm-newsletter-detail-title" tabindex="-1">${escapeHtml(item.name || "Untitled")}</h4>
          <p class="crm-lead-source">
            ${escapeHtml(HEALTH_LABELS[item.health] || humanizeOptionLabel(item.health))}
            · ${escapeHtml(item.cadence || "")}${link ? html` · ${link}` : ""}
          </p>
        </div>
      </header>
      <dl class="crm-newsletter-stats">
        <div><dt>Issues</dt><dd>${escapeHtml(String(stats.issueCount || 0))}</dd></div>
        <div><dt>With sponsors</dt><dd>${escapeHtml(String(withSponsors))}</dd></div>
        <div><dt>Sponsor sightings</dt><dd>${escapeHtml(String(stats.sponsorSightings || 0))}</dd></div>
        <div><dt>Last issue</dt><dd>${escapeHtml(stats.lastIssueAt ? shortDate(stats.lastIssueAt) : "None yet")}</dd></div>
      </dl>
      ${issues.length
        ? html`<ol class="crm-issue-list" aria-label="Issues">${issues.map(issueRow).join("")}</ol>`
        : html`<div class="honest-state">
            <strong>No issues recorded yet</strong>
            <p>Issues appear here when they arrive at ${escapeHtml(item.mailbox || "the newsletter inbox")} or are imported from the archive.</p>
          </div>`}
    </article>`;
  }

  function showList() {
    openId = null;
    surface.querySelector("[data-crm-newsletter-detail]").hidden = true;
    surface.querySelector("[data-crm-newsletters]").hidden = false;
    surface.querySelector("[data-crm-newsletters-toolbar]").hidden = false;
  }

  /** Open one newsletter's issues; resolves false when it does not exist. */
  async function showNewsletter(id) {
    openId = id;
    const detail = surface.querySelector("[data-crm-newsletter-detail]");
    surface.querySelector("[data-crm-newsletters]").hidden = true;
    surface.querySelector("[data-crm-newsletters-toolbar]").hidden = true;
    detail.hidden = false;
    detail.innerHTML = html`<p class="surface-status" role="status">Loading issues…</p>`;
    try {
      const [item, result] = await Promise.all([
        api(`/newsletters/${encodeURIComponent(id)}`),
        api(`/newsletters/${encodeURIComponent(id)}/issues`),
      ]);
      if (openId !== id) return true;
      detail.innerHTML = detailMarkup(item, result.items || []);
      detail.querySelector(".crm-newsletter-detail-title")?.focus();
      return true;
    } catch (error) {
      if (openId !== id) return true;
      renderEntityLoadState(detail, {
        kind: "newsletter",
        id,
        status: error.status === 404 ? "not-found" : "error",
        error: error.message,
        retry: () => showNewsletter(id),
        returnToList: () => {
          showList();
          navigate(listPath(), { render: false });
        },
      });
      return false;
    }
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
    surface.querySelector("[data-crm-newsletter-detail]").addEventListener("click", (event) => {
      if (event.target.closest("[data-close-newsletter]")) {
        const previous = openId;
        showList();
        navigate(listPath(), { render: false });
        const rows = [...surface.querySelectorAll("[data-open-newsletter]")];
        (rows.find((row) => row.dataset.openNewsletter === previous) || rows[0])?.focus();
        return;
      }
      const route = event.target.closest("a[data-open-route]");
      if (!route || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      navigate(route.getAttribute("href"));
    });
    surface.querySelector("[data-crm-newsletters]").addEventListener("click", (event) => {
      if (event.target.closest("[data-retry-newsletters]")) {
        fail(loadNewsletters, "Could not load newsletters");
        return;
      }
      const open = event.target.closest("[data-open-newsletter]");
      if (open && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        navigate(newsletterPath(open.dataset.openNewsletter), { render: false });
        fail(() => showNewsletter(open.dataset.openNewsletter), "Could not open newsletter");
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

  return { loadNewsletters, showList, showNewsletter, wireNewsletterControls };
}
