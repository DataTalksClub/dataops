const fields = [
  ["transactionDate", "Date sent", "date"],
  ["paidDate", "Actual date paid", "date"],
  ["counterparty", "Provider"],
  ["description", "What"],
  ["amount", "Invoice amount (positive)", "number"],
  ["currency", "Invoice currency"],
  ["amountEur", "Actual EUR paid (positive)", "number"],
  ["paymentEvidence", "Payment evidence / operator attestation"],
  ["statementRef", "Statement reference"],
  ["invoiceNumber", "Invoice / stable reference"],
  ["accountContext", "Merchant account context"],
  ["quantity", "Count", "number"],
  ["subtype", "Type"],
  ["period", "Period"],
  ["category", "Category"],
  ["archiveExceptionReason", "Archive exception reason (if applicable)"],
  ["comment", "Comment"],
];

// Ledger dates read as short human dates in UTC, like the published sheet.
function shortDate(value) {
  const iso = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  const sameYear = iso.slice(0, 4) === String(new Date().getFullYear());
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(parsed);
}

// Sheet-sign convention: expenses are negative; only the invoice currency
// column carries the invoice amount, EUR stays blank until the actual bank
// payment is reviewed.
function ledgerMoney(record) {
  const amount = String(record.fields?.amount || "");
  const amountEur = String(record.fields?.amountEur || "");
  return {
    usd: record.fields?.currency === "USD" && amount ? `-${amount}` : "",
    eur: amountEur ? `-${amountEur}` : "",
  };
}

function ledgerRow(record, position, escapeHtml) {
  const e = (value) => escapeHtml(String(value ?? ""));
  const money = ledgerMoney(record);
  const description = String(record.fields?.description || "").trim();
  const label = record.fields?.counterparty || description || "unidentified provider";
  return `<tr data-review-invoice="${e(record.id)}" tabindex="0" aria-label="Review invoice ${position}: ${e(label)}">
<td class="num">${position}</td>
<td>${e(shortDate(record.fields?.transactionDate))}</td>
<td>${e(shortDate(record.fields?.paidDate))}</td>
<td><strong>${e(record.fields?.counterparty || "—")}</strong></td>
<td class="invoice-what">${e(description || "—")}</td>
<td class="num">${e(money.usd)}</td>
<td class="num">${e(money.eur)}</td>
<td class="invoice-statement">${e(String(record.fields?.statementRef || "").trim())}</td>
<td class="num">${e(String(record.fields?.quantity || 1))}</td>
<td><span class="invoice-state is-${e(record.status)}">${e(record.status)}</span></td>
</tr>`;
}

// Dense ledger matching the published expense sheet: one row per invoice,
// pending drafts first, oldest first inside each group.
export function invoiceLedgerMarkup(items, escapeHtml) {
  const rank = { pending: 0, confirmed: 1, rejected: 2 };
  const ordered = [...items].sort(
    (a, b) =>
      (rank[a.status] ?? 3) - (rank[b.status] ?? 3) ||
      String(a.fields?.transactionDate || "9999").localeCompare(
        String(b.fields?.transactionDate || "9999"),
      ),
  );
  const pending = ordered.filter((record) => record.status === "pending").length;
  const summary = `<p class="invoice-ledger-summary">${ordered.length} invoice${ordered.length === 1 ? "" : "s"} · ${pending} pending review</p>`;
  if (!ordered.length) {
    const empty = `<div class="honest-state"><strong>No invoice drafts received.</strong>`
      + `<p>Forward an invoice PDF to the intake address and it appears here with extracted values.</p></div>`;
    return `${summary}${empty}`;
  }
  return `${summary}<div class="invoice-ledger-wrap">
<table class="invoice-ledger">
<thead>
<tr>
<th class="num">#</th>
<th>Date sent</th>
<th>Date paid</th>
<th>Provider</th>
<th>What</th>
<th class="num">Price, $</th>
<th class="num">Price, EUR</th>
<th>Statement</th>
<th class="num">Count</th>
<th>Status</th>
</tr>
</thead>
<tbody>${ordered
    .map((record, index) => ledgerRow(record, index + 1, escapeHtml))
    .join("")}</tbody>
</table>
</div>`;
}

function reextractEligible(record) {
  return (
    record.status === "pending" &&
    !(record.audit || []).some((item) =>
      ["corrected", "re-extracted"].includes(item.action),
    )
  );
}

export function invoiceDetailMarkup(record, escapeHtml) {
  const e = (value) => escapeHtml(String(value ?? ""));
  const pending = record.status === "pending";
  const destinations = Object.entries(record.destinations || {})
    .map(
      ([name, value]) =>
        `<li>
    <strong>${e(name === "sheets" ? "Spreadsheet" : "Dropbox")}: ${e(value.state)}</strong>
    ${value.error ? `<p role="alert">${e(value.error)}</p>` : ""}
    ${value.reference ? `<p>Reference: ${e(value.reference)}</p>` : ""}
    <small>Operation: ${e(value.operationId)}</small>
    </li>`,
    )
    .join("");
  return `<header>
    <h4>${e(record.fields?.counterparty || "Invoice review")}</h4>
    <p>${e(record.status)} · Revision ${e(record.revision)} · Publication ${e(record.publicationStatus)}</p>
    </header>
    ${record.verification ? `<p>Fields verified by ${e(record.verification.actor)} · Revision ${e(record.verification.revision)} · ${e(record.verification.at)}</p>` : ""}
    <p>Extraction: ${e(record.extraction?.method || "Manual completion required")}</p>
    <ul>${[
      ...(record.extraction?.issues || []),
      ...(record.missingEvidence || []).map((field) => `Missing evidence: ${field}`),
    ].map((issue) => `<li>${e(issue)}</li>`).join("")}</ul>
    <details>
    <summary>Source and extraction evidence</summary>
    <p>Intake: ${e(record.source?.intakeItemIds?.join(", "))}</p>
    <p>Artifact: ${e(record.source?.artifactId)} · SHA-256: ${e(record.source?.checksum)}</p>
    <ul>${(record.extraction?.evidence || []).map((value) => `<li>${e(value)}</li>`).join("")}</ul>
    </details>
    <button type="button" data-invoice-document>Open original private PDF</button>
    <form data-invoice-fields>
    <fieldset ${pending ? "" : "disabled"}>
    <legend>Reviewed expense fields</legend>
    <div class="invoice-fields">${fields
      .map(
        ([
          name,
          label,
          type = "text",
        ]) => `<label>${label}<input name="${name}" type="${type}" ${type === "number" ? 'step="any"' : ""} value="${e(record.fields?.[name])}" />
    </label>`,
      )
      .join("")}
    <label>Archive original PDF<select name="archiveRequired">
    <option value="true" ${record.fields?.archiveRequired !== false ? "selected" : ""}>Required</option>
    <option value="false" ${record.fields?.archiveRequired === false ? "selected" : ""}>Reviewed exception</option>
    </select>
    </label>
    </div>
    </fieldset>
    <p>Enter the actual bank EUR amount and payment evidence. Invoice tax conversion is not bank payment evidence.</p>
    ${pending ? `<label class="checkbox-label">
    <input type="checkbox" name="verified" />
    <span>I verified invoice and actual payment values. Publish automatically when I save.</span>
    </label><button type="submit" class="quiet-button">Save corrections</button>` : ""}</form>
    <ul class="invoice-destinations">${destinations}</ul>
    <div class="row-actions">${
      pending
        ? `<button type="button" class="primary-button" data-invoice-action="verify" ${record.missingEvidence?.length ? "disabled" : ""}>Verify and publish automatically</button>
    ${reextractEligible(record) ? '<button type="button" class="quiet-button" data-invoice-action="reextract">Re-extract from document</button>' : ""}
    <button type="button" class="danger-text-button" data-invoice-action="reject">Reject invoice</button>`
        : record.status === "confirmed" &&
            record.publicationStatus !== "complete"
          ? '<button type="button" class="primary-button" data-invoice-action="retry">Reconcile and retry publication</button>'
          : ""
    }</div>
    <details>
    <summary>Review audit</summary>
    <ul>${(record.audit || []).map((item) => `<li>${e(item.action)} · ${e(item.actor)} · ${e(item.at)} · Revision ${e(item.revision)}</li>`).join("")}</ul>
    </details>`;
}

export async function mountInvoiceReview(host, context) {
  const { request, workApiUrl, escapeHtml } = context;
  const e = (value) => escapeHtml(String(value ?? ""));
  const api = (path = "", options = {}) =>
    request(workApiUrl(`/api/bookkeeping/invoices${path}`), {
      ...options,
      headers: { "content-type": "application/json" },
    });
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  host.innerHTML = `<header class="section-header">
    <div>
    <p class="section-kicker">Forwarded invoices</p>
    <h3>Invoice ledger</h3>
    <p>Forwarded invoices land here with extracted provider, description and price. Open a row to confirm values; verified rows publish automatically.</p>
    </div>
    <button type="button" data-invoice-refresh>Refresh invoices</button>
    </header>
    <p aria-live="polite" data-invoice-status>
    </p>
    <details>
    <summary>Publication readiness</summary>
    <div data-invoice-readiness>Checking configuration…</div>
    </details>
    <details>
    <summary>Process a received intake</summary>
    <form data-invoice-process>
    <label>Received intake ID <input name="intakeItemId" required />
    </label>
    <button type="submit">Process / reprocess received intake</button>
    </form>
    </details>
    <div data-invoice-list>Loading invoices…</div>
    <article data-invoice-detail hidden>
    </article>`;
  const status = host.querySelector("[data-invoice-status]");
  const list = host.querySelector("[data-invoice-list]");
  const detail = host.querySelector("[data-invoice-detail]");
  let selected;
  async function safe(action) {
    try {
      await action();
    } catch (error) {
      status.textContent = `Needs attention: ${error.message}`;
    }
  }
  async function refresh() {
    const results = await Promise.allSettled([api(), api("/readiness")]);
    const [queue, readiness] = results;
    if (queue.status === "fulfilled") {
      list.innerHTML = invoiceLedgerMarkup(queue.value.items || [], escapeHtml);
    } else list.textContent = `Cannot load invoices: ${queue.reason.message}`;
    host.querySelector("[data-invoice-readiness]").innerHTML =
      readiness.status === "fulfilled"
        ? `<p>${readiness.value.ready ? "Ready for automatic publication after fields are verified." : "Publication blocked. Resolve the checks below."}</p>
    <ul>${(readiness.value.checks || []).map((check) => `<li>${e(check.name)}: ${check.ready ? "Ready" : "Needs attention"} — ${e(check.message)}</li>`).join("")}</ul>`
        : `Cannot check readiness: ${e(readiness.reason.message)}`;
  }
  async function show(record) {
    selected = record;
    detail.hidden = false;
    detail.innerHTML = invoiceDetailMarkup(record, escapeHtml);
    detail
      .querySelector("[data-invoice-document]")
      .addEventListener("click", () =>
        safe(async () => {
          const result = await api(
            `/${encodeURIComponent(selected.id)}/document`,
          );
          const link = document.createElement("a");
          link.href = result.url;
          link.target = "_blank";
          link.rel = "noopener";
          link.click();
        }),
      );
    const form = detail.querySelector("[data-invoice-fields]");
    form.addEventListener("input", () => {
      detail.querySelectorAll("[data-invoice-action]").forEach((button) => {
        button.disabled = true;
      });
      status.textContent = "Save corrected values before verifying this revision.";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      safe(async () => {
        const values = Object.fromEntries(new FormData(form));
        const verified = values.verified === "on";
        delete values.verified;
        for (const key of ["amount", "amountEur"])
          values[key] = values[key].trim() || null;
        values.quantity =
          values.quantity === "" ? null : Number(values.quantity);
        values.archiveRequired = values.archiveRequired === "true";
        const result = await api(
          `/${encodeURIComponent(selected.id)}`,
          json("PUT", { revision: selected.revision, fields: values, ...(verified ? { verified: true } : {}) }),
        );
        await show(result);
        await refresh();
        status.textContent =
          result.publicationStatus === "complete"
            ? "Fields verified. Publication verified in each required destination."
            : result.status === "confirmed"
              ? `Fields verified. Publication ${result.publicationStatus}; inspect each destination below.`
              : "Corrections saved. Verify the new revision to publish automatically.";
      });
    });
    detail.querySelectorAll("[data-invoice-action]").forEach((button) =>
      button.addEventListener("click", () =>
        safe(async () => {
          button.disabled = true;
          try {
            const result = await api(
              `/${encodeURIComponent(selected.id)}/${button.dataset.invoiceAction}`,
              json("POST", { revision: selected.revision }),
            );
            await show(result);
            await refresh();
            status.textContent =
              button.dataset.invoiceAction === "reextract"
                ? `Fields re-extracted (${result.extraction?.method || "unknown method"}). Confirm the values to publish.`
                : result.publicationStatus === "complete"
                  ? "Publication verified in each required destination."
                  : `Review ${result.status}. Publication ${result.publicationStatus}; inspect each destination below.`;
          } finally {
            button.disabled = false;
          }
        }),
      ),
    );
  }
  function openRow(row) {
    const id = row?.dataset?.reviewInvoice;
    if (id) safe(async () => show(await api(`/${encodeURIComponent(id)}`)));
  }
  list.addEventListener("click", (event) => {
    openRow(event.target.closest("[data-review-invoice]"));
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-review-invoice]");
    if (row) {
      event.preventDefault();
      openRow(row);
    }
  });
  host
    .querySelector("[data-invoice-refresh]")
    .addEventListener("click", () => safe(refresh));
  host
    .querySelector("[data-invoice-process]")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      safe(async () => {
        const intakeItemId = new FormData(event.target).get("intakeItemId");
        const result = await api("/process", json("POST", { intakeItemId }));
        await refresh();
        status.textContent =
          (result.issues || []).join("; ") ||
          `${result.items?.length || 0} invoice draft(s) available for review. Ingestion does not verify fields or publish.`;
      });
    });
  await refresh();
}
