// One section header for every Finance section: a title, an optional
// one-line hint, an optional meta chip under them, and the section's actions
// on the right. No eyebrows.
// `create` is collectionCreateButtonMarkup(): the section's create action sits
// right after its title, never in the page header's corner.
export function financeSectionHead({ id, title, hint = "", meta = "", actions = "", create = "" }) {
  const heading = html`<h2 id="${id}" class="dk-section-header__title">${title}</h2>`;
  return html`<header class="dk-section-header finance-section-head">
    <div class="finance-section-head__main">
      ${create ? html`<div class="collection-header__lead">${heading}${create}</div>` : heading}
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
