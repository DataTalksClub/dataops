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
    <h3>Verify fields for automatic publication</h3>
    <p>Verify invoice and actual payment values to publish automatically to the spreadsheet and archive. Each destination is checked separately.</p>
    </div>
    <button type="button" data-invoice-refresh>Refresh invoices</button>
    </header>
    <p aria-live="polite" data-invoice-status>
    </p>
    <details>
    <summary>Publication readiness</summary>
    <div data-invoice-readiness>Checking configuration…</div>
    </details>
    <form data-invoice-process>
    <label>Received intake ID <input name="intakeItemId" required />
    </label>
    <button type="submit">Process / reprocess received intake</button>
    </form>
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
      const items = queue.value.items || [];
      list.innerHTML = items.length
        ? `<div class="bookkeeping-table-wrap">
    <table>
    <thead>
    <tr>
    <th>Provider / reference</th>
    <th>Review</th>
    <th>Publication</th>
    <th>Actions</th>
    </tr>
    </thead>
    <tbody>${items
      .map(
        (record) => `<tr>
    <td>${e(record.fields?.counterparty || "Unidentified provider")}<small>${e(record.fields?.invoiceNumber)}</small>
    </td>
    <td>${e(record.status)}</td>
    <td>${e(record.publicationStatus)}</td>
    <td>
    <button type="button" data-review-invoice="${e(record.id)}">Review invoice</button>
    </td>
    </tr>`,
      )
      .join("")}</tbody>
    </table>
    </div>`
        : "No invoice drafts received.";
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
              result.publicationStatus === "complete"
                ? "Publication verified in each required destination."
                : `Review ${result.status}. Publication ${result.publicationStatus}; inspect each destination below.`;
          } finally {
            button.disabled = false;
          }
        }),
      ),
    );
  }
  list.addEventListener("click", (event) => {
    const id = event.target.closest("[data-review-invoice]")?.dataset
      .reviewInvoice;
    if (id) safe(async () => show(await api(`/${encodeURIComponent(id)}`)));
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
