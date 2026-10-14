// Month period navigator shared by Calendar and Bookkeeping: a "today"
// button, previous/next icon buttons, the period title as a month picker
// (year stepper, month grid, footer shortcuts) and an optional badge.
// Surfaces own the period state; this module owns markup and picker behavior.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const chevron = (points) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;

/**
 * @param {object} options
 * @param {string} options.headingId     id of the period heading (h2)
 * @param {string} options.todayLabel    label of the jump-to-now button
 * @param {string} options.groupLabel    accessible name of the prev/next group
 * @param {string} [options.badgeHtml]   trusted markup shown after the title
 * @param {{action: string, label: string}[]} [options.shortcuts]
 *   footer buttons of the picker; each renders data-picker-shortcut="action"
 */
export function periodNavMarkup({ headingId, todayLabel, groupLabel, badgeHtml = "", shortcuts = [] }) {
  return `
    <div class="period-nav">
      <button type="button" class="period-nav__today" data-today>${todayLabel}</button>
      <div class="period-nav__arrows" role="group" aria-label="${groupLabel}">
        <button type="button" class="period-nav__arrow" data-prev aria-label="Previous period" title="Previous period">${chevron("15 18 9 12 15 6")}</button>
        <button type="button" class="period-nav__arrow" data-next aria-label="Next period" title="Next period">${chevron("9 18 15 12 9 6")}</button>
      </div>
      <div class="period-nav__picker">
        <h2 id="${headingId}" class="period-nav__heading">
          <button type="button" class="period-nav__title-btn" data-picker-toggle aria-haspopup="dialog" aria-expanded="false" title="Choose month and year">
            <span class="period-nav__title" data-period-heading></span>
            <svg class="period-nav__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
        </h2>
        ${badgeHtml}
        <div class="period-nav__popover" data-picker-popover hidden role="dialog" aria-label="Choose month and year">
          <div class="period-nav__year">
            <button type="button" class="period-nav__year-btn" data-picker-prev-year aria-label="Previous year">‹</button>
            <span class="period-nav__year-label" data-picker-year></span>
            <button type="button" class="period-nav__year-btn" data-picker-next-year aria-label="Next year">›</button>
          </div>
          <div class="period-nav__months" role="grid" aria-label="Months">
            ${MONTHS.map((m, i) => `<button type="button" class="period-nav__month" data-picker-month="${i}">${m}</button>`).join("")}
          </div>
          <div class="period-nav__foot">
            ${shortcuts.map(({ action, label }) => `<button type="button" class="period-nav__shortcut" data-picker-shortcut="${action}">${label}</button>`).join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Wires the picker inside `root` (the element holding periodNavMarkup).
 * `selected()` and `current()` return { year, month } with a 0-based month,
 * or month null when no single month is selected.
 */
export function mountPeriodNav(root, { selected, current, onToday, onPrev, onNext, onMonth, onShortcut, dismissScope = root }) {
  const toggle = root.querySelector("[data-picker-toggle]"),
    popover = root.querySelector("[data-picker-popover]"),
    yearLabel = root.querySelector("[data-picker-year]"),
    monthButtons = root.querySelectorAll("[data-picker-month]");
  let pickerYear = selected().year;

  function paint() {
    if (!popover || popover.hidden) return;
    if (yearLabel) yearLabel.textContent = String(pickerYear);
    const chosen = selected(), now = current();
    monthButtons.forEach((button) => {
      const month = Number(button.dataset.pickerMonth);
      button.classList.toggle("is-selected", pickerYear === chosen.year && month === chosen.month);
      button.classList.toggle("is-current", pickerYear === now.year && month === now.month);
    });
  }
  function open() {
    pickerYear = selected().year;
    popover.hidden = false;
    toggle?.setAttribute("aria-expanded", "true");
    paint();
  }
  function close() {
    if (popover && !popover.hidden) {
      popover.hidden = true;
      toggle?.setAttribute("aria-expanded", "false");
    }
  }
  const handle = (selector, fn) => {
    const element = root.querySelector(selector);
    if (element) element.onclick = (event) => { event?.stopPropagation?.(); fn(); };
  };

  handle("[data-today]", () => onToday());
  handle("[data-prev]", () => onPrev());
  handle("[data-next]", () => onNext());
  handle("[data-picker-toggle]", () => (popover?.hidden ? open() : close()));
  handle("[data-picker-prev-year]", () => { pickerYear -= 1; paint(); });
  handle("[data-picker-next-year]", () => { pickerYear += 1; paint(); });
  monthButtons.forEach((button) => {
    button.onclick = (event) => {
      event?.stopPropagation?.();
      close();
      onMonth(pickerYear, Number(button.dataset.pickerMonth));
    };
  });
  root.querySelectorAll("[data-picker-shortcut]").forEach((button) => {
    button.onclick = (event) => {
      event?.stopPropagation?.();
      close();
      onShortcut?.(button.dataset.pickerShortcut, pickerYear);
    };
  });
  dismissScope.addEventListener("click", (event) => {
    if (popover && !popover.contains(event.target) && !toggle?.contains(event.target)) close();
  });
  dismissScope.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return {
    setTitle(text) {
      const title = root.querySelector("[data-period-heading]");
      if (title) title.textContent = text;
    },
    setStep({ prevLabel, nextLabel, disabled = false }) {
      const prev = root.querySelector("[data-prev]"), next = root.querySelector("[data-next]");
      for (const [button, label] of [[prev, prevLabel], [next, nextLabel]]) {
        if (!button) continue;
        button.setAttribute("aria-label", label);
        button.setAttribute("title", label);
        button.disabled = disabled;
      }
    },
    close,
  };
}
