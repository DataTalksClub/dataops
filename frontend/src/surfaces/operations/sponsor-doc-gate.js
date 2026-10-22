import { bindCodeInput, describeUserCodeError, formatUserCode, normalizeUserCode } from "../../dakit/device-code.js";

export const SPONSOR_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const SPONSOR_CODE_LENGTH = 16;

/**
 * Neutral access-code gate for the guest/materials form (no sponsor wording:
 * podcast guests and newsletter sponsors share this screen).
 *
 * Returns an unbind function for the code input binding; the caller runs it
 * before replacing the root (and on destroy).
 */
export function renderSponsorDocGate({
  el,
  root,
  initialCode,
  gateError,
  onUnlock,
}) {
  const card = el("div", "dk-auth-card sponsor-doc-card");
  card.dataset.sponsorView = "gate";
  const head = el("header", "dk-auth-card__head");
  const ledeText =
    "Enter the 16-character access code from your DataTalks.Club email, or open the full link with ?code= included.";
  head.append(el("h1", "dk-auth-card__title", "Enter access code"), el("p", "dk-auth-card__lede", ledeText));
  card.append(head);

  if (gateError) {
    const alert = el("div", "dk-callout dk-callout--danger");
    alert.setAttribute("role", "alert");
    alert.dataset.sponsorGateError = "";
    alert.append(el("div", "dk-callout__body", gateError));
    card.append(alert);
  }

  const form = el("form", "dk-auth-card__form");
  form.noValidate = true;
  const field = el("div", "dk-field");
  const label = el("label", "dk-label", "Access code");
  label.setAttribute("for", "sponsor-doc-code-input");

  const input = el("input", "dk-code-input");
  input.id = "sponsor-doc-code-input";
  input.type = "text";
  input.autocomplete = "off";
  input.autocapitalize = "characters";
  input.spellcheck = false;
  input.placeholder = "XXXX-XXXX-XXXX-XXXX";
  input.value = formatUserCode(initialCode);

  const hint = el("p", "dk-hint", "16 characters (letters and digits, hyphens optional).");
  hint.id = "sponsor-doc-code-hint";
  const errText = el("p", "dk-error");
  errText.id = "sponsor-doc-code-error";
  errText.hidden = true;

  const submitBtn = el("button", "dk-button dk-button--lg dk-button--primary", "Continue");
  submitBtn.type = "submit";
  submitBtn.dataset.sponsorAction = "unlock";

  const codeOpts = { alphabet: SPONSOR_CODE_ALPHABET, length: SPONSOR_CODE_LENGTH };
  const syncValidation = (result) => {
    const msg = describeUserCodeError(result, codeOpts);
    const showError = Boolean(msg) && result.error !== "too_short";
    errText.textContent = showError ? msg : "";
    errText.hidden = !showError;
    submitBtn.disabled = !result.ok;
  };

  input.addEventListener("dk-code-change", (event) => syncValidation(event.detail));
  const unbind = bindCodeInput(input, codeOpts);
  syncValidation(normalizeUserCode(input.value, codeOpts));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const check = normalizeUserCode(input.value, codeOpts);
    if (!check.ok) {
      errText.textContent = describeUserCodeError(check, codeOpts);
      errText.hidden = false;
      return;
    }
    onUnlock(check.display);
  });

  field.append(label, input, hint, errText);
  const actionsWrap = el("div", "dk-auth-card__actions");
  actionsWrap.append(submitBtn);
  form.append(field, actionsWrap);
  card.append(form);
  root.append(card);
  return unbind;
}
