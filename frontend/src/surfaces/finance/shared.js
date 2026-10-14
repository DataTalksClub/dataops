// One section header for every Finance section: a title, an optional
// one-line hint, an optional meta chip under them, and the section's actions
// on the right. No eyebrows.
export function financeSectionHead({ id, title, hint = "", meta = "", actions = "" }) {
  return html`<header class="dk-section-header finance-section-head">
    <div class="finance-section-head__main">
      <h2 id="${id}" class="dk-section-header__title">${title}</h2>
      ${hint ? html`<p class="finance-section-head__hint">${hint}</p>` : ""}
      ${meta}
    </div>
    ${actions ? html`<div class="finance-section-head__actions">${actions}</div>` : ""}
  </header>`;
}

export function html(strings, ...values) {
  return strings.reduce(
    (markup, segment, index) =>
      markup + segment + (index < values.length ? values[index] : ""),
    "",
  );
}
