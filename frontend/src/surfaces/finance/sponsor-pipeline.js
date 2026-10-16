import { html } from "./shared.js";

export const SPONSOR_PIPELINE_STAGES = Object.freeze([
  { id: "open", label: "Opportunities" },
  { id: "agreed", label: "Agreed" },
  { id: "invoiced", label: "Invoiced" },
  { id: "delivered", label: "Delivered" },
]);

// Stages describe progress; the underlying deal status remains open/agreed/lost.
export function sponsorPipelineStage(deal) {
  if (deal.status === "lost") return null;
  if (deal.fulfillment === "delivered") return "delivered";
  if (["invoiced", "partial", "paid", "overdue"].includes(deal.money)) return "invoiced";
  return deal.status === "agreed" ? "agreed" : "open";
}

export function groupSponsorPipelineDeals(deals) {
  const grouped = Object.fromEntries(SPONSOR_PIPELINE_STAGES.map(({ id }) => [id, []]));
  for (const deal of deals) {
    const stage = sponsorPipelineStage(deal);
    if (stage) grouped[stage].push(deal);
  }
  return grouped;
}

export function renderSponsorPipelineFilters({ deals, selected, escapeHtml }) {
  const groups = groupSponsorPipelineDeals(deals);
  const count = Object.values(groups).reduce((total, items) => total + items.length, 0);
  return [{ id: "", label: "All deals", count }, ...SPONSOR_PIPELINE_STAGES.map((stage) => ({
    ...stage,
    count: groups[stage.id].length,
  }))].map(({ id, label, count: value }) => html`<button
    type="button" data-pipeline-status="${escapeHtml(id)}"
    aria-pressed="${selected === id ? "true" : "false"}"
  >${label} <strong>${value}</strong></button>`).join("");
}

function pipelineCard(deal, { organizationName, escapeHtml, humanSponsorDate }) {
  const product = { "one-off": "One-off", package: "Package", course: "Course" }[deal.productKind] || "Deal";
  const amount = deal.amountEur != null && Number.isFinite(Number(deal.amountEur))
    ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(deal.amountEur))
    : "";
  const publication = deal.deliverables?.find((item) => item.plannedPublicationDate)?.plannedPublicationDate;
  // What happens next is the deal's earliest open Task; the Tasks queue owns it.
  const task = deal.openTasks?.[0];
  const action = task
    ? `${task.description} · ${humanSponsorDate(task.date)}`
    : publication ? `Publishes ${humanSponsorDate(publication)}` : "No open task";
  return html`<article class="crm-pipeline-card" data-open-deal="${escapeHtml(deal.id)}">
    <h4>${escapeHtml(organizationName(deal.organizationId))}</h4>
    <p class="crm-pipeline-card-meta"><span>${escapeHtml(product)}</span>${amount ? html`<strong>${escapeHtml(amount)}</strong>` : ""}</p>
    <p class="crm-pipeline-card-action">${escapeHtml(action)}</p>
    <div class="row-actions">
      <button type="button" data-open-deal="${escapeHtml(deal.id)}">Open deal</button>
      <button type="button" data-edit-deal="${escapeHtml(deal.id)}">Edit</button>
    </div>
  </article>`;
}

export function renderSponsorPipelineBoard({ deals, ...context }) {
  const grouped = groupSponsorPipelineDeals(deals);
  return SPONSOR_PIPELINE_STAGES.map(({ id, label }) => html`<section
    class="crm-pipeline-column" data-pipeline-stage="${id}" aria-label="${label} deals"
  >
    <header><h3>${label}</h3><span>${grouped[id].length}</span></header>
    <div class="crm-pipeline-column-cards">${grouped[id].length
      ? grouped[id].map((deal) => pipelineCard(deal, context)).join("")
      : '<p class="crm-pipeline-empty">No deals in this stage</p>'}</div>
  </section>`).join("");
}
