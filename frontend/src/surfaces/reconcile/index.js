// Month-end bank reconciliation page at /finance/reconcile/YYYY-MM: every
// bank transaction and every unpaired ledger row of the month, what each one
// lacks, and the actions that supply it (attach an invoice or payment proof,
// create the ledger row, match/unmatch, mark an exception), then the close
// gate. Each action reloads the month, so the status shown is always the
// server's. Renders GET /api/reconcile/months/:period.
import { mountPeriodNav, periodNavMarkup } from "../period-nav.js";
import {
  attachDialogMarkup,
  blockersMarkup,
  confirmationMarkup,
  exceptionDialogMarkup,
  headerActionsMarkup,
  html,
  ledgerDialogMarkup,
  matchDialogMarkup,
  monthBodyMarkup,
  reopenDialogMarkup,
  stateBadgeMarkup,
  unmatchDialogMarkup,
} from "./markup.js";
import {
  clearExceptionRequest,
  exceptionRequest,
  FILTER_IDS,
  invoiceRequest,
  ledgerRequest,
  matchRequest,
  monthLabel,
  pairRequest,
  periodFromPath,
  previousMonth,
  proofRequest,
  reconcilePath,
  rowSides,
  shiftMonth,
  unpairRequest,
  uploadBookkeepingDocument,
} from "./model.js";

/**
 * The month's API calls, independent of the page: tests drive it with a fake
 * `request` to check the exact bodies each action sends.
 */
export function createReconcileClient({ request, workApiUrl, fetchImpl, cryptoRef }) {
  const monthUrl = (period, suffix = "") => workApiUrl(`/api/reconcile/months/${encodeURIComponent(period)}${suffix}`);
  const post = (period, [action, body]) => request(monthUrl(period, `/${action}`), { method: "POST", body: JSON.stringify(body) });
  const upload = (file) => uploadBookkeepingDocument(file, { request, workApiUrl, fetchImpl, cryptoRef, documentType: "receipt" });
  return {
    load: (period) => request(monthUrl(period)),
    csv: (period) => request(monthUrl(period, "?format=csv"), { responseType: "blob" }),
    post,
    async attachProof(period, row, file) {
      return post(period, proofRequest(row, await upload(file)));
    },
    async attachInvoice(period, row, file, { category } = {}) {
      const documentId = await upload(file);
      const [action, body] = invoiceRequest(row, documentId);
      return post(period, [action, action === "ledger" ? ledgerRequest(row, { category, documentId })[1] : body]);
    },
    createLedger: (period, row, fields) => post(period, ledgerRequest(row, fields)),
    match: (period, row, otherId, note) => post(period, matchRequest(row, otherId, note)),
    confirmPair: (period, row, note) => post(period, pairRequest(row.bank.key, row.ledger.id, note)),
    unmatch: (period, row, note) => post(period, unpairRequest(row, note)),
    markException: (period, row, fields) => post(period, exceptionRequest(row, fields)),
    clearException: (period, row) => post(period, clearExceptionRequest(row)),
    confirmExceptions: (period) => post(period, ["confirm-exceptions", {}]),
    close: (period) => post(period, ["close", {}]),
    reopen: (period, reason) => post(period, ["reopen", { reason }]),
    viewDocument: (id) => request(workApiUrl(`/api/bookkeeping/documents/${encodeURIComponent(id)}/download?disposition=inline`)),
  };
}

/** The 409 gate payload (error + blockers) from a failed close or confirm. */
export function gateErrorOf(error) {
  const payload = error?.payload;
  if (error?.status === 409 && payload) return { error: payload.error || error.message, blockers: payload.blockers || [] };
  if (error?.status === 403) return { error: "Only an admin confirms a month's exception list", blockers: [] };
  return { error: error?.message || "Request failed", blockers: [] };
}

export function createReconcileSurface(context) {
  const { documentList, escapeHtml: e, request, setRouteTitle, todayIsoDate, workApiUrl } = context;
  const locationRef = context.locationRef || globalThis.location;
  const historyRef = context.historyRef || globalThis.history;
  const client = createReconcileClient({ request, workApiUrl, fetchImpl: context.fetchImpl, cryptoRef: context.cryptoRef });
  let generation = 0;

  async function renderReconcileSurface() {
    const today = typeof todayIsoDate === "function" ? todayIsoDate() : new Date().toISOString().slice(0, 10);
    const params = new URLSearchParams(locationRef?.search || "");
    let period = periodFromPath(locationRef?.pathname) || previousMonth(today);
    let filter = FILTER_IDS.includes(params.get("status")) ? params.get("status") : "all";
    let month = null;
    if (!periodFromPath(locationRef?.pathname)) historyRef?.replaceState?.({}, "", urlFor());

    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "reconcile-surface";
    documentList.append(surface);
    setRouteTitle("Reconciliation");
    surface.innerHTML = html`<header class="dk-page-header recon-header">
        <div class="dk-page-header__main">
          <h1 class="dk-page-header__title">Bank reconciliation</h1>
          <p class="dk-page-header__subtitle">Every bank transaction and ledger row of the month, and what each one still lacks.</p>
        </div>
        <div class="dk-page-header__actions" data-recon-actions></div>
      </header>
      <div class="recon-toolbar">
        <div data-recon-period>${periodNavMarkup({ headingId: "recon-period-heading", todayLabel: "Last month", groupLabel: "Month" })}</div>
        <div class="recon-badges" data-recon-badges></div>
      </div>
      <div data-recon-feedback aria-live="polite"></div>
      <div class="recon-body" data-recon-body><p class="recon-muted">Loading…</p></div>
      <dialog class="dk-dialog recon-dialog" data-recon-dialog aria-label="Reconciliation action"></dialog>`;

    const body = surface.querySelector("[data-recon-body]");
    const feedback = surface.querySelector("[data-recon-feedback]");
    const dialog = surface.querySelector("[data-recon-dialog]");
    const nav = mountPeriodNav(surface.querySelector("[data-recon-period]"), {
      selected: () => ({ year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) - 1 }),
      current: () => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }),
      onToday: () => choose(previousMonth(today)),
      onPrev: () => choose(shiftMonth(period, -1)),
      onNext: () => choose(shiftMonth(period, 1)),
      onMonth: (year, index) => choose(`${year}-${String(index + 1).padStart(2, "0")}`),
      dismissScope: surface,
    });

    function urlFor() {
      return `${reconcilePath(period)}${filter === "all" ? "" : `?status=${filter}`}`;
    }

    function say(markup) {
      feedback.innerHTML = markup;
    }
    const notice = (text, tone = "success") =>
      say(html`<div class="dk-callout dk-callout--${tone}" role="${tone === "danger" ? "alert" : "status"}"><div class="dk-callout__body">${e(text)}</div></div>`);

    function paint() {
      nav.setTitle(monthLabel(period));
      nav.setStep({ prevLabel: `Previous month (${shiftMonth(period, -1)})`, nextLabel: `Next month (${shiftMonth(period, 1)})` });
      if (!month) return;
      surface.querySelector("[data-recon-actions]").innerHTML = headerActionsMarkup(month);
      surface.querySelector("[data-recon-badges]").innerHTML = `${stateBadgeMarkup(month, e)} ${confirmationMarkup(month, e)}`;
      body.innerHTML = monthBodyMarkup(month, filter, e);
    }

    async function load() {
      const mine = ++generation;
      paint();
      body.setAttribute("aria-busy", "true");
      try {
        const next = await client.load(period);
        if (mine !== generation) return;
        month = next;
        paint();
      } catch (error) {
        if (mine !== generation) return;
        month = null;
        surface.querySelector("[data-recon-actions]").innerHTML = "";
        surface.querySelector("[data-recon-badges]").innerHTML = "";
        body.innerHTML = html`<div class="dk-callout dk-callout--danger" role="alert"><div class="dk-callout__body">
            Could not load ${e(period)}: ${e(error?.message || "request failed")}</div></div>
          <button type="button" class="dk-button dk-button--secondary" data-recon-retry>Retry</button>`;
      } finally {
        if (mine === generation) body.removeAttribute("aria-busy");
      }
    }

    function choose(next) {
      if (next === period) return;
      period = next;
      month = null;
      say("");
      historyRef?.pushState?.({}, "", urlFor());
      load();
    }

    function setFilter(next) {
      filter = next;
      historyRef?.replaceState?.({}, "", urlFor());
      paint();
    }

    // ---- dialogs ---------------------------------------------------------
    function openDialog(markup, submit, { onOpen } = {}) {
      dialog.innerHTML = markup;
      const form = dialog.querySelector("[data-recon-form]");
      const error = dialog.querySelector("[data-recon-dialog-error]");
      dialog.querySelector("[data-recon-cancel]")?.addEventListener("click", () => dialog.close());
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = dialog.querySelector("[data-recon-submit]");
        button.disabled = true;
        error.hidden = true;
        try {
          const message = await submit(form);
          dialog.close();
          if (message) notice(message);
          await load();
        } catch (failure) {
          error.textContent = failure?.message || "Request failed";
          error.hidden = false;
        } finally {
          button.disabled = false;
        }
      });
      onOpen?.(form);
      dialog.showModal();
      form.querySelector("input:not([type=hidden]), select, textarea, button[type=submit]")?.focus();
    }

    function wireDrop(form) {
      const input = form.querySelector("[data-recon-file]");
      const zone = form.querySelector("[data-recon-drop]");
      const name = form.querySelector("[data-recon-file-name]");
      const show = () => { name.textContent = input.files?.[0]?.name || "No file chosen"; };
      input.addEventListener("change", show);
      zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("is-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
      zone.addEventListener("drop", (event) => {
        event.preventDefault();
        zone.classList.remove("is-over");
        if (event.dataTransfer?.files?.length) {
          input.files = event.dataTransfer.files;
          show();
        }
      });
    }

    const chosenFile = (form) => {
      const file = form.querySelector("[data-recon-file]").files?.[0];
      if (!file) throw new Error("Choose a PDF first");
      return file;
    };
    const value = (form, name) => form.elements[name]?.value || "";

    function rowAction(action, row) {
      if (action === "attach-invoice") {
        return openDialog(attachDialogMarkup(row, "invoice", e), async (form) => {
          await client.attachInvoice(period, row, chosenFile(form), { category: value(form, "category") });
          return rowSides(row).kind === "bank" ? "Ledger row created with the invoice attached." : "Invoice attached.";
        }, { onOpen: wireDrop });
      }
      if (action === "attach-proof") {
        return openDialog(attachDialogMarkup(row, "proof", e), async (form) => {
          await client.attachProof(period, row, chosenFile(form));
          return "Payment proof attached.";
        }, { onOpen: wireDrop });
      }
      if (action === "create-ledger") {
        return openDialog(ledgerDialogMarkup(row, e), async (form) => {
          await client.createLedger(period, row, { category: value(form, "category"), description: value(form, "description") });
          return "Ledger row created and paired.";
        });
      }
      if (action === "match") {
        return openDialog(matchDialogMarkup(month, row, e), async (form) => {
          const other = value(form, "manual").trim() || form.querySelector("input[name=other]:checked")?.value;
          if (!other) throw new Error("Pick a row or enter an id");
          await client.match(period, row, other, value(form, "note"));
          return "Rows matched.";
        });
      }
      if (action === "unmatch") {
        return openDialog(unmatchDialogMarkup(row, e), async (form) => {
          await client.unmatch(period, row, value(form, "note"));
          return "Rows unmatched.";
        });
      }
      if (action === "exception") {
        return openDialog(exceptionDialogMarkup(month, row, e), async (form) => {
          await client.markException(period, row, { kind: value(form, "kind"), proof: value(form, "proof"), note: value(form, "note") });
          return "Exception recorded.";
        });
      }
      if (action === "confirm-pair") return run(() => client.confirmPair(period, row), "Match confirmed.");
      if (action === "clear-exception") return run(() => client.clearException(period, row), "Exception cleared.");
    }

    async function run(call, message, { gate = false } = {}) {
      try {
        await call();
        notice(message);
      } catch (error) {
        if (gate) say(blockersMarkup(gateErrorOf(error), e));
        else notice(error?.message || "Request failed", "danger");
      }
      await load();
    }

    async function downloadCsv() {
      try {
        const blob = await client.csv(period);
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `reconcile-${period}.csv`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 0);
      } catch (error) {
        notice(`Could not download the CSV: ${error?.message || "request failed"}`, "danger");
      }
    }

    // Opening the tab before the signed URL arrives keeps it a direct result
    // of the click, so pop-up blockers let it through.
    async function viewDocument(id) {
      const tab = globalThis.open?.("", "_blank");
      try {
        const result = await client.viewDocument(id);
        if (tab) {
          tab.opener = null;
          tab.location.href = result.downloadUrl;
        } else globalThis.location.assign(result.downloadUrl);
      } catch (error) {
        tab?.close?.();
        notice(`Could not open the document: ${error?.message || "request failed"}`, "danger");
      }
    }

    surface.addEventListener("click", (event) => {
      const target = event.target;
      const filterButton = target.closest("[data-recon-filter]");
      if (filterButton) return setFilter(filterButton.dataset.reconFilter === filter && filterButton.classList.contains("recon-stat")
        ? "all" : filterButton.dataset.reconFilter);
      const doc = target.closest("[data-recon-doc]");
      if (doc) return viewDocument(doc.dataset.reconDoc);
      const action = target.closest("[data-recon-action]");
      if (action) {
        const row = month?.rows.find((item) => item.id === action.dataset.reconRow);
        if (row) rowAction(action.dataset.reconAction, row);
        return;
      }
      if (target.closest("[data-recon-retry]")) return load();
      if (target.closest("[data-recon-csv]")) return downloadCsv();
      if (target.closest("[data-recon-close]")) return run(() => client.close(period), `${period} closed.`, { gate: true });
      if (target.closest("[data-recon-confirm]")) return run(() => client.confirmExceptions(period), "Exception list confirmed.", { gate: true });
      if (target.closest("[data-recon-reopen]")) {
        return openDialog(reopenDialogMarkup(month, e), async (form) => {
          const reason = value(form, "reason").trim();
          if (!reason) throw new Error("Give a reason to reopen the month");
          await client.reopen(period, reason);
          return `${period} reopened.`;
        });
      }
    });

    await load();
  }

  return { renderReconcileSurface };
}
