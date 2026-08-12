import { html } from "./shared.js";

export function createBookkeepingSurface(context) {
  const {
    documentList,
    escapeHtml,
    humanizeOptionLabel,
    request,
    setPageTitle,
    workApiUrl,
  } = context;

  async function renderBookkeepingSurface() {
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "bookkeeping-surface";
    surface.innerHTML = html` <header class="bookkeeping-header">
        <div>
          <p class="surface-eyebrow">Monthly close</p>
          <h2>Bookkeeping</h2>
          <p>
            Record the ledger, match private evidence, and prepare a reviewable
            monthly package.
          </p>
        </div>
        <button class="primary-button" data-bookkeeping-add>Add entry</button>
      </header>
      <nav class="bookkeeping-job-nav" aria-label="Bookkeeping jobs">
        <a href="#bookkeeping-ledger"
          ><span>1</span><strong>Record ledger</strong
          ><small>Transactions and totals</small></a
        ><a href="#bookkeeping-evidence"
          ><span>2</span><strong>Match evidence</strong
          ><small>PDFs and references</small></a
        ><a href="#bookkeeping-package"
          ><span>3</span><strong>Close month</strong
          ><small>Review package</small></a
        >
      </nav>
      <p data-bookkeeping-status class="surface-status" role="status">
        Private downloads expire after five minutes.
      </p>
      <section
        id="bookkeeping-ledger"
        class="bookkeeping-section bookkeeping-ledger-section"
        aria-labelledby="bookkeeping-ledger-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 1</p>
            <h3 id="bookkeeping-ledger-heading">
              Record and review the ledger
            </h3>
            <p>
              Filter transactions, confirm totals, and open an entry only when
              it needs work.
            </p>
          </div>
          <p class="bookkeeping-totals" aria-live="polite"></p>
        </header>
        <div class="bookkeeping-filters">
          <label
            >Search
            <input
              data-filter="search"
              type="search"
              placeholder="Provider, description, or category" /></label
          ><label
            >Year
            <select data-filter="year">
              <option value="">All years</option>
            </select></label
          >
          <details>
            <summary>More filters</summary>
            <div class="bookkeeping-filter-more">
              <label>Type <input data-filter="entryType" /></label
              ><label>Category <input data-filter="category" /></label
              ><label
                >Provider / payee <input data-filter="counterparty" /></label
              ><label
                >Currency <input data-filter="currency" maxlength="3"
              /></label>
            </div>
          </details>
        </div>
        <div class="bookkeeping-ledger" aria-live="polite">Loading ledger…</div>
      </section>
      <section
        id="bookkeeping-evidence"
        class="bookkeeping-section bookkeeping-evidence"
        aria-labelledby="bookkeeping-evidence-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 2</p>
            <h3 id="bookkeeping-evidence-heading">
              Match transaction evidence
            </h3>
            <p>
              Upload verified PDFs and connect each file to the ledger entry it
              supports.
            </p>
          </div>
          <button class="quiet-button" data-setup-accounts>
            Set up business accounts
          </button>
        </header>
        <div class="bookkeeping-upload">
          <label class="bookkeeping-file"
            >PDF evidence
            <input type="file" accept="application/pdf,.pdf" data-pdf /></label
          ><label
            >Document type
            <select data-document-type>
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
              <option value="bank-statement">Bank statement</option>
              <option value="private-account-statement">
                Private account statement
              </option>
            </select></label
          ><label
            >Account
            <select data-account>
              <option value="">No account</option>
            </select></label
          ><label
            >Statement month <input type="month" data-statement-month /></label
          ><label class="bookkeeping-transaction-link"
            >Link to transaction
            <select data-transaction>
              <option value="">No transaction</option>
            </select></label
          ><button class="primary-button" data-upload>Upload PDF</button>
        </div>
        <div class="bookkeeping-documents" aria-live="polite">
          Loading documents…
        </div>
      </section>
      <section
        id="bookkeeping-package"
        class="bookkeeping-section bookkeeping-package-section"
        aria-labelledby="bookkeeping-package-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 3</p>
            <h3 id="bookkeeping-package-heading">
              Prepare the monthly package
            </h3>
            <p>
              Choose the reporting month and include private-account statements
              only when they are needed.
            </p>
          </div>
        </header>
        <fieldset class="bookkeeping-private-statements">
          <legend>Optional private-account statements</legend>
          <div data-private-statements>No eligible private statements.</div>
        </fieldset>
        <div class="bookkeeping-package">
          <label>Report month <input type="month" data-report-month /></label
          ><button class="primary-button" data-report>
            Create monthly package
          </button>
        </div>
      </section>
      <dialog class="surface-dialog bookkeeping-entry-dialog">
        <form method="dialog" novalidate>
          <header>
            <p class="surface-eyebrow">Ledger record</p>
            <h3>Bookkeeping entry</h3>
            <p>
              Required fields describe the transaction. Payment and
              classification details may be added later.
            </p>
          </header>
          <div class="dialog-fields bookkeeping-entry-fields">
            <input type="hidden" name="id" /><label
              >Transaction date
              <input name="transactionDate" type="date" /></label
            ><label>Paid date <input name="paidDate" type="date" /></label
            ><label class="span-all"
              >Provider / payee <input name="counterparty" /></label
            ><label class="span-all"
              >Description <input name="description" /></label
            ><label>Amount <input name="amount" inputmode="decimal" /></label
            ><label
              >Currency
              <input name="currency" maxlength="3" value="EUR" /></label
            ><label>Category <input name="category" /></label
            ><label>Type <input name="entryType" /></label
            ><label class="span-all"
              >Statement / reference <input name="statementRef"
            /></label>
            <p class="span-all" role="alert" data-form-error></p>
          </div>
          <footer class="bookkeeping-actions">
            <button class="primary-button" data-save>Save</button
            ><button value="cancel">Cancel</button>
          </footer>
        </form>
      </dialog>
      <dialog class="surface-dialog bookkeeping-delete-dialog">
        <form method="dialog">
          <header>
            <p class="surface-eyebrow">Destructive change</p>
            <h3>Delete bookkeeping entry?</h3>
            <p>
              <strong data-delete-entry-name>This ledger entry</strong> will be
              permanently removed. Linked evidence is not deleted.
            </p>
          </header>
          <footer>
            <button type="button" class="danger-button" data-delete-confirm>
              Delete entry</button
            ><button value="cancel" data-delete-cancel>Keep entry</button>
          </footer>
        </form>
      </dialog>`;
    documentList.append(surface);
    setPageTitle("Bookkeeping", "Bookkeeping");
    let entries = [],
      documents = [],
      links = [];
    const ledger = surface.querySelector(".bookkeeping-ledger"),
      totals = surface.querySelector(".bookkeeping-totals"),
      entryDialog = surface.querySelector(".bookkeeping-entry-dialog"),
      form = entryDialog.querySelector("form"),
      status = surface.querySelector("[data-bookkeeping-status]");
    const api = (path, options = {}) =>
      request(workApiUrl(`/api/bookkeeping${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    async function safeAction(action, fallback) {
      try {
        await action();
      } catch (error) {
        status.textContent = `${fallback}: ${error.message}`;
      }
    }
    function openPrivateDownload(url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }
    function renderLedger() {
      const filters = Object.fromEntries(
        [...surface.querySelectorAll("[data-filter]")].map((el) => [
          el.dataset.filter,
          el.value.trim(),
        ]),
      );
      const shown = entries.filter(
        (e) =>
          (!filters.year || e.transactionDate.startsWith(filters.year)) &&
          (!filters.entryType ||
            String(e.entryType || "")
              .toLowerCase()
              .includes(filters.entryType.toLowerCase())) &&
          (!filters.category ||
            String(e.category || "")
              .toLowerCase()
              .includes(filters.category.toLowerCase())) &&
          (!filters.counterparty ||
            e.counterparty
              .toLowerCase()
              .includes(filters.counterparty.toLowerCase())) &&
          (!filters.currency ||
            e.currency === filters.currency.toUpperCase()) &&
          (!filters.search ||
            [e.counterparty, e.description, e.category, e.entryType]
              .join(" ")
              .toLowerCase()
              .includes(filters.search.toLowerCase())),
      );
      const sums = {};
      shown.forEach(
        (e) => (sums[e.currency] = (sums[e.currency] || 0) + Number(e.amount)),
      );
      totals.textContent =
        Object.entries(sums)
          .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`)
          .join(" · ") || "No filtered total";
      ledger.innerHTML = shown.length
        ? html`<div class="bookkeeping-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Paid</th>
                  <th>Provider / description</th>
                  <th>Amount</th>
                  <th>Category / type</th>
                  <th>Evidence</th>
                  <th><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                ${shown
                  .map(
                    (e) =>
                      html`<tr>
                        <td data-label="Transaction date">
                          ${escapeHtml(e.transactionDate)}
                        </td>
                        <td data-label="Paid">
                          ${escapeHtml(e.paidDate || "Unpaid")}
                        </td>
                        <td data-label="Entry">
                          <strong>${escapeHtml(e.counterparty)}</strong
                          ><small>${escapeHtml(e.description)}</small>
                        </td>
                        <td data-label="Amount" class="ledger-amount">
                          ${escapeHtml(`${e.amount} ${e.currency}`)}
                        </td>
                        <td data-label="Category / type">
                          ${escapeHtml([e.category, e.entryType].filter(Boolean).join(" / ") || "—")}
                        </td>
                        <td data-label="Evidence">
                          <span
                            class="evidence-state ${e.statementRef ? "is-attached" : ""}"
                            >${escapeHtml(e.statementRef ? "Referenced" : "Missing")}</span
                          >
                        </td>
                        <td data-label="Actions">
                          <div class="row-actions">
                            <button data-edit="${escapeHtml(e.id)}">Edit</button
                            ><button
                              class="danger-text-button"
                              data-delete="${escapeHtml(e.id)}"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : html`<div class="honest-state">
            <strong>No bookkeeping entries</strong>
            <p>Adjust filters or add the first entry.</p>
          </div>`;
    }
    async function refreshEvidence() {
      const [docResult, linkResult, accountResult] = await Promise.all([
        api("/documents"),
        api("/links"),
        api("/accounts"),
      ]);
      documents = docResult.items || [];
      links = linkResult.items || [];
      surface.querySelector("[data-account]").innerHTML = html`<option value="">
          No account
        </option>
        ${(accountResult.items || []).map((a) => html`<option value="${escapeHtml(a.id)}">${escapeHtml(a.displayName)} (${escapeHtml(a.kind)})</option>`).join("")}`;
      surface.querySelector(".bookkeeping-documents").innerHTML =
        documents.length
          ? documents
              .map((d) => {
                const documentLinks = links.filter(
                  (l) => l.documentId === d.id,
                );
                const matchDescription = documentLinks.length
                  ? ` · matched to ${documentLinks.length} ${documentLinks.length === 1 ? "entry" : "entries"}`
                  : " · not matched";
                return html`<article class="bookkeeping-document-row">
                  <div>
                    <strong
                      >${escapeHtml(d.originalFilename || "Private PDF")}</strong
                    >
                    <p>
                      ${escapeHtml(humanizeOptionLabel(d.documentType))}${matchDescription}
                    </p>
                  </div>
                  <div class="row-actions">
                    <button data-download="${escapeHtml(d.id)}">Download</button
                    >${documentLinks
                      .map((l) => {
                        const transaction = entries.find(
                          (e) => e.id === l.transactionId,
                        );
                        return ` <button data-unlink="${escapeHtml(l.id)}">Unlink ${escapeHtml(transaction?.counterparty || "entry")}</button>`;
                      })
                      .join("")}
                  </div>
                </article>`;
              })
              .join("")
          : html`<div class="honest-state">
              <strong>No private documents uploaded</strong>
              <p>Choose a PDF above to add the first piece of evidence.</p>
            </div>`;
      const privateStatements = documents.filter(
        (d) => d.documentType === "private-account-statement",
      );
      surface.querySelector("[data-private-statements]").innerHTML =
        privateStatements.length
          ? privateStatements
              .map(
                (d) =>
                  html`<label class="checkbox-label"
                    ><input type="checkbox" value="${escapeHtml(d.id)}" />
                    <span
                      >${escapeHtml(d.originalFilename || "Private statement")}</span
                    ></label
                  >`,
              )
              .join("")
          : "No eligible private statements.";
    }
    try {
      const result = await api("/transactions");
      entries = result.items || [];
      const years = [
        ...new Set(entries.map((e) => e.transactionDate.slice(0, 4))),
      ]
        .sort()
        .reverse();
      surface
        .querySelector('[data-filter="year"]')
        .insertAdjacentHTML(
          "beforeend",
          years.map((y) => html`<option>${y}</option>`).join(""),
        );
      surface
        .querySelector("[data-transaction]")
        .insertAdjacentHTML(
          "beforeend",
          entries
            .map(
              (e) =>
                html`<option value="${escapeHtml(e.id)}">
                  ${escapeHtml(`${e.transactionDate} · ${e.counterparty}`)}
                </option>`,
            )
            .join(""),
        );
      renderLedger();
      await refreshEvidence();
    } catch (error) {
      ledger.textContent = `Could not load bookkeeping: ${error.message}`;
      surface.querySelector(".bookkeeping-documents").textContent =
        "Could not load private documents.";
      status.textContent = "Retry by reopening Bookkeeping.";
    }
    surface
      .querySelectorAll("[data-filter]")
      .forEach((el) => el.addEventListener("input", renderLedger));
    surface
      .querySelector("[data-bookkeeping-add]")
      .addEventListener("click", () => {
        form.reset();
        form.elements.currency.value = "EUR";
        entryDialog.querySelector("h3").textContent = "Add ledger entry";
        entryDialog.showModal();
      });
    form.addEventListener("input", (event) => {
      event.target.removeAttribute("aria-invalid");
      surface.querySelector("[data-form-error]").textContent = "";
    });
    ledger.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit]")?.dataset.edit,
        del = event.target.closest("[data-delete]")?.dataset.delete;
      if (edit) {
        const item = entries.find((e) => e.id === edit);
        Object.keys(item).forEach((k) => {
          if (form.elements[k]) form.elements[k].value = item[k] || "";
        });
        entryDialog.querySelector("h3").textContent = "Edit ledger entry";
        entryDialog.showModal();
      }
      if (del) {
        const dialog = surface.querySelector(".bookkeeping-delete-dialog"),
          item = entries.find((e) => e.id === del);
        dialog.dataset.id = del;
        dialog.querySelector("[data-delete-entry-name]").textContent =
          item?.counterparty || "This ledger entry";
        dialog.showModal();
      }
    });
    surface.querySelector("[data-save]").addEventListener("click", (event) => {
      event.preventDefault();
      safeAction(async () => {
        const data = Object.fromEntries(
          [...new FormData(form)].filter(([, v]) => v !== ""),
        );
        const missing = [
          "transactionDate",
          "counterparty",
          "description",
          "amount",
          "currency",
        ].find((k) => !data[k]);
        if (missing) {
          const requiredFieldLabels = {
            transactionDate: "Transaction date",
            counterparty: "Provider / payee",
            description: "Description",
            amount: "Amount",
            currency: "Currency",
          };
          const field = form.elements[missing];
          field.setAttribute("aria-invalid", "true");
          field.focus();
          surface.querySelector("[data-form-error]").textContent =
            `${requiredFieldLabels[missing]} is required.`;
          return;
        }
        data.currency = data.currency.toUpperCase();
        const id = form.elements.id.value;
        const saved = await api(`/transactions${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        });
        entries = id
          ? entries.map((e) => (e.id === id ? saved : e))
          : [saved, ...entries];
        entryDialog.close();
        renderLedger();
      }, "Could not save entry");
    });
    surface
      .querySelector("[data-delete-cancel]")
      .addEventListener("click", () =>
        surface.querySelector(".bookkeeping-delete-dialog").close(),
      );
    surface
      .querySelector("[data-delete-confirm]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const dialog = surface.querySelector(".bookkeeping-delete-dialog");
          await api(`/transactions/${dialog.dataset.id}`, { method: "DELETE" });
          entries = entries.filter((e) => e.id !== dialog.dataset.id);
          dialog.close();
          renderLedger();
        }, "Could not delete entry"),
      );
    surface
      .querySelector("[data-setup-accounts]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const result = await api("/accounts/setup", { method: "POST" });
          status.textContent = `${result.accounts.length} business accounts ready.`;
          await refreshEvidence();
        }, "Could not set up accounts"),
      );
    surface.querySelector("[data-upload]").addEventListener("click", () =>
      safeAction(async () => {
        const file = surface.querySelector("[data-pdf]").files[0];
        if (!file) {
          status.textContent = "Choose a PDF first.";
          return;
        }
        const bytes = await file.arrayBuffer(),
          sha256 = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
          runId = crypto.randomUUID(),
          idempotencyKey = crypto.randomUUID(),
          documentType = surface.querySelector("[data-document-type]").value;
        const ownership = { idempotencyKey, runId };
        const prepared = await api("/documents/prepare", {
          method: "POST",
          body: JSON.stringify({
            sha256,
            byteSize: file.size,
            documentType,
            ...ownership,
            sourceRef: `portal-${sha256.slice(0, 24)}`,
            accountId: ["bank-statement", "private-account-statement"].includes(
              documentType,
            )
              ? surface.querySelector("[data-account]").value || undefined
              : undefined,
            statementMonth: [
              "bank-statement",
              "private-account-statement",
            ].includes(documentType)
              ? surface.querySelector("[data-statement-month]").value ||
                undefined
              : undefined,
          }),
        });
        let completed = prepared;
        if (prepared.outcome !== "existing") {
          const uploaded = await fetch(prepared.uploadUrl, {
            method: "PUT",
            headers: prepared.uploadHeaders || {
              "content-type": "application/pdf",
            },
            body: file,
          });
          if (!uploaded.ok) throw new Error("Upload failed");
          completed = await api(`/documents/${prepared.document.id}/complete`, {
            method: "POST",
            body: JSON.stringify(ownership),
          });
        }
        const transactionId = surface.querySelector("[data-transaction]").value;
        if (transactionId)
          await api("/links", {
            method: "POST",
            body: JSON.stringify({
              documentId: completed.document.id,
              transactionId,
              coverageType: "evidence",
            }),
          });
        status.textContent =
          prepared.outcome === "existing"
            ? "Matching PDF already verified."
            : "PDF uploaded and verified.";
        await refreshEvidence();
      }, "Could not upload PDF"),
    );
    surface
      .querySelector(".bookkeeping-documents")
      .addEventListener("click", (event) =>
        safeAction(async () => {
          const download =
              event.target.closest("[data-download]")?.dataset.download,
            unlink = event.target.closest("[data-unlink]")?.dataset.unlink;
          if (download) {
            const result = await api(`/documents/${download}/download`);
            openPrivateDownload(result.downloadUrl);
          }
          if (unlink) {
            await api(`/links/${unlink}`, { method: "DELETE" });
            await refreshEvidence();
          }
        }, "Could not update document"),
      );
    surface.querySelector("[data-report]").addEventListener("click", () =>
      safeAction(async () => {
        const month = surface.querySelector("[data-report-month]").value;
        if (!month) {
          status.textContent = "Choose a report month.";
          return;
        }
        const privateDocumentIds = [
          ...surface.querySelectorAll(
            "[data-private-statements] input:checked",
          ),
        ].map((input) => input.value);
        const snapshot = await api("/reports/snapshot", {
          method: "POST",
          body: JSON.stringify({ month, privateDocumentIds }),
        });
        status.textContent = snapshot.warnings?.missingEvidence
          ? `${snapshot.warnings.missingEvidence} missing-evidence warning(s).`
          : "Snapshot ready.";
        const archive = await api(`/reports/${snapshot.report.id}/archive`, {
          method: "POST",
        });
        openPrivateDownload(archive.downloadUrl);
      }, "Could not create monthly package"),
    );
  }

  return { renderBookkeepingSurface };
}
